import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import { fetchBitbucketPRContext, splitDiffByFile, MAX_DIFF_CHARS } from '../review-context';

const config = { username: 'alice', token: 'tok', repository: 'ws/repo' };
const API = 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/5';

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function mockFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const key = Object.keys(routes)
        .sort((x, y) => y.length - x.length)
        .find((k) => url === k || url.startsWith(`${k}?`) || url.startsWith(k));
      if (!key) throw new Error(`unexpected url ${url}`);
      return routes[key]();
    })
  );
  return calls;
}

const pr = {
  id: 5,
  title: 'T',
  description: 'D',
  state: 'OPEN',
  author: { display_name: 'Alice' },
  source: {
    branch: { name: 'feat' },
    commit: { hash: 'abc123' },
    repository: { full_name: 'fork/repo' }
  },
  destination: { branch: { name: 'main' }, commit: { hash: 'def456' } }
};

const diff =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+x\n' +
  'diff --git a/new.ts b/new.ts\nnew file mode 100644\n+y\n';

afterEach(() => vi.unstubAllGlobals());

describe('splitDiffByFile', () => {
  it('splits per file', () => {
    const m = splitDiffByFile(diff);
    expect([...m.keys()]).toEqual(['a.ts', 'new.ts']);
    expect(m.get('new.ts')).toContain('+y');
    expect(m.get('a.ts')).not.toContain('+y');
  });
  it('handles empty diff', () => {
    expect(splitDiffByFile('').size).toBe(0);
  });
});

describe('fetchBitbucketPRContext', () => {
  it('builds context with patches, totals and pagination', async () => {
    mockFetch({
      [API]: () => jsonRes(pr),
      [`${API}/diff`]: () => new Response(diff),
      [`${API}/diffstat?page=2`]: () =>
        jsonRes({ values: [{ status: 'added', lines_added: 3, lines_removed: 0, new: { path: 'new.ts' } }] }),
      [`${API}/diffstat`]: () =>
        jsonRes({
          values: [{ status: 'modified', lines_added: 1, lines_removed: 2, old: { path: 'a.ts' }, new: { path: 'a.ts' } }],
          next: `${API}/diffstat?page=2`
        }),
      [`${API}/commits`]: () => jsonRes({ values: [{ hash: 'abc123', message: 'hi\nbody', date: 'd' }] })
    });
    const r = await fetchBitbucketPRContext(config, 5);
    expect(r.headSha).toBe('abc123');
    expect(r.sourceBranch).toBe('feat');
    expect(r.sourceRepository).toBe('fork/repo');
    expect(r.context.author).toBe('Alice');
    expect(r.context.baseBranch).toBe('main');
    expect(r.context.headBranch).toBe('feat');
    expect(r.context.totalAdditions).toBe(4);
    expect(r.context.totalDeletions).toBe(2);
    expect(r.context.changedFiles.map((f) => [f.path, f.status])).toEqual([
      ['a.ts', 'modified'],
      ['new.ts', 'added']
    ]);
    expect(r.context.changedFiles[1].patch).toContain('+y');
    expect(r.context.diffTruncated).toBe(false);
    expect(r.context.commits[0]).toMatchObject({ oid: 'abc123', messageHeadline: 'hi' });
    expect(r.context.labels).toEqual([]);
    expect(r.context.aiBotComments).toEqual([]);
  });

  it('truncates oversized diffs', async () => {
    mockFetch({
      [API]: () => jsonRes(pr),
      [`${API}/diff`]: () => new Response('x'.repeat(MAX_DIFF_CHARS + 10)),
      [`${API}/diffstat`]: () => jsonRes({ values: [] }),
      [`${API}/commits`]: () => jsonRes({ values: [] })
    });
    const r = await fetchBitbucketPRContext(config, 5);
    expect(r.context.diffTruncated).toBe(true);
    expect(r.context.diff.length).toBe(MAX_DIFF_CHARS);
  });

  it('ignores a next link to a foreign origin', async () => {
    const calls = mockFetch({
      [API]: () => jsonRes(pr),
      [`${API}/diff`]: () => new Response(diff),
      [`${API}/diffstat`]: () => jsonRes({ values: [], next: 'https://evil.example/x' }),
      [`${API}/commits`]: () => jsonRes({ values: [] })
    });
    await fetchBitbucketPRContext(config, 5);
    expect(calls.some((c) => c.includes('evil.example'))).toBe(false);
  });

  it('throws when the source commit hash is missing', async () => {
    mockFetch({ [API]: () => jsonRes({ ...pr, source: { branch: { name: 'feat' } } }) });
    await expect(fetchBitbucketPRContext(config, 5)).rejects.toThrow(/no source commit hash/);
  });
});
