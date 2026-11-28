/**
 * zeenha fork: create a spec from a description without Electron.
 *
 * Mirrors AgentManager.startSpecCreation. Returns the exit code (and the new
 * spec id) instead of calling process.exit, so it can be tested. The spec
 * folder is removed again on any failure that this run caused.
 *
 * createHeadlessSpecInDir runs the same spec creation in a folder that already
 * exists (a scheduled task created without spec.md), for runHeadlessTask.
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import type { AgentExecutorConfig, SerializableSessionConfig } from '../ai/agent/types';
import { WorkerBridgeCore } from '../ai/agent/worker-bridge-core';
import type { WorkerBridgeCoreOptions } from '../ai/agent/worker-bridge-core';
import { serializeSecurityProfile } from '../ai/agent/task-session';
import { resolveModelId } from '../ai/config/phase-config';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { allocateSpecDir } from '../utils/spec-number-lock';
import { resolveHeadlessAuth } from './auth';
import type { HeadlessAuthResult } from './auth';
import { loadHeadlessConfig, mcpOptionsForHeadless, resolveProjectSettings } from './config';
import type { HeadlessConfig, HeadlessProjectSettings } from './config';
import { collectBridgeRun } from './bridge-run';
import type { HeadlessBridge } from './bridge-run';
import { classifySpecRun, EXIT_ERROR, EXIT_SUCCESS } from './outcome';
import { createProgressReporter } from './progress';
import type { ProgressReporter } from './progress';
import { AUTO_BUILD_PATH, findGitRoot, HeadlessSetupError } from './shared';

export interface HeadlessNewSpecOptions {
  /** Project root (or any directory inside it). Defaults to the current directory. */
  projectPath?: string;
  description: string;
  configPath?: string;
  json?: boolean;
  verbose?: boolean;
  /** Absolute path of the worker entry file. */
  workerPath?: string;
  /** Print the final summary. Default true; false when a build follows. */
  summary?: boolean;
  createBridge?: (options: WorkerBridgeCoreOptions) => HeadlessBridge;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function buildDefaultSpecPrompt(description: string, specDir: string): string {
  return `You are a spec creation agent. Your job is to create a detailed specification and implementation plan for the following task:\n\n${description}\n\nSpec directory: ${specDir}\n\nCreate a spec.md with requirements and an implementation_plan.json with phases and subtasks.`;
}

