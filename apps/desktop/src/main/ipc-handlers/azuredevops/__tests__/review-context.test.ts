import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import { fetchAzureDevOpsPRContext, splitDiffByFile, MAX_DIFF_CHARS } from '../review-context';

const config = { organization: 'org', project: 'proj', repository: 'repo', pat: 'pat' };
const REPO = 'https://dev.azure.com/org/proj/_apis/git/repositories/repo';
const PR = `${REPO}/pullrequests/5`;

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const textRes = (body: string) => new Response(body, { status: 200 });
const notFound = () => new Response('nf', { status: 404 });

function mockFetch(handler: (url: string) => Response | undefined) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const res = handler(url);
      if (!res) throw new Error(`unexpected url ${url}`);
      return res;
    })
  );
  return calls;
}

const pr = {
  pullRequestId: 5,
  title: 'T',
  description: 'D',
  status: 'active',
  sourceRefName: 'refs/heads/feat',
  targetRefName: 'refs/heads/main',
  createdBy: { displayName: 'Alice' }
};

const iterations = {
  value: [
    { id: 1, sourceRefCommit: { commitId: 'old' }, commonRefCommit: { commitId: 'b0' } },
    { id: 2, sourceRefCommit: { commitId: 'head2' }, commonRefCommit: { commitId: 'base2' } }
  ]
};

const commits = {
  value: [{ commitId: 'c1', comment: 'first\nbody', committer: { date: '2024-01-01T00:00:00Z' } }]
};

function itemUrl(path: string, sha: string) {
  return (u: string) =>
    u.includes(`/items?path=${encodeURIComponent(path)}`) && u.includes(`versionDescriptor.version=${sha}`);
}

afterEach(() => vi.unstubAllGlobals());

describe('splitDiffByFile', () => {
  it('splits per file', () => {
    const m = splitDiffByFile('diff --git a/a b/a\n+x\ndiff --git a/b b/b\n+y\n');
    expect([...m.keys()]).toEqual(['a', 'b']);
    expect(m.get('b')).toContain('+y');
  });
  it('handles empty diff', () => {
    expect(splitDiffByFile('').size).toBe(0);
  });
});

describe('fetchAzureDevOpsPRContext', () => {
  function routes(changePages: Array<{ changeEntries: unknown[]; nextSkip?: number }>, bigText?: string) {
    return (url: string) => {
      if (url.startsWith(`${PR}/iterations/2/changes`)) {
        const skip = Number(/\$skip=(\d+)/.exec(url)?.[1] ?? 0);
        return jsonRes(changePages[skip === 0 ? 0 : 1]);
      }
      if (url.startsWith(`${PR}/iterations`)) return jsonRes(iterations);
      if (url.startsWith(`${PR}/commits`)) return jsonRes(commits);
      if (url.startsWith(PR)) return jsonRes(pr);
      if (itemUrl('/src/a.ts', 'base2')(url)) return textRes('a\nb\nc\n');
      if (itemUrl('/src/a.ts', 'head2')(url)) return textRes(bigText ?? 'a\nB\nc\n');
      if (itemUrl('/src/new.ts', 'head2')(url)) return textRes('n\n');
      if (itemUrl('/src/new.ts', 'base2')(url)) return notFound();
      if (itemUrl('/src/gone.ts', 'base2')(url)) return textRes('g\n');
      if (itemUrl('/src/gone.ts', 'head2')(url)) return notFound();
      return undefined;
    };
  }

  const pages = [
    {
      changeEntries: [
        { changeType: 'edit', item: { path: '/src/a.ts' } },
        { changeType: 'edit', item: { path: '/src', isFolder: true } }
      ],
      nextSkip: 100
    },
    {
      changeEntries: [
        { changeType: 'add', item: { path: '/src/new.ts' } },
        { changeType: 'delete', item: { path: '/src/gone.ts' } }
      ]
    }
  ];

  it('builds context from iterations, changes, items and commits', async () => {
    const calls = mockFetch(routes(pages));
    const r = await fetchAzureDevOpsPRContext(config, 5);

    expect(r.headSha).toBe('head2');
    expect(r.sourceBranch).toBe('feat');
    expect(r.forkSource).toBeUndefined();
    const c = r.context;
    expect(c.author).toBe('Alice');
    expect(c.baseBranch).toBe('main');
    expect(c.headBranch).toBe('feat');
    expect(c.state).toBe('OPEN');
    expect(c.changedFiles.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/new.ts', 'added'],
      ['src/gone.ts', 'removed']
    ]);
    expect(c.changedFiles[0].patch).toContain('-b\n+B');
    expect(c.totalAdditions).toBe(2);
    expect(c.totalDeletions).toBe(2);
    expect(c.diffTruncated).toBe(false);
    expect(c.commits).toEqual([
      { oid: 'c1', messageHeadline: 'first', committedDate: '2024-01-01T00:00:00Z' }
    ]);
    expect(calls.some((u) => u.includes('/iterations/2/changes') && u.includes('$skip=100'))).toBe(true);
    expect(calls.some((u) => u.includes('src%2Fsrc'))).toBe(false);
  });

  it('truncates diff but keeps full per-file patches', async () => {
    const big = `${'x'.repeat(100)}\n`.repeat(2500);
    mockFetch(routes(pages, big));
    const r = await fetchAzureDevOpsPRContext(config, 5);
    expect(r.context.diffTruncated).toBe(true);
    expect(r.context.diff.length).toBe(MAX_DIFF_CHARS);
    expect(r.context.changedFiles[0].patch?.length).toBeGreaterThan(0);
  });

  it('flags fork sources', async () => {
    const base = routes(pages);
    mockFetch((u) => (u === PR || u.startsWith(`${PR}?`) ? jsonRes({ ...pr, forkSource: { repository: { id: 'x' } } }) : base(u)));
    const r = await fetchAzureDevOpsPRContext(config, 5);
    expect(r.forkSource).toBe(true);
  });
});
