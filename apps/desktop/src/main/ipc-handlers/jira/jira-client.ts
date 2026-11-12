/**
 * Jira Cloud REST client helpers (import-only).
 * Auth: Basic (email + API token). Site is restricted to https://<sub>.atlassian.net.
 * Error messages never include the token or the Authorization header.
 */

import type { JiraIssue, JiraProject } from '../../../shared/types';
import { sanitizeText, stripControlChars } from '../shared/sanitize';

export type JiraIssueData = Omit<JiraIssue, 'alreadyImported' | 'existingSpecId'>;

export interface JiraIssueSearchPage {
  issues: JiraIssueData[];
  nextPageToken?: string;
  isLast: boolean;
}

const SITE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/;
const REQUEST_TIMEOUT_MS = 20000;
const KEY_CHUNK_SIZE = 50;
const MAX_PROJECT_PAGES = 20;
const ISSUE_FIELDS = 'summary,description,status,priority,issuetype,labels,assignee,created,updated';

export function normalizeJiraSiteUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (/[\s\\]/.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (!SITE_HOST_RE.test(parsed.hostname)) return null;
  return parsed.origin;
}

export function buildAuthHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf-8').toString('base64')}`;
}

export function isValidProjectKey(key: unknown): key is string {
  return typeof key === 'string' && PROJECT_KEY_RE.test(key);
}

export function isValidIssueKey(key: unknown): key is string {
  return typeof key === 'string' && ISSUE_KEY_RE.test(key);
}

export function escapeJqlText(text: string): string {
  return stripControlChars(text, false)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

export function buildSearchJql(opts: { projectKey: string; searchText?: string; keys?: string[] }): string {
  if (!isValidProjectKey(opts.projectKey)) {
    throw new Error('Invalid Jira project key');
  }
  const clauses = [`project = "${opts.projectKey}"`];
  const text = opts.searchText?.trim();
  if (text) {
    clauses.push(`text ~ "${escapeJqlText(text.slice(0, 200))}"`);
  }
  if (opts.keys && opts.keys.length > 0) {
    const keys = opts.keys.filter(isValidIssueKey);
    if (keys.length === 0) throw new Error('No valid Jira issue keys');
    clauses.push(`key in (${keys.map(k => `"${k}"`).join(', ')})`);
  }
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

// ============================================
// ADF -> Markdown
// ============================================

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

function applyMarks(text: string, marks: AdfNode['marks']): string {
  let result = text;
  for (const mark of marks ?? []) {
    switch (mark?.type) {
      case 'code':
        result = `\`${result}\``;
        break;
      case 'strong':
        result = `**${result}**`;
        break;
      case 'em':
        result = `*${result}*`;
        break;
      case 'link': {
        const href = mark.attrs?.href;
        if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
          result = `[${result}](${href})`;
        }
        break;
      }
      default:
        break;
    }
  }
  return result;
}

function inlineText(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(n => renderNode(n, 0)).join('');
}

function renderList(node: AdfNode, depth: number, ordered: boolean): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  (node.content ?? []).forEach((item, idx) => {
    const marker = ordered ? `${idx + 1}.` : '-';
    const parts = (item.content ?? []);
    const first: string[] = [];
    const nested: string[] = [];
    for (const child of parts) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        nested.push(renderList(child, depth + 1, child.type === 'orderedList'));
      } else {
        first.push(renderNode(child, depth).trim());
      }
    }
    lines.push(`${indent}${marker} ${first.join(' ')}`.trimEnd());
    lines.push(...nested);
  });
  return lines.join('\n');
}

function renderNode(node: AdfNode, depth: number): string {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'text':
      return applyMarks(typeof node.text === 'string' ? node.text : '', node.marks);
    case 'hardBreak':
      return '\n';
    case 'rule':
      return '---';
    case 'paragraph':
      return inlineText(node.content);
    case 'heading': {
      const raw = Number(node.attrs?.level);
      const level = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 6) : 1;
      return `${'#'.repeat(level)} ${inlineText(node.content)}`;
    }
    case 'bulletList':
      return renderList(node, depth, false);
    case 'orderedList':
      return renderList(node, depth, true);
    case 'listItem':
      return blockText(node.content, depth);
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' && /^[\w+-]{1,30}$/.test(node.attrs.language)
        ? node.attrs.language
        : '';
      const code = (node.content ?? []).map(n => (typeof n.text === 'string' ? n.text : '')).join('');
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case 'blockquote':
      return blockText(node.content, depth)
        .split('\n')
        .map(l => `> ${l}`.trimEnd())
        .join('\n');
    case 'mention': {
      const t = node.attrs?.text;
      return typeof t === 'string' ? t : '@user';
    }
    case 'inlineCard': {
      const url = node.attrs?.url;
      return typeof url === 'string' && /^https?:\/\//i.test(url) ? `<${url}>` : '';
    }
    default:
      // Unknown node: degrade to its text content
      if (typeof node.text === 'string') return node.text;
      return node.content ? blockText(node.content, depth) : '';
  }
}