export async function createHeadlessSpec(
  options: HeadlessNewSpecOptions,
): Promise<{ exitCode: number; specId?: string }> {
  // Secrets resolved later in the run; every line written goes through redact().
  const secrets: string[] = [];
  const redact = (text: string): string => {
    let result = text;
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  };
  const rawOut = options.out ?? ((t: string) => void process.stdout.write(t));
  const rawErr = options.err ?? ((t: string) => void process.stderr.write(t));
  const reporter = createProgressReporter({
    json: options.json,
    verbose: options.verbose,
    out: (t) => rawOut(redact(t)),
    err: (t) => rawErr(redact(t)),
  });

  let specId: string | undefined;
  let specDir: string | undefined;
  let created = false;

  const fail = (message: string): { exitCode: number } => {
    if (created && specDir) {
      try {
        rmSync(specDir, { recursive: true, force: true });
      } catch {
        // best effort; the failure is reported below either way
      }
    }
    reporter.error(message);
    reporter.summary({ kind: 'error', exitCode: EXIT_ERROR, reason: message }, { spec: specId });
    return { exitCode: EXIT_ERROR };
  };

  try {
    // (1) description
    const description = (options.description ?? '').trim();
    if (!description) throw new HeadlessSetupError('Missing description');

    // (2) project, (3) config and settings
    const projectPath = findGitRoot(path.resolve(options.projectPath ?? process.cwd()));
    const config = loadHeadlessConfig(options.configPath);
    const settings = resolveProjectSettings(projectPath, config);

    // (4) model and credentials, before anything is created on disk
    const modelId = resolveModelId('sonnet');
    const resolvedAuth = await resolveHeadlessAuth(modelId, null, config);
    if (resolvedAuth.auth.apiKey) secrets.push(resolvedAuth.auth.apiKey);

    // (5) allocate the spec folder
    const firstLine = description.split(/\r?\n/)[0] ?? description;
    // zeenha fork: the shared allocator, like the desktop's create-task path.
    const allocated = await allocateSpecDir({ path: projectPath, autoBuildPath: AUTO_BUILD_PATH }, firstLine);
    specId = allocated.specId;
    specDir = allocated.specDir;
    created = true;

    // (6)-(8) spec creation in the new folder
    const failure = await runSpecOrchestrator({
      projectPath,
      specId,
      specDir,
      description,
      settings,
      resolvedAuth,
      reporter,
      workerPath: options.workerPath,
      createBridge: options.createBridge,
    });
    if (failure) return fail(failure.reason);

    // (10) success
    reporter.log(`Created spec ${specId} at ${specDir}`);
    if (options.summary !== false) {
      reporter.summary({ kind: 'success', exitCode: EXIT_SUCCESS }, { spec: specId });
    }
    return { exitCode: EXIT_SUCCESS, specId };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

interface SpecOrchestratorParams {
  projectPath: string;
  specId: string;
  specDir: string;
  description: string;
  settings: Pick<HeadlessProjectSettings, 'prOnlyLanding' | 'envPassthrough' | 'bashSandbox' | 'webFetchProvider'>;
  resolvedAuth: HeadlessAuthResult;
  reporter: ProgressReporter;
  workerPath?: string;
  createBridge?: (options: WorkerBridgeCoreOptions) => HeadlessBridge;
  signal?: AbortSignal;
  handleProcessSignals?: boolean;
}

/**
 * Run the spec orchestrator in a spec folder that already exists and check
 * that it wrote spec.md and implementation_plan.json. Undefined on success.
 */
async function runSpecOrchestrator(
  params: SpecOrchestratorParams,
): Promise<{ reason: string; aborted: boolean } | undefined> {
  const { projectPath, specId, specDir, description, settings, resolvedAuth, reporter } = params;

  // (6) session config, as in startSpecCreation
  const systemPrompt = tryLoadPrompt('spec_orchestrator') ?? buildDefaultSpecPrompt(description, specDir);
  const sessionConfig: SerializableSessionConfig = {
    agentType: 'spec_orchestrator',
    systemPrompt,
    phase: 'spec',
    initialMessages: [
      {
        role: 'user',
        content: `Task: ${description}\n\nProject directory: ${projectPath}\nSpec directory: ${specDir}\nAuto-approve: true`,
      },
    ],
    maxSteps: 1000,
    specDir,
    projectDir: projectPath,
    provider: resolvedAuth.provider,
    modelId: resolvedAuth.modelId,
    apiKey: resolvedAuth.auth.apiKey,
    baseURL: resolvedAuth.auth.baseURL,
    configDir: resolvedAuth.configDir,
    oauthTokenFilePath: resolvedAuth.auth.oauthTokenFilePath,
    mcpOptions: mcpOptionsForHeadless(projectPath, AUTO_BUILD_PATH),
    toolContext: {
      cwd: projectPath,
      projectDir: projectPath,
      specDir,
      securityProfile: serializeSecurityProfile(projectPath, {
        prOnlyLanding: settings.prOnlyLanding,
        envPassthrough: settings.envPassthrough,
        bashSandbox: settings.bashSandbox,
        webFetchProvider: settings.webFetchProvider,
      }),
    },
  };
  const executorConfig: AgentExecutorConfig = {
    taskId: specId,
    processType: 'spec-creation',
    session: sessionConfig,
  };

  // (7) bridge and outcome
  const workerPath = params.workerPath;
  const bridgeOptions: WorkerBridgeCoreOptions = {
    resolveWorkerPath: () => {
      if (!workerPath) throw new Error('No worker path was supplied');
      return workerPath;
    },
  };
  const bridge = params.createBridge ? params.createBridge(bridgeOptions) : new WorkerBridgeCore(bridgeOptions);
  reporter.log(`Creating spec ${specId} in ${specDir}`);

  const runInput = await collectBridgeRun({
    bridge,
    executorConfig,
    reporter,
    signal: params.signal,
    handleProcessSignals: params.handleProcessSignals,
  });
  const outcome = classifySpecRun(runInput);
  if (outcome.kind !== 'success') {
    return { reason: outcome.reason ?? 'Spec creation failed', aborted: runInput.abortSignal !== undefined };
  }

  // (8) the spec must actually exist
  const specFile = path.join(specDir, 'spec.md');
  if (!existsSync(specFile) || statSync(specFile).size === 0) {
    return { reason: 'Spec creation finished but spec.md was not written', aborted: false };
  }
  if (!existsSync(path.join(specDir, 'implementation_plan.json'))) {
    return { reason: 'Spec creation finished but implementation_plan.json was not written', aborted: false };
  }
  return undefined;
}

/**
 * zeenha fork: the task description stored in a spec folder that has no
 * spec.md yet (requirements.json, else the plan's description), or undefined.
 * Scheduled tasks store their description there instead of writing spec.md.
 */
export function readSpecTaskDescription(specDir: string): string | undefined {
  const read = (file: string, field: string): string | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(path.join(specDir, file), 'utf-8')) as Record<string, unknown> | null;
      const value = parsed?.[field];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  return read('requirements.json', 'task_description') ?? read('implementation_plan.json', 'description');
}

/** Spec creation was stopped by an abort signal (daemon stop, token budget). */
export class HeadlessSpecAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadlessSpecAbortedError';
  }
}

export interface HeadlessSpecInDirOptions {
  projectPath: string;
  specId: string;
  /** An existing spec folder. Nothing is allocated, and nothing is removed on failure. */
  specDir: string;
  description: string;
  config: HeadlessConfig;
  settings: SpecOrchestratorParams['settings'];
  reporter: ProgressReporter;
  /** Receives the resolved API key, so the caller's reporter redacts it. */
  secrets: string[];
  workerPath?: string;
  createBridge?: (options: WorkerBridgeCoreOptions) => HeadlessBridge;
  signal?: AbortSignal;
  handleProcessSignals?: boolean;
}

/**
 * zeenha fork: run spec creation in an EXISTING spec folder: the same
 * orchestrator call createHeadlessSpec makes, without allocating a folder.
 * The desktop does the same for a task without spec.md (launchTask ->
 * startSpecCreation). Throws HeadlessSetupError on failure and
 * HeadlessSpecAbortedError when the signal aborted it.
 */
export async function createHeadlessSpecInDir(options: HeadlessSpecInDirOptions): Promise<void> {
  const modelId = resolveModelId('sonnet');
  const resolvedAuth = await resolveHeadlessAuth(modelId, null, options.config);
  if (resolvedAuth.auth.apiKey && !options.secrets.includes(resolvedAuth.auth.apiKey)) {
    options.secrets.push(resolvedAuth.auth.apiKey);
  }
  const failure = await runSpecOrchestrator({ ...options, resolvedAuth });
  if (!failure) {
    options.reporter.log(`Created spec ${options.specId} at ${options.specDir}`);
    return;
  }
  const message = `Spec creation failed: ${failure.reason}`;
  throw failure.aborted ? new HeadlessSpecAbortedError(message) : new HeadlessSetupError(message);
}
