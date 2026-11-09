/**
 * Modal for importing Jira issues as tasks.
 */

import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, Search } from 'lucide-react';
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
import type { JiraImportResult } from '../../../shared/types';
import { useJiraImport } from './useJiraImport';

const ALL_PROJECTS_VALUE = '__all__';

export interface JiraTaskImportModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: (result: JiraImportResult) => void;
  /** Default Jira project key (project's jiraProjectKey setting) */
  defaultProjectKey?: string;
}

export function JiraTaskImportModal({
  projectId,
  open,
  onOpenChange,
  onImportComplete,
  defaultProjectKey
}: JiraTaskImportModalProps) {
  const { t } = useTranslation('jira');
  const jira = useJiraImport({ projectId, open, defaultProjectKey, onImportComplete });
  const { importResult, selectedKeys, issues } = jira;
  const done = Boolean(importResult);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) jira.resetState();
    onOpenChange(newOpen);
  };

  const allSelected = issues.length > 0 && selectedKeys.size === issues.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Download className="h-5 w-5" />
            {t('import.title')}
          </DialogTitle>
          <DialogDescription>{t('import.description')}</DialogDescription>
        </DialogHeader>

        {importResult && (
          <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm space-y-1">
            <div className="flex items-center gap-2 font-medium text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t('import.successImported', { count: importResult.imported })}
            </div>
            {importResult.skipped.length > 0 && (
              <div className="text-muted-foreground">
                {t('import.skippedDuplicates', { count: importResult.skipped.length })}
              </div>
            )}
            {importResult.errors && importResult.errors.length > 0 && (
              <div className="text-warning">
                <div>{t('import.partialFailure')}</div>
                <ul className="list-disc pl-5">
                  {importResult.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {jira.error && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {jira.error}
          </div>
        )}

        {!done && (
          <>
            <div className="flex gap-2 shrink-0">
              <Select
                value={jira.selectedProjectKey || ALL_PROJECTS_VALUE}
                onValueChange={(v) => jira.setSelectedProjectKey(v === ALL_PROJECTS_VALUE ? '' : v)}
              >
                <SelectTrigger className="w-[220px]" aria-label={t('import.projectSelect.label')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PROJECTS_VALUE}>{t('import.projectSelect.all')}</SelectItem>
                  {jira.jiraProjects.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.key} - {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  value={jira.searchInput}
                  placeholder={t('import.searchPlaceholder')}
                  onChange={(e) => jira.setSearchInput(e.target.value)}
                />
              </div>
            </div>

            {issues.length > 0 && (
              <div className="flex items-center justify-between shrink-0 text-sm">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={allSelected ? jira.deselectAll : jira.selectAll}
                  >
                    {allSelected ? t('import.deselectAll') : t('import.selectAll')}
                  </Button>
                  <span className="text-muted-foreground">
                    {t('import.selectedCount', { count: selectedKeys.size })}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={jira.handleRefresh}
                  disabled={jira.isLoadingIssues}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('import.refresh')}
                </Button>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
              {jira.isLoadingIssues && (
                <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('import.loading')}
                </div>
              )}
              {!jira.isLoadingIssues && issues.length === 0 && !jira.error && (
                <div className="py-8 text-center text-muted-foreground">
                  {jira.searchInput ? t('import.empty.noMatch') : t('import.empty.noIssues')}
                </div>
              )}
              {!jira.isLoadingIssues &&
                issues.map((issue) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the wrapped control
                  <label
                    key={issue.key}
                    className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      className="mt-1"
                      checked={selectedKeys.has(issue.key)}
                      onCheckedChange={() => jira.toggleIssue(issue.key)}
                      aria-label={issue.key}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{issue.key}</span>
                        <span className="text-sm font-medium truncate">{issue.summary}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{issue.statusName}</Badge>
                        <Badge variant="secondary">{issue.issueType}</Badge>
                        {issue.priorityName && <Badge variant="muted">{issue.priorityName}</Badge>}
                        {issue.alreadyImported && (
                          <Badge variant="warning">{t('import.alreadyImported')}</Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{issue.assigneeName ?? t('issue.unassigned')}</span>
                        {issue.labels.map((label) => (
                          <Badge key={label} variant="outline" className="text-[10px]">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </label>
                ))}
              {jira.hasMore && !jira.isLoadingIssues && (
                <div className="flex justify-center py-2">
                  <Button variant="outline" size="sm" onClick={jira.loadMore} disabled={jira.isLoadingMore}>
                    {jira.isLoadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('import.loadMore')}
                  </Button>
                </div>
              )}
            </div>

            {jira.showDuplicateConfirm && (
              <div role="alertdialog" className="shrink-0 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm space-y-2">
                <div className="flex items-center gap-2 font-medium text-warning">
                  <AlertTriangle className="h-4 w-4" />
                  {t('import.duplicateWarning.title')}
                </div>
                <p>{t('import.duplicateWarning.body', { count: jira.duplicateCount })}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={jira.confirmReimport}>
                    {t('import.confirmReimport')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={jira.skipReimport}>
                    {t('import.skipReimport')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {done ? t('import.done') : t('import.cancel')}
          </Button>
          {!done && (
            <Button
              onClick={jira.handleImport}
              disabled={selectedKeys.size === 0 || jira.isImporting}
            >
              {jira.isImporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('import.importing')}
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  {t('import.importButton', { count: selectedKeys.size })}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
