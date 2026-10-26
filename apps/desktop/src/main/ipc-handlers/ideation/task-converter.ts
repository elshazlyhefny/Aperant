/**
 * Convert ideation ideas to tasks
 */

import path from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { IpcMainInvokeEvent } from 'electron';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type {
  IPCResult,
  Task,
  ImplementationPlan,
  TaskMetadata,
  TaskCategory,
  TaskImpact,
  TaskComplexity,
  TaskPriority
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { normalizeIdea, readIdeationFile, writeIdeationFile, updateIdeationTimestamp } from './file-utils';
import type { RawIdea } from './types';
import { withSpecNumberLock } from '../../utils/spec-number-lock';
import { slugifySpecTitle } from '../../utils/spec-slug';

/**
 * Create a slugified version of a title for use in directory names
 */
function slugifyTitle(title: string): string {
  return slugifySpecTitle(title);
}

/**
 * zeenha fork: the sections each idea type carries into its task, in order.
 * Only code improvements and UI/UX ideas had any, so a converted security,
 * code quality, performance or documentation idea became a task with no
 * remediation, proposed change or affected files: the spec writer started
 * from the title, description and rationale alone.
 */
const TASK_SECTIONS: Record<string, ReadonlyArray<readonly [field: string, heading: string]>> = {
  code_improvements: [
    ['builds_upon', 'Builds Upon'],
    ['implementation_approach', 'Implementation Approach'],
    ['affected_files', 'Affected Files'],
    ['existing_patterns', 'Patterns to Follow'],
  ],
  ui_ux_improvements: [
    ['category', 'Category'],
    ['current_state', 'Current State'],
    ['proposed_change', 'Proposed Change'],
    ['user_benefit', 'User Benefit'],
    ['affected_components', 'Affected Components'],
  ],
  documentation_gaps: [
    ['category', 'Category'],
    ['target_audience', 'Target Audience'],
    ['current_documentation', 'Current Documentation'],
    ['proposed_content', 'Proposed Content'],
    ['affected_areas', 'Affected Areas'],
  ],
  security_hardening: [
    ['severity', 'Severity'],
    ['vulnerability', 'Vulnerability'],
    ['current_risk', 'Current Risk'],
    ['remediation', 'Remediation'],
    ['affected_files', 'Affected Files'],
    ['references', 'References'],
    ['compliance', 'Compliance'],
  ],
  performance_optimizations: [
    ['impact', 'Impact'],
    ['current_metric', 'Current Metric'],
    ['expected_improvement', 'Expected Improvement'],
    ['implementation', 'Implementation'],
    ['tradeoffs', 'Tradeoffs'],
    ['affected_areas', 'Affected Areas'],
  ],
  code_quality: [
    ['severity', 'Severity'],
    ['current_state', 'Current State'],
    ['proposed_change', 'Proposed Change'],
    ['code_example', 'Code Example'],
    ['best_practice', 'Best Practice'],
    ['affected_files', 'Affected Files'],
    ['prerequisites', 'Prerequisites'],
    ['breaking_change', 'Breaking Change'],
  ],
};

function formatSection(heading: string, value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.filter((v) => typeof v === 'string' && v.trim());
    return items.length > 0 ? `## ${heading}\n${items.map((v) => `- ${v}`).join('\n')}\n\n` : '';
  }
  if (typeof value === 'boolean') return value ? `## ${heading}\nYes\n\n` : '';
  if (typeof value !== 'string' || !value.trim()) return '';
  return heading === 'Code Example' ? `## ${heading}\n\`\`\`\n${value}\n\`\`\`\n\n` : `## ${heading}\n${value}\n\n`;
}

/**
 * Build task description from idea data
 */
