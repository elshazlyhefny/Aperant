import { describe, expect, it } from 'vitest';
import enTasks from '../../../../shared/i18n/locales/en/tasks.json';
import frTasks from '../../../../shared/i18n/locales/fr/tasks.json';

const resolve = (tree: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);

// Keys used by TaskLogs.tsx (without the "tasks:" namespace prefix).
// entryCount is pluralised, so it is checked through its _one/_other forms.
const KEYS = [
  'logs.jumpToLatest',
  'logs.empty.title',
  'logs.empty.hint',
  'logs.entryCount_one',
  'logs.entryCount_other',
  'logs.modelTooltip',
  'logs.thinkingTooltip',
  'logs.done',
  'logs.showOutput',
  'logs.hideOutput',
  'logs.showMore',
  'logs.showLess',
  'logs.thinking.low',
  'logs.thinking.medium',
  'logs.thinking.high',
  'logs.thinking.xhigh',
  'logs.tools.reading',
  'logs.tools.searchingFiles',
  'logs.tools.searchingCode',
  'logs.tools.editing',
  'logs.tools.writing',
  'logs.tools.running',
  'execution.phases.planning',
  'execution.phases.coding',
  'execution.phases.validation',
  'execution.phases.complete',
  'execution.phases.failed',
  'execution.phases.pending',
  'execution.labels.interrupted',
  'labels.running',
];

describe('TaskLogs locale keys', () => {
  for (const [name, tree] of [['en', enTasks], ['fr', frTasks]] as const) {
    it(`${name}/tasks.json defines every key used by TaskLogs`, () => {
      for (const key of KEYS) {
        const value = resolve(tree, key);
        expect(typeof value, `${name}: ${key}`).toBe('string');
        expect((value as string).length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });
  }
});
