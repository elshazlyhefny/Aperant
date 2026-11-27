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
  readTaskMetadata,
  resolveTaskModelId,
  resolveTaskPhaseProvider,
  serializeSecurityProfile,
} from '../ai/agent/task-session';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { createOrGetWorktree } from '../ai/worktree/worktree-manager';
import { phaseConnectionResolver } from '../ai/agent/phase-connection';
import { createDeliveryReceiptRecorder, type DeliveryReceiptRecorder } from '../delivery-receipts';
import { isValidTaskId } from '../utils/spec-path-helpers';
import { resolveHeadlessPhaseFallback, resolveHeadlessAuth, type HeadlessAuthResult } from './auth';
import { loadHeadlessConfig, mcpOptionsForHeadless, resolveProjectSettings } from './config';
import type { HeadlessConfig } from './config';
import { collectBridgeRun } from './bridge-run';
import type { HeadlessBridge } from './bridge-run';
import { classifyRun, EXIT_ERROR } from './outcome';
import type { RunOutcome } from './outcome';
import { createProgressReporter } from './progress';
import type { ResultInfo } from './progress';
import {
  AUTO_BUILD_PATH,
  findGitRoot,
  HeadlessSetupError,
  providerPhaseModels,
  resolveDeliveryReceiptRoot,
  resolveHeadlessSpec,
} from './shared';
import { resolveHeadlessTokenBudget } from './token-budget';
import {
  notifyHeadlessOutcome,
  projectNameFromPath,
  readSpecTitle,
  resolveHeadlessWebhook,
} from './webhook';
import { isWritebackEnabled, reportOutcomeToSource, resolveHeadlessWritebackSettings, writebackEventForOutcome } from './writeback';
import type { HeadlessWritebackSettings } from './writeback';
import type { Project } from '../../shared/types';

export type { HeadlessBridge };

export interface HeadlessRunOptions {
  /** Project root (or any directory inside it). Defaults to the current directory. */
  projectPath?: string;
  /** Spec id (e.g. 001-my-feature) or a path to the spec directory. */
  spec: string;
  configPath?: string;
  /** Already-loaded config; used instead of reading configPath. */
  config?: HeadlessConfig;
  /** Aborting behaves like SIGTERM: the bridge is terminated. */
  signal?: AbortSignal;
  /** Register SIGINT/SIGTERM handlers (default true). The daemon passes false. */
  handleProcessSignals?: boolean;
  baseBranch?: string;
  noPush?: boolean;
  json?: boolean;
  verbose?: boolean;
  /** Task correlation for daemon child NDJSON. */
  taskId?: string;
  /** Absolute path of the worker entry file. */
  workerPath?: string;
  createBridge?: (options: WorkerBridgeCoreOptions) => HeadlessBridge;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Test-only: replaces the webhook retry backoff delay. */
  webhookDelay?: (ms: number) => Promise<void>;
  /** Send the outcome webhook (default true). The daemon passes false and sends its own. */
  sendWebhook?: boolean;
  /** Write the outcome back to the source issue (default true). The daemon passes false and writes back itself. */
  sendWriteback?: boolean;
  /** Test-only: replaces the source write-back dispatcher. */
  reportOutcome?: typeof reportOutcomeToSource;
}

export interface HeadlessRunResult {
  exitCode: number;
  outcome: RunOutcome | undefined;
  specId?: string;
  branch?: string;
  worktreePath?: string;
  aborted: boolean;
}

export async function runHeadlessTask(options: HeadlessRunOptions): Promise<number> {
  return (await runHeadlessTaskDetailed(options)).exitCode;
}

