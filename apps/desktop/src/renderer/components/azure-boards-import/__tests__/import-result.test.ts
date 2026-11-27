import { describe, expect, it } from 'vitest';
import type { AzureBoardsImportResult } from '../../../../shared/types';
import { getFailedIds, mergeImportResults } from '../import-result';

const imported = { id: 5, status: 'imported', specId: '001-a', title: 'First' } as const;
const skipped = { id: 2, status: 'skipped', specId: '002-b', title: 'Second' } as const;
const failed = { id: 3, status: 'failed', title: 'Third', reason: 'Import failed' } as const;
const previous: AzureBoardsImportResult = {
  success: false,
  imported: 1,
  failed: 1,
  skipped: [{ id: 2, specId: '002-b' }],
  errors: ['Failed to import AB#3: Import failed'],
  items: [imported, skipped, failed]
};
const importedRetry: AzureBoardsImportResult = {
  success: true,
  imported: 1,
  failed: 0,
  skipped: [],
  items: [{ id: 3, status: 'imported', title: 'Updated title', specId: '003-c' }]
};

// Simulate IPC responses from a main process that predates per-item outcomes.
const { items: _items, ...legacyResult } = previous;
const legacy = legacyResult as AzureBoardsImportResult;

describe('getFailedIds', () => {
  it('returns only failed ids in result order', () => {
    const result: AzureBoardsImportResult = {
      ...previous,
      failed: 2,
      items: [{ id: 10, status: 'failed' }, ...previous.items]
    };
    expect(getFailedIds(result)).toEqual([10, 3]);
  });

  it('returns no failed ids without a result or per-item outcomes', () => {
    expect(getFailedIds(null)).toEqual([]);
    expect(getFailedIds(legacy)).toEqual([]);
  });
});

describe('mergeImportResults', () => {
  it('replaces a recovered failure and retains earlier imports and skips', () => {
    expect(mergeImportResults(previous, importedRetry)).toEqual({
      success: true,
      imported: 2,
      failed: 0,
      skipped: previous.skipped,
      errors: undefined,
      items: [imported, skipped, importedRetry.items[0]]
    });
  });

  it('keeps the previous title and updates the reason if the retry fails again', () => {
    const retry: AzureBoardsImportResult = {
      success: false,
      imported: 0,
      failed: 1,
      skipped: [],
      items: [{ id: 3, status: 'failed', reason: 'Still unavailable' }]
    };
    expect(mergeImportResults(previous, retry)).toEqual({
      ...previous,
      errors: ['Failed to import AB#3: Still unavailable'],
      items: [imported, skipped, { ...failed, reason: 'Still unavailable' }]
    });
  });

  it('counts a previously failed item as skipped when it already exists on retry', () => {
    const retry: AzureBoardsImportResult = {
      success: true,
      imported: 0,
      failed: 0,
      skipped: [{ id: 3, specId: '003-c' }],
      items: [{ id: 3, status: 'skipped', specId: '003-c' }]
    };
    expect(mergeImportResults(previous, retry)).toEqual({
      success: true,
      imported: 1,
      failed: 0,
      skipped: [...previous.skipped, ...retry.skipped],
      errors: undefined,
      items: [imported, skipped, { id: 3, status: 'skipped', title: 'Third', specId: '003-c' }]
    });
  });

  it('appends outcomes for ids not previously in the result', () => {
    const retry: AzureBoardsImportResult = {
      ...importedRetry,
      failed: 1,
      success: false,
      items: [{ id: 1, status: 'failed', reason: 'Not found' }, ...importedRetry.items]
    };
    expect(mergeImportResults(previous, retry)).toEqual({
      success: false,
      imported: 2,
      failed: 1,
      skipped: previous.skipped,
      errors: ['Failed to import AB#1: Not found'],
      items: [imported, skipped, importedRetry.items[0], retry.items[0]]
    });
  });

  it('treats absent per-item outcomes on either side as an empty array', () => {
    expect(mergeImportResults(legacy, importedRetry)).toEqual(importedRetry);
    expect(mergeImportResults(previous, legacy)).toEqual(previous);
  });
});
