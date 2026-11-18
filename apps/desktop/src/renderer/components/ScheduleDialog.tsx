import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { cn } from '../lib/utils';
import { useScheduleStore } from '../stores/schedule-store';
import { validateCadence } from '../../shared/utils/schedule-time';
import {
  DEFAULT_SCHEDULE_TOKEN_BUDGET,
  MIN_INTERVAL_MINUTES,
  type RecurringSchedule,
  type ScheduleCadence
} from '../../shared/types/schedule';

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** When set the dialog edits this schedule, otherwise it creates one. */
  schedule?: RecurringSchedule | null;
}

type CadenceKind = ScheduleCadence['kind'];
type ScheduleField = 'name' | 'title' | 'description' | 'time' | 'days' | 'interval' | 'budget';
interface FormError {
  field: ScheduleField | null;
  message: string;
}

const DEFAULT_TIME = '09:00';
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** Create/edit dialog for a recurring schedule. */
export function ScheduleDialog({ open, onOpenChange, projectId, schedule }: ScheduleDialogProps) {
  const { t } = useTranslation(['schedules', 'common']);
  const createSchedule = useScheduleStore((s) => s.createSchedule);
  const updateSchedule = useScheduleStore((s) => s.updateSchedule);

  const [name, setName] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<CadenceKind>('daily');
  const [time, setTime] = useState(DEFAULT_TIME);
  const [days, setDays] = useState<number[]>([1]);
  const [everyMinutes, setEveryMinutes] = useState('60');
  const [tokenBudget, setTokenBudget] = useState(String(DEFAULT_SCHEDULE_TOKEN_BUDGET));
  const [error, setError] = useState<FormError | null>(null);
  const [saving, setSaving] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const daysRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<HTMLInputElement>(null);
  const budgetRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    if (schedule) {
      setName(schedule.name);
      setTaskTitle(schedule.template.title);
      setDescription(schedule.template.description);
      setTokenBudget(String(schedule.template.tokenBudget));
      const c = schedule.cadence;
      setKind(c.kind);
      setTime(c.kind === 'interval' ? DEFAULT_TIME : c.time);
      setDays(c.kind === 'weekly' ? c.days : [1]);
      setEveryMinutes(c.kind === 'interval' ? String(c.everyMinutes) : '60');
    } else {
      setName('');
      setTaskTitle('');
      setDescription('');
      setTokenBudget(String(DEFAULT_SCHEDULE_TOKEN_BUDGET));
      setKind('daily');
      setTime(DEFAULT_TIME);
      setDays([1]);
      setEveryMinutes('60');
    }
  }, [open, schedule]);

  const buildCadence = (): ScheduleCadence => {
    if (kind === 'daily') return { kind, time };
    if (kind === 'weekly') return { kind, time, days: [...days].sort((a, b) => a - b) };
    return { kind, everyMinutes: Number(everyMinutes) };
  };

  const validate = (cadence: ScheduleCadence, budget: number): FormError | null => {
    if (!name.trim()) return { field: 'name', message: t('schedules:validation.nameRequired') };
    if (!taskTitle.trim()) return { field: 'title', message: t('schedules:validation.titleRequired') };
    if (!description.trim()) {
      return { field: 'description', message: t('schedules:validation.descriptionRequired') };
    }
    if (!validateCadence(cadence).ok) {
      if (cadence.kind === 'interval') {
        return {
          field: 'interval',
          message: t('schedules:validation.intervalMin', { min: MIN_INTERVAL_MINUTES })
        };
      }
      if (cadence.kind === 'weekly' && cadence.days.length === 0) {
        return { field: 'days', message: t('schedules:validation.noDays') };
      }
      return { field: 'time', message: t('schedules:validation.invalidTime') };
    }
    if (!Number.isInteger(budget) || budget <= 0) {
      return { field: 'budget', message: t('schedules:validation.budgetInvalid') };
    }
    return null;
  };

  const focusField = (field: ScheduleField | null) => {
    const refs = {
      name: nameRef,
      title: titleRef,
      description: descriptionRef,
      time: timeRef,
      days: daysRef,
      interval: intervalRef,
      budget: budgetRef
    };
    if (field) refs[field].current?.focus();
  };

  const invalidProps = (field: ScheduleField, hintId?: string) => {
    const failed = error?.field === field;
    const describedBy = [hintId, failed ? 'schedule-error' : undefined].filter(Boolean).join(' ');
    return {
      'aria-invalid': failed || undefined,
      'aria-describedby': describedBy || undefined
    };
  };

  const handleSave = async () => {
    const cadence = buildCadence();
    const budget = Number(tokenBudget);
    const validationError = validate(cadence, budget);
    if (validationError) {
      setError(validationError);
      focusField(validationError.field);
      return;
    }
    setSaving(true);
    const input = {
      projectId,
      name: name.trim(),
      cadence,
      template: {
        ...(schedule?.template ?? {}),
        title: taskTitle.trim(),
        description: description.trim(),
        tokenBudget: budget
      }
    };
    const saved = schedule
      ? await updateSchedule(schedule.id, input)
      : await createSchedule(projectId, input);
    setSaving(false);
    if (saved) {
      onOpenChange(false);
    } else {
      setError({
        field: null,
        message: useScheduleStore.getState().error ?? t('schedules:errors.saveFailed')
      });
    }
  };

  const toggleDay = (day: number) => {
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
    setError(null);
  };

  const cadenceKinds: { value: CadenceKind; label: string }[] = [
    { value: 'daily', label: t('schedules:form.cadenceDaily') },
    { value: 'weekly', label: t('schedules:form.cadenceWeekly') },
    { value: 'interval', label: t('schedules:form.cadenceCustom') }
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {schedule ? t('schedules:form.editTitle') : t('schedules:form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('schedules:form.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="schedule-name">{t('schedules:form.name')}</Label>
            <Input
              id="schedule-name"
              ref={nameRef}
              {...invalidProps('name')}
              value={name}
              placeholder={t('schedules:form.namePlaceholder')}
              onChange={(e) => { setName(e.target.value); setError(null); }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="schedule-task-title">{t('schedules:form.taskTitle')}</Label>
            <Input
              id="schedule-task-title"
              ref={titleRef}
              {...invalidProps('title')}
              value={taskTitle}
              onChange={(e) => { setTaskTitle(e.target.value); setError(null); }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="schedule-task-description">{t('schedules:form.taskDescription')}</Label>
            <Textarea
              id="schedule-task-description"
              ref={descriptionRef}
              {...invalidProps('description')}
              rows={4}
              value={description}
              placeholder={t('schedules:form.taskDescriptionPlaceholder')}
              onChange={(e) => { setDescription(e.target.value); setError(null); }}
            />
          </div>

          <div className="space-y-2">
            <Label id="schedule-cadence-label">{t('schedules:form.cadence')}</Label>
            <div role="group" aria-labelledby="schedule-cadence-label" className="flex gap-2">
              {cadenceKinds.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={kind === option.value ? 'default' : 'outline'}
                  aria-pressed={kind === option.value}
                  onClick={() => { setKind(option.value); setError(null); }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          {kind !== 'interval' && (
            <div className="space-y-2">
              <Label htmlFor="schedule-time">{t('schedules:form.time')}</Label>
              <Input
                id="schedule-time"
                ref={timeRef}
                {...invalidProps('time')}
                type="time"
                value={time}
                onChange={(e) => { setTime(e.target.value); setError(null); }}
                className="w-40"
              />
            </div>
          )}

          {kind === 'weekly' && (
            <div className="space-y-2">
              <Label id="schedule-weekdays-label">{t('schedules:form.weekdays')}</Label>
              <div
                ref={daysRef}
                tabIndex={-1}
                role="group"
                aria-labelledby="schedule-weekdays-label"
                aria-describedby={error?.field === 'days' ? 'schedule-error' : undefined}
                className="flex flex-wrap gap-2"
              >
                {WEEKDAYS.map((day) => (
                  <Button
                    key={day}
                    type="button"
                    size="sm"
                    variant={days.includes(day) ? 'default' : 'outline'}
                    className={cn('min-w-12')}
                    aria-pressed={days.includes(day)}
                    onClick={() => toggleDay(day)}
                  >
                    {t(`schedules:weekdays.${day}`)}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {kind === 'interval' && (
            <div className="space-y-2">
              <Label htmlFor="schedule-interval">{t('schedules:form.everyMinutes')}</Label>
              <Input
                id="schedule-interval"
                ref={intervalRef}
                {...invalidProps('interval', 'schedule-interval-hint')}
                type="number"
                min={MIN_INTERVAL_MINUTES}
                value={everyMinutes}
                onChange={(e) => { setEveryMinutes(e.target.value); setError(null); }}
                className="w-40"
              />
              <p id="schedule-interval-hint" className="text-sm text-muted-foreground">
                {t('schedules:form.everyMinutesHint', { min: MIN_INTERVAL_MINUTES })}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="schedule-token-budget">{t('schedules:form.tokenBudget')}</Label>
            <Input
              id="schedule-token-budget"
              ref={budgetRef}
              {...invalidProps('budget', 'schedule-budget-hint')}
              type="number"
              min={1}
              value={tokenBudget}
              onChange={(e) => { setTokenBudget(e.target.value); setError(null); }}
            />
            <p id="schedule-budget-hint" className="text-sm text-muted-foreground">
              {t('schedules:form.tokenBudgetHint')}
            </p>
          </div>

          {error && (
            <p id="schedule-error" role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:buttons.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {t('common:buttons.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
