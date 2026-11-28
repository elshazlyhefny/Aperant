/**
 * Utility functions for spec creation and management
 */

import path from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { AUTO_BUILD_PATHS } from '../../../shared/constants';
import type { Project, TaskMetadata } from '../../../shared/types';
import { allocateSpecDir } from '../../utils/spec-number-lock';
import { debugLog } from './utils/logger';
import { labelMatchesWholeWord } from '../shared/label-utils';
import { sanitizeText, sanitizeStringArray, sanitizeUrl } from '../shared/sanitize';
import { applyDefaultTaskAgent } from '../../utils/default-task-agent';
import { readSettingsFile } from '../../settings-utils';

export interface SpecCreationData {
  specId: string;
  specDir: string;
  taskDescription: string;
  metadata: TaskMetadata;
}

/**
 * Determine task category based on GitHub issue labels
 * Maps to TaskCategory type from shared/types/task.ts
 */
function determineCategoryFromLabels(labels: string[]): 'feature' | 'bug_fix' | 'refactoring' | 'documentation' | 'security' | 'performance' | 'ui_ux' | 'infrastructure' | 'testing' {
  const lowerLabels = labels.map(l => l.toLowerCase());

  // Check for bug labels
  if (lowerLabels.some(l => l.includes('bug') || l.includes('defect') || l.includes('error') || l.includes('fix'))) {
    return 'bug_fix';
  }

  // Check for security labels
  if (lowerLabels.some(l => l.includes('security') || l.includes('vulnerability') || l.includes('cve'))) {
    return 'security';
  }

  // Check for performance labels
  if (lowerLabels.some(l => l.includes('performance') || l.includes('optimization') || l.includes('speed'))) {
    return 'performance';
  }

  // Check for UI/UX labels
  if (lowerLabels.some(l => l.includes('ui') || l.includes('ux') || l.includes('design') || l.includes('styling'))) {
    return 'ui_ux';
  }

  // Check for infrastructure labels
  // Use whole-word matching for 'ci' and 'cd' to avoid false positives like 'acid' or 'decide'
  if (lowerLabels.some(l =>
    l.includes('infrastructure') ||
    l.includes('devops') ||
    l.includes('deployment') ||
    labelMatchesWholeWord(l, 'ci') ||
    labelMatchesWholeWord(l, 'cd')
  )) {
    return 'infrastructure';
  }

  // Check for testing labels
  if (lowerLabels.some(l => l.includes('test') || l.includes('testing') || l.includes('qa'))) {
    return 'testing';
  }

  // Check for refactoring labels
  if (lowerLabels.some(l => l.includes('refactor') || l.includes('cleanup') || l.includes('maintenance') || l.includes('chore') || l.includes('tech-debt') || l.includes('technical debt'))) {
    return 'refactoring';
  }

  // Check for documentation labels
  if (lowerLabels.some(l => l.includes('documentation') || l.includes('docs'))) {
    return 'documentation';
  }

  // Check for enhancement/feature labels (default)
  // This catches 'enhancement', 'feature', 'improvement', or any unlabeled issues
  return 'feature';
}

/**
 * Create a new spec directory and initial files
 * Uses coordinated spec numbering to prevent collisions across worktrees
 */
export async function createSpecForIssue(
  project: Project,
  issueNumber: number,
  issueTitle: string,
  taskDescription: string,
  githubUrl: string,
  labels: string[] = [],
  baseBranch?: string
): Promise<SpecCreationData> {
  // Sanitize network-sourced data before writing to disk
  const safeTitle = sanitizeText(issueTitle, 500);
  const safeDescription = sanitizeText(taskDescription, 50000, true);
  const safeGithubUrl = sanitizeUrl(githubUrl);
  const safeLabels = sanitizeStringArray(labels, 50, 200);

  // zeenha fork: the shared allocator takes the spec number lock, picks the
  // next number (main + all worktrees) and creates the directory under it.
  const { specId, specDir } = await allocateSpecDir(project, safeTitle);

  // Create initial files
  const now = new Date().toISOString();

  // implementation_plan.json
  const implementationPlan = {
    feature: safeTitle,
    description: safeDescription,
    created_at: now,
    updated_at: now,
    status: 'pending',
    phases: []
  };
  // lgtm[js/http-to-file-access] - specDir is controlled, slugifiedTitle sanitizes input
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
    JSON.stringify(implementationPlan, null, 2),
    'utf-8'
  );

  // requirements.json
  const requirements = {
    task_description: safeDescription,
    workflow_type: 'feature'
  };
  // lgtm[js/http-to-file-access] - specDir is controlled, slugifiedTitle sanitizes input
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS),
    JSON.stringify(requirements, null, 2),
    'utf-8'
  );

  // Determine category from GitHub issue labels
  const category = determineCategoryFromLabels(safeLabels);

  // task_metadata.json
  // zeenha fork: tasks created here get the Settings default task agent, like tasks created by hand.
  const metadata: TaskMetadata = applyDefaultTaskAgent({
    sourceType: 'github',
    githubIssueNumber: issueNumber,
    githubUrl: safeGithubUrl,
    category,
    // Store baseBranch for worktree creation and QA comparison
    // This comes from project.settings.mainBranch or task-level override
    ...(baseBranch && { baseBranch })
  }, readSettingsFile());
  // lgtm[js/http-to-file-access] - specDir is controlled, slugifiedTitle sanitizes input
  writeFileSync(
    path.join(specDir, 'task_metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  );

  return {
    specId,
    specDir,
    taskDescription: safeDescription,
    metadata
  };
}

/**
 * Build issue context with comments
 */
export function buildIssueContext(
  issueNumber: number,
  issueTitle: string,
  issueBody: string | undefined,
  labels: string[],
  htmlUrl: string,
  comments: Array<{ body: string; user: { login: string } }>
): string {
  return `
# GitHub Issue #${issueNumber}: ${issueTitle}

${issueBody || 'No description provided.'}

${comments.length > 0 ? `## Comments (${comments.length}):
${comments.map(c => `**${c.user.login}:** ${c.body}`).join('\n\n')}` : ''}

**Labels:** ${labels.join(', ') || 'None'}
**URL:** ${htmlUrl}
`;
}

/**
 * Build investigation task description
 */
export function buildInvestigationTask(
  issueNumber: number,
  issueTitle: string,
  issueContext: string
): string {
  return `Investigate GitHub Issue #${issueNumber}: ${issueTitle}

${issueContext}

Please analyze this issue and provide:
1. A brief summary of what the issue is about
2. A proposed solution approach
3. The files that would likely need to be modified
4. Estimated complexity (simple/standard/complex)
5. Acceptance criteria for resolving this issue`;
}

/**
 * Update implementation plan status
 * Used to immediately update the plan file so the frontend shows the correct status
 */
export function updateImplementationPlanStatus(specDir: string, status: string): void {
  const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

  try {
    const content = readFileSync(planPath, 'utf-8');
    const plan = JSON.parse(content);
    plan.status = status;
    plan.updated_at = new Date().toISOString();
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
  } catch (error) {
    // File doesn't exist or couldn't be read - this is expected for new specs
    // Log legitimate errors (malformed JSON, disk write failures, permission errors)
    if (error instanceof Error && error.message && !error.message.includes('ENOENT')) {
      debugLog('spec-utils', `Failed to update implementation plan status: ${error.message}`);
    }
  }
}
