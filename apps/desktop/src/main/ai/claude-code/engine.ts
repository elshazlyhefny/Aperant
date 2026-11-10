/**
 * Claude Code engine
 * ==================
 *
 * Runs one model conversation through the installed Claude Code CLI:
 * spawn `claude -p`, feed it the prompt, serve Aperant's tools over the
 * bridge, and report everything as stream parts.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { Tool as AITool } from 'ai';

import {
  buildClaudeArgs,
  buildClaudeEnv,
  buildStreamJsonUserMessage,
  type ClaudeEffort,
  type PromptImage,
  resolveClaudeBinary,
} from './cli-args';
import {
  type ClaudeCodePart,
  type CliStep,
  type CliUsage,
  cliFailureError,
  createCliEventParser,
} from './cli-events';
import { startToolBridge, type ToolBridge } from './tool-bridge';

/** Empty MCP config: with --strict-mcp-config this means "no MCP servers at all". */
const NO_MCP_SERVERS = '{"mcpServers":{}}';
/** How long to wait after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3000;
/** Keep the end of stderr for error messages. */
const STDERR_TAIL_BYTES = 4000;
/** While a bridged tool runs the CLI prints nothing; report liveness this often. */
export const TOOL_KEEPALIVE_MS = 15_000;

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ClaudeCodeRunOptions {
  modelId: string;
  system?: string;
  prompt: string;
  /** Images sent with the prompt (stream-json input). */
  images?: PromptImage[];
  tools?: Record<string, AITool>;
  effort?: ClaudeEffort;
  jsonSchema?: Record<string, unknown>;
  cwd?: string;
  abortSignal?: AbortSignal;
  /**
   * Asked before each further model request, with the steps finished so far.
   * Returning true ends the run (the AI SDK `stopWhen` meaning: tools of the
   * last step have run, no further model call is made).
   */
  shouldStop?: (steps: readonly CliStep[]) => boolean | PromiseLike<boolean>;
  onPart: (part: ClaudeCodePart) => void;
  /**
   * OAuth token of the Claude account Aperant selected. The CLI then runs as
   * that account (CLAUDE_CODE_OAUTH_TOKEN) instead of whatever `~/.claude` is
   * signed into, so profile choice and account switching apply. Passed in the
   * environment only, never on the command line.
   */
  oauthToken?: string;
  /**
   * CLAUDE_CONFIG_DIR of that account's profile. Preferred over oauthToken:
   * the CLI then reads and refreshes the profile's own credentials, so a
   * token rotated while a long task runs does not end it ("oauth token
   * revoked"). The token is not passed then, because CLAUDE_CODE_OAUTH_TOKEN
   * would override the profile's live credentials.
   */
  configDir?: string;
  /** Test seams. */
  spawn?: SpawnFn;
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeCodeRunResult {
  text: string;
  structuredOutput?: unknown;
  finishReason: string;
  usage: CliUsage;
  steps: CliStep[];
  /** True when `shouldStop` ended the run before the model finished. */
  stoppedEarly: boolean;
}

export function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export async function runClaudeCode(options: ClaudeCodeRunOptions): Promise<ClaudeCodeRunResult> {
  if (options.abortSignal?.aborted) throw abortError();

  const binary = options.binaryPath ?? resolveClaudeBinary(options.env);
  if (!binary) {
    throw new Error(
      'Claude Code CLI not found. Install Claude Code and sign in with `claude`, ' +
        'or set APERANT_CLAUDE_PATH to the claude executable.',
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), 'aperant-cc-'));
  let bridge: ToolBridge | null = null;
  let child: ChildProcess | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let stoppedEarly = false;
  let aborted = false;
  let stopError: unknown = null;
  // Nothing is reported, and no tool runs, once the run has been stopped.
  const onPart = (part: ClaudeCodePart) => {
    if (!stoppedEarly && !aborted) options.onPart(part);
  };

  const kill = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (killTimer) return;
    const target = child;
    killTimer = setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  };
  const onAbort = () => {
    aborted = true;
    kill();
  };
  // Registered before any await: an abort during setup must not be missed.
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const hasTools = options.tools != null && Object.keys(options.tools).length > 0;
    if (hasTools && options.tools) {
      bridge = await startToolBridge(options.tools, {
        abortSignal: options.abortSignal,
        keepaliveMs: TOOL_KEEPALIVE_MS,
        isClosed: () => stoppedEarly || aborted,
        onBusy: () => onPart({ type: 'keepalive' }),
        onCall: (toolCallId, toolName, input) => onPart({ type: 'tool-call', toolCallId, toolName, input }),
        onResult: (toolCallId, toolName, input, output) =>
          onPart({ type: 'tool-result', toolCallId, toolName, input, output }),
        onError: (toolCallId, toolName, input, error) =>
          onPart({ type: 'tool-error', toolCallId, toolName, input, error }),
      });
    }

    // Files are 0600: the system prompt may hold project text, the MCP config holds the bridge token.
    let systemPromptFile: string | undefined;
    if (options.system) {
      systemPromptFile = join(workDir, 'system-prompt.txt');
      await writeFile(systemPromptFile, options.system, { mode: 0o600 });
    }
    let mcpConfig = NO_MCP_SERVERS;
    if (bridge) {
      mcpConfig = join(workDir, 'mcp.json');
      await writeFile(mcpConfig, bridge.mcpConfig(), { mode: 0o600 });
    }

    const hasImages = (options.images?.length ?? 0) > 0;
    const args = buildClaudeArgs({
      modelId: options.modelId,
      systemPromptFile,
      mcpConfig,
      hasTools,
      effort: options.effort,
      jsonSchema: options.jsonSchema,
      inputStreamJson: hasImages,
    });

    // The signal itself is the authority: an abort before the listener existed set no flag.
    if (aborted || options.abortSignal?.aborted) throw abortError();
    const env = buildClaudeEnv(options.env);
    if (options.configDir) {
      env.CLAUDE_CONFIG_DIR = options.configDir.replace(/^~(?=$|\/)/, homedir());
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    } else if (options.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
    }
    const spawnFn = options.spawn ?? (nodeSpawn as SpawnFn);
    child = spawnFn(binary, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const proc = child;

    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });

    const stop = () => {
      stoppedEarly = true;
      kill();
    };
    // A synchronous stop condition (stepCountIs) decides at once, before any
    // part of the next step is reported or any of its tools can run. One that
    // returns a promise is awaited in order; if it throws, the run stops and
    // the error is raised after the CLI has exited.
    let stopCheck: Promise<void> = Promise.resolve();
    const parser = createCliEventParser({
      onPart,
      aliases: bridge?.aliases,
      onStepStart: (steps) => {
        if (!options.shouldStop || steps.length === 0 || stoppedEarly) return;
        const finished = [...steps];
        let answer: boolean | PromiseLike<boolean>;
        try {
          answer = options.shouldStop(finished);
        } catch (error) {
          stopError = error;
          stop();
          return;
        }
        if (typeof answer === 'boolean') {
          if (answer) stop();
          return;
        }
        const pending = answer;
        stopCheck = stopCheck.then(async () => {
          if (stoppedEarly) return;
          try {
            if (await pending) stop();
          } catch (error) {
            stopError = error;
            stop();
          }
        });
      },
    });

    const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      proc.once('error', (error) => resolve({ code: null, error }));
      proc.once('close', (code) => resolve({ code }));
    });

    proc.stdin?.on('error', () => {
      /* the CLI may exit before reading all of stdin; the exit code tells the story */
    });
    proc.stdin?.end(
      hasImages ? buildStreamJsonUserMessage(options.prompt, options.images ?? []) : options.prompt,
    );

    if (proc.stdout) {
      const lines = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // not a protocol line (e.g. a warning); ignore
        }
        if (!stoppedEarly) parser.handle(event);
      }
    }

    const { code, error: spawnError } = await exit;
    await stopCheck;

    if (aborted || options.abortSignal?.aborted) throw abortError();
    if (stopError) throw stopError;
    if (spawnError) throw new Error(`Could not start Claude Code CLI (${binary}): ${spawnError.message}`);

    const steps = [...parser.steps];
    const usage = parser.totalUsage;
    if (stoppedEarly) {
      const lastText = steps.length > 0 ? steps[steps.length - 1].text : '';
      return { text: lastText, finishReason: 'length', usage, steps, stoppedEarly: true };
    }

    const result = parser.result;
    if (!result || result.isError || result.subtype !== 'success') {
      throw cliFailureError(result, code, stderrTail);
    }

    return {
      text: result.text,
      ...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
      finishReason: steps.length > 0 ? steps[steps.length - 1].finishReason : 'stop',
      usage,
      steps,
      stoppedEarly: false,
    };
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort);
    kill();
    await bridge?.close();
    await rm(workDir, { recursive: true, force: true });
  }
}
