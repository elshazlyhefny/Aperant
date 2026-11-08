/**
 * zeenha fork: persistent store for user approvals of project-declared MCP
 * launches (see ai/mcp/mcp-approval.ts). Kept in its own file in userData, NOT
 * in settings.json (renderer settings saves rewrite that file and could drop
 * approvals) and never inside the repository (a hostile repo could pre-approve).
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { McpApprovals } from './ai/mcp/mcp-approval';

interface ApprovalFile {
  version: 1;
  projects: Record<string, McpApprovals>;
}

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'mcp-approvals.json');
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
    const projects: Record<string, McpApprovals> = {};
    for (const [key, value] of Object.entries(parsed.projects as Record<string, Record<string, unknown>>)) {
      if (!value || typeof value !== 'object') continue;
      projects[key] = { servers: stringList(value.servers), chromeExecutables: stringList(value.chromeExecutables) };
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

function update(projectPath: string, mutate: (a: McpApprovals) => void): void {
  const data = readFile();
  const key = path.resolve(projectPath);
  const current = data.projects[key] ?? { servers: [], chromeExecutables: [] };
  mutate(current);
  current.servers = [...new Set(current.servers)];
  current.chromeExecutables = [...new Set(current.chromeExecutables)];
  data.projects[key] = current;
  writeFile(data);
}

export function getApprovals(projectPath: string): McpApprovals {
  const found = readFile().projects[path.resolve(projectPath)];
  return found
    ? { servers: [...found.servers], chromeExecutables: [...found.chromeExecutables] }
    : { servers: [], chromeExecutables: [] };
}

export function approveServer(projectPath: string, hash: string): void {
  update(projectPath, (a) => {
    a.servers.push(hash);
  });
}

export function approveChromeExecutable(projectPath: string, exePath: string): void {
  update(projectPath, (a) => {
    a.chromeExecutables.push(exePath);
  });
}

export function removeServerApproval(projectPath: string, hash: string): void {
  update(projectPath, (a) => {
    a.servers = a.servers.filter((h) => h !== hash);
  });
}

export function removeChromeExecutableApproval(projectPath: string, exePath: string): void {
  update(projectPath, (a) => {
    a.chromeExecutables = a.chromeExecutables.filter((p) => p !== exePath);
  });
}
