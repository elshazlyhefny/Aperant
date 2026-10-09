/**
 * zeenha fork: batch IDs name the files under `batches/`. They used to be
 * `batch-001`… on every run, so a second run overwrote the first run's batches.
 * And an issue the grouping model left out was silently dropped.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('../../../client/factory', () => ({ createSimpleClient: vi.fn() }));

import {
  BatchProcessor,
  type BatchSuggestion,
  createBatchRunId,
  UNGROUPED_REASONING,
} from '../batch-processor';
import type { GitHubIssue } from '../duplicate-detector';

const issues: GitHubIssue[] = [1, 2, 3, 4].map((n) => ({ number: n, title: `Issue ${n}` }));

const suggestion = (issueNumbers: number[], theme = 'theme'): BatchSuggestion => ({
  issueNumbers,
  theme,
  reasoning: 'related',
  confidence: 0.9,
});

describe('createBatchRunId', () => {
  it('is filename-safe and starts with a sortable UTC timestamp', () => {
    const id = createBatchRunId(new Date('2026-10-09T03:05:12.123Z'));
    expect(id).toMatch(/^20261009T030512123Z-[0-9a-f]{6}$/);
  });

  it('differs between two runs in the same millisecond', () => {
    const now = new Date('2026-10-09T03:05:12.123Z');
    expect(createBatchRunId(now)).not.toBe(createBatchRunId(now));
  });

  it('sorts by time', () => {
    const earlier = createBatchRunId(new Date('2026-10-09T03:05:12.123Z'));
    const later = createBatchRunId(new Date('2026-10-10T00:00:00.000Z'));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe('BatchProcessor.buildBatches', () => {
  const processor = new BatchProcessor();

  it('gives two runs disjoint batch IDs', () => {
    const suggestions = [suggestion([1, 2]), suggestion([3, 4])];
    const first = processor.buildBatches(issues, suggestions).map((b) => b.batchId);
    const second = processor.buildBatches(issues, suggestions).map((b) => b.batchId);

    expect(new Set(first).size).toBe(2);
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    for (const id of [...first, ...second]) {
      expect(id).toMatch(/^batch-[0-9A-Za-z-]+$/);
    }
  });

  it('numbers batches within a run under the run id', () => {
    const batches = processor.buildBatches(issues, [suggestion([1, 2]), suggestion([3, 4])], 'RUN');
    expect(batches.map((b) => b.batchId)).toEqual(['batch-RUN-001', 'batch-RUN-002']);
  });

  it('puts an issue the model left out in a batch of its own, flagged', () => {
    const batches = processor.buildBatches(issues, [suggestion([1, 2]), suggestion([3])], 'RUN');

    const numbers = batches.flatMap((b) => b.issues.map((i) => i.number));
    expect(numbers.sort()).toEqual([1, 2, 3, 4]);
    const ungrouped = batches.find((b) => b.issues[0]?.number === 4);
    expect(ungrouped?.issues).toHaveLength(1);
    expect(ungrouped?.reasoning).toBe(UNGROUPED_REASONING);
    expect(ungrouped?.confidence).toBe(0);
  });

  it('keeps an issue the model repeated in its first batch only', () => {
    const batches = processor.buildBatches(issues, [suggestion([1, 2]), suggestion([2, 3, 4])], 'RUN');
    expect(batches.map((b) => b.issues.map((i) => i.number))).toEqual([[1, 2], [3, 4]]);
  });

  it('makes no batch for a suggestion naming no known issue', () => {
    const batches = processor.buildBatches(issues, [suggestion([99]), suggestion([1, 2, 3, 4])], 'RUN');
    expect(batches).toHaveLength(1);
    expect(batches[0].batchId).toBe('batch-RUN-001');
  });
});

describe('safeBatchId (approved batches from the renderer)', () => {
  it('keeps a filename-safe id', async () => {
    const { safeBatchId } = await import('../batch-processor');
    expect(safeBatchId('batch-20261009T030512123Z-a1b2c3-001', 5, 'run')).toBe('batch-20261009T030512123Z-a1b2c3-001');
  });

  it.each(['../../../etc/passwd', 'a/b', 'x.json', '', 'a'.repeat(121), 7, undefined])(
    'replaces an unsafe or missing id (%s) with a unique one',
    async (raw) => {
      const { safeBatchId } = await import('../batch-processor');
      expect(safeBatchId(raw, 12, 'RUN-1')).toBe('batch-RUN-1-012');
    },
  );
});

