import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Loader2, Play, Tags } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Progress } from '../../ui/progress';
import type { GitHubTriageConfig, GitHubTriageResult } from '../../../../shared/types';
import type { UseGitHubTriageReturn } from '../hooks/useGitHubTriage';

type ThresholdKey = 'duplicateThreshold' | 'spamThreshold' | 'featureCreepThreshold';
const THRESHOLDS: Array<{ key: ThresholdKey; label: string }> = [
  { key: 'duplicateThreshold', label: 'githubTriage.settings.duplicate' },
  { key: 'spamThreshold', label: 'githubTriage.settings.spam' },
  { key: 'featureCreepThreshold', label: 'githubTriage.settings.featureCreep' },
];

/** A result only offers to change GitHub when it suggests a change. */
const hasLabelChanges = (r: GitHubTriageResult) => r.labelsToAdd.length > 0 || r.labelsToRemove.length > 0;

/** Percent text from the form, as a 0..1 threshold; null when it is not a number from 0 to 100. */
function parsePercent(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value / 100;
}

const toPercentText = (value: number) => String(Math.round(value * 100));

export interface TriageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoFullName: string;
  triage: UseGitHubTriageReturn;
  /** Issue titles the issue list already holds, to name results. */
  issueTitles?: Map<number, string>;
}

