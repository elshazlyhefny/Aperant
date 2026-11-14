/**
 * zeenha fork: run one spec through the build pipeline without Electron.
 *
 * Mirrors AgentManager.startTaskExecution using the shared task-session
 * helpers. Returns the exit code instead of calling process.exit, so it can be
 * tested. Isolation is the same as in the app: the task always runs in its own
 * git worktree, and there is no project-root fallback (PR-only landing is
 * always on).
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { getSpecsDir } from '../../shared/constants';
import type { AgentExecutorConfig, SerializableSessionConfig } from '../ai/agent/types';
import { WorkerBridgeCore } from '../ai/agent/worker-bridge-core';
import type { WorkerBridgeCoreOptions } from '../ai/agent/worker-bridge-core';
import {
  buildDefaultPlannerPrompt,
  buildTaskExecutionMessages,
  resolveTaskModelId,
  resolveTaskPhaseProvider,
  resolveTaskTokenBudget,
  serializeSecurityProfile,
} from '../ai/agent/task-session';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { createOrGetWorktree } from '../ai/worktree/worktree-manager';
import { resolveHeadlessAuth } from './auth';
import { loadHeadlessConfig, mcpOptionsForHeadless, resolveProjectSettings } from './config';
import { collectBridgeRun } from './bridge-run';
import type { HeadlessBridge } from './bridge-run';
import { classifyRun, EXIT_ERROR } from './outcome';
import { createProgressReporter } from './progress';
import { AUTO_BUILD_PATH, findGitRoot, HeadlessSetupError, providerPhaseModels } from './shared';

export type { HeadlessBridge };

export interface HeadlessRunOptions {
  /** Project root (or any directory inside it). Defaults to the current directory. */
  projectPath?: string;
  /** Spec id (e.g. 001-my-feature) or a path to the spec directory. */
  spec: string;
  configPath?: string;
  baseBranch?: string;
  noPush?: boolean;
  json?: boolean;
  verbose?: boolean;
  /** Absolute path of the worker entry file. */
  workerPath?: string;
  createBridge?: (options: WorkerBridgeCoreOptions) => HeadlessBridge;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function resolveSpec(projectRoot: string, spec: string): { specId: string; specDir: string } {
  const specsDir = path.join(projectRoot, getSpecsDir(AUTO_BUILD_PATH));
  const looksLikePath = spec.includes('/') || spec.includes(path.sep);
  if (!looksLikePath) {
    return { specId: spec, specDir: path.join(specsDir, spec) };
  }
  const specDir = path.resolve(spec);
  const specId = path.basename(specDir);
  if (path.resolve(specsDir, specId) !== specDir) {
    throw new HeadlessSetupError(`Spec directory ${specDir} must be inside ${specsDir}`);
  }
  return { specId, specDir };
}

export async function runHeadlessTask(options: HeadlessRunOptions): Promise<number> {
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
  const fail = (message: string, specId?: string): number => {
    reporter.error(message);
    reporter.summary({ kind: 'error', exitCode: EXIT_ERROR, reason: message }, { spec: specId });
    return EXIT_ERROR;
  };

  let specId: string | undefined;
  try {
    // (1) project and spec
    const projectPath = findGitRoot(path.resolve(options.projectPath ?? process.cwd()));
    const resolved = resolveSpec(projectPath, options.spec);
    specId = resolved.specId;
    const specDir = resolved.specDir;
    if (!existsSync(specDir) || !statSync(specDir).isDirectory() || !existsSync(path.join(specDir, 'spec.md'))) {
      throw new HeadlessSetupError(`Spec not found: ${path.join(specDir, 'spec.md')} does not exist`);
    }

    // (2) config and project settings
    const config = loadHeadlessConfig(options.configPath);
    const settings = resolveProjectSettings(projectPath, config, {
      baseBranch: options.baseBranch,
      noPush: options.noPush,
    });

    // (3) model and credentials, before anything is created on disk
    const modelId = await resolveTaskModelId(specDir, 'planning', providerPhaseModels(config));
    const preferredProvider = resolveTaskPhaseProvider(specDir, 'planning');
    const resolvedAuth = await resolveHeadlessAuth(modelId, preferredProvider, config);
    if (resolvedAuth.auth.apiKey) secrets.push(resolvedAuth.auth.apiKey);

    // (4) worktree; no fallback to the project root
    let worktreePath: string;
    let branch: string;
    try {
      const result = await createOrGetWorktree(
        projectPath,
        specId,
        settings.baseBranch,
        false,
        settings.pushNewBranches,
        AUTO_BUILD_PATH,
      );
      worktreePath = result.worktreePath;
      branch = result.branch;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HeadlessSetupError(
        `Could not create the task's git worktree, so the task was not started (headless runs land changes through pull requests only). ${reason}`,
      );
    }
    const worktreeSpecDir = path.join(worktreePath, getSpecsDir(AUTO_BUILD_PATH), specId);

    // (5) session config, as in startTaskExecution
    const systemPrompt = tryLoadPrompt('planner') ?? buildDefaultPlannerPrompt(specId, projectPath);
    const sessionConfig: SerializableSessionConfig = {
      agentType: 'build_orchestrator',
      systemPrompt,
      initialMessages: buildTaskExecutionMessages(worktreeSpecDir, specId, worktreePath),
      maxSteps: 1000,
      specDir: worktreeSpecDir,
      projectDir: worktreePath,
      sourceSpecDir: specDir,
      // zeenha fork: the task's token budget from task_metadata.json, as in the app.
      // The CLI has no project store, so there is no project default.
      tokenBudget: resolveTaskTokenBudget(specDir),
      provider: resolvedAuth.provider,
      modelId: resolvedAuth.modelId,
      apiKey: resolvedAuth.auth.apiKey,
      baseURL: resolvedAuth.auth.baseURL,
      configDir: resolvedAuth.configDir,
      oauthTokenFilePath: resolvedAuth.auth.oauthTokenFilePath,
      mcpOptions: mcpOptionsForHeadless(projectPath, AUTO_BUILD_PATH),
      toolContext: {
        cwd: worktreePath,
        projectDir: worktreePath,
        specDir: worktreeSpecDir,
        securityProfile: serializeSecurityProfile(worktreePath, {
          prOnlyLanding: settings.prOnlyLanding,
          envPassthrough: settings.envPassthrough,
          bashSandbox: settings.bashSandbox,
          webFetchProvider: settings.webFetchProvider,
        }),
      },
    };
    const executorConfig: AgentExecutorConfig = {
      taskId: specId,
      processType: 'task-execution',
      session: sessionConfig,
    };

    // (6) bridge, events, outcome collection
    const workerPath = options.workerPath;
    const bridgeOptions: WorkerBridgeCoreOptions = {
      resolveWorkerPath: () => {
        if (!workerPath) throw new Error('No worker path was supplied');
        return workerPath;
      },
    };
    const bridge = options.createBridge ? options.createBridge(bridgeOptions) : new WorkerBridgeCore(bridgeOptions);

    const info = { spec: specId, branch, worktree: worktreePath };
    reporter.log(`Running ${specId} in worktree ${worktreePath} (branch ${branch})`);

    const reported = classifyRun(await collectBridgeRun({ bridge, executorConfig, reporter }));

    reporter.summary(reported, info);
    return reported.exitCode;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), specId);
  }
}
