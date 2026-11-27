import type { AzureBoardsImportResult } from '../../../shared/types';

export function getFailedIds(result: AzureBoardsImportResult | null): number[] {
  return (result?.items ?? []).filter((item) => item.status === 'failed').map((item) => item.id);
}

export function mergeImportResults(
  previous: AzureBoardsImportResult,
  retry: AzureBoardsImportResult
): AzureBoardsImportResult {
  // A Map preserves the order of the original batch when replacing outcomes by id.
  const byId = new Map((previous.items ?? []).map((item) => [item.id, item]));
  for (const item of retry.items ?? []) {
    const previousTitle = byId.get(item.id)?.title;
    byId.set(
      item.id,
      item.title === undefined && previousTitle !== undefined ? { ...item, title: previousTitle } : item
    );
  }

  const items = Array.from(byId.values());
  const skipped: AzureBoardsImportResult['skipped'] = [];
  const errors: string[] = [];
  let imported = 0;
  for (const item of items) {
    if (item.status === 'imported') {
      imported++;
    } else if (item.status === 'failed') {
      errors.push(`Failed to import AB#${item.id}: ${item.reason ?? 'Unknown error'}`);
    } else if (item.specId !== undefined) {
      skipped.push({ id: item.id, specId: item.specId });
    }
  }

  return {
    items,
    imported,
    failed: errors.length,
    skipped,
    success: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined
  };
}
