// zeenha fork: board banner shown while the serve daemon holds the queue lock
import { ServerCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../shared/types';

interface DaemonQueueBannerProps {
  lockedBy: string;
  taskIds: string[];
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

export function DaemonQueueBanner({ lockedBy, taskIds, tasks, onTaskClick }: DaemonQueueBannerProps) {
  const { t } = useTranslation('tasks');

  const running = taskIds
    .map((id) => ({ id, task: tasks.find((x) => x.id === id) }))
    .filter((entry): entry is { id: string; task: Task } => entry.task?.status === 'in_progress');

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <ServerCog className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{t('kanban.daemonQueue.title', { holder: lockedBy })}</p>
        <p className="text-muted-foreground">{t('kanban.daemonQueue.paused')}</p>
        {running.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t('kanban.daemonQueue.running')}</span>
            {running.map(({ id, task }) => (
              <button
                key={id}
                type="button"
                data-testid={`daemon-task-${id}`}
                onClick={() => onTaskClick(task)}
                className="max-w-xs truncate rounded-md border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent"
              >
                {task.title || id}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