function blockText(nodes: AdfNode[] | undefined, depth: number): string {
  return (nodes ?? [])
    .map(n => renderNode(n, depth))
    .filter(s => s !== '')
    .join('\n\n');
}

export function adfToMarkdown(adf: unknown): string {
  if (adf == null) return '';
  if (typeof adf === 'string') return adf;
  if (typeof adf !== 'object') return '';
  const root = adf as AdfNode;
  return blockText(root.type === 'doc' ? root.content : [root], 0).trim();
}

// ============================================
// HTTP
// ============================================

export class JiraAPIError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'JiraAPIError';
  }
}

export async function jiraFetch(
  siteUrl: string,
  email: string,
  token: string,
  apiPath: string,
  query?: Record<string, string | number | undefined>,
  options?: { method?: 'GET' | 'POST'; body?: unknown }
): Promise<unknown> {
  const site = normalizeJiraSiteUrl(siteUrl);
  if (!site) throw new JiraAPIError('Invalid Jira site URL. Use https://<name>.atlassian.net');

  const url = new URL(apiPath, site);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const hasBody = options?.body !== undefined;
  const headers: Record<string, string> = {
    Authorization: buildAuthHeader(email, token),
    Accept: 'application/json',
  };
  if (hasBody) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options?.method ?? 'GET',
      headers,
      ...(hasBody ? { body: JSON.stringify(options?.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new JiraAPIError('Jira request timed out');
    }
    throw new JiraAPIError('Could not reach Jira. Check the site URL and your network connection.');
  }

  if (!response.ok) {
    switch (response.status) {
      case 401:
      case 403:
        throw new JiraAPIError('Jira authentication failed. Check your email and API token.', response.status);
      case 404:
        throw new JiraAPIError('Jira resource not found. Check the site URL and project key.', 404);
      case 429:
        throw new JiraAPIError('Jira rate limit reached. Try again in a moment.', 429);
      default:
        throw new JiraAPIError(`Jira request failed (HTTP ${response.status})`, response.status);
    }
  }

  if (response.status === 204) return null;

  try {
    return await response.json();
  } catch {
    if (response.headers?.get?.('content-length') === '0') return null;
    throw new JiraAPIError('Jira returned an invalid response');
  }
}

// ============================================
// API operations
// ============================================

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, max: number): string {
  return sanitizeText(value, max);
}

export async function checkConnection(
  siteUrl: string,
  email: string,
  token: string
): Promise<{ userName: string; siteName: string }> {
  const data = asRecord(await jiraFetch(siteUrl, email, token, '/rest/api/3/myself'));
  const site = normalizeJiraSiteUrl(siteUrl) ?? '';
  return {
    userName: str(data.displayName, 200) || str(data.emailAddress, 200),
    siteName: site ? new URL(site).hostname : '',
  };
}

const MAX_COMMENT_CHARS = 30000;
const MAX_COMMENT_LINE_CHARS = 5000;

export function buildAdfComment(text: string): {
  version: 1;
  type: 'doc';
  content: Array<{ type: 'paragraph'; content: Array<{ type: 'text'; text: string }> }>;
} {
  const capped = stripControlChars(typeof text === 'string' ? text : '', true).slice(0, MAX_COMMENT_CHARS);
  const content = capped
    .split(/\r?\n/)
    .map(line => sanitizeText(line, MAX_COMMENT_LINE_CHARS))
    .filter(line => line.trim() !== '')
    .map(line => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] }));
  return { version: 1, type: 'doc', content };
}

export async function addIssueComment(
  siteUrl: string,
  email: string,
  token: string,
  issueKey: string,
  text: string
): Promise<void> {
  if (!isValidIssueKey(issueKey)) throw new JiraAPIError('Invalid Jira issue key');
  await jiraFetch(siteUrl, email, token, `/rest/api/3/issue/${issueKey}/comment`, undefined, {
    method: 'POST',
    body: { body: buildAdfComment(text) },
  });
}