export function TriageDialog({ open, onOpenChange, repoFullName, triage, issueTitles }: TriageDialogProps) {
  const { t } = useTranslation('common');
  const { config, results, isRunning, isSaving, isApplying, progress, error, applyResult, load, saveConfig, startTriage, applyLabels } =
    triage;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [thresholdText, setThresholdText] = useState<Record<ThresholdKey, string>>({
    duplicateThreshold: '',
    spamThreshold: '',
    featureCreepThreshold: '',
  });
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!config) return;
    setThresholdText({
      duplicateThreshold: toPercentText(config.duplicateThreshold),
      spamThreshold: toPercentText(config.spamThreshold),
      featureCreepThreshold: toPercentText(config.featureCreepThreshold),
    });
  }, [config]);

  // Drop selections for results that no longer offer a change (e.g. after a re-run).
  const selectable = useMemo(() => results.filter(hasLabelChanges), [results]);
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(selectable.map((r) => r.issueNumber));
      const next = new Set([...prev].filter((n) => allowed.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectable]);

  const parsed = THRESHOLDS.map(({ key }) => [key, parsePercent(thresholdText[key])] as const);
  const thresholdsValid = parsed.every(([, v]) => v !== null);
  const thresholdsChanged = config !== null && parsed.some(([key, v]) => v !== null && Math.abs(v - config[key]) > 1e-9);

  const handleSave = async () => {
    if (!config || !thresholdsValid) return;
    const next: GitHubTriageConfig = { ...config };
    for (const [key, value] of parsed) next[key] = value as number;
    setSaveState((await saveConfig(next)) ? 'saved' : 'failed');
  };

  const toggle = (issueNumber: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(issueNumber);
      else next.delete(issueNumber);
      return next;
    });
  };
  const allSelected = selectable.length > 0 && selected.size === selectable.length;

  const selectedResults = results.filter((r) => selected.has(r.issueNumber));

  const handleConfirmApply = async () => {
    setConfirming(false);
    const outcome = await applyLabels([...selected].sort((a, b) => a - b));
    if (outcome?.success) {
      // Keep only the issues that failed selected, so a retry is one click.
      setSelected(new Set(outcome.failed.map((f) => f.issueNumber)));
    }
  };

  const busy = isRunning || isApplying;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tags className="h-5 w-5" />
              {t('githubTriage.title')}
            </DialogTitle>
            <DialogDescription>{t('githubTriage.description', { repo: repoFullName })}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
            {/* Settings */}
            <section className="space-y-2" aria-labelledby="triage-settings-title">
              <h3 id="triage-settings-title" className="text-sm font-medium">
                {t('githubTriage.settings.title')}
              </h3>
              <p className="text-xs text-muted-foreground">{t('githubTriage.settings.description')}</p>
              <div className="flex flex-wrap items-end gap-3">
                {THRESHOLDS.map(({ key, label }) => (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`triage-${key}`} className="text-xs">
                      {t(label)}
                    </Label>
                    <div className="flex items-center gap-1">
                      <Input
                        id={`triage-${key}`}
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        className="w-20"
                        value={thresholdText[key]}
                        disabled={!config}
                        aria-invalid={parsePercent(thresholdText[key]) === null}
                        onChange={(e) => {
                          setSaveState('idle');
                          setThresholdText((prev) => ({ ...prev, [key]: e.target.value }));
                        }}
                      />
                      <span className="text-xs text-muted-foreground">%</span>
                    </div>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={handleSave} disabled={!thresholdsValid || !thresholdsChanged || isSaving}>
                  {isSaving ? t('buttons.saving') : t('githubTriage.settings.save')}
                </Button>
              </div>
              {!thresholdsValid && <p className="text-xs text-destructive">{t('githubTriage.settings.invalid')}</p>}
              {saveState === 'saved' && <p className="text-xs text-success">{t('githubTriage.settings.saved')}</p>}
              {saveState === 'failed' && <p className="text-xs text-destructive">{t('githubTriage.settings.saveFailed')}</p>}
            </section>

            {/* Run */}
            <section className="space-y-2">
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={() => startTriage()} disabled={busy}>
                  {isRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                  {isRunning
                    ? t('githubTriage.run.running')
                    : results.length > 0
                      ? t('githubTriage.run.rerun')
                      : t('githubTriage.run.start')}
                </Button>
                <span className="text-xs text-muted-foreground">{t('githubTriage.run.hint')}</span>
              </div>
              {isRunning && progress && (
                <div className="space-y-1" data-testid="triage-progress">
                  <Progress value={progress.progress} />
                  <p className="text-xs text-muted-foreground">{progress.message}</p>
                </div>
              )}
              {!isRunning && progress?.phase === 'complete' && (
                <p className="text-xs text-muted-foreground">{progress.message}</p>
              )}
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium">{t('githubTriage.run.errorTitle')}</p>
                    <p className="text-xs text-muted-foreground break-words">{error}</p>
                  </div>
                </div>
              )}
            </section>

            {/* Results */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{t('githubTriage.results.title', { count: results.length })}</h3>
                {selectable.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="triage-select-all"
                      checked={allSelected ? true : selected.size > 0 ? 'indeterminate' : false}
                      onCheckedChange={(checked) =>
                        setSelected(checked === true ? new Set(selectable.map((r) => r.issueNumber)) : new Set())
                      }
                      disabled={busy}
                    />
                    <Label htmlFor="triage-select-all" className="text-xs">
                      {t('githubTriage.results.selectAll')}
                    </Label>
                  </div>
                )}
              </div>

              {results.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('githubTriage.results.empty')}</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {results.map((r) => {
                    const changes = hasLabelChanges(r);
                    const title = issueTitles?.get(r.issueNumber);
                    return (
                      <li key={r.issueNumber} className="flex items-start gap-3 p-3" data-testid={`triage-result-${r.issueNumber}`}>
                        <Checkbox
                          aria-label={t('githubTriage.results.selectIssue', { number: r.issueNumber })}
                          checked={selected.has(r.issueNumber)}
                          onCheckedChange={(checked) => toggle(r.issueNumber, checked === true)}
                          disabled={!changes || busy}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">#{r.issueNumber}</span>
                            {title && <span className="text-sm truncate">{title}</span>}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary">{t(`githubTriage.categories.${r.category}`, { defaultValue: r.category })}</Badge>
                            <Badge variant="outline">{t(`githubTriage.priority.${r.priority}`, { defaultValue: r.priority })}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {t('githubTriage.results.confidence', { value: Math.round(r.confidence * 100) })}
                            </span>
                            {r.isDuplicate && (
                              <Badge variant="outline">
                                {r.duplicateOf
                                  ? t('githubTriage.results.duplicateOf', { number: r.duplicateOf })
                                  : t('githubTriage.results.duplicate')}
                              </Badge>
                            )}
                            {r.isSpam && <Badge variant="destructive">{t('githubTriage.results.spam')}</Badge>}
                            {r.isFeatureCreep && <Badge variant="outline">{t('githubTriage.results.featureCreep')}</Badge>}
                            {r.labelsAppliedAt && (
                              <span className="inline-flex items-center gap-1 text-xs text-success">
                                <CheckCircle2 className="h-3 w-3" />
                                {t('githubTriage.results.applied')}
                              </span>
                            )}
                          </div>
                          {changes ? (
                            <p className="text-xs text-muted-foreground">
                              {r.labelsToAdd.map((l) => `+ ${l}`).concat(r.labelsToRemove.map((l) => `− ${l}`)).join(', ')}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">{t('githubTriage.results.noChanges')}</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Last label write */}
            {applyResult && (
              <section role="status" className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="triage-apply-result">
                {applyResult.success ? (
                  <>
                    <p>{t('githubTriage.apply.summary', { count: applyResult.applied.length })}</p>
                    {applyResult.applied
                      .filter((a) => a.skipped.length > 0)
                      .map((a) => (
                        <p key={`s${a.issueNumber}`} className="text-xs text-muted-foreground">
                          {t('githubTriage.apply.skipped', { number: a.issueNumber, labels: a.skipped.join(', ') })}
                        </p>
                      ))}
                    {applyResult.failed.map((f) => (
                      <p key={`f${f.issueNumber}`} className="text-xs text-destructive break-words">
                        {t('githubTriage.apply.failed', { number: f.issueNumber, error: f.error })}
                      </p>
                    ))}
                  </>
                ) : (
                  <p className="text-destructive break-words">{t('githubTriage.apply.error', { error: applyResult.error ?? '' })}</p>
                )}
              </section>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('buttons.close')}
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={selected.size === 0 || busy}>
              {isApplying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Tags className="h-4 w-4 mr-2" />}
              {isApplying ? t('githubTriage.apply.applying') : t('githubTriage.apply.button', { count: selected.size })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Writing labels changes the user's repository: ask first, and say exactly what will change. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('githubTriage.apply.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('githubTriage.apply.confirmDescription', { count: selectedResults.length, repo: repoFullName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 overflow-y-auto space-y-1 text-sm" data-testid="triage-confirm-list">
            {selectedResults.map((r) => (
              <li key={r.issueNumber}>
                <span className="font-medium">#{r.issueNumber}</span>{' '}
                <span className="text-muted-foreground">
                  {r.labelsToAdd.map((l) => `+ ${l}`).concat(r.labelsToRemove.map((l) => `− ${l}`)).join(', ')}
                </span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('buttons.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmApply}>{t('githubTriage.apply.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
