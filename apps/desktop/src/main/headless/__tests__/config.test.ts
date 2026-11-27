import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHeadlessConfig, mcpOptionsForHeadless, resolveProjectSettings } from '../config';
import { hashMcpServer } from '../../ai/mcp/mcp-approval';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'headless-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadHeadlessConfig', () => {
  it('returns defaults without a path', () => {
    expect(loadHeadlessConfig()).toEqual({});
  });

  it('parses a valid file', () => {
    const file = path.join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ globalPriorityOrder: ['a'], project: { mainBranch: 'dev', pushNewBranches: false } }));
    const config = loadHeadlessConfig(file);
    expect(config.globalPriorityOrder).toEqual(['a']);
    expect(config.project?.mainBranch).toBe('dev');
    expect(config.project?.pushNewBranches).toBe(false);
  });

  it('parses the webhook section without validating the url', () => {
    const file = path.join(dir, 'w.json');
    writeFileSync(file, JSON.stringify({ webhook: { url: 'not a url', events: { failed: false, prOpened: true, other: 1 }, extra: 1 } }));
    expect(loadHeadlessConfig(file).webhook).toEqual({ url: 'not a url', events: { failed: false, prOpened: true } });
  });

  it('accepts a webhook secret and never echoes a bad one', () => {
    const file = path.join(dir, 'ws.json');
    writeFileSync(file, JSON.stringify({ webhook: { secret: 's3cret' } }));
    expect(loadHeadlessConfig(file).webhook).toEqual({ secret: 's3cret' });
    writeFileSync(file, JSON.stringify({ webhook: { secret: { leak: 'TOPSECRETVALUE' } } }));
    let message = '';
    try {
      loadHeadlessConfig(file);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/webhook\.secret must be a string/);
    expect(message).not.toContain('TOPSECRETVALUE');
  });

  it('parses the writeback section and ignores unknown keys', () => {
    const file = path.join(dir, 'wb.json');
    writeFileSync(file, JSON.stringify({
      writeback: { github: true, linear: false, other: 1, jira: { enabled: true, transitionStatusName: 'Done', extra: 1 } }
    }));
    expect(loadHeadlessConfig(file).writeback).toEqual({
      github: true,
      linear: false,
      jira: { enabled: true, transitionStatusName: 'Done' }
    });
  });

  it('parses the writeback.azureBoards block and ignores unknown keys', () => {
    const file = path.join(dir, 'wbazure.json');
    writeFileSync(file, JSON.stringify({
      writeback: { azureBoards: { enabled: true, transitionOnReview: false, transitionStateName: 'Done', extra: 1 } }
    }));
    expect(loadHeadlessConfig(file).writeback).toEqual({
      azureBoards: { enabled: true, transitionOnReview: false, transitionStateName: 'Done' }
    });
  });

  it('rejects a mistyped writeback.azureBoards block', () => {
    const bad = path.join(dir, 'wbazurebad.json');
    const cases: [unknown, RegExp][] = [
      [{ azureBoards: 'x' }, /writeback\.azureBoards must be an object/],
      [{ azureBoards: { enabled: 'x' } }, /writeback\.azureBoards\.enabled must be a boolean/],
      [{ azureBoards: { transitionOnReview: 1 } }, /writeback\.azureBoards\.transitionOnReview must be a boolean/],
      [{ azureBoards: { transitionStateName: 5 } }, /writeback\.azureBoards\.transitionStateName must be a string/]
    ];
    for (const [writeback, message] of cases) {
      writeFileSync(bad, JSON.stringify({ writeback }));
      expect(() => loadHeadlessConfig(bad)).toThrow(message);
    }
  });

  it('leaves writeback undefined by default', () => {
    const file = path.join(dir, 'nowb.json');
    writeFileSync(file, JSON.stringify({}));
    expect(loadHeadlessConfig(file).writeback).toBeUndefined();
  });

  it('rejects a mistyped writeback section', () => {
    const bad = path.join(dir, 'wbbad.json');
    const cases: [unknown, RegExp][] = [
      ['x', /writeback must be an object/],
      [{ github: 'yes' }, /writeback\.github must be a boolean/],
      [{ gitlab: 1 }, /writeback\.gitlab must be a boolean/],
      [{ linear: {} }, /writeback\.linear must be a boolean/],
      [{ jira: 'x' }, /writeback\.jira must be an object/],
      [{ jira: { enabled: 'x' } }, /writeback\.jira\.enabled must be a boolean/],
      [{ jira: { comment: 1 } }, /writeback\.jira\.comment must be a boolean/],
      [{ jira: { transitionOnReview: 'y' } }, /writeback\.jira\.transitionOnReview must be a boolean/],
      [{ jira: { transitionStatusName: 5 } }, /writeback\.jira\.transitionStatusName must be a string/]
    ];
    for (const [writeback, message] of cases) {
      writeFileSync(bad, JSON.stringify({ writeback }));
      expect(() => loadHeadlessConfig(bad)).toThrow(message);
    }
  });

  it('rejects a mistyped webhook section', () => {
    const bad = path.join(dir, 'wbad.json');
    const cases: [unknown, RegExp][] = [
      ['x', /webhook must be an object/],
      [{ url: 5 }, /webhook\.url must be a string/],
      [{ secret: 5 }, /webhook\.secret must be a string/],
      [{ events: 'x' }, /webhook\.events must be an object/],
      [{ events: { blocked: 'yes' } }, /webhook\.events\.blocked must be a boolean/],
    ];
    for (const [webhook, re] of cases) {
      writeFileSync(bad, JSON.stringify({ webhook }));
      expect(() => loadHeadlessConfig(bad)).toThrow(re);
    }
  });

  it('fails loudly on a missing, invalid or mistyped file', () => {
    expect(() => loadHeadlessConfig(path.join(dir, 'nope.json'))).toThrow(/Cannot read config file/);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(() => loadHeadlessConfig(bad)).toThrow(/Cannot read config file/);
    writeFileSync(bad, '[]');
    expect(() => loadHeadlessConfig(bad)).toThrow(/JSON object/);
    writeFileSync(bad, JSON.stringify({ providerAccounts: 'x' }));
    expect(() => loadHeadlessConfig(bad)).toThrow(/providerAccounts/);
    writeFileSync(bad, JSON.stringify({ project: { pushNewBranches: 'yes' } }));
    expect(() => loadHeadlessConfig(bad)).toThrow(/pushNewBranches/);
  });
});