export async function transitionIssue(
  siteUrl: string,
  email: string,
  token: string,
  issueKey: string,
  statusName: string
): Promise<{ transitioned: boolean; reason?: 'transition_not_available' }> {
  if (!isValidIssueKey(issueKey)) throw new JiraAPIError('Invalid Jira issue key');
  const data = asRecord(await jiraFetch(siteUrl, email, token, `/rest/api/3/issue/${issueKey}/transitions`));
  const target = String(statusName ?? '').trim().toLowerCase();
  const match = target
    ? (Array.isArray(data.transitions) ? data.transitions : [])
        .map(asRecord)
        .find(t => str(asRecord(t.to).name, 100).trim().toLowerCase() === target && str(t.id, 50))
    : undefined;
  if (!match) return { transitioned: false, reason: 'transition_not_available' };
  await jiraFetch(siteUrl, email, token, `/rest/api/3/issue/${issueKey}/transitions`, undefined, {
    method: 'POST',
    body: { transition: { id: str(match.id, 50) } },
  });
  return { transitioned: true };
}

export async function listProjects(siteUrl: string, email: string, token: string): Promise<JiraProject[]> {
  const projects: JiraProject[] = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
    const data = asRecord(
      await jiraFetch(siteUrl, email, token, '/rest/api/3/project/search', {
        startAt,
        maxResults: 50,
        orderBy: 'name',
      })
    );
    const values = Array.isArray(data.values) ? data.values : [];
    for (const v of values) {
      const p = asRecord(v);
      const key = str(p.key, 50);
      if (!isValidProjectKey(key)) continue;
      projects.push({ id: str(p.id, 50), key, name: str(p.name, 200) || key });
    }
    if (data.isLast === true || values.length === 0) break;
    startAt += values.length;
  }
  return projects;
}

function mapIssue(raw: unknown, siteUrl: string): JiraIssueData | null {
  const issue = asRecord(raw);
  const key = str(issue.key, 50);
  if (!isValidIssueKey(key)) return null;
  const f = asRecord(issue.fields);
  const status = asRecord(f.status);
  const statusCategory = asRecord(status.statusCategory);
  const assignee = asRecord(f.assignee);
  const priority = asRecord(f.priority);
  const labels = Array.isArray(f.labels)
    ? f.labels.map(l => str(l, 100)).filter(Boolean).slice(0, 50)
    : [];
  return {
    id: str(issue.id, 50),
    key,
    summary: str(f.summary, 500) || key,
    description: sanitizeText(adfToMarkdown(f.description), 50000, true),
    statusName: str(status.name, 100),
    statusCategory: str(statusCategory.key, 50),
    priorityName: str(priority.name, 100) || undefined,
    issueType: str(asRecord(f.issuetype).name, 100),
    labels,
    assigneeName: str(assignee.displayName, 200) || undefined,
    createdAt: str(f.created, 50),
    updatedAt: str(f.updated, 50),
    url: `${siteUrl}/browse/${key}`,
  };
}

export async function searchIssues(
  siteUrl: string,
  email: string,
  token: string,
  opts: { projectKey: string; searchText?: string; maxResults?: number; nextPageToken?: string }
): Promise<JiraIssueSearchPage> {
  const site = normalizeJiraSiteUrl(siteUrl);
  if (!site) throw new JiraAPIError('Invalid Jira site URL. Use https://<name>.atlassian.net');
  const data = asRecord(
    await jiraFetch(siteUrl, email, token, '/rest/api/3/search/jql', {
      jql: buildSearchJql({ projectKey: opts.projectKey, searchText: opts.searchText }),
      fields: ISSUE_FIELDS,
      maxResults: Math.min(Math.max(opts.maxResults ?? 50, 1), 100),
      nextPageToken: opts.nextPageToken,
    })
  );
  const issues = (Array.isArray(data.issues) ? data.issues : [])
    .map(i => mapIssue(i, site))
    .filter((i): i is JiraIssueData => i !== null);
  const nextPageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
  return { issues, nextPageToken, isLast: !nextPageToken };
}

export async function getIssuesByKeys(
  siteUrl: string,
  email: string,
  token: string,
  projectKey: string,
  keys: string[]
): Promise<JiraIssueData[]> {
  const site = normalizeJiraSiteUrl(siteUrl);
  if (!site) throw new JiraAPIError('Invalid Jira site URL. Use https://<name>.atlassian.net');
  const valid = [...new Set(keys.filter(isValidIssueKey))];
  const result: JiraIssueData[] = [];
  for (let i = 0; i < valid.length; i += KEY_CHUNK_SIZE) {
    const chunk = valid.slice(i, i + KEY_CHUNK_SIZE);
    const data = asRecord(
      await jiraFetch(siteUrl, email, token, '/rest/api/3/search/jql', {
        jql: buildSearchJql({ projectKey, keys: chunk }),
        fields: ISSUE_FIELDS,
        maxResults: chunk.length,
      })
    );
    for (const raw of Array.isArray(data.issues) ? data.issues : []) {
      const mapped = mapIssue(raw, site);
      if (mapped) result.push(mapped);
    }
  }
  return result;
}