export function buildTaskDescription(rawIdea: RawIdea): string {
  // ideation.json files written before normalizeIdea may still hold camelCase keys
  const idea = normalizeIdea(rawIdea, '');
  let description = `# ${idea.title}\n\n`;
  description += `## Overview\n\n${idea.description}\n\n`;
  description += `## Rationale\n${idea.rationale}\n\n`;
  for (const [field, heading] of TASK_SECTIONS[idea.type] ?? []) {
    description += formatSection(heading, idea[field]);
  }
  return description;
}

/**
 * Build task metadata from idea
 */
function buildTaskMetadata(idea: RawIdea): TaskMetadata {
  const metadata: TaskMetadata = {
    sourceType: 'ideation',
    ideationType: idea.type,
    ideaId: idea.id,
    rationale: idea.rationale
  };

  // Map idea type to task category
  const ideaTypeToCategory: Record<string, TaskCategory> = {
    'code_improvements': 'feature',
    'ui_ux_improvements': 'ui_ux',
    'documentation_gaps': 'documentation',
    'security_hardening': 'security',
    'performance_optimizations': 'performance',
    'code_quality': 'refactoring'
  };
  metadata.category = ideaTypeToCategory[idea.type] || 'feature';

  // zeenha fork: four of the six idea types are written in camelCase
  // (affectedFiles, estimatedEffort, ...). Only the snake_case names were read,
  // so tasks made from those ideas lost their files, effort and audience.
  const pick = <T,>(snake: T | undefined, camel: T | undefined): T | undefined => snake ?? camel;

  // Extract type-specific metadata with proper type casting
  if (idea.type === 'code_improvements') {
    const effort = pick(idea.estimated_effort, idea.estimatedEffort) as TaskComplexity | undefined;
    metadata.estimatedEffort = effort;
    metadata.complexity = effort;
    metadata.affectedFiles = pick(idea.affected_files, idea.affectedFiles);
  } else if (idea.type === 'ui_ux_improvements') {
    metadata.uiuxCategory = idea.category;
    metadata.affectedFiles = pick(idea.affected_components, idea.affectedComponents);
    metadata.problemSolved = pick(idea.current_state, idea.currentState);
  } else if (idea.type === 'documentation_gaps') {
    metadata.estimatedEffort = pick(idea.estimated_effort, idea.estimatedEffort) as TaskComplexity | undefined;
    metadata.priority = idea.priority as TaskPriority | undefined;
    metadata.targetAudience = pick(idea.target_audience, idea.targetAudience);
    metadata.affectedFiles = pick(idea.affected_areas, idea.affectedAreas);
  } else if (idea.type === 'security_hardening') {
    const severity = idea.severity as 'low' | 'medium' | 'high' | 'critical' | undefined;
    metadata.securitySeverity = severity;
    metadata.impact = severity as TaskImpact | undefined;
    metadata.priority = severity === 'critical' ? 'urgent' : severity === 'high' ? 'high' : 'medium';
    metadata.affectedFiles = pick(idea.affected_files, idea.affectedFiles);
  } else if (idea.type === 'performance_optimizations') {
    metadata.performanceCategory = idea.category;
    metadata.impact = idea.impact as TaskImpact | undefined;
    metadata.estimatedEffort = pick(idea.estimated_effort, idea.estimatedEffort) as TaskComplexity | undefined;
    metadata.affectedFiles = pick(idea.affected_areas, idea.affectedAreas);
  } else if (idea.type === 'code_quality') {
    const severity = idea.severity as 'suggestion' | 'minor' | 'major' | 'critical' | undefined;
    metadata.codeQualitySeverity = severity;
    metadata.estimatedEffort = pick(idea.estimated_effort, idea.estimatedEffort) as TaskComplexity | undefined;
    metadata.affectedFiles = pick(idea.affected_files, idea.affectedFiles);
    metadata.priority = severity === 'critical' ? 'urgent' : severity === 'major' ? 'high' : 'medium';
  }

  return metadata;
}

/**
 * Create spec directory structure and files
 */
