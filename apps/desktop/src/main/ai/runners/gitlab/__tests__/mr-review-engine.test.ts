/**
 * zeenha fork: MR reviews read the MR-head checkout with read-only tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StreamCall = {
  tools: Record<string, { name: string; cwd: string; projectDir: string }>;
  messages: Array<{ content: string }>;
  stopWhen: unknown;
};

const state = vi.hoisted(() => ({
  streams: [] as unknown[],
  generates: [] as unknown[],
  streamError: undefined as Error | undefined,
}));

const REVIEW_JSON = JSON.stringify({
  summary: 'Looks fine',
  verdict: 'needs_revision',
  verdict_reasoning: 'bug',
  findings: [
    { severity: 'high', category: 'quality', title: 'Null deref', description: 'd', file: 'a.ts', line: 3, fixable: false },
  ],
});

vi.mock('../../../tools/build-registry', () => ({
  buildToolRegistry: () => ({
    getTool: (name: string) => ({
      bind: (ctx: { cwd: string; projectDir: string }) => ({ name, cwd: ctx.cwd, projectDir: ctx.projectDir }),
    }),
  }),
}));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: async () => ({ model: { modelId: 'test' }, systemPrompt: 'SYSTEM', tools: {}, maxSteps: 10 }),
}));
vi.mock('../../../claude-code/sdk', () => ({
  streamText: (options: unknown) => {
    state.streams.push(options);
    if (state.streamError) throw state.streamError;
    return {
      fullStream: (async function* () {
        yield* [];
      })(),
      text: Promise.resolve(REVIEW_JSON),
    };
  },
}));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: async (options: unknown) => {
    state.generates.push(options);
    return { text: REVIEW_JSON };
  },
}));

import { MRReviewEngine, type MRContext } from '../mr-review-engine';

const context: MRContext = {
  mrIid: 5,
  title: 'Fix',
  description: 'desc',
  author: 'a',
  sourceBranch: 'feat',
  targetBranch: 'main',
  changedFiles: [{ new_path: 'a.ts' }],
  diff: '+x',
  totalAdditions: 1,
  totalDeletions: 0,
};

const headCheckout = {
  kind: 'pr-head' as const,
  dir: '/project/.auto-claude/pr-review/mr-5-abcdef12-x',
  sha: 'abcdef1234567890abcdef1234567890abcdef12',
  cleanup: async () => undefined,
};

beforeEach(() => {
  state.streams.length = 0;
  state.generates.length = 0;
  state.streamError = undefined;
});

describe('MRReviewEngine.runReview', () => {
  it('runs a read-only tool loop over the MR-head checkout', async () => {
    const result = await new MRReviewEngine({}).runReview(context, undefined, { checkout: headCheckout });

    expect(state.generates).toHaveLength(0);
    expect(state.streams).toHaveLength(1);
    const call = state.streams[0] as StreamCall;
    expect(Object.keys(call.tools).sort()).toEqual(['Glob', 'Grep', 'Read']);
    for (const t of Object.values(call.tools)) {
      expect(t.cwd).toBe(headCheckout.dir);
      expect(t.projectDir).toBe(headCheckout.dir);
    }
    expect(call.messages[0].content).toContain("checkout of this MR's head commit (abcdef123456)");
    expect(call.stopWhen).toBeDefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('Null deref');
    expect(result.verdict).toBe('needs_revision');
    expect(result.blockers).toHaveLength(1);
  });

  it.each([
    ['no options', undefined],
    ['a base checkout', { checkout: { kind: 'base' as const, reason: 'fetch failed' } }],
  ])('uses single-pass generateText with %s', async (_label, options) => {
    const progress: string[] = [];
    const result = await new MRReviewEngine({}, (u) => progress.push(u.message)).runReview(context, undefined, options);

    expect(state.streams).toHaveLength(0);
    expect(state.generates).toHaveLength(1);
    const call = state.generates[0] as { prompt: string; tools?: unknown };
    expect(call.tools).toBeUndefined();
    expect(call.prompt).not.toContain('## Files you can read');
    expect(result.findings).toHaveLength(1);
    if (options) expect(progress.some((m) => m.includes('fetch failed'))).toBe(true);
  });

  it('merges MCP tools under the built-in read tools', async () => {
    const mcpTool = { name: 'mcp-x' };
    const toolsFor = vi.fn(async () => ({
      Read: { name: 'mcp-read' },
      Glob: { name: 'mcp-glob' },
      Grep: { name: 'mcp-grep' },
      lookup: mcpTool,
    }));
    const progress: string[] = [];
    await new MRReviewEngine({}, (u) => progress.push(u.message)).runReview(context, undefined, {
      checkout: headCheckout,
      mcp: { toolsFor, close: async () => undefined } as never,
    });

    expect(toolsFor).toHaveBeenCalledWith('pr_reviewer');
    const call = state.streams[0] as StreamCall;
    expect(Object.keys(call.tools).sort()).toEqual(['Glob', 'Grep', 'Read', 'lookup']);
    expect(call.tools.Read.name).toBe('Read');
    expect(call.tools.Glob.name).toBe('Glob');
    expect(call.tools.Grep.name).toBe('Grep');
    expect(call.tools.lookup).toBe(mcpTool);
    expect(progress.some((m) => m.includes('lookup'))).toBe(true);
  });

  it('never asks MCP for tools with a base checkout', async () => {
    const toolsFor = vi.fn(async () => ({ lookup: { name: 'mcp-x' } }));
    await new MRReviewEngine({}).runReview(context, undefined, {
      checkout: { kind: 'base' as const, reason: 'fetch failed' },
      mcp: { toolsFor, close: async () => undefined } as never,
    });

    expect(toolsFor).not.toHaveBeenCalled();
    expect(state.streams).toHaveLength(0);
  });

  it('wraps a streamText failure', async () => {
    state.streamError = new Error('boom');
    await expect(
      new MRReviewEngine({}).runReview(context, undefined, { checkout: headCheckout }),
    ).rejects.toThrow('MR review failed: boom');
  });
});