export async function runHeadlessTaskDetailed(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  // The reporter reads this list as secrets are resolved; redact values before serialization.
  const secrets: string[] = [];
  const redact = (text: string): string => {
    let result = text;
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  };
  const rawErr = options.err ?? ((t: string) => void process.stderr.write(t));
  const reporter = createProgressReporter({
    json: options.json,
    verbose: options.verbose,
    taskId: options.taskId,
    out: options.out,
    err: rawErr,
    redact: secrets,
  });

  // zeenha fork: outcome webhook state, set as early as possible so setup failures can notify too.
  let webhook: ReturnType<typeof resolveHeadlessWebhook>;
  let webhookProject = '';
  let webhookTitle = '';
  // zeenha fork: source write-back state, filled in alongside the webhook.
  let writebackSettings: HeadlessWritebackSettings | undefined;
  let writebackProjectPath = '';
  let mainSpecDir: string | undefined;
  let worktreeSpecDirForWriteback: string | undefined;
  let specId: string | undefined;
  let recorder: DeliveryReceiptRecorder | undefined;
  // zeenha fork: the effective budget joins the result line once the build ran.
  let resultTokenBudget: ResultInfo['tokenBudget'];
  const sendOutcome = async (outcome: RunOutcome): Promise<void> => {
    if (webhook) {
      try {
        await notifyHeadlessOutcome({
          webhook,
          outcome,
          projectName: webhookProject,
          taskTitle: webhookTitle,
          warn: (message) => rawErr(redact(`warning: ${message}\n`)),
          delay: options.webhookDelay,
          recorder,
        });
      } catch {
        // The webhook must never change the run result.
      }
    }
    if (!writebackSettings || !mainSpecDir) return;
    // zeenha fork: null for an account pause, which is never written back.
    const writebackEvent = writebackEventForOutcome(outcome);
    if (!writebackEvent) return;
    try {
      // Awaited: cli.ts exits right after this function returns.
      await (options.reportOutcome ?? reportOutcomeToSource)({
        settings: writebackSettings,
        project: {
          id: webhookProject,
          name: webhookProject,
          path: writebackProjectPath,
          autoBuildPath: AUTO_BUILD_PATH,
        } as Project,
        specDirs: worktreeSpecDirForWriteback ? [mainSpecDir, worktreeSpecDirForWriteback] : [mainSpecDir],
        event: writebackEvent,
        title: webhookTitle,
        prUrl: outcome.prUrl,
        recorder,
        warn: (message) => rawErr(redact(`warning: ${message}\n`)),
      });
    } catch {
      // Write-back must never change the run result.
    }
  };

  let result: HeadlessRunResult & { outcome: RunOutcome };

  try {
    // (1) project and spec
    const projectPath = findGitRoot(path.resolve(options.projectPath ?? process.cwd()));
    webhookProject = projectNameFromPath(projectPath);
    const resolved = resolveHeadlessSpec(projectPath, options.spec);
    specId = resolved.specId;
    const specDir = resolved.specDir;
    writebackProjectPath = projectPath;
    mainSpecDir = specDir;
    webhookTitle = specId;
    if (!existsSync(specDir) || !statSync(specDir).isDirectory() || !existsSync(path.join(specDir, 'spec.md'))) {
      throw new HeadlessSetupError(`Spec not found: ${path.join(specDir, 'spec.md')} does not exist`);
    }
    webhookTitle = readSpecTitle(specDir, specId);

    // (2) config and project settings
    const config = options.config ?? loadHeadlessConfig(options.configPath);
    if (options.sendWebhook !== false) {
      webhook = resolveHeadlessWebhook(config, process.env);
      if (webhook && 'warning' in webhook) {
        rawErr(`warning: ${webhook.warning}\n`);
      } else if (webhook) {
        secrets.push(webhook.url);
        if (webhook.secret) secrets.push(webhook.secret);
      }
    }
    if (options.sendWriteback !== false) {
      const resolvedWriteback = resolveHeadlessWritebackSettings(config);
      if (isWritebackEnabled(resolvedWriteback)) writebackSettings = resolvedWriteback;
    }
    if ((webhook || writebackSettings) && isValidTaskId(specId)) {
      recorder = createDeliveryReceiptRecorder(resolveDeliveryReceiptRoot(projectPath), specId);
    }
    const settings = resolveProjectSettings(projectPath, config, {
      baseBranch: options.baseBranch,
      noPush: options.noPush,
    });

    const tokenBudget = resolveHeadlessTokenBudget(specDir, config);
    reporter.tokenBudget(tokenBudget);

    // (3) model and credentials, before anything is created on disk
    const modelId = await resolveTaskModelId(specDir, 'planning', providerPhaseModels(config));
    const preferredProvider = resolveTaskPhaseProvider(specDir, 'planning');
    const resolvePhase = phaseConnectionResolver(readTaskMetadata(specDir), () => ({
      accounts: config.providerAccounts ?? [],
      priorityOrder: config.globalPriorityOrder ?? [],
      codexTokenFilePath: config.codexTokenFilePath,
      fallback: resolveHeadlessPhaseFallback,
    }));
    const resolvedAuth: HeadlessAuthResult = resolvePhase
      ? { provider: preferredProvider ?? 'anthropic', modelId, auth: {} }
      : await resolveHeadlessAuth(modelId, preferredProvider, config);
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
    worktreeSpecDirForWriteback = worktreeSpecDir;

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
      // zeenha fork: for the prompt's {{BASE_BRANCH}} and the QA verify gate.
      baseBranch: settings.baseBranch,
      mainProjectDir: projectPath,
      // zeenha fork: use task_metadata.json, then --config project.defaultTokenBudget,
      // never desktop settings.
      tokenBudget: tokenBudget.limit,
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
      resolvePhaseConnection: resolvePhase && (async phase => {
        const connection = await resolvePhase(phase);
        if (connection.apiKey && !secrets.includes(connection.apiKey)) secrets.push(connection.apiKey);
        return connection;
      }),
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

    reporter.log(`Running ${specId} in worktree ${worktreePath} (branch ${branch})`);

    const runInput = await collectBridgeRun({
      bridge,
      executorConfig,
      reporter,
      signal: options.signal,
      handleProcessSignals: options.handleProcessSignals,
    });
    const reported = classifyRun(runInput);

    result = {
      exitCode: reported.exitCode,
      outcome: reported,
      specId,
      branch,
      worktreePath,
      aborted: runInput.abortSignal !== undefined,
    };
    resultTokenBudget = { limit: tokenBudget.limit ?? null, source: tokenBudget.source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    const outcome: RunOutcome = { kind: 'error', exitCode: EXIT_ERROR, reason: message };
    result = { exitCode: EXIT_ERROR, outcome, specId, aborted: false };
  }

  // Delivery runs exactly once, outside the build/setup failure path.
  await sendOutcome(result.outcome);
  const receipts = recorder?.snapshot();
  if (specId && receipts?.length) reporter.deliveryReceipts(specId, receipts);
  reporter.summary(result.outcome, {
    spec: specId,
    branch: result.branch,
    worktree: result.worktreePath,
    tokenBudget: resultTokenBudget,
  });
  return result;
}
