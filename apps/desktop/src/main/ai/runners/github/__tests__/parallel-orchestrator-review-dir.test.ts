/**
 * zeenha fork: the reviewers' tools read the PR-head checkout, not the base
 * branch in the project folder, and carry the project's MCP tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const streams = vi.hoisted(() => [] as Array<{ tools: Record<string, { cwd?: string }>; messages: Array<{ content: string }> }>);

vi.mock('../../../security/security-profile', () => ({ getSecurityProfile: () => ({}) }));
vi.mock('../../../tools/build-registry', () => ({
  buildToolRegistry: () => ({
    getTool: (name: string) => ({ bind: (ctx: { cwd: string; projectDir: string }) => ({ name, cwd: ctx.cwd, projectDir: ctx.projectDir }) }),
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
import type { PRReviewMcpSession } from '../pr-review-mcp';

const context = {
  prNumber: 7, title: 'Escape output', description: '', author: 'a', baseBranch: 'main', headBranch: 'feature',
  changedFiles: [{ path: 'app.php', status: 'modified', additions: 1, deletions: 1, patch: '-return $unsafe;\n+return e($unsafe);' }],
  commits: [], diff: '', totalAdditions: 1, totalDeletions: 1,
} as never;

beforeEach(() => {
  streams.length = 0;
});

type Internals = { runFindingValidator: (...a: unknown[]) => Promise<unknown> };

describe('PR review reads the PR checkout', () => {
  const toolsFor = vi.fn(async (agentType: string) => ({ [`mcp__github__${agentType}`]: { cwd: 'github' } }));
  const mcp = { toolsFor, close: vi.fn() } as unknown as PRReviewMcpSession;

  it("binds every specialist's tools to the review folder, adds its MCP tools and the checkout note", async () => {
    const reviewer = new ParallelOrchestratorReviewer({
      repo: 'o/r', projectDir: '/project', reviewDir: '/project/.auto-claude/pr-review/pr-7', checkoutNote: 'CHECKOUT NOTE', mcp,
    });

    await reviewer.review(context);

    const specialists = streams.filter((s) => !s.messages[0].content.includes('Findings to Validate'));
    expect(specialists).toHaveLength(4);
    for (const s of specialists) {
      const builtin = Object.values(s.tools).filter((t) => t.cwd !== 'github');
      expect(builtin.length).toBeGreaterThan(0);
      for (const t of builtin) expect(t).toMatchObject({ cwd: '/project/.auto-claude/pr-review/pr-7', projectDir: '/project/.auto-claude/pr-review/pr-7' });
      expect(Object.keys(s.tools).some((k) => k.startsWith('mcp__github__pr_'))).toBe(true);
      expect(s.messages[0].content).toContain('CHECKOUT NOTE');
    }
    expect(toolsFor.mock.calls.map((c) => c[0]).sort()).toEqual([
      'pr_codebase_fit_specialist', 'pr_logic_specialist', 'pr_quality_specialist', 'pr_security_specialist',
    ]);
  });

  it('gives the finding validator the same folder, MCP tools and note', async () => {
    const reviewer = new ParallelOrchestratorReviewer({
      repo: 'o/r', projectDir: '/project', reviewDir: '/project/.auto-claude/pr-review/pr-7', checkoutNote: 'CHECKOUT NOTE', mcp,
    });
    const finding = { id: 'f1', severity: 'high', category: 'security', title: 'XSS', description: 'd', file: 'app.php', line: 1 };

    await (reviewer as unknown as Internals).runFindingValidator([finding], context, 'sonnet', 'medium');

    const validator = streams.find((s) => s.messages[0].content.includes('Findings to Validate'));
    expect(validator).toBeDefined();
    const builtin = Object.entries(validator?.tools ?? {}).filter(([k]) => !k.startsWith('mcp__'));
    expect(builtin.length).toBeGreaterThan(0);
    for (const [, t] of builtin) expect(t.cwd).toBe('/project/.auto-claude/pr-review/pr-7');
    expect(validator?.tools).toHaveProperty('mcp__github__pr_finding_validator');
    expect(validator?.messages[0].content).toContain('CHECKOUT NOTE');
  });

  it('reads the project folder when there is no review folder (upstream behaviour)', async () => {
    await new ParallelOrchestratorReviewer({ repo: 'o/r', projectDir: '/project' }).review(context);
    for (const s of streams) {
      for (const t of Object.values(s.tools)) expect(t.cwd).toBe('/project');
    }
  });
});
