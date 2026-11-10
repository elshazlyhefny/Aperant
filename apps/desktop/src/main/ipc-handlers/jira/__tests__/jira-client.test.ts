import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  normalizeJiraSiteUrl,
  buildAuthHeader,
  isValidProjectKey,
  isValidIssueKey,
  escapeJqlText,
  buildSearchJql,
  adfToMarkdown,
  jiraFetch,
  checkConnection,
  searchIssues,
  getIssuesByKeys,
} from '../jira-client';
import { findExistingJiraSpecs, createSpecFromJiraIssue } from '../jira-spec';

const TOKEN = 'SECRET-TOKEN-123';

describe('normalizeJiraSiteUrl', () => {
  it('accepts bare host and https origin', () => {
    expect(normalizeJiraSiteUrl('acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeJiraSiteUrl('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net');
  });
  it.each([
    'http://acme.atlassian.net',
    'https://evil.com',
    'evil.com',
    'acme.atlassian.net.evil.com',
    'https://user:pass@acme.atlassian.net',
    'https://acme.atlassian.net/path',
    'https://acme.atlassian.net:8443',
    'https://evil.com/@acme.atlassian.net',
    'ftp://acme.atlassian.net',
    '',
  ])('rejects %s', (input) => {
    expect(normalizeJiraSiteUrl(input)).toBeNull();
  });
  it('rejects non-strings', () => {
    expect(normalizeJiraSiteUrl(undefined)).toBeNull();
  });
});

describe('keys, auth and JQL', () => {
  it('builds basic auth header', () => {
    expect(buildAuthHeader('a@b.c', 't')).toBe(`Basic ${Buffer.from('a@b.c:t').toString('base64')}`);
  });
  it('validates keys', () => {
    expect(isValidProjectKey('PROJ')).toBe(true);
    expect(isValidProjectKey('proj')).toBe(false);
    expect(isValidProjectKey('P" OR 1=1')).toBe(false);
    expect(isValidIssueKey('PROJ-123')).toBe(true);
    expect(isValidIssueKey('PROJ-0')).toBe(false);
    expect(isValidIssueKey('PROJ-1" OR "a')).toBe(false);
  });
  it('escapes JQL text', () => {
    expect(escapeJqlText('a "b" \\c')).toBe('a \\"b\\" \\\\c');
  });
  it('builds JQL', () => {
    expect(buildSearchJql({ projectKey: 'PROJ' })).toBe('project = "PROJ" ORDER BY updated DESC');
    expect(buildSearchJql({ projectKey: 'PROJ', searchText: 'say "hi"' })).toContain('text ~ "say \\"hi\\""');
    const jql = buildSearchJql({ projectKey: 'PROJ', keys: ['PROJ-1', 'bad', 'PROJ-2'] });
    expect(jql).toContain('key in ("PROJ-1", "PROJ-2")');
    expect(() => buildSearchJql({ projectKey: 'bad"' })).toThrow();
  });
});

describe('adfToMarkdown', () => {
  const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, marks });
  it('handles marks, headings and paragraphs', () => {
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
        {
          type: 'paragraph',
          content: [
            text('bold', [{ type: 'strong' }]),
            text(' '),
            text('it', [{ type: 'em' }]),
            text(' '),
            text('c', [{ type: 'code' }]),
            text(' '),
            text('l', [{ type: 'link', attrs: { href: 'https://x.io' } }]),
            { type: 'hardBreak' },
            { type: 'mention', attrs: { text: '@bob' } },
          ],
        },
        { type: 'rule' },
      ],
    });
    expect(md).toContain('## Title');
    expect(md).toContain('**bold** *it* `c` [l](https://x.io)\n@bob');
    expect(md).toContain('---');
  });
  it('handles nested lists', () => {
    const li = (t: string, nested?: unknown) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [text(t)] }, ...(nested ? [nested] : [])],
    });
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [li('a', { type: 'orderedList', content: [li('a1'), li('a2')] }), li('b')],
        },
      ],
    });
    expect(md).toBe('- a\n  1. a1\n  2. a2\n- b');
  });
  it('handles code blocks, quotes, cards and unknown nodes', () => {
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('let a = 1;')] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [text('quoted')] }] },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://x.io/a' } }] },
        { type: 'panel', content: [{ type: 'paragraph', content: [text('inside panel')] }] },
      ],
    });
    expect(md).toContain('```ts\nlet a = 1;\n```');
    expect(md).toContain('> quoted');
    expect(md).toContain('<https://x.io/a>');
    expect(md).toContain('inside panel');
  });
  it('ignores unsafe link hrefs and bad input', () => {
    expect(adfToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])] }] })).toBe('x');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(42)).toBe('');
  });
});

