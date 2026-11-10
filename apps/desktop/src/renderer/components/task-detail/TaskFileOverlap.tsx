import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { useToast } from '../../hooks/use-toast';
import { useTaskStore, setTaskHold } from '../../stores/task-store';
import {
  findFileOverlaps,
  getPlannedFiles,
  isHoldActive,
  isOverlapCandidate
} from '../../../shared/utils/file-overlap';
import type { Task } from '../../../shared/types';

interface TaskFileOverlapProps {
  task: Task;
}

/**
 * zeenha fork: tells the user which other active tasks plan to change the same
 * files, and lets them hold this task until one of those tasks finishes.
 * Releasing a held queued task is done by the Kanban board's hold-cleared effect.
 */
export function TaskFileOverlap({ task }: TaskFileOverlapProps) {
  const { t } = useTranslation(['tasks']);
  const { toast } = useToast();
  const tasks = useTaskStore((state) => state.tasks);
  const current = tasks.find((x) => x.id === task.id) ?? task;

  if (!isOverlapCandidate(current)) return null;

  const planned = getPlannedFiles(current);
  if (!planned) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="task-overlap-unknown">
        {t('tasks:overlap.unknown')}
      </p>
    );
  }

  const overlaps = findFileOverlaps(tasks).get(current.id) ?? [];
  const holdActive = isHoldActive(current, tasks);
  const blockerId = current.metadata?.holdUntilTaskId;
  const blockerTitle = tasks.find((x) => x.id === blockerId)?.title ?? '';

  const updateHold = async (id: string | null) => {
    const ok = await setTaskHold(current.id, id);
    if (!ok) {
      toast({ title: t('tasks:overlap.holdFailed'), variant: 'destructive' });
    }
  };

  if (overlaps.length === 0 && !holdActive) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="task-overlap-none">
        {t('tasks:overlap.none')}
      </p>
    );
  }

  return (
    <div
      className="rounded-xl border border-warning/30 bg-warning/10 p-4"
      data-testid="task-overlap-warning"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-3">
          <h3 className="font-medium text-sm text-foreground">{t('tasks:overlap.title')}</h3>
          {overlaps.map((overlap) => (
            <div key={overlap.taskId} className="space-y-2">
              <p className="text-sm text-foreground">
                {t('tasks:overlap.sharedWith', { title: overlap.title, count: overlap.files.length })}
              </p>
              <ul className="max-h-32 overflow-y-auto rounded-md bg-background/50 p-2 font-mono text-xs text-muted-foreground">
                {overlap.files.map((file) => (
                  <li key={file} className="break-all">{file}</li>
                ))}
              </ul>
              {!holdActive && (
                <Button
                  variant="warning"
                  size="sm"
                  onClick={() => updateHold(overlap.taskId)}
                >
                  {t('tasks:overlap.wait', { title: overlap.title })}
                </Button>
              )}
            </div>
          ))}
          {holdActive && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">
                {t('tasks:overlap.waitingFor', { title: blockerTitle })}
              </span>
              <Button variant="outline" size="sm" onClick={() => updateHold(null)}>
                {t('tasks:overlap.stopWaiting')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