describe('loadHeadlessConfig webhook and project options', () => {
  const write = (value: unknown) => {
    const file = path.join(dir, 'w.json');
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  it('parses webhook.enabled and keeps the section as written (defaults are merged when it is resolved)', () => {
    const config = loadHeadlessConfig(
      write({ webhook: { enabled: true, url: 'https://example.com/hook', events: { prOpened: true, failed: false } } }),
    );
    expect(config.webhook).toEqual({
      enabled: true,
      url: 'https://example.com/hook',
      events: { failed: false, prOpened: true },
    });
  });

  it('accepts webhook.format auto, slack, teams and discord', () => {
    for (const format of ['auto', 'slack', 'teams', 'discord']) {
      expect(loadHeadlessConfig(write({ webhook: { format } })).webhook?.format).toBe(format);
    }
    expect(loadHeadlessConfig(write({ webhook: {} })).webhook).toEqual({});
  });

  it('rejects an invalid webhook.format', () => {
    for (const format of ['mattermost', 5, null, '']) {
      expect(() => loadHeadlessConfig(write({ webhook: { format } }))).toThrow(
        /webhook\.format must be one of auto, slack, teams, discord/,
      );
    }
  });

  it('parses maxParallelTasks', () => {
    expect(loadHeadlessConfig(write({ project: { maxParallelTasks: 3 } })).project?.maxParallelTasks).toBe(3);
  });

  it('parses project.defaultTokenBudget', () => {
    const file = write({ project: { defaultTokenBudget: 500_000 } });
    expect(loadHeadlessConfig(file).project?.defaultTokenBudget).toBe(500_000);
  });

  it('leaves project.defaultTokenBudget absent when omitted', () => {
    const project = { mainBranch: 'dev', pushNewBranches: false, maxParallelTasks: 3 };
    const config = loadHeadlessConfig(write({ project }));
    expect(config.project).toEqual(project);
    expect(config.project).not.toHaveProperty('defaultTokenBudget');
  });

  it.each([0, -1, 1.5, '1000', null])('rejects project.defaultTokenBudget = %j', (defaultTokenBudget) => {
    const file = write({ project: { defaultTokenBudget } });
    expect(() => loadHeadlessConfig(file)).toThrow(
      `Config file ${file}: project.defaultTokenBudget must be a positive integer (omit it for no default)`,
    );
  });

  it('rejects bad webhook values', () => {
    expect(() => loadHeadlessConfig(write({ webhook: 'x' }))).toThrow(/webhook must be an object/);
    expect(() => loadHeadlessConfig(write({ webhook: [] }))).toThrow(/webhook must be an object/);
    expect(() => loadHeadlessConfig(write({ webhook: { enabled: 'yes' } }))).toThrow(/webhook.enabled/);
    expect(() => loadHeadlessConfig(write({ webhook: { url: 5 } }))).toThrow(/webhook.url must be a string/);
    expect(() => loadHeadlessConfig(write({ webhook: { events: { failed: 'no' } } }))).toThrow(/events.failed/);
    expect(() => loadHeadlessConfig(write({ webhook: { events: 1 } }))).toThrow(/events must be an object/);
  });

  it('rejects bad maxParallelTasks', () => {
    for (const bad of [0, -1, 1.5, '2']) {
      expect(() => loadHeadlessConfig(write({ project: { maxParallelTasks: bad } }))).toThrow(/maxParallelTasks/);
    }
  });
});

describe('resolveProjectSettings', () => {
  it('defaults and always lands through pull requests', () => {
    const s = resolveProjectSettings(dir, {});
    expect(s).toMatchObject({ baseBranch: 'main', pushNewBranches: true, prOnlyLanding: true });
    expect(resolveProjectSettings(dir, { project: { pushNewBranches: false } }, { noPush: true }).prOnlyLanding).toBe(true);
  });

  it('orders base branch: flag > .aperant.json > config > main', () => {
    const config = { project: { mainBranch: 'fromconfig' } };
    expect(resolveProjectSettings(dir, config).baseBranch).toBe('fromconfig');
    writeFileSync(path.join(dir, '.aperant.json'), JSON.stringify({ baseBranch: 'zeenha' }));
    expect(resolveProjectSettings(dir, config).baseBranch).toBe('zeenha');
    expect(resolveProjectSettings(dir, config, { baseBranch: 'flag' }).baseBranch).toBe('flag');
  });

  it('--no-push disables pushing', () => {
    expect(resolveProjectSettings(dir, {}, { noPush: true }).pushNewBranches).toBe(false);
  });

  it('parses env passthrough and sandbox mode', () => {
    const s = resolveProjectSettings(dir, { project: { envPassthrough: 'FOO,BAR', bashSandbox: 'bogus' } });
    expect(Array.isArray(s.envPassthrough)).toBe(true);
    expect(typeof s.bashSandbox).toBe('string');
  });

  it('parses webFetchProvider and falls back to jina', () => {
    expect(resolveProjectSettings(dir, {}).webFetchProvider).toBe('jina');
    expect(resolveProjectSettings(dir, { project: { webFetchProvider: 'bogus' } }).webFetchProvider).toBe('jina');
    expect(resolveProjectSettings(dir, { project: { webFetchProvider: 'direct' } }).webFetchProvider).toBe('direct');
  });
});

describe('mcpOptionsForHeadless', () => {
  it('keeps repo-supplied custom servers unapproved', () => {
    const server = { id: 'evil', type: 'http', url: 'https://example.com/mcp' };
    expect(hashMcpServer(server as never)).toBeTruthy();
    const env = path.join(dir, '.auto-claude');
    require('node:fs').mkdirSync(env);
    writeFileSync(path.join(env, '.env'), `CONTEXT7_ENABLED=false\nCUSTOM_MCP_SERVERS=${JSON.stringify([server])}\n`);
    const options = mcpOptionsForHeadless(dir);
    expect(options.customServers).toBeUndefined();
    expect(options.context7Enabled).toBe(false);
  });
});

describe('import chain', () => {
  const SRC_ROOT = path.resolve(__dirname, '../../..');
  const FORBIDDEN = /^electron($|-log($|\/))/;
  const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

  function resolveLocal(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
    else if (spec.startsWith('@shared/')) base = path.join(SRC_ROOT, 'shared', spec.slice(8));
    else return null;
    return [base, `${base}.ts`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')]
      .find((f) => existsSync(f) && statSync(f).isFile()) ?? null;
  }

  function chains(entry: string): string[] {
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue = [entry];
    const found: string[] = [];
    while (queue.length) {
      const file = queue.shift() as string;
      for (const m of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
        if (FORBIDDEN.test(m[1])) {
          const chain = [m[1]];
          for (let at: string | null = file; at; at = parent.get(at) ?? null) chain.unshift(path.relative(SRC_ROOT, at));
          found.push(chain.join(' -> '));
          continue;
        }
        const target = resolveLocal(file, m[1]);
        if (target && !parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      }
    }
    return found;
  }

  it.each(['config.ts', 'auth.ts'])('%s reaches no electron import', (name) => {
    expect(chains(path.join(SRC_ROOT, 'main/headless', name))).toEqual([]);
  });
});
