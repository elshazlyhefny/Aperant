/** Queue state for one project, sent from the main-process task queue manager. */
export interface TaskQueueState {
  projectId: string;
  maxParallelTasks: number;
  inProgressCount: number;
  /** Queued task ids, oldest first */
  queuedTaskIds: string[];
  /** Task ids skipped in the last pass because promotion failed */
  skippedTaskIds: string[];
  /** Set when another process (the daemon) runs this project's queue, so the desktop does not promote */
  lockedBy?: string;
}
