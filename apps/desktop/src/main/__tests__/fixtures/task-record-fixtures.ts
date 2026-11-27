import type { ReviewReason, TaskStatus } from '../../../shared/types';

interface TaskRecordFixture {
  name: string;
  specId: string;
  /** A string is written to implementation_plan.json as-is. */
  plan?: object | string;
  requirements?: object;
  specMd?: string;
  expected: {
    status: TaskStatus;
    reviewReason?: ReviewReason;
    title: string;
    description: string;
    subtaskIds: string[];
    subtaskFiles?: Record<string, string[]>;
    createdAt?: string;
    updatedAt?: string;
  };
}

// Keep plans old and incomplete coding states unfinished so the desktop reader
// does not auto-correct the fixture. Unreadable plans are tested per reader.
const timestamps = {
  created_at: '2023-12-31T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

export const TASK_RECORD_FIXTURES: TaskRecordFixture[] = [
  {
    name: 'prefers the trimmed requirements description and preserves timestamps',
    specId: '051-description-priority',
    plan: { ...timestamps, feature: 'Plan Feature', description: 'Plan description' },
    requirements: { task_description: '  Original request\n' },
    specMd: '# Spec Title\n\n## Overview\n\nSpec overview',
    expected: {
      status: 'backlog',
      title: 'Plan Feature',
      description: 'Original request',
      subtaskIds: [],
      createdAt: '2023-12-31T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  },
  {
    name: 'uses the plan description and title when requirements are missing',
    specId: '052-missing-requirements',
    plan: { ...timestamps, title: 'Legacy Plan Title', description: 'Plan description' },
    specMd: '# Spec Title\n\n## Overview\n\nSpec overview',
    expected: { status: 'backlog', title: 'Legacy Plan Title', description: 'Plan description', subtaskIds: [] },
  },
  {
    name: 'uses the plan description when requirements are blank',
    specId: '053-blank-requirements',
    plan: { ...timestamps, feature: 'Plan Feature', description: 'Plan description' },
    requirements: { task_description: ' \n\t ' },
    specMd: '## Overview\n\nSpec overview',
    expected: { status: 'backlog', title: 'Plan Feature', description: 'Plan description', subtaskIds: [] },
  },
  {
    name: 'replaces a spec-ID feature with the Specification heading and uses the Overview',
    specId: '054-foo',
    plan: { ...timestamps, feature: '054-foo' },
    specMd: '# Specification: Real Title\n\n## Overview\n\nSpec overview',
    expected: { status: 'backlog', title: 'Real Title', description: 'Spec overview', subtaskIds: [] },
  },
  {
    name: 'replaces a spec-ID feature with the Quick Spec heading',
    specId: '055-quick',
    plan: { ...timestamps, feature: '055-quick' },
    specMd: '# Quick Spec: Quick Title',
    expected: { status: 'backlog', title: 'Quick Title', description: '', subtaskIds: [] },
  },
  {
    name: 'keeps a spec-ID title when Markdown is missing',
    specId: '056-no-markdown',
    plan: { ...timestamps, feature: '056-no-markdown' },
    expected: { status: 'backlog', title: '056-no-markdown', description: '', subtaskIds: [] },
  },
  {
    name: 'uses the directory name when there is no plan or Markdown',
    specId: '057-no-plan',
    expected: { status: 'backlog', title: '057-no-plan', description: '', subtaskIds: [] },
  },
  {
    name: 'uses the Markdown heading and overview when there is no plan',
    specId: '058-markdown-only',
    specMd: '# Markdown Title\n\n## Overview\n\nSpec overview',
    expected: { status: 'backlog', title: 'Markdown Title', description: 'Spec overview', subtaskIds: [] },
  },
  {
    name: 'flattens legacy chunks and current subtasks and extracts their files',
    specId: '059-chunks',
    plan: {
      ...timestamps,
      feature: 'Mixed Phases',
      status: 'in_progress',
      reviewReason: 'errors',
      phases: [
        {
          chunks: [
            {
              id: 'legacy-chunk',
              title: 'Legacy chunk',
              description: 'Update the reader',
              status: 'completed',
              files_to_modify: ['reader.ts'],
              files_to_create: ['reader.test.ts', 'reader.ts'],
            },
          ],
        },
        {
          subtasks: [
            {
              id: 'current-subtask',
              title: 'Current subtask',
              description: 'Add documentation',
              status: 'pending',
              files_to_create: ['guide.md'],
            },
          ],
        },
      ],
    },
    expected: {
      status: 'in_progress',
      title: 'Mixed Phases',
      description: '',
      subtaskIds: ['legacy-chunk', 'current-subtask'],
      subtaskFiles: { 'legacy-chunk': ['reader.ts', 'reader.test.ts'], 'current-subtask': ['guide.md'] },
    },
  },
  {
    name: 'falls back to backlog for unknown status',
    specId: '060-unknown-status',
    plan: { ...timestamps, status: 'weird', feature: 'Unknown Status' },
    expected: { status: 'backlog', title: 'Unknown Status', description: '', subtaskIds: [] },
  },
  {
    name: 'keeps the review reason for human review',
    specId: '061-human-review',
    plan: { ...timestamps, status: 'human_review', reviewReason: 'qa_rejected', feature: 'Human Review' },
    expected: {
      status: 'human_review',
      reviewReason: 'qa_rejected',
      title: 'Human Review',
      description: '',
      subtaskIds: [],
    },
  },
  {
    name: 'drops the review reason for AI review',
    specId: '062-ai-review',
    plan: { ...timestamps, status: 'ai_review', reviewReason: 'errors', feature: 'AI Review' },
    expected: { status: 'ai_review', title: 'AI Review', description: '', subtaskIds: [] },
  },
  {
    name: 'maps queued to queue',
    specId: '063-queued',
    plan: { ...timestamps, status: 'queued', feature: 'Queued Plan' },
    expected: { status: 'queue', title: 'Queued Plan', description: '', subtaskIds: [] },
  },
  {
    name: 'maps completed to done',
    specId: '064-completed',
    plan: { ...timestamps, status: 'completed', feature: 'Completed Plan' },
    expected: { status: 'done', title: 'Completed Plan', description: '', subtaskIds: [] },
  },
  {
    name: 'maps review to AI review',
    specId: '065-review',
    plan: { ...timestamps, status: 'review', feature: 'Review Plan' },
    expected: { status: 'ai_review', title: 'Review Plan', description: '', subtaskIds: [] },
  },
];
