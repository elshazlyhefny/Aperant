import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const mockResolveAuth = vi.fn();

vi.mock('../auth', () => ({
  resolveHeadlessAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));
vi.mock('../../ai/prompts/prompt-loader', () => ({
  tryLoadPrompt: () => 'SPEC PROMPT',
}));

import { createHeadlessSpec } from '../new-spec';
import type { HeadlessBridge } from '../bridge-run';

const SECRET = 'sk-ant-super-secret-key';
const DESCRIPTION = 'Add a login page';

class FakeBridge extends EventEmitter implements HeadlessBridge {
  spawn = vi.fn();
  terminate = vi.fn().mockResolvedValue(undefined);
}

let projectDir: string;
let out: string[];
let err: string[];
let bridge: FakeBridge;

const specsRoot = () => path.join(projectDir, '.auto-claude', 'specs');
const listSpecs = () => (existsSync(specsRoot()) ? readdirSync(specsRoot()).sort() : []);

function create(overrides: Partial<Parameters<typeof createHeadlessSpec>[0]> = {}) {
  return createHeadlessSpec({
    projectPath: projectDir,
    description: DESCRIPTION,
    workerPath: '/fake/worker.js',
    createBridge: () => bridge,
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    ...overrides,
  });
}

interface SpawnConfig {
  taskId: string;
  session: { specDir: string };
}

/** Make spawn() simulate the worker: write files, emit progress, then exit. */
function scriptWorker(
  opts: {
    files?: Array<'spec.md' | 'implementation_plan.json'>;
    code?: number;
    extra?: (taskId: string, specDir: string) => void;
  } = {},
) {
  const { files = ['spec.md', 'implementation_plan.json'], code = 0, extra } = opts;
  bridge.spawn.mockImplementation((config: SpawnConfig) => {
    const specDir = config.session.specDir;
    for (const f of files) {
      writeFileSync(path.join(specDir, f), f === 'spec.md' ? '# Spec\n' : '{"phases":[]}');
    }
    setImmediate(() => {
      bridge.emit('execution-progress', config.taskId, {
        phase: 'planning',
        message: 'Spec creation: quick_spec (1/2)',
      });
      extra?.(config.taskId, specDir);
      bridge.emit('exit', config.taskId, code, 'spec-creation');
    });
  });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'headless-newspec-')));
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  out = [];
  err = [];
  bridge = new FakeBridge();
  mockResolveAuth.mockReset();
  mockResolveAuth.mockResolvedValue({
    auth: { apiKey: SECRET },
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
  });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('createHeadlessSpec', () => {
  it('creates a spec and reports success', async () => {
    scriptWorker();
    const result = await create();
    expect(result.exitCode).toBe(0);
    expect(result.specId).toMatch(/^001-/);
    const specDir = path.join(specsRoot(), result.specId as string);
    expect(existsSync(path.join(specDir, 'spec.md'))).toBe(true);
    expect(existsSync(path.join(specDir, 'implementation_plan.json'))).toBe(true);
    expect(out.join('')).toContain(`RESULT success exit=0 spec=${result.specId}`);

    const config = bridge.spawn.mock.calls[0][0];
    expect(config.processType).toBe('spec-creation');
    expect(config.session.agentType).toBe('spec_orchestrator');
    expect(config.session.phase).toBe('spec');
    expect(config.session.toolContext.securityProfile.prOnlyLanding).toBe(true);
    expect(config.session.initialMessages[0].content).toContain(DESCRIPTION);
  });

  it('numbers the next spec after existing folders', async () => {
    scriptWorker();
    const first = await create();
    const second = await create();
    expect(first.specId).toMatch(/^001-/);
    expect(second.specId).toMatch(/^002-/);

    mkdirSync(path.join(specsRoot(), '007-old'), { recursive: true });
    const third = await create();
    expect(third.specId).toMatch(/^008-/);
  });

  it('prints json progress and a final result line', async () => {
    scriptWorker();
    const result = await create({ json: true });
    expect(result.exitCode).toBe(0);
    const lines = out.join('').split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.some((p) => p.type === 'progress')).toBe(true);
    const last = parsed[parsed.length - 1];
    expect(last).toMatchObject({ type: 'result', kind: 'success', exitCode: 0, spec: result.specId });
  });

  it('prints no RESULT line with summary:false but still returns the spec id', async () => {
    scriptWorker();
    const result = await create({ summary: false });
    expect(result.exitCode).toBe(0);
    expect(result.specId).toBeDefined();
    expect(out.join('')).not.toContain('RESULT');
  });

  it('removes the spec folder when the worker reports PLANNING_FAILED', async () => {
    scriptWorker({
      code: 1,
      extra: (taskId) => {
        bridge.emit('task-event', taskId, { type: 'PLANNING_FAILED', error: 'no plan' });
        bridge.emit('error', taskId, 'worker crashed');
      },
      files: ['spec.md'],
    });
    const result = await create();
    expect(result.exitCode).toBe(1);
    expect(listSpecs()).toEqual([]);
    const errText = err.join('');
    expect(errText).toContain('error:');
    expect(errText).toContain('reason:');
  });

  it('fails and cleans up when spec.md is missing', async () => {
    scriptWorker({ files: ['implementation_plan.json'] });
    const result = await create();
    expect(result.exitCode).toBe(1);
    expect(result.specId).toBeUndefined();
    expect(listSpecs()).toEqual([]);
  });

  it('fails and cleans up when implementation_plan.json is missing', async () => {
    scriptWorker({ files: ['spec.md'] });
    const result = await create();
    expect(result.exitCode).toBe(1);
    expect(listSpecs()).toEqual([]);
  });

  it('fails without credentials and creates no folder', async () => {
    mockResolveAuth.mockRejectedValue(new Error('No credentials found.'));
    const result = await create();
    expect(result.exitCode).toBe(1);
    expect(bridge.spawn).not.toHaveBeenCalled();
    expect(listSpecs()).toEqual([]);
  });

  it.each(['', '   \n  '])('rejects an empty description (%j)', async (description) => {
    const result = await create({ description });
    expect(result.exitCode).toBe(1);
    expect(bridge.spawn).not.toHaveBeenCalled();
    expect(listSpecs()).toEqual([]);
  });

  it('fails and removes the folder when spawn throws', async () => {
    bridge.spawn.mockImplementation(() => {
      throw new Error('boom');
    });
    const result = await create();
    expect(result.exitCode).toBe(1);
    expect(listSpecs()).toEqual([]);
    expect(err.join('')).toContain('boom');
  });

  it('never writes the api key to out or err', async () => {
    scriptWorker({
      code: 1,
      extra: (taskId) => {
        bridge.emit('log', taskId, `using key ${SECRET}`);
        bridge.emit('error', taskId, `bad key ${SECRET}`);
        bridge.emit('task-event', taskId, { type: 'PLANNING_FAILED', error: `key ${SECRET}` });
      },
    });
    await create({ json: true, verbose: true });
    const outText = out.join('');
    const errText = err.join('');
    expect(outText).not.toContain(SECRET);
    expect(errText).not.toContain(SECRET);
    expect(outText + errText).toContain('[REDACTED]');
  });

  it('never removes a pre-existing spec folder on failure', async () => {
    const existing = path.join(specsRoot(), '001-existing');
    mkdirSync(existing, { recursive: true });
    writeFileSync(path.join(existing, 'spec.md'), '# Existing\n');
    scriptWorker({ code: 1, files: [] });
    const result = await create();
    expect(result.exitCode).toBe(1);
    expect(listSpecs()).toEqual(['001-existing']);
    expect(existsSync(path.join(existing, 'spec.md'))).toBe(true);
  });
});