describe('jiraFetch error mapping', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown = {}) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body }));

  it.each([
    [401, /authentication failed/i],
    [403, /authentication failed/i],
    [404, /not found/i],
    [429, /rate limit/i],
    [500, /HTTP 500/],
  ])('maps status %i', async (status, re) => {
    stub(status);
    const err = await jiraFetch('acme.atlassian.net', 'a@b.c', TOKEN, '/rest/api/3/myself').catch((e: Error) => e) as Error;
    expect(err.message).toMatch(re);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('Authorization');
  });

  it('does not leak token on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`boom ${TOKEN}`)));
    const err = await jiraFetch('acme.atlassian.net', 'a@b.c', TOKEN, '/x').catch((e: Error) => e) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it('sends auth and accept headers and rejects bad sites without fetching', async () => {
    stub(200, { displayName: 'Ann' });
    const res = await checkConnection('acme.atlassian.net', 'a@b.c', TOKEN);
    expect(res).toEqual({ userName: 'Ann', siteName: 'acme.atlassian.net' });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/myself');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers.Authorization).toBe(buildAuthHeader('a@b.c', TOKEN));
    await expect(jiraFetch('evil.com', 'a', 'b', '/x')).rejects.toThrow(/Invalid Jira site/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps issues from search and chunks key lookups', async () => {
    const issue = (n: number) => ({
      id: String(n),
      key: `PROJ-${n}`,
      fields: {
        summary: 'S',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }] },
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        priority: { name: 'High' },
        issuetype: { name: 'Bug' },
        labels: ['x'],
        assignee: { displayName: 'Bob' },
      },
    });
    stub(200, { issues: [issue(1)], nextPageToken: 'tok' });
    const page = await searchIssues('acme.atlassian.net', 'a', 'b', { projectKey: 'PROJ' });
    expect(page.nextPageToken).toBe('tok');
    expect(page.isLast).toBe(false);
    expect(page.issues[0]).toMatchObject({ key: 'PROJ-1', description: 'desc', url: 'https://acme.atlassian.net/browse/PROJ-1', issueType: 'Bug' });

    stub(200, { issues: [] });
    const keys = Array.from({ length: 120 }, (_, i) => `PROJ-${i + 1}`);
    await getIssuesByKeys('acme.atlassian.net', 'a', 'b', 'PROJ', [...keys, 'bad key']);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('jira spec files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'jira-spec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const issue = {
    id: '10001',
    key: 'PROJ-7',
    summary: 'Fix login',
    description: 'Body\x00text',
    statusName: 'To Do',
    statusCategory: 'new',
    priorityName: 'High',
    issueType: 'Bug',
    labels: ['a', 'b'],
    createdAt: '',
    updatedAt: '',
    url: '',
  };

  it('creates spec files in next numbered dir', () => {
    mkdirSync(path.join(dir, '003-existing'));
    const res = createSpecFromJiraIssue(dir, 'acme.atlassian.net', issue);
    expect(res.specId).toMatch(/^004-fix-login/);
    for (const f of ['implementation_plan.json', 'requirements.json', 'task_metadata.json']) {
      expect(existsSync(path.join(res.specDir, f))).toBe(true);
    }
    expect(res.description).toContain('**Jira Issue:** [PROJ-7](https://acme.atlassian.net/browse/PROJ-7)');
    expect(res.description).toContain('**Labels:** a, b');
    expect(res.description).toContain('Bodytext');
    const meta = JSON.parse(readFileSync(path.join(res.specDir, 'task_metadata.json'), 'utf-8'));
    expect(meta).toMatchObject({
      sourceType: 'jira',
      jiraIssueKey: 'PROJ-7',
      jiraIssueId: '10001',
      jiraSiteUrl: 'https://acme.atlassian.net',
      jiraUrl: 'https://acme.atlassian.net/browse/PROJ-7',
      category: 'bug_fix',
    });
  });

  it('uses feature category for non-bugs and sanitizes malicious titles', () => {
    const res = createSpecFromJiraIssue(dir, 'acme.atlassian.net', {
      ...issue,
      issueType: 'Story',
      summary: '../../etc/passwd\x00\x1b[31m',
    });
    expect(res.metadata.category).toBe('feature');
    expect(res.specDir.startsWith(dir + path.sep)).toBe(true);
    expect(path.dirname(res.specDir)).toBe(dir);
    expect(res.description).not.toContain('\x00');
    expect(res.description).not.toContain('\x1b');
  });

  it('rejects invalid keys and sites', () => {
    expect(() => createSpecFromJiraIssue(dir, 'evil.com', issue)).toThrow();
    expect(() => createSpecFromJiraIssue(dir, 'acme.atlassian.net', { ...issue, key: 'x/../y' })).toThrow();
  });

  it('finds existing specs, tolerating bad files', () => {
    const a = createSpecFromJiraIssue(dir, 'acme.atlassian.net', issue);
    const other = createSpecFromJiraIssue(dir, 'other.atlassian.net', { ...issue, key: 'PROJ-8' });
    mkdirSync(path.join(dir, '900-bad'));
    writeFileSync(path.join(dir, '900-bad', 'task_metadata.json'), '{not json');
    mkdirSync(path.join(dir, '901-empty'));
    writeFileSync(path.join(dir, 'file.txt'), 'x');
    const map = findExistingJiraSpecs(dir, 'https://acme.atlassian.net/');
    expect(map.get('PROJ-7')).toBe(a.specId);
    expect(map.has('PROJ-8')).toBe(false);
    expect(other.specId).toBeTruthy();
    expect(findExistingJiraSpecs(path.join(dir, 'missing'), 'acme.atlassian.net').size).toBe(0);
  });
});
