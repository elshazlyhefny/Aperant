/**
 * zeenha fork: create a spec from a description without Electron.
 *
 * Mirrors AgentManager.startSpecCreation. Returns the exit code (and the new
 * spec id) instead of calling process.exit, so it can be tested. The spec
 * folder is removed again on any failure that this run caused.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { getSpecsDir } from '../../shared/constants';
import type { AgentExecutorConfig, SerializableSessionConfig } from '../ai/agent/types';
import { WorkerBridgeCore } from '../ai/agent/worker-bridge-core';
import type { WorkerBridgeCoreOptions } from '../ai/agent/worker-bridge-core';
import { serializeSecurityProfile } from '../ai/agent/task-session';
import { resolveModelId } from '../ai/config/phase-config';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { withSpecNumberLock } from '../utils/spec-number-lock';
import { buildSpecId } from '../utils/spec-slug';
import { resolveHeadlessAuth } from './auth';
import { loadHeadlessConfig, mcpOptionsForHeadless, resolveProjectSettings } from './config';
import { collectBridgeRun } from './bridge-run';
import type { HeadlessBridge } from './bridge-run';
import { classifySpecRun, EXIT_ERROR, EXIT_SUCCESS } from './outcome';
import { createProgressReporter } from './progress';
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
    const allocated = await withSpecNumberLock(projectPath, (lock) => {
      const n = lock.getNextSpecNumber(AUTO_BUILD_PATH);
      const id = buildSpecId(n, firstLine);
      const dir = path.join(projectPath, getSpecsDir(AUTO_BUILD_PATH), id);
      mkdirSync(dir, { recursive: true });
      return { id, dir };
    });
    specId = allocated.id;
    specDir = allocated.dir;
    created = true;

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
    const workerPath = options.workerPath;
    const bridgeOptions: WorkerBridgeCoreOptions = {
      resolveWorkerPath: () => {
        if (!workerPath) throw new Error('No worker path was supplied');
        return workerPath;
      },
    };
    const bridge = options.createBridge ? options.createBridge(bridgeOptions) : new WorkerBridgeCore(bridgeOptions);
    reporter.log(`Creating spec ${specId} in ${specDir}`);

    const outcome = classifySpecRun(await collectBridgeRun({ bridge, executorConfig, reporter }));
    if (outcome.kind !== 'success') {
      return fail(outcome.reason ?? 'Spec creation failed');
    }

    // (8) the spec must actually exist
    const specFile = path.join(specDir, 'spec.md');
    if (!existsSync(specFile) || statSync(specFile).size === 0) {
      return fail('Spec creation finished but spec.md was not written');
    }
    if (!existsSync(path.join(specDir, 'implementation_plan.json'))) {
      return fail('Spec creation finished but implementation_plan.json was not written');
    }

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