function createSpecFiles(
  specDir: string,
  idea: RawIdea,
  taskDescription: string
): void {
  // Create the spec directory
  mkdirSync(specDir, { recursive: true });

  // Create initial implementation_plan.json
  const initialPlan: ImplementationPlan = {
    feature: idea.title,
    description: idea.description,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'backlog',
    planStatus: 'pending',
    phases: [],
    workflow_type: 'development',
    services_involved: [],
    final_acceptance: [],
    spec_file: 'spec.md'
  };
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
    JSON.stringify(initialPlan, null, 2),
    'utf-8'
  );

  // Create initial spec.md
  // zeenha fork: from the full task description. It was built from the title,
  // description and rationale only, so the idea's remediation, proposed change
  // and affected files never reached the planner: all 69 ideation tasks in
  // zeenha-ai started from a 12-line spec, and task 007 built half its fix
  // because the other half (redact `otp`/`code`) was only in `remediation`.
  const specContent = `${taskDescription.trimEnd()}

---
*This spec was created from ideation and is pending detailed specification.*
`;
  writeFileSync(path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE), specContent, 'utf-8');
}

/**
 * Convert an idea to a task
 */
export async function convertIdeaToTask(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaId: string
): Promise<IPCResult<Task>> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const ideationPath = path.join(
    project.path,
    AUTO_BUILD_PATHS.IDEATION_DIR,
    AUTO_BUILD_PATHS.IDEATION_FILE
  );

  // zeenha fork: no early "Ideation not found" when ideation.json is missing:
  // readIdeationFile() (inside the lock) builds it from the per-category files.

  // Get specs directory path
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specsDir = path.join(project.path, specsBaseDir);

  // Ensure specs directory exists
  if (!existsSync(specsDir)) {
    mkdirSync(specsDir, { recursive: true });
  }

  try {
    // Use coordinated spec numbering with lock to prevent collisions
    // CRITICAL: All state checks must happen INSIDE the lock to prevent TOCTOU race conditions
    return await withSpecNumberLock(project.path, async (lock) => {
      // Re-read ideation file INSIDE the lock to get fresh state
      const ideation = readIdeationFile(ideationPath);
      if (!ideation) {
        return { success: false, error: 'Ideation not found' };
      }

      // Find the idea (inside lock for fresh state)
      const idea = ideation.ideas?.find((i) => i.id === ideaId);
      if (!idea) {
        return { success: false, error: 'Idea not found' };
      }

      // Idempotency check INSIDE lock - prevents TOCTOU race condition
      // Two concurrent requests can both pass an outside check, but only one
      // can hold the lock at a time, so this check is authoritative
      if (idea.linked_task_id) {
        return {
          success: false,
          error: `Idea has already been converted to task: ${idea.linked_task_id}`
        };
      }

      // Get next spec number from global scan (main + all worktrees)
      const nextNum = lock.getNextSpecNumber(project.autoBuildPath);
      const slugifiedTitle = slugifyTitle(idea.title);
      const specId = `${String(nextNum).padStart(3, '0')}-${slugifiedTitle}`;
      const specDir = path.join(specsDir, specId);

      // Build task description and metadata
      const taskDescription = buildTaskDescription(idea);
      const metadata = buildTaskMetadata(idea);

      // Create spec files (inside lock to ensure atomicity)
      createSpecFiles(specDir, idea, taskDescription);

      // Save metadata
      const metadataPath = path.join(specDir, 'task_metadata.json');
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

      // Update idea status to archived (converted ideas are archived)
      idea.status = 'archived';
      idea.linked_task_id = specId;
      updateIdeationTimestamp(ideation);
      writeIdeationFile(ideationPath, ideation);

      // Create task object to return
      const task: Task = {
        id: specId,
        specId: specId,
        projectId,
        title: idea.title,
        description: taskDescription,
        status: 'backlog',
        subtasks: [],
        logs: [],
        metadata,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      return { success: true, data: task };
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to convert idea to task'
    };
  }
}
