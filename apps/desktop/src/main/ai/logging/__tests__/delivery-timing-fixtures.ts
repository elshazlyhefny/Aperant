/** zeenha fork: fixed, synthetic timelines shared by the parity test and baseline report. */
import type { ReviewReason, TaskStatus } from '../../../../shared/types';
import type { DeliveryTimingResult } from '../../../../shared/types/run-metrics';

export const FIXTURE_QUEUE_ENTRY = Date.parse('2026-06-30T12:00:00.000Z');
const MINUTE = 60_000;

export interface DeliveryTimingStep {
  /** Milliseconds from the first queue entry, not from the previous step. */
  afterMs: number;
  status: TaskStatus;
  reviewReason?: ReviewReason;
  pause?: 'budget' | 'credential';
  interrupted?: true;
}

interface DeliveryTimingScenario {
  name: string;
  steps: readonly DeliveryTimingStep[];
  /** Defaults to the desktop steps when statuses and reasons are shared. */
  daemonSteps?: readonly DeliveryTimingStep[];
  expected: DeliveryTimingResult;
}

function step(
  minutes: number,
  status: TaskStatus,
  options: Omit<DeliveryTimingStep, 'afterMs' | 'status'> = {}
): DeliveryTimingStep {
  return { afterMs: minutes * MINUTE, status, ...options };
}

function complete(
  total: number,
  { queued, active, credential = 0, budget = 0, other = 0 }: {
    queued: number;
    active: number;
    credential?: number;
    budget?: number;
    other?: number;
  }
): DeliveryTimingResult {
  return {
    state: 'complete',
    startedAt: new Date(FIXTURE_QUEUE_ENTRY).toISOString(),
    reviewReadyAt: new Date(FIXTURE_QUEUE_ENTRY + total * MINUTE).toISOString(),
    totalMs: total * MINUTE,
    segments: {
      queuedMs: queued * MINUTE,
      activeMs: active * MINUTE,
      credentialPauseMs: credential * MINUTE,
      budgetPauseMs: budget * MINUTE,
      otherMs: other * MINUTE
    }
  };
}

const budgetResumeSteps = (pause: DeliveryTimingStep) => [
  step(0, 'queue'),
  step(2, 'in_progress'),
  pause,
  step(42, 'in_progress'),
  step(52, 'human_review', { reviewReason: 'completed' })
];

export const DELIVERY_TIMING_SCENARIOS: readonly DeliveryTimingScenario[] = [
  {
    name: 'A: clean delivery',
    steps: [
      step(0, 'queue'),
      step(10, 'in_progress'),
      step(40, 'ai_review'),
      step(55, 'human_review', { reviewReason: 'completed' })
    ],
    expected: complete(55, { queued: 10, active: 45 })
  },
  {
    name: 'B: credential pause and requeue',
    steps: [
      step(0, 'queue'),
      step(5, 'in_progress'),
      step(20, 'human_review', { reviewReason: 'account_required' }),
      step(50, 'queue'),
      step(60, 'in_progress'),
      step(80, 'human_review', { reviewReason: 'completed' })
    ],
    expected: complete(80, { queued: 15, active: 35, credential: 30 })
  },
  {
    name: 'C: budget pause and direct resume',
    steps: budgetResumeSteps(step(12, 'human_review', { reviewReason: 'token_budget' })),
    daemonSteps: budgetResumeSteps(step(12, 'error', { pause: 'budget' })),
    expected: complete(52, { queued: 2, active: 20, budget: 30 })
  },
  {
    name: 'D: credential pause without resume',
    steps: [step(0, 'queue'), step(5, 'in_progress'), step(20, 'human_review', { reviewReason: 'account_required' })],
    expected: { state: 'open' }
  },
  {
    name: 'E: QA rejected, then fixed',
    steps: [
      step(0, 'queue'),
      step(4, 'in_progress'),
      step(14, 'ai_review'),
      step(24, 'human_review', { reviewReason: 'qa_rejected' }),
      step(34, 'in_progress'),
      step(44, 'ai_review'),
      step(54, 'human_review', { reviewReason: 'completed' })
    ],
    expected: complete(54, { queued: 4, active: 40, other: 10 })
  },
  {
    name: 'F: restart recovery while active',
    steps: [
      step(0, 'queue'),
      step(5, 'in_progress'),
      step(20, 'queue', { interrupted: true }),
      step(25, 'in_progress'),
      step(40, 'human_review', { reviewReason: 'completed' })
    ],
    expected: { state: 'incomplete', reason: 'interrupted' }
  }
];
