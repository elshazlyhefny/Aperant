/**
 * Tests for findTaskAndProject cross-project scoping.
 * Verifies that projectId prevents cross-project task contamination
 * when multiple projects have tasks with the same specId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findTaskAndProject } from '../shared';
import type { Task, Project } from '../../../../shared/types';

// Mock projectStore
const mockProjects: Project[] = [];
const mockTasksByProject: Map<string, Task[]> = new Map();
const { getTasksSpy, mockHints } = vi.hoisted(() => ({
  getTasksSpy: vi.fn<(projectId: string) => unknown[]>(),
  mockHints: vi.fn<(taskId: string) => string[]>()
}));

vi.mock('../../../project-store', () => ({
  projectStore: {
    getProjects: () => mockProjects,
    getTasks: (projectId: string) => getTasksSpy(projectId),
    getProjectIdsForTask: (taskId: string) => mockHints(taskId)
  }
}));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    specId: 'test-spec',
    projectId: 'project-1',
    title: 'Test Task',
    description: 'Test',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: `project-${Date.now()}`,
    name: 'Test Project',
    path: '/test/project',
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    ...overrides
  } as Project;
}

describe('findTaskAndProject', () => {
  beforeEach(() => {
    mockProjects.length = 0;
    mockTasksByProject.clear();
    getTasksSpy.mockReset();
    getTasksSpy.mockImplementation((projectId: string) => mockTasksByProject.get(projectId) || []);
    mockHints.mockReset();
    mockHints.mockReturnValue([]);
  });

  describe('task index hints', () => {
    function setupTwoProjects() {
      const projectA = createProject({ id: 'proj-a' });
      const projectB = createProject({ id: 'proj-b' });
      const taskB = createTask({ id: 'task-b', specId: 'spec-b', projectId: 'proj-b' });
      mockProjects.push(projectA, projectB);
      mockTasksByProject.set('proj-a', []);
      mockTasksByProject.set('proj-b', [taskB]);
      return { projectA, projectB, taskB };
    }

    it('does not query other projects on a hint hit', () => {
      const { projectB, taskB } = setupTwoProjects();
      mockHints.mockReturnValue(['proj-b']);

      const result = findTaskAndProject('spec-b');
      expect(result.task).toBe(taskB);
      expect(result.project).toBe(projectB);
      expect(getTasksSpy).toHaveBeenCalledTimes(1);
      expect(getTasksSpy).toHaveBeenCalledWith('proj-b');
    });

    it('falls back to the full walk when the hint is stale', () => {
      const { projectB, taskB } = setupTwoProjects();
      mockHints.mockReturnValue(['proj-a']);

      const result = findTaskAndProject('spec-b');
      expect(result.task).toBe(taskB);
      expect(result.project).toBe(projectB);
      expect(getTasksSpy).toHaveBeenCalledWith('proj-a');
      expect(getTasksSpy).toHaveBeenCalledWith('proj-b');
    });

    it('falls back to the full walk without a hint', () => {
      const { projectB, taskB } = setupTwoProjects();

      const result = findTaskAndProject('spec-b');
      expect(result.task).toBe(taskB);
      expect(result.project).toBe(projectB);
      expect(getTasksSpy).toHaveBeenCalledTimes(2);
    });

    it('does not use hints when projectId is given', () => {
      setupTwoProjects();
      mockHints.mockReturnValue(['proj-b']);

      const result = findTaskAndProject('spec-b', 'proj-a');
      expect(result.task).toBeUndefined();
      expect(mockHints).not.toHaveBeenCalled();
      expect(getTasksSpy).toHaveBeenCalledTimes(1);
      expect(getTasksSpy).toHaveBeenCalledWith('proj-a');
    });
  });

  it('should find task by specId without projectId (backward compatibility)', () => {
    const project = createProject({ id: 'proj-1' });
    const task = createTask({ id: 'task-1', specId: 'write-to-file', projectId: 'proj-1' });

    mockProjects.push(project);
    mockTasksByProject.set('proj-1', [task]);

    const result = findTaskAndProject('write-to-file');
    expect(result.task).toBe(task);
    expect(result.project).toBe(project);
  });

  it('should scope search to specified project when projectId is provided', () => {
    const projectA = createProject({ id: 'proj-a', name: 'Project A' });
    const projectB = createProject({ id: 'proj-b', name: 'Project B' });

    const taskA = createTask({ id: 'task-a', specId: 'write-to-file', projectId: 'proj-a' });
    const taskB = createTask({ id: 'task-b', specId: 'write-to-file', projectId: 'proj-b' });

    mockProjects.push(projectA, projectB);
    mockTasksByProject.set('proj-a', [taskA]);
    mockTasksByProject.set('proj-b', [taskB]);

    // Without projectId - returns first match (Project A)
    const resultNoScope = findTaskAndProject('write-to-file');
    expect(resultNoScope.task).toBe(taskA);
    expect(resultNoScope.project).toBe(projectA);

    // With projectId for Project B - returns Project B's task
    const resultScopedB = findTaskAndProject('write-to-file', 'proj-b');
    expect(resultScopedB.task).toBe(taskB);
    expect(resultScopedB.project).toBe(projectB);

    // With projectId for Project A - returns Project A's task
    const resultScopedA = findTaskAndProject('write-to-file', 'proj-a');
    expect(resultScopedA.task).toBe(taskA);
    expect(resultScopedA.project).toBe(projectA);
  });

  it('should NOT fall back to other projects when projectId is provided but task not found', () => {
    const projectA = createProject({ id: 'proj-a' });
    const projectB = createProject({ id: 'proj-b' });

    const taskA = createTask({ id: 'task-a', specId: 'write-to-file', projectId: 'proj-a' });

    mockProjects.push(projectA, projectB);
    mockTasksByProject.set('proj-a', [taskA]);
    mockTasksByProject.set('proj-b', []);

    // Search Project B (which has no tasks) — should NOT find Project A's task
    const result = findTaskAndProject('write-to-file', 'proj-b');
    expect(result.task).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  it('should return undefined when projectId refers to a non-existent project', () => {
    const project = createProject({ id: 'proj-1' });
    const task = createTask({ id: 'task-1', specId: 'write-to-file', projectId: 'proj-1' });

    mockProjects.push(project);
    mockTasksByProject.set('proj-1', [task]);

    // Search with a projectId that doesn't exist — should NOT fall back
    const result = findTaskAndProject('write-to-file', 'non-existent-project');
    expect(result.task).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  it('should return undefined when task not found in any project', () => {
    const project = createProject({ id: 'proj-1' });
    mockProjects.push(project);
    mockTasksByProject.set('proj-1', []);

    const result = findTaskAndProject('nonexistent-task');
    expect(result.task).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  it('should find task by id as well as specId', () => {
    const project = createProject({ id: 'proj-1' });
    const task = createTask({ id: 'unique-uuid', specId: 'write-to-file', projectId: 'proj-1' });

    mockProjects.push(project);
    mockTasksByProject.set('proj-1', [task]);

    const result = findTaskAndProject('unique-uuid', 'proj-1');
    expect(result.task).toBe(task);
    expect(result.project).toBe(project);
  });

  it('should log warning when provided projectId is not found', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockProjects.push(createProject({ id: 'proj-1' }));

    findTaskAndProject('some-task', 'ghost-project');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ghost-project'),
      // Flexible match on the rest of the message
    );
    warnSpy.mockRestore();
  });
});
