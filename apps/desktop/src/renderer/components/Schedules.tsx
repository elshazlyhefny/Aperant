import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2, AlertTriangle, Zap, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog';
import { ScheduleDialog } from './ScheduleDialog';
import { useScheduleStore } from '../stores/schedule-store';
import type {
  RecurringSchedule,
  ScheduleCadence,
  ScheduleRunRecord
} from '../../shared/types/schedule';

// zeenha fork: list and manage recurring task schedules.

interface SchedulesProps {
  projectId: string;
}

const REPORT_KINDS: ScheduleRunRecord['kind'][] = [
  'missed',
  'skipped_unfinished',
  'budget_exceeded',
  'failed'
];

function pendingReports(schedule: RecurringSchedule): ScheduleRunRecord[] {
  return schedule.history.filter((r) => !r.acknowledged && REPORT_KINDS.includes(r.kind));
}

export function Schedules({ projectId }: SchedulesProps) {
  const { t, i18n } = useTranslation(['schedules', 'common']);
  const schedules = useScheduleStore((s) => s.schedules);
  const loadSchedules = useScheduleStore((s) => s.loadSchedules);
  const setEnabled = useScheduleStore((s) => s.setEnabled);
  const deleteSchedule = useScheduleStore((s) => s.deleteSchedule);
  const acknowledgeReports = useScheduleStore((s) => s.acknowledgeReports);
  const runNow = useScheduleStore((s) => s.runNow);
  const isLoading = useScheduleStore((s) => s.isLoading);
  const loadError = useScheduleStore((s) => s.loadError);
  const activeProjectId = useScheduleStore((s) => s.activeProjectId);

  const [runningNowId, setRunningNowId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    scheduleId: string;
    text: string;
    isError: boolean;
    scope?: 'card' | 'banner';
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringSchedule | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RecurringSchedule | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    void loadSchedules(projectId);
  }, [projectId, loadSchedules]);

  const formatDate = (ms: number) => new Date(ms).toLocaleString(i18n.language);

  const cadenceSummary = (cadence: ScheduleCadence): string => {
    if (cadence.kind === 'daily') {
      return t('schedules:cadenceSummary.daily', { time: cadence.time });
    }
    if (cadence.kind === 'weekly') {
      const days = cadence.days.map((d) => t(`schedules:weekdays.${d}`)).join(', ');
      return t('schedules:cadenceSummary.weekly', { days, time: cadence.time });
    }
    return t('schedules:cadenceSummary.interval', { count: cadence.everyMinutes });
  };

  const recordText = (record: ScheduleRunRecord): string => {
    if (record.detail === 'manual') {
      if (record.kind === 'started') return t('schedules:history.startedManual');
      if (record.kind === 'skipped_unfinished') return t('schedules:history.skippedManual');
    }
    return t(`schedules:history.${record.kind}`, { count: record.missedCount ?? 0 });
  };

  const handleRunNow = async (scheduleId: string) => {
    setRunningNowId(scheduleId);
    setNotice(null);
    let text: string;
    let isError = false;
    try {
      const result = await runNow(scheduleId);
      if (!result) {
        text = t('schedules:runNow.failed');
        isError = true;
      } else if (result.started) text = t('schedules:runNow.started');
      else if (result.reason === 'unfinished') text = t('schedules:runNow.unfinished');
      else {
        text = t('schedules:runNow.failed');
        isError = true;
      }
    } catch {
      text = t('schedules:runNow.failed');
      isError = true;
    }
    setNotice({ scheduleId, text, isError, scope: 'card' });
    setRunningNowId(null);
  };

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (schedule: RecurringSchedule) => {
    setEditing(schedule);
    setDialogOpen(true);
  };

  const handleToggleEnabled = async (schedule: RecurringSchedule) => {
    setNotice(null);
    const ok = await setEnabled(schedule.id, !schedule.enabled);
    if (!ok) {
      setNotice({
        scheduleId: schedule.id,
        text: t('schedules:errors.actionFailed'),
        isError: true,
        scope: 'card'
      });
    }
  };

  const handleDismiss = async (schedule: RecurringSchedule) => {
    setNotice(null);
    const ok = await acknowledgeReports(
      schedule.id,
      pendingReports(schedule).map((r) => r.id)
    );
    if (!ok) {
      setNotice({
        scheduleId: schedule.id,
        text: t('schedules:errors.actionFailed'),
        isError: true,
        scope: 'banner'
      });
    }
  };

  const requestDelete = (schedule: RecurringSchedule) => {
    setDeleteError(null);
    setPendingDelete(schedule);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const ok = await deleteSchedule(pendingDelete.id);
      if (ok) {
        setPendingDelete(null);
      } else {
        setDeleteError(t('schedules:errors.deleteFailed'));
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const showLoading =
    schedules.length === 0 && !loadError && (isLoading || activeProjectId !== projectId);

  const withReports = schedules.filter((s) => pendingReports(s).length > 0);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('schedules:title')}</h1>
          <p className="text-sm text-muted-foreground">{t('schedules:description')}</p>
        </div>
        {schedules.length > 0 && (
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('schedules:buttons.new')}
          </Button>
        )}
      </div>

      {withReports.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm"
        >
          <div className="mb-2 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            {t('schedules:banner.title')}
          </div>
          <ul className="space-y-2">
            {withReports.map((schedule) => (
              <li key={schedule.id} className="flex items-start justify-between gap-4">
                <div>
                  <span className="font-medium">{schedule.name}</span>
                  <ul className="text-muted-foreground">
                    {pendingReports(schedule).map((record) => (
                      <li key={record.id}>
                        {formatDate(record.at)} - {recordText(record)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleDismiss(schedule)}
                  >
                    {t('schedules:buttons.dismiss')}
                  </Button>
                  {notice?.scheduleId === schedule.id && notice.scope === 'banner' && (
                    <p role="alert" className="text-destructive">
                      {notice.text}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showLoading ? (
        <div
          role="status"
          className="flex flex-1 items-center justify-center text-muted-foreground"
        >
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="ml-2 text-sm">{t('schedules:loading')}</span>
        </div>
      ) : schedules.length === 0 && loadError ? (
        <div className="flex flex-1 items-center justify-center">
          <div role="alert" className="text-center">
            <AlertCircle className="mx-auto mb-2 h-8 w-8 text-destructive" />
            <p className="mb-2 text-sm text-destructive">{t('schedules:errors.loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void loadSchedules(projectId)}>
              <RefreshCw className="mr-1 h-3 w-3" />
              {t('schedules:buttons.retry')}
            </Button>
          </div>
        </div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <CalendarClock className="h-10 w-10 text-muted-foreground" />
          <h2 className="text-lg font-medium">{t('schedules:empty.title')}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t('schedules:empty.description')}
          </p>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t('schedules:buttons.new')}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {schedules.map((schedule) => (
            <Card key={schedule.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {schedule.name}
                      <Badge variant={schedule.enabled ? 'default' : 'secondary'}>
                        {schedule.enabled
                          ? t('schedules:status.active')
                          : t('schedules:status.paused')}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      {cadenceSummary(schedule.cadence)} - {schedule.template.title}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={runningNowId === schedule.id}
                      onClick={() => void handleRunNow(schedule.id)}
                    >
                      <Zap className="mr-1 h-4 w-4" />
                      {t('schedules:buttons.runNow')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleToggleEnabled(schedule)}
                    >
                      {schedule.enabled ? (
                        <Pause className="mr-1 h-4 w-4" />
                      ) : (
                        <Play className="mr-1 h-4 w-4" />
                      )}
                      {schedule.enabled
                        ? t('schedules:buttons.pause')
                        : t('schedules:buttons.resume')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => openEdit(schedule)}>
                      <Pencil className="mr-1 h-4 w-4" />
                      {t('schedules:buttons.edit')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => requestDelete(schedule)}>
                      <Trash2 className="mr-1 h-4 w-4" />
                      {t('schedules:buttons.delete')}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {notice?.scheduleId === schedule.id && notice.scope !== 'banner' && (
                  <p
                    role={notice.isError ? 'alert' : 'status'}
                    className={notice.isError ? 'text-destructive' : 'text-muted-foreground'}
                  >
                    {notice.text}
                  </p>
                )}
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                  <span>
                    {t('schedules:tokenBudgetSummary', {
                      count: schedule.template.tokenBudget
                    })}
                  </span>
                  {schedule.enabled && schedule.nextRunAt !== null && (
                    <span>{t('schedules:nextRun', { date: formatDate(schedule.nextRunAt) })}</span>
                  )}
                  <span>
                    {t('schedules:lastRun', {
                      date: schedule.lastRunAt ? formatDate(schedule.lastRunAt) : t('schedules:never')
                    })}
                  </span>
                  {schedule.lastTaskId && (
                    <span>{t('schedules:lastTask', { id: schedule.lastTaskId })}</span>
                  )}
                </div>
                <div>
                  <h3 className="mb-1 font-medium">{t('schedules:history.title')}</h3>
                  {schedule.history.length === 0 ? (
                    <p className="text-muted-foreground">{t('schedules:history.empty')}</p>
                  ) : (
                    <ul className="space-y-1 text-muted-foreground">
                      {[...schedule.history]
                        .sort((a, b) => b.at - a.at)
                        .slice(0, 10)
                        .map((record) => (
                          <li key={record.id}>
                            {formatDate(record.at)} - {recordText(record)}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        schedule={editing}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('schedules:delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('schedules:delete.description', { name: pendingDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:buttons.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {t('schedules:buttons.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
