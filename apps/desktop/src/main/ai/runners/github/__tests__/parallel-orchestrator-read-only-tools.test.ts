/**
 * zeenha fork: the PR validator and specialists only ever bind Read, Glob and Grep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const streams = vi.hoisted(() => [] as Array<{ tools: Record<string, unknown>; messages: Array<{ content: string }> }>);

const overrideTools = vi.hoisted(() => ({ on: false }));
vi.mock('../../../config/agent-configs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../config/agent-configs')>();
  return {
    ...orig,
    getAgentConfig: (t: Parameters<typeof orig.getAgentConfig>[0]) => {
      const c = orig.getAgentConfig(t);
      return overrideTools.on ? { ...c, tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'] } : c;
    },
  };
});
vi.mock('../../../security/security-profile', () => ({ getSecurityProfile: () => ({}) }));
vi.mock('../../../tools/build-registry', () => ({
  buildToolRegistry: () => ({
    getTool: (name: string) => ({ bind: () => ({ name }) }),
  }),
}));
vi.mock('../../../prompts/prompt-loader', () => ({ loadPrompt: () => 'SYSTEM' }));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: async () => ({ model: { modelId: 'claude-sonnet-test' }, systemPrompt: 'SYSTEM', tools: {}, maxSteps: 10 }),
}));
vi.mock('../../../claude-code/sdk', () => ({
  streamText: (options: (typeof streams)[number]) => {
    streams.push(options);
    return {
      fullStream: (async function* () {
        yield* [];
      })(),
      output: Promise.resolve(options.messages[0].content.includes('Findings to Validate') ? { validations: [] } : { findings: [] }),
      text: Promise.resolve(''),
    };
  },
}));

import { ParallelOrchestratorReviewer } from '../parallel-orchestrator';

const context = {
  prNumber: 7, title: 'Escape output', description: '', author: 'a', baseBranch: 'main', headBranch: 'feature',
  changedFiles: [{ path: 'app.php', status: 'modified', additions: 1, deletions: 1, patch: '-return $unsafe;\n+return e($unsafe);' }],
  commits: [], diff: '', totalAdditions: 1, totalDeletions: 1,
} as never;
const finding = { id: 'f1', severity: 'high', category: 'security', title: 'XSS', description: 'd', file: 'app.php', line: 1 };

type Internals = { runFindingValidator: (...a: unknown[]) => Promise<unknown> };

const isValidator = (s: (typeof streams)[number]) => s.messages[0].content.includes('Findings to Validate');
const builtinKeys = (s: (typeof streams)[number]) => Object.keys(s.tools).filter((k) => !k.startsWith('mcp__')).sort();
const FORBIDDEN = ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'SpawnSubagent'];

function expectReadOnly(s: (typeof streams)[number]) {
  expect(builtinKeys(s)).toEqual(['Glob', 'Grep', 'Read']);
  for (const f of FORBIDDEN) expect(s.tools).not.toHaveProperty(f);
}

beforeEach(() => {
  streams.length = 0;
  overrideTools.on = false;
});

describe.each([
  ['with a review folder', { reviewDir: '/project/.auto-claude/pr-review/pr-7' }],
  ['without a review folder', {}],
])('PR review binds read-only tools (%s)', (_name, extra) => {
  const make = () => new ParallelOrchestratorReviewer({ repo: 'o/r', projectDir: '/project', ...extra });

  it('validator gets only Read, Glob, Grep', async () => {
    await (make() as unknown as Internals).runFindingValidator([finding], context, 'sonnet', 'medium');
    const v = streams.find(isValidator);
    expect(v).toBeDefined();
    expectReadOnly(v as (typeof streams)[number]);
  });

  it('every specialist gets only Read, Glob, Grep', async () => {
    await make().review(context);
    const specialists = streams.filter((s) => !isValidator(s));
    expect(specialists).toHaveLength(4);
    for (const s of specialists) expectReadOnly(s);
  });

  it('still read-only when the agent config lists write-capable tools', async () => {
    overrideTools.on = true;
    await (make() as unknown as Internals).runFindingValidator([finding], context, 'sonnet', 'medium');
    await make().review(context);
    expect(streams.length).toBe(5);
    for (const s of streams) expectReadOnly(s);
  });
});
