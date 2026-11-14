import type { TaskStatus } from '../types';

/**
 * Map UI TaskStatus to Python-compatible planStatus
 */
export function mapStatusToPlanStatus(status: TaskStatus): string {
  switch (status) {
    case 'queue':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'ai_review':
    case 'human_review':
      return 'review';
    case 'done':
      return 'completed';
    default:
      return 'pending';
  }
}
