/**
 * zeenha fork: persistent store for user approvals of project-declared webhook
 * URLs (see project-webhook-approval.ts). Own file in userData, never inside
 * the repository (a hostile repo could pre-approve) and not in settings.json.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { WebhookApprovals } from './project-webhook-approval';

interface ApprovalFile {
  version: 1;
  projects: Record<string, WebhookApprovals>;
}

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'webhook-approvals.json');
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))];
}

function readFile(): ApprovalFile {
  const empty: ApprovalFile = { version: 1, projects: {} };
  try {
    const storePath = getStorePath();
    if (!existsSync(storePath)) return empty;
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.projects || typeof parsed.projects !== 'object') {
      return empty;
    }
    const projects: Record<string, WebhookApprovals> = {};
    for (const [key, value] of Object.entries(parsed.projects as Record<string, Record<string, unknown>>)) {
      if (!value || typeof value !== 'object') continue;
      projects[key] = { urls: stringList(value.urls) };
    }
    return { version: 1, projects };
  } catch {
    // Missing or corrupt: nothing is approved (fail closed)
    return empty;
  }
}

function writeFile(data: ApprovalFile): void {
  const storePath = getStorePath();
  mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, storePath);
}

function update(projectPath: string, mutate: (a: WebhookApprovals) => void): void {
  const data = readFile();
  const key = path.resolve(projectPath);
  const current = data.projects[key] ?? { urls: [] };
  mutate(current);
  current.urls = [...new Set(current.urls)];
  data.projects[key] = current;
  writeFile(data);
}

export function getWebhookApprovals(projectPath: string): WebhookApprovals {
  const found = readFile().projects[path.resolve(projectPath)];
  return found ? { urls: [...found.urls] } : { urls: [] };
}

export function approveWebhookUrlHash(projectPath: string, hash: string): void {
  update(projectPath, (a) => {
    a.urls.push(hash);
  });
}

export function removeWebhookUrlApproval(projectPath: string, hash: string): void {
  update(projectPath, (a) => {
    a.urls = a.urls.filter((h) => h !== hash);
  });
}
