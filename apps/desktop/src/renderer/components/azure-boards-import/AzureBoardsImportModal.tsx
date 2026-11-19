/**
 * Modal for importing Azure Boards work items as tasks.
 */

import { useRef, type KeyboardEvent } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { AzureBoardsImportResult } from '../../../shared/types';
import { useAzureBoardsImport } from './useAzureBoardsImport';

export interface AzureBoardsImportModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: (result: AzureBoardsImportResult) => void;
}

export function AzureBoardsImportModal({
  projectId,
  open,
  onOpenChange,
  onImportComplete
}: AzureBoardsImportModalProps) {
  const { t } = useTranslation('azuredevops');
  const boards = useAzureBoardsImport({ projectId, open, onImportComplete });
  const { importResult, selectedIds, items } = boards;
  const done = Boolean(importResult);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) boards.resetState();
    onOpenChange(newOpen);
  };

  const allSelected = items.length > 0 && selectedIds.size === items.length;

  const focusRow = (index: number) => {
    const item = items[index];
    if (item) rowRefs.current.get(item.id)?.focus();
  };

  const handleListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      boards.selectAll();
      return;
    }
    if (e.key === 'Enter') {
      if (selectedIds.size > 0) {
        e.preventDefault();
        boards.handleImport();
      }
    }
  };

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number, id: number) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(Math.min(index + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(Math.max(index - 1, 0));
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      boards.toggleItem(id);
    }
  };

  const handleQueryKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void boards.runQuery();
    }
  };

  const runDisabled =
    boards.isLoadingItems || (boards.queryMode === 'saved' && !boards.savedQueryId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Download className="h-5 w-5" />
            {t('boards.title')}
          </DialogTitle>
          <DialogDescription>{t('boards.description')}</DialogDescription>
        </DialogHeader>

        {importResult && (
          <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm space-y-1">
            <div className="flex items-center gap-2 font-medium text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t('boards.successImported', { count: importResult.imported })}
            </div>
            {importResult.skipped.length > 0 && (
              <div className="text-muted-foreground">
                {t('boards.skippedDuplicates', { count: importResult.skipped.length })}
              </div>
            )}
            {importResult.errors && importResult.errors.length > 0 && (
              <div className="text-warning">
                <div>{t('boards.partialFailure')}</div>
                <ul className="list-disc pl-5">
                  {importResult.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {boards.error && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {boards.error}
          </div>
        )}

        {!done && (
          <>
            <div className="flex gap-2 shrink-0" role="radiogroup" aria-label={t('boards.queryMode.label')}>
              {(['filter', 'saved'] as const).map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={boards.queryMode === mode}
                  size="sm"
                  variant={boards.queryMode === mode ? 'default' : 'outline'}
                  onClick={() => boards.setQueryMode(mode)}
                >
                  {t(`boards.queryMode.${mode}`)}
                </Button>
              ))}
            </div>

            {boards.queryMode === 'filter' ? (
              <div className="shrink-0 space-y-3">
                <Input
                  value={boards.areaPath}
                  placeholder={t('boards.areaPath.placeholder')}
                  aria-label={t('boards.areaPath.label')}
                  onChange={(e) => boards.setAreaPath(e.target.value)}
                  onKeyDown={handleQueryKeyDown}
                />
                {boards.metadata.states.length > 0 && (
                  <fieldset className="space-y-1">
                    <legend className="text-xs font-medium text-muted-foreground">
                      {t('boards.states.label')}
                    </legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {boards.metadata.states.map((s) => (
                        // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the wrapped control
                        <label key={s} className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <Checkbox
                            checked={boards.states.includes(s)}
                            onCheckedChange={() => boards.toggleState(s)}
                            aria-label={s}
                          />
                          {s}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
                {boards.metadata.workItemTypes.length > 0 && (
                  <fieldset className="space-y-1">
                    <legend className="text-xs font-medium text-muted-foreground">
                      {t('boards.types.label')}
                    </legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {boards.metadata.workItemTypes.map((type) => (
                        // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the wrapped control
                        <label key={type} className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <Checkbox
                            checked={boards.workItemTypes.includes(type)}
                            onCheckedChange={() => boards.toggleWorkItemType(type)}
                            aria-label={type}
                          />
                          {type}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
              </div>
            ) : (
              <div className="shrink-0">
                <Select value={boards.savedQueryId} onValueChange={boards.setSavedQueryId}>
                  <SelectTrigger aria-label={t('boards.savedQuery.label')}>
                    <SelectValue placeholder={t('boards.savedQuery.placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {boards.savedQueries.map((q) => (
                      <SelectItem key={q.id} value={q.id}>
                        {q.path || q.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between shrink-0 text-sm">
              <div className="flex items-center gap-2">
                {items.length > 0 && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={allSelected ? boards.deselectAll : boards.selectAll}
                    >
                      {allSelected ? t('boards.deselectAll') : t('boards.selectAll')}
                    </Button>
                    <span className="text-muted-foreground">
                      {t('boards.selectedCount', { count: selectedIds.size })}
                    </span>
                  </>
                )}
              </div>
              <Button size="sm" onClick={() => void boards.runQuery()} disabled={runDisabled}>
                <Play className="mr-2 h-4 w-4" />
                {t('boards.run')}
              </Button>
            </div>

            {boards.truncated && (
              <div className="shrink-0 rounded-md border border-warning/30 bg-warning/10 p-2 text-sm text-warning">
                {t('boards.truncated', { shown: items.length, total: boards.totalCount })}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto">
              {boards.isLoadingItems && (
                <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('boards.loading')}
                </div>
              )}
              {!boards.isLoadingItems && items.length === 0 && !boards.error && (
                <div className="py-8 text-center text-muted-foreground">
                  {boards.hasRun ? t('boards.empty') : t('boards.notRun')}
                </div>
              )}
              {!boards.isLoadingItems && items.length > 0 && (
                <div
                  role="listbox"
                  aria-multiselectable="true"
                  aria-label={t('boards.results')}
                  className="space-y-2"
                  onKeyDown={handleListKeyDown}
                >
                  {items.map((item, index) => {
                    const selected = selectedIds.has(item.id);
                    return (
                      <div
                        key={item.id}
                        role="option"
                        aria-selected={selected}
                        tabIndex={index === 0 ? 0 : -1}
                        ref={(el) => {
                          if (el) rowRefs.current.set(item.id, el);
                          else rowRefs.current.delete(item.id);
                        }}
                        onKeyDown={(e) => handleRowKeyDown(e, index, item.id)}
                        onClick={() => boards.toggleItem(item.id)}
                        className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Checkbox
                          className="mt-1"
                          tabIndex={-1}
                          checked={selected}
                          aria-hidden="true"
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={() => boards.toggleItem(item.id)}
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">#{item.id}</span>
                            <span className="text-sm font-medium truncate">{item.title}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline">{item.state}</Badge>
                            <Badge variant="secondary">{item.workItemType}</Badge>
                            {item.alreadyImported && (
                              <Badge variant="warning">{t('boards.alreadyImported')}</Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span>{item.assignedTo ?? t('boards.unassigned')}</span>
                            {item.tags.map((tag) => (
                              <Badge key={tag} variant="outline" className="text-[10px]">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {items.length > 0 && (
              <p className="shrink-0 text-xs text-muted-foreground">{t('boards.keyboardHint')}</p>
            )}

            {boards.showDuplicateConfirm && (
              <div role="alertdialog" className="shrink-0 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm space-y-2">
                <div className="flex items-center gap-2 font-medium text-warning">
                  <AlertTriangle className="h-4 w-4" />
                  {t('boards.duplicateWarning.title')}
                </div>
                <p>{t('boards.duplicateWarning.body', { count: boards.duplicateCount })}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={boards.confirmReimport}>
                    {t('boards.duplicateWarning.confirm')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={boards.skipReimport}>
                    {t('boards.duplicateWarning.skip')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {done ? t('boards.done') : t('boards.cancel')}
          </Button>
          {!done && (
            <Button
              onClick={boards.handleImport}
              disabled={selectedIds.size === 0 || boards.isImporting}
            >
              {boards.isImporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('boards.importing')}
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  {t('boards.importButton', { count: selectedIds.size })}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
