/**
 * zeenha fork: IPC handler for project-wide delivery and token metrics.
 */
import { ipcMain } from 'electron';
import path from 'path';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { ProjectRunMetrics, ProjectRunMetricsRequest } from '../../../shared/types/run-metrics';
import { buildProjectRunMetrics, loadProjectRunMetricInputs } from '../../ai/logging/project-run-metrics';
import { projectStore } from '../../project-store';
import { ensureAbsolutePath } from '../../utils/path-helpers';

const MAX_PERIOD_DAYS = 3650;

function isValidPeriod(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PERIOD_DAYS)
  );
}

export function registerProjectRunMetricsHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_RUN_METRICS_GET,
    async (
      _,
      projectId: string,
      request?: Partial<ProjectRunMetricsRequest>
    ): Promise<IPCResult<ProjectRunMetrics | null>> => {
      try {
        if (typeof projectId !== 'string' || projectId.length === 0) {
          return { success: false, error: 'Invalid project ID' };
        }
        const periodDays = request?.periodDays === undefined ? null : request.periodDays;
        if (!isValidPeriod(periodDays)) {
          return { success: false, error: 'Invalid period' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          console.error('[PROJECT_RUN_METRICS_GET] Project not found:', projectId);
          return { success: false, error: 'Project not found' };
        }

        const tasks = projectStore
          .getTasks(projectId)
          .filter((task) => !task.metadata?.archivedAt)
          .map((task) => ({
            specId: task.specId,
            status: task.status,
            title: task.title,
            updatedAt: task.updatedAt,
          }));

        const specsDir = path.join(ensureAbsolutePath(project.path), getSpecsDir(project.autoBuildPath));
        const inputs = await loadProjectRunMetricInputs(tasks, specsDir);
        return { success: true, data: buildProjectRunMetrics(inputs, { periodDays }) };
      } catch (error) {
        console.error('[PROJECT_RUN_METRICS_GET] Failed to build project run metrics:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to build project run metrics',
        };
      }
    }
  );
}
