/**
 * zeenha fork: picks the tasks that must be Done before this task may leave
 * the queue (`metadata.taskDependencies`). Does a client-side cycle pre-check
 * with the same function the main process uses.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { findDependencyCycle } from '../../../shared/utils/task-dependencies';
import { TASK_STATUS_LABELS } from '../../../shared/constants/task';
import type { Task } from '../../../shared/types';

interface TaskDependencyPickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  tasks: Task[];
  /** The task being edited; it can't depend on itself. Omit when creating. */
  excludeTaskId?: string;
  disabled?: boolean;
  idPrefix?: string;
}

export function TaskDependencyPicker({
  value,
  onChange,
  tasks,
  excludeTaskId,
  disabled = false,
  idPrefix = 'task',
}: TaskDependencyPickerProps) {
  const { t } = useTranslation(['tasks']);
  const [query, setQuery] = useState('');
  const [cycleError, setCycleError] = useState<string | null>(null);

  const statusLabel = (task: Task) => t(`tasks:${TASK_STATUS_LABELS[task.status] ?? 'columns.backlog'}`);

  const selectedTasks = useMemo(
    () => value.map((id) => ({ id, task: tasks.find((x) => x.id === id || x.specId === id) })),
    [value, tasks]
  );

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter(
      (task) =>
        !task.metadata?.archivedAt &&
        task.id !== excludeTaskId &&
        task.specId !== excludeTaskId &&
        !value.includes(task.id) &&
        !value.includes(task.specId) &&
        (q === '' || task.title.toLowerCase().includes(q) || task.specId.toLowerCase().includes(q))
    );
  }, [tasks, excludeTaskId, value, query]);

  const handleAdd = (task: Task) => {
    const next = [...value, task.id];
    if (excludeTaskId) {
      const cycle = findDependencyCycle(excludeTaskId, next, tasks);
      if (cycle) {
        setCycleError(t('tasks:dependencies.cycleError', { path: cycle.join(' → ') }));
        return;
      }
    }
    setCycleError(null);
    onChange(next);
  };

  const handleRemove = (id: string) => {
    setCycleError(null);
    onChange(value.filter((v) => v !== id));
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-dependency-search`} className="text-sm font-medium text-foreground">
        {t('tasks:dependencies.title')}
      </Label>

      {selectedTasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('tasks:dependencies.none')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {selectedTasks.map(({ id, task }) => (
            <li key={id}>
              <Badge variant="secondary" className="gap-1.5 pr-1">
                <span>{task?.title ?? id}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => handleRemove(id)}
                  aria-label={t('tasks:dependencies.remove', { title: task?.title ?? id })}
                  className="rounded p-0.5 hover:bg-muted"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <Input
        id={`${idPrefix}-dependency-search`}
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('tasks:dependencies.searchPlaceholder')}
      />

      {candidates.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
          {candidates.map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="truncate">
                {task.title}
                <span className="ml-2 text-xs text-muted-foreground">{statusLabel(task)}</span>
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => handleAdd(task)}
                aria-label={t('tasks:dependencies.add', { title: task.title })}
                className="shrink-0 text-xs text-primary hover:underline"
              >
                {t('tasks:dependencies.addButton')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {cycleError && (
        <p role="alert" className="text-xs text-destructive">
          {cycleError}
        </p>
      )}
    </div>
  );
}

/** Map a main-process dependency rejection (DEPENDENCY_*:ids) to a message, or null. */
export function mapDependencyError(
  raw: string | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string
): string | null {
  if (!raw) return null;
  if (raw.startsWith('DEPENDENCY_CYCLE')) {
    return t('tasks:dependencies.cycleError', { path: raw.slice(raw.indexOf(':') + 1).split('->').join(' → ') });
  }
  if (raw.startsWith('DEPENDENCY_SELF')) return t('tasks:dependencies.selfError');
  if (raw.startsWith('DEPENDENCY_UNKNOWN')) return t('tasks:dependencies.unknownError');
  return null;
}
