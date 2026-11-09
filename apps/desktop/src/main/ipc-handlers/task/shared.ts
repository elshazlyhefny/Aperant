import type { Task, Project } from '../../../shared/types';
import { projectStore } from '../../project-store';

/**
 * Helper function to find task and project by taskId.
 *
 * When projectId is provided, the search is strictly scoped to that project.
 * If the task is not found in the specified project, returns undefined (does NOT
 * fall back to other projects). This prevents cross-project contamination when
 * multiple projects have tasks with the same specId.
 *
 * When projectId is NOT provided, searches all projects for backward
 * compatibility with callers that don't have projectId (e.g., file watcher events).
 * zeenha fork: projects whose last scan contained the task are tried first, then
 * all projects in list order. If several projects contain the same task id, the
 * earliest project in list order that has been scanned wins.
 */
export const findTaskAndProject = (taskId: string, projectId?: string): { task: Task | undefined; project: Project | undefined } => {
  const projects = projectStore.getProjects();

  // If projectId provided, search ONLY that project (no fallback)
  if (projectId) {
    const targetProject = projects.find((p) => p.id === projectId);
    if (!targetProject) {
      console.warn(`[findTaskAndProject] projectId "${projectId}" not found in projects list, returning undefined`);
      return { task: undefined, project: undefined };
    }
    const tasks = projectStore.getTasks(targetProject.id);
    const task = tasks.find((t) => t.id === taskId || t.specId === taskId);
    return { task, project: task ? targetProject : undefined };
  }

  // No projectId: zeenha fork: try the projects the task index hints at first,
  // verifying each against its tasks, so a hit does not scan every project.
  for (const hintedId of projectStore.getProjectIdsForTask(taskId)) {
    const hinted = projects.find((p) => p.id === hintedId);
    if (!hinted) continue;
    const task = projectStore.getTasks(hinted.id).find((t) => t.id === taskId || t.specId === taskId);
    if (task) {
      return { task, project: hinted };
    }
  }

  // No (valid) hint, e.g. before the first scan or for a brand-new task:
  // search all projects (backward compatibility for file watcher etc.)
  for (const p of projects) {
    const tasks = projectStore.getTasks(p.id);
    const task = tasks.find((t) => t.id === taskId || t.specId === taskId);
    if (task) {
      return { task, project: p };
    }
  }

  return { task: undefined, project: undefined };
};
