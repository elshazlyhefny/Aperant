/**
 * Unit tests for Project Store
 * Tests project CRUD operations and task reading from filesystem
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Test directories - will be set in beforeEach with unique temp dir
let TEST_DIR: string;
let USER_DATA_PATH: string;
let TEST_PROJECT_PATH: string;

// Mock Electron before importing the store
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return USER_DATA_PATH;
      return TEST_DIR;
    })
  }
}));

// Setup test directories with unique secure temp dir
function setupTestDirs(): void {
  // Create a unique, secure temporary directory
  TEST_DIR = mkdtempSync(path.join(tmpdir(), 'project-store-test-'));
  USER_DATA_PATH = path.join(TEST_DIR, 'userData');
  TEST_PROJECT_PATH = path.join(TEST_DIR, 'test-project');

  mkdirSync(USER_DATA_PATH, { recursive: true });
  mkdirSync(path.join(USER_DATA_PATH, 'store'), { recursive: true });
  mkdirSync(TEST_PROJECT_PATH, { recursive: true });
}

// Cleanup test directories
function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('ProjectStore', () => {
  beforeEach(async () => {
    cleanupTestDirs();
    setupTestDirs();
    vi.resetModules();
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
  });

  describe('addProject', () => {
    it('should create a new project with correct structure', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);

      expect(project).toHaveProperty('id');
      expect(project.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(project.path).toBe(TEST_PROJECT_PATH);
      expect(project.name).toBe('test-project'); // Derived from path
      expect(project.settings).toBeDefined();
      expect(project.createdAt).toBeInstanceOf(Date);
      expect(project.updatedAt).toBeInstanceOf(Date);
    });

    it('should use provided name if given', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH, 'Custom Name');

      expect(project.name).toBe('Custom Name');
    });

    it('should return existing project if already added', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project1 = store.addProject(TEST_PROJECT_PATH);
      const project2 = store.addProject(TEST_PROJECT_PATH);

      expect(project1.id).toBe(project2.id);
    });

    it('should detect auto-claude directory if present', async () => {
      // Create .auto-claude directory (the data directory, not source code)
      mkdirSync(path.join(TEST_PROJECT_PATH, '.auto-claude'), { recursive: true });

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);

      expect(project.autoBuildPath).toBe('.auto-claude');
    });

    it('should set empty autoBuildPath if not present', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);

      expect(project.autoBuildPath).toBe('');
    });

    it('should persist project to disk', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      store.addProject(TEST_PROJECT_PATH);

      // Check file exists
      const storePath = path.join(USER_DATA_PATH, 'store', 'projects.json');
      expect(existsSync(storePath)).toBe(true);

      // Check content
      const content = JSON.parse(readFileSync(storePath, 'utf-8'));
      expect(content.projects).toHaveLength(1);
      expect(content.projects[0].path).toBe(TEST_PROJECT_PATH);
    });
  });

  describe('removeProject', () => {
    it('should return false for non-existent project', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const result = store.removeProject('nonexistent-id');

      expect(result).toBe(false);
    });

    it('should remove existing project and return true', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const result = store.removeProject(project.id);

      expect(result).toBe(true);
      expect(store.getProjects()).toHaveLength(0);
    });

    it('should persist removal to disk', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      store.removeProject(project.id);

      // Check file content
      const storePath = path.join(USER_DATA_PATH, 'store', 'projects.json');
      const content = JSON.parse(readFileSync(storePath, 'utf-8'));
      expect(content.projects).toHaveLength(0);
    });
  });

  describe('getProjects', () => {
    it('should return empty array when no projects', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const projects = store.getProjects();

      expect(projects).toEqual([]);
    });

    it('should return all projects', async () => {
      const project2Path = path.join(TEST_DIR, 'test-project-2');
      mkdirSync(project2Path, { recursive: true });

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      store.addProject(TEST_PROJECT_PATH);
      store.addProject(project2Path);

      const projects = store.getProjects();

      expect(projects).toHaveLength(2);
    });
  });

  describe('getProject', () => {
    it('should return undefined for non-existent project', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.getProject('nonexistent-id');

      expect(project).toBeUndefined();
    });

    it('should return project by ID', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const added = store.addProject(TEST_PROJECT_PATH);
      const retrieved = store.getProject(added.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(added.id);
    });
  });

  describe('updateProjectSettings', () => {
    it('should return undefined for non-existent project', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const result = store.updateProjectSettings('nonexistent-id', { model: 'sonnet' });

      expect(result).toBeUndefined();
    });

    it('should update settings and return updated project', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const updated = store.updateProjectSettings(project.id, {
        model: 'sonnet',
        linearSync: true
      });

      expect(updated).toBeDefined();
      expect(updated?.settings.model).toBe('sonnet');
      expect(updated?.settings.linearSync).toBe(true);
    });

    it('should update updatedAt timestamp', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const originalUpdatedAt = project.updatedAt;

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = store.updateProjectSettings(project.id, { model: 'haiku' });

      expect(updated?.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });

    it('should persist settings changes', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      store.updateProjectSettings(project.id, { model: 'sonnet' });

      // Read directly from file
      const storePath = path.join(USER_DATA_PATH, 'store', 'projects.json');
      const content = JSON.parse(readFileSync(storePath, 'utf-8'));
      expect(content.projects[0].settings.model).toBe('sonnet');
    });
  });

  describe('declared base branch', () => {
    function declareBase(projectPath: string, baseBranch: string): void {
      writeFileSync(path.join(projectPath, '.aperant.json'), JSON.stringify({ baseBranch }));
    }

    it('uses the branch a repository declares when the project is added', async () => {
      const projectPath = path.join(TEST_DIR, 'declared');
      mkdirSync(projectPath, { recursive: true });
      declareBase(projectPath, 'trunk');

      const { projectStore } = await import('../project-store');
      expect(projectStore.addProject(projectPath).settings.mainBranch).toBe('trunk');
    });

    it('keeps the declared branch when settings are updated', async () => {
      const projectPath = path.join(TEST_DIR, 'declared-update');
      mkdirSync(projectPath, { recursive: true });
      declareBase(projectPath, 'trunk');

      const { projectStore } = await import('../project-store');
      const project = projectStore.addProject(projectPath);

      expect(
        projectStore.updateProjectSettings(project.id, { mainBranch: 'develop' })?.settings.mainBranch,
      ).toBe('trunk');
    });

    it('leaves a project without a declaration on its stored branch', async () => {
      const projectPath = path.join(TEST_DIR, 'undeclared');
      mkdirSync(projectPath, { recursive: true });

      const { projectStore } = await import('../project-store');
      const project = projectStore.addProject(projectPath);

      expect(
        projectStore.updateProjectSettings(project.id, { mainBranch: 'develop' })?.settings.mainBranch,
      ).toBe('develop');
    });
  });

  describe('getTasks', () => {
    it('should return empty array for non-existent project', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const tasks = store.getTasks('nonexistent-id');

      expect(tasks).toEqual([]);
    });

    it('should return empty array if specs directory does not exist', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks).toEqual([]);
    });

    it('should read tasks from filesystem correctly', async () => {
      // Create spec directory structure in .auto-claude (the data directory)
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '001-test-feature');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Test Feature',
        workflow_type: 'feature',
        services_involved: [],
        status: 'in_progress',
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'subtask-1', description: 'First subtask', status: 'completed' },
              { id: 'subtask-2', description: 'Second subtask', status: 'pending' }
            ]
          }
        ],
        final_acceptance: ['Test passes'],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(
        path.join(specsDir, 'implementation_plan.json'),
        JSON.stringify(plan)
      );

      const specContent = `# Test Feature\n\n## Overview\n\nThis is a test feature description.\n`;
      writeFileSync(path.join(specsDir, 'spec.md'), specContent);

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('Test Feature');
      expect(tasks[0].specId).toBe('001-test-feature');
      expect(tasks[0].subtasks).toHaveLength(2);
      expect(tasks[0].status).toBe('in_progress'); // Some completed, some pending
    });

    it('should determine status as backlog when no subtasks completed', async () => {
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '002-pending');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Pending Feature',
        workflow_type: 'feature',
        services_involved: [],
        status: 'backlog',
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'subtask-1', description: 'Subtask 1', status: 'pending' },
              { id: 'subtask-2', description: 'Subtask 2', status: 'pending' }
            ]
          }
        ],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(
        path.join(specsDir, 'implementation_plan.json'),
        JSON.stringify(plan)
      );

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks[0].status).toBe('backlog');
    });

    it('should determine status as ai_review when all subtasks completed', async () => {
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '003-complete');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Complete Feature',
        workflow_type: 'feature',
        services_involved: [],
        status: 'ai_review',
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'subtask-1', description: 'Subtask 1', status: 'completed' },
              { id: 'subtask-2', description: 'Subtask 2', status: 'completed' }
            ]
          }
        ],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(
        path.join(specsDir, 'implementation_plan.json'),
        JSON.stringify(plan)
      );

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks[0].status).toBe('ai_review');
    });

    describe('stale status correction', () => {
      const staleSpecId = '003-all-subtasks-done';
      const planFile = () =>
        path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', staleSpecId, 'implementation_plan.json');

      beforeEach(() => {
        mkdirSync(path.dirname(planFile()), { recursive: true });
        writeFileSync(planFile(), JSON.stringify({
          feature: 'Done coding',
          workflow_type: 'feature',
          services_involved: [],
          status: 'in_progress',
          xstateState: 'qa_review',
          phases: [{
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [{ id: 'subtask-1', description: 'Subtask 1', status: 'completed' }]
          }],
          final_acceptance: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          spec_file: 'spec.md'
        }));
      });

      it('leaves a task alone while its agent is running', async () => {
        const { ProjectStore } = await import('../project-store');
        const store = new ProjectStore();
        store.setTaskRunningCheck((taskId) => taskId === staleSpecId);

        const project = store.addProject(TEST_PROJECT_PATH);
        const tasks = store.getTasks(project.id);

        expect(tasks[0].status).toBe('in_progress');
        expect(JSON.parse(readFileSync(planFile(), 'utf-8')).xstateState).toBe('qa_review');
      });

      it('corrects the task once no agent is running', async () => {
        const { ProjectStore } = await import('../project-store');
        const store = new ProjectStore();
        store.setTaskRunningCheck(() => false);

        const project = store.addProject(TEST_PROJECT_PATH);
        const tasks = store.getTasks(project.id);

        expect(tasks[0].status).toBe('human_review');
        expect(JSON.parse(readFileSync(planFile(), 'utf-8')).xstateState).toBe('human_review');
      });
    });

    it('should determine status as human_review when plan status is human_review', async () => {
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '004-rejected');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Rejected Feature',
        workflow_type: 'feature',
        services_involved: [],
        status: 'human_review',
        reviewReason: 'qa_rejected',
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'subtask-1', description: 'Subtask 1', status: 'completed' }
            ]
          }
        ],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(
        path.join(specsDir, 'implementation_plan.json'),
        JSON.stringify(plan)
      );

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks[0].status).toBe('human_review');
    });

    it('should determine reviewReason from plan when status is human_review', async () => {
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '005-approved');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Approved Feature',
        workflow_type: 'feature',
        services_involved: [],
        status: 'human_review',
        reviewReason: 'completed',
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'subtask-1', description: 'Subtask 1', status: 'completed' }
            ]
          }
        ],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(
        path.join(specsDir, 'implementation_plan.json'),
        JSON.stringify(plan)
      );

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks[0].status).toBe('human_review');
      expect(tasks[0].reviewReason).toBe('completed');
    });

    it('should determine status as done when plan status is explicitly done', async () => {
      // User explicitly marking task as done via drag-and-drop sets status to done
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '006-done');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Done Feature',
        workflow_type: 'feature',
        services_involved: [],
        status: 'done', // Explicitly set by user
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'subtask-1', description: 'Subtask 1', status: 'completed' }
            ]
          }
        ],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(
        path.join(specsDir, 'implementation_plan.json'),
        JSON.stringify(plan)
      );

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks[0].status).toBe('done');
    });

    it('should prefer original task description from requirements.json over plan description', async () => {
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '007-description-priority');
      mkdirSync(specsDir, { recursive: true });

      const aiDescription = 'AI-generated implementation plan description';
      const userDescription = 'User entered: preserve this exact original task description';

      const plan = {
        feature: 'Description Priority Feature',
        description: aiDescription,
        workflow_type: 'feature',
        services_involved: [],
        status: 'pending',
        phases: [],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(
        path.join(specsDir, 'implementation_plan.json'),
        JSON.stringify(plan)
      );

      const requirements = {
        task_description: userDescription,
        workflow_type: 'feature'
      };
      writeFileSync(
        path.join(specsDir, 'requirements.json'),
        JSON.stringify(requirements)
      );

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].description).toBe(userDescription);
    });
  });

  describe('persistence', () => {
    it('should load existing data on construction', async () => {
      // Create store file manually
      const storePath = path.join(USER_DATA_PATH, 'store', 'projects.json');
      writeFileSync(storePath, JSON.stringify({
        projects: [
          {
            id: 'test-id-123',
            name: 'Preexisting Project',
            path: '/test/path',
            autoBuildPath: '',
            settings: {
              model: 'sonnet',
              memoryBackend: 'memory',
              linearSync: false,
              notifications: {
                onTaskComplete: true,
                onTaskFailed: true,
                onReviewNeeded: true,
                sound: false
              }
            },
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z'
          }
        ],
        settings: {}
      }));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const projects = store.getProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('test-id-123');
      expect(projects[0].createdAt).toBeInstanceOf(Date);
    });

    it('should handle corrupted store file gracefully', async () => {
      // Create corrupted store file
      const storePath = path.join(USER_DATA_PATH, 'store', 'projects.json');
      writeFileSync(storePath, 'not valid json {{{');

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const projects = store.getProjects();

      expect(projects).toEqual([]);
    });
  });

  describe('archiveTasks - multi-location handling', () => {
    it('should archive task from main specs directory only', async () => {
      // Create spec directory in main location only
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '001-test-task');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Test Feature',
        workflow_type: 'feature',
        services_involved: [],
        phases: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };
      writeFileSync(path.join(specsDir, 'implementation_plan.json'), JSON.stringify(plan));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const result = store.archiveTasks(project.id, ['001-test-task'], '1.0.0');

      expect(result).toBe(true);

      // Verify metadata was created with archive info
      const metadataPath = path.join(specsDir, 'task_metadata.json');
      expect(existsSync(metadataPath)).toBe(true);

      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      expect(metadata.archivedAt).toBeDefined();
      expect(metadata.archivedInVersion).toBe('1.0.0');
    });

    it('should archive task from BOTH main and worktree locations', async () => {
      // Create spec directory in main location
      const mainSpecsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '002-multi-location');
      mkdirSync(mainSpecsDir, { recursive: true });

      // Create spec directory in worktree location
      // Worktree path: .auto-claude/worktrees/tasks/<worktreeName>/.auto-claude/specs/<taskId>
      const worktreeDir = path.join(
        TEST_PROJECT_PATH,
        '.auto-claude',
        'worktrees',
        'tasks',
        'my-worktree',
        '.auto-claude',
        'specs',
        '002-multi-location'
      );
      mkdirSync(worktreeDir, { recursive: true });

      const plan = {
        feature: 'Multi-Location Feature',
        workflow_type: 'feature',
        services_involved: [],
        phases: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(path.join(mainSpecsDir, 'implementation_plan.json'), JSON.stringify(plan));
      writeFileSync(path.join(worktreeDir, 'implementation_plan.json'), JSON.stringify(plan));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const result = store.archiveTasks(project.id, ['002-multi-location'], '2.0.0');

      expect(result).toBe(true);

      // Verify metadata was created in BOTH locations
      const mainMetadataPath = path.join(mainSpecsDir, 'task_metadata.json');
      const worktreeMetadataPath = path.join(worktreeDir, 'task_metadata.json');

      expect(existsSync(mainMetadataPath)).toBe(true);
      expect(existsSync(worktreeMetadataPath)).toBe(true);

      const mainMetadata = JSON.parse(readFileSync(mainMetadataPath, 'utf-8'));
      const worktreeMetadata = JSON.parse(readFileSync(worktreeMetadataPath, 'utf-8'));

      expect(mainMetadata.archivedAt).toBeDefined();
      expect(mainMetadata.archivedInVersion).toBe('2.0.0');
      expect(worktreeMetadata.archivedAt).toBeDefined();
      expect(worktreeMetadata.archivedInVersion).toBe('2.0.0');
    });

    it('should handle task that exists only in worktree', async () => {
      // Create spec directory ONLY in worktree location (not in main)
      const worktreeDir = path.join(
        TEST_PROJECT_PATH,
        '.auto-claude',
        'worktrees',
        'tasks',
        'only-worktree',
        '.auto-claude',
        'specs',
        '003-worktree-only'
      );
      mkdirSync(worktreeDir, { recursive: true });

      const plan = {
        feature: 'Worktree Only Feature',
        workflow_type: 'feature',
        services_involved: [],
        phases: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };
      writeFileSync(path.join(worktreeDir, 'implementation_plan.json'), JSON.stringify(plan));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const result = store.archiveTasks(project.id, ['003-worktree-only'], '1.0.0');

      expect(result).toBe(true);

      // Verify metadata was created in worktree
      const metadataPath = path.join(worktreeDir, 'task_metadata.json');
      expect(existsSync(metadataPath)).toBe(true);

      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      expect(metadata.archivedAt).toBeDefined();
    });

    it('should skip non-existent task gracefully', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      // Create .auto-claude directory so project is recognized
      mkdirSync(path.join(TEST_PROJECT_PATH, '.auto-claude'), { recursive: true });

      const project = store.addProject(TEST_PROJECT_PATH);
      // Task doesn't exist anywhere
      const result = store.archiveTasks(project.id, ['nonexistent-task']);

      // Should return true (no errors) since missing tasks are skipped
      expect(result).toBe(true);
    });

    it('should reject path traversal attempts in taskId', async () => {
      // Create a valid spec dir
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', 'valid-task');
      mkdirSync(specsDir, { recursive: true });

      const plan = { feature: 'Test', phases: [] };
      writeFileSync(path.join(specsDir, 'implementation_plan.json'), JSON.stringify(plan));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);

      // Try various path traversal attacks
      const maliciousIds = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        'task/../../../secret',
        '.',
        '..',
        'task\0.json'
      ];

      for (const maliciousId of maliciousIds) {
        // These should be rejected and not cause any file operations
        const result = store.archiveTasks(project.id, [maliciousId]);
        // Should return true since invalid IDs are skipped, not treated as errors
        expect(result).toBe(true);
      }
    });

    it('should return false for non-existent project', async () => {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const result = store.archiveTasks('nonexistent-project-id', ['some-task']);

      expect(result).toBe(false);
    });
  });

  describe('unarchiveTasks - multi-location handling', () => {
    it('should unarchive task from BOTH main and worktree locations', async () => {
      // Create archived task in both locations
      const mainSpecsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '004-unarchive-test');
      mkdirSync(mainSpecsDir, { recursive: true });

      const worktreeDir = path.join(
        TEST_PROJECT_PATH,
        '.auto-claude',
        'worktrees',
        'tasks',
        'unarchive-worktree',
        '.auto-claude',
        'specs',
        '004-unarchive-test'
      );
      mkdirSync(worktreeDir, { recursive: true });

      const plan = {
        feature: 'Unarchive Test',
        phases: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };

      const archivedMetadata = {
        archivedAt: '2024-06-01T00:00:00Z',
        archivedInVersion: '1.0.0'
      };

      // Create plan and archived metadata in both locations
      writeFileSync(path.join(mainSpecsDir, 'implementation_plan.json'), JSON.stringify(plan));
      writeFileSync(path.join(mainSpecsDir, 'task_metadata.json'), JSON.stringify(archivedMetadata));
      writeFileSync(path.join(worktreeDir, 'implementation_plan.json'), JSON.stringify(plan));
      writeFileSync(path.join(worktreeDir, 'task_metadata.json'), JSON.stringify(archivedMetadata));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const result = store.unarchiveTasks(project.id, ['004-unarchive-test']);

      expect(result).toBe(true);

      // Verify archivedAt was removed from BOTH locations
      const mainMetadata = JSON.parse(readFileSync(path.join(mainSpecsDir, 'task_metadata.json'), 'utf-8'));
      const worktreeMetadata = JSON.parse(readFileSync(path.join(worktreeDir, 'task_metadata.json'), 'utf-8'));

      expect(mainMetadata.archivedAt).toBeUndefined();
      expect(mainMetadata.archivedInVersion).toBeUndefined();
      expect(worktreeMetadata.archivedAt).toBeUndefined();
      expect(worktreeMetadata.archivedInVersion).toBeUndefined();
    });
  });

  describe('cache invalidation', () => {
    it('should invalidate cache after archiveTasks', async () => {
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '005-cache-test');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Cache Test Feature',
        workflow_type: 'feature',
        services_involved: [],
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [{ id: 'subtask-1', description: 'Test', status: 'pending' }]
          }
        ],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };
      writeFileSync(path.join(specsDir, 'implementation_plan.json'), JSON.stringify(plan));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);

      // First call should populate cache
      const tasksBefore = store.getTasks(project.id);
      expect(tasksBefore).toHaveLength(1);
      expect(tasksBefore[0].metadata?.archivedAt).toBeUndefined();

      // Archive the task
      store.archiveTasks(project.id, ['005-cache-test']);

      // After archiving, cache should be invalidated and getTasks should return updated data
      const tasksAfter = store.getTasks(project.id);
      expect(tasksAfter[0].metadata?.archivedAt).toBeDefined();
    });

    it('should return fresh data after invalidateTasksCache is called', async () => {
      const specsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '006-invalidate-test');
      mkdirSync(specsDir, { recursive: true });

      const plan = {
        feature: 'Initial Feature',
        workflow_type: 'feature',
        services_involved: [],
        phases: [],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };
      writeFileSync(path.join(specsDir, 'implementation_plan.json'), JSON.stringify(plan));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);

      // First call should populate cache
      const tasksBefore = store.getTasks(project.id);
      expect(tasksBefore[0].title).toBe('Initial Feature');

      // Modify the file directly (simulating external change)
      const updatedPlan = { ...plan, feature: 'Updated Feature' };
      writeFileSync(path.join(specsDir, 'implementation_plan.json'), JSON.stringify(updatedPlan));

      // Without invalidation, should still return cached data
      const tasksCached = store.getTasks(project.id);
      expect(tasksCached[0].title).toBe('Initial Feature');

      // Invalidate cache
      store.invalidateTasksCache(project.id);

      // Now should return fresh data
      const tasksAfterInvalidation = store.getTasks(project.id);
      expect(tasksAfterInvalidation[0].title).toBe('Updated Feature');
    });
  });

  describe('getProjectIdsForTask', () => {
    function writeSpec(name: string): string {
      const dir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'implementation_plan.json'),
        JSON.stringify({
          feature: name,
          workflow_type: 'feature',
          services_involved: [],
          phases: [],
          final_acceptance: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          spec_file: 'spec.md'
        })
      );
      return dir;
    }

    it('is filled after getTasks', async () => {
      writeSpec('007-index-test');
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();
      const project = store.addProject(TEST_PROJECT_PATH);

      expect(store.getProjectIdsForTask('007-index-test')).toEqual([]);
      store.getTasks(project.id);
      expect(store.getProjectIdsForTask('007-index-test')).toEqual([project.id]);
      expect(store.getProjectIdsForTask('unknown')).toEqual([]);
    });

    it('is replaced after a spec is removed and the cache invalidated', async () => {
      const dir = writeSpec('008-gone');
      writeSpec('009-stays');
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();
      const project = store.addProject(TEST_PROJECT_PATH);

      store.getTasks(project.id);
      expect(store.getProjectIdsForTask('008-gone')).toEqual([project.id]);

      rmSync(dir, { recursive: true, force: true });
      store.invalidateTasksCache(project.id);
      // The hint survives invalidation until the next scan
      expect(store.getProjectIdsForTask('008-gone')).toEqual([project.id]);

      store.getTasks(project.id);
      expect(store.getProjectIdsForTask('008-gone')).toEqual([]);
      expect(store.getProjectIdsForTask('009-stays')).toEqual([project.id]);
    });

    it('is cleared by removeProject', async () => {
      writeSpec('010-removed');
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();
      const project = store.addProject(TEST_PROJECT_PATH);

      store.getTasks(project.id);
      expect(store.getProjectIdsForTask('010-removed')).toEqual([project.id]);
      store.removeProject(project.id);
      expect(store.getProjectIdsForTask('010-removed')).toEqual([]);
    });
  });

  describe('getTasks - worktree deduplication', () => {
    it('should not duplicate tasks that exist in both main and worktree', async () => {
      // Create same task in both main and worktree
      const mainSpecsDir = path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs', '007-dedupe-test');
      mkdirSync(mainSpecsDir, { recursive: true });

      const worktreeDir = path.join(
        TEST_PROJECT_PATH,
        '.auto-claude',
        'worktrees',
        'tasks',
        'dedupe-worktree',
        '.auto-claude',
        'specs',
        '007-dedupe-test'
      );
      mkdirSync(worktreeDir, { recursive: true });

      const plan = {
        feature: 'Dedupe Test Feature',
        workflow_type: 'feature',
        services_involved: [],
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [{ id: 'subtask-1', description: 'Test', status: 'pending' }]
          }
        ],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md'
      };

      writeFileSync(path.join(mainSpecsDir, 'implementation_plan.json'), JSON.stringify(plan));
      writeFileSync(path.join(worktreeDir, 'implementation_plan.json'), JSON.stringify(plan));

      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();

      const project = store.addProject(TEST_PROJECT_PATH);
      const tasks = store.getTasks(project.id);

      // Should only return ONE task, not two
      const matchingTasks = tasks.filter(t => t.specId === '007-dedupe-test');
      expect(matchingTasks).toHaveLength(1);
    });
  });

  describe('file parse cache', () => {
    const specsRoot = () => path.join(TEST_PROJECT_PATH, '.auto-claude', 'specs');
    const worktreeSpecsRoot = () =>
      path.join(TEST_PROJECT_PATH, '.auto-claude', 'worktrees', 'tasks', 'wt-1', '.auto-claude', 'specs');

    /** Set a file's mtime to `ageSec` seconds ago (+ offsetSec) so the racy-write guard does not apply. */
    function backdate(file: string, ageSec = 60, offsetSec = 0): void {
      const t = Date.now() / 1000 - ageSec + offsetSec;
      utimesSync(file, t, t);
    }

    function writeOld(file: string, content: string, ageSec = 60): void {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      backdate(file, ageSec);
    }

    function makePlan(overrides: Record<string, unknown> = {}, subtaskStatus = 'pending') {
      return {
        feature: 'Cache Feature',
        workflow_type: 'feature',
        services_involved: [],
        phases: [{
          phase: 1,
          name: 'Phase 1',
          type: 'implementation',
          subtasks: [{ id: 'subtask-1', description: 'Test', status: subtaskStatus }]
        }],
        final_acceptance: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        spec_file: 'spec.md',
        ...overrides
      };
    }

    const planOf = (root: string, spec: string) => path.join(root, spec, 'implementation_plan.json');

    async function setup() {
      const { ProjectStore } = await import('../project-store');
      const store = new ProjectStore();
      const project = store.addProject(TEST_PROJECT_PATH);
      const scan = () => {
        store.invalidateTasksCache(project.id);
        return store.getTasks(project.id);
      };
      return { store, project, scan };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rescan with nothing changed gives zero new misses and identical tasks', async () => {
      writeOld(planOf(specsRoot(), '001-a'), JSON.stringify(makePlan()));
      writeOld(planOf(specsRoot(), '002-b'), JSON.stringify(makePlan({ feature: 'B' })));
      const { store, scan } = await setup();

      const first = scan();
      const before = store.getFileCacheStats();
      const second = scan();
      const after = store.getFileCacheStats();

      expect(after.misses).toBe(before.misses);
      expect(after.hits).toBeGreaterThan(before.hits);
      expect(second).toEqual(first);
    });

    it('editing one spec plan re-reads only that file', async () => {
      writeOld(planOf(specsRoot(), '001-a'), JSON.stringify(makePlan({ feature: 'Alpha' })));
      writeOld(planOf(specsRoot(), '002-b'), JSON.stringify(makePlan({ feature: 'Beta' })));
      const { store, scan } = await setup();
      scan();
      const before = store.getFileCacheStats();

      writeOld(planOf(specsRoot(), '001-a'), JSON.stringify(makePlan({ feature: 'Alpha edited longer' })), 30);
      const tasks = scan();

      expect(store.getFileCacheStats().misses - before.misses).toBe(1);
      expect(tasks.find((t) => t.specId === '001-a')?.title).toBe('Alpha edited longer');
      expect(tasks.find((t) => t.specId === '002-b')?.title).toBe('Beta');
    });

    it('detects a rewrite with the same size but a different mtime', async () => {
      const file = planOf(specsRoot(), '001-a');
      writeOld(file, JSON.stringify(makePlan({ feature: 'AAAA' })), 60);
      const { scan } = await setup();
      expect(scan()[0].title).toBe('AAAA');

      writeOld(file, JSON.stringify(makePlan({ feature: 'BBBB' })), 30);
      expect(scan()[0].title).toBe('BBBB');
    });

    it('never serves a rewrite inside the guard window stale', async () => {
      const file = planOf(specsRoot(), '001-a');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(makePlan({ feature: 'AAAA' })));
      const { scan } = await setup();
      expect(scan()[0].title).toBe('AAAA');

      const { mtimeMs } = await import('fs').then((fs) => fs.statSync(file));
      writeFileSync(file, JSON.stringify(makePlan({ feature: 'BBBB' })));
      // Force the identical mtime, as a same-tick rewrite would produce
      utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
      expect(scan()[0].title).toBe('BBBB');
    });

    it('reads spec.md at most once per scan when description and title fallbacks both apply', async () => {
      const dir = path.join(specsRoot(), '001-looks-like-id');
      writeOld(planOf(specsRoot(), '001-looks-like-id'), JSON.stringify(makePlan({ feature: '001-looks-like-id' })));
      writeOld(path.join(dir, 'spec.md'), '# Specification: Real Title\n\n## Overview\n\nThe overview text.\n');
      const { store, scan } = await setup();

      const before = store.getFileCacheStats();
      const tasks = scan();

      // plan + spec.md = 2 misses; spec.md accounts for at most 1
      expect(store.getFileCacheStats().misses - before.misses).toBeLessThanOrEqual(2);
      expect(tasks[0].title).toBe('Real Title');
      expect(tasks[0].description).toBe('The overview text.');

      const mid = store.getFileCacheStats();
      scan();
      expect(store.getFileCacheStats().misses).toBe(mid.misses);
    });

    it('mutating returned task metadata does not affect the next scan', async () => {
      const dir = path.join(specsRoot(), '001-a');
      writeOld(planOf(specsRoot(), '001-a'), JSON.stringify(makePlan()));
      writeOld(path.join(dir, 'task_metadata.json'), JSON.stringify({ category: 'feature', labels: ['x'] }));
      const { scan } = await setup();

      const first = scan();
      (first[0].metadata as Record<string, unknown>).category = 'mutated';
      (first[0].metadata as { labels?: string[] }).labels?.push('y');

      const second = scan();
      expect(second[0].metadata).toEqual({ category: 'feature', labels: ['x'] });
    });

    describe('stale status correction with cached plans', () => {
      const spec = '003-all-done';
      const staleDoc = (overrides: Record<string, unknown> = {}) =>
        makePlan({ status: 'in_progress', xstateState: 'qa_review', ...overrides }, 'completed');

      it('corrects on the first scan, rewrites the file and reads it back as human_review', async () => {
        const file = planOf(specsRoot(), spec);
        writeOld(file, JSON.stringify(staleDoc()));
        const { scan } = await setup();

        expect(scan()[0].status).toBe('human_review');
        expect(JSON.parse(readFileSync(file, 'utf-8')).xstateState).toBe('human_review');

        backdate(file, 60);
        const again = scan();
        expect(again[0].status).toBe('human_review');
        expect(again[0].reviewReason).toBe('completed');
      });

      it('does not mutate the cached plan object in place', async () => {
        const file = planOf(specsRoot(), spec);
        writeOld(file, JSON.stringify(staleDoc()));
        const { store, scan } = await setup();
        let running = true;
        store.setTaskRunningCheck(() => running);

        expect(scan()[0].status).toBe('in_progress');
        const cached = (store as unknown as {
          fileCache: { read: (p: string, f: (r: string) => unknown) => { status: string } | undefined };
        }).fileCache.read(file, (r) => JSON.parse(r));
        expect(cached?.status).toBe('in_progress');

        running = false;
        expect(scan()[0].status).toBe('human_review');
        expect(cached?.status).toBe('in_progress');
      });

      it('still corrects later when first skipped because updated_at was recent', async () => {
        const file = planOf(specsRoot(), spec);
        writeOld(file, JSON.stringify(staleDoc({ updated_at: new Date(Date.now() - 10_000).toISOString() })));
        const { store, scan } = await setup();

        expect(scan()[0].status).toBe('in_progress');
        const before = store.getFileCacheStats();

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 60_000);
        const later = scan();

        expect(store.getFileCacheStats().misses - before.misses).toBe(0);
        expect(later[0].status).toBe('human_review');
      });

      it('still corrects after isTaskRunning flips', async () => {
        writeOld(planOf(specsRoot(), spec), JSON.stringify(staleDoc()));
        const { store, scan } = await setup();
        let running = true;
        store.setTaskRunningCheck(() => running);

        expect(scan()[0].status).toBe('in_progress');
        running = false;
        expect(scan()[0].status).toBe('human_review');
      });
    });

    it('evicts entries of deleted spec dirs and removed worktree dirs', async () => {
      writeOld(planOf(specsRoot(), '001-a'), JSON.stringify(makePlan()));
      writeOld(planOf(specsRoot(), '002-b'), JSON.stringify(makePlan({ feature: 'B' })));
      writeOld(planOf(worktreeSpecsRoot(), '001-a'), JSON.stringify(makePlan()));
      const { store, scan } = await setup();
      scan();

      // Deleted spec dir: recreating the same content must be a miss again
      rmSync(path.join(specsRoot(), '002-b'), { recursive: true, force: true });
      scan();
      let before = store.getFileCacheStats();
      writeOld(planOf(specsRoot(), '002-b'), JSON.stringify(makePlan({ feature: 'B' })));
      scan();
      expect(store.getFileCacheStats().misses - before.misses).toBe(1);

      // Removed worktree dir: its scope is evicted
      rmSync(path.join(TEST_PROJECT_PATH, '.auto-claude', 'worktrees'), { recursive: true, force: true });
      scan();
      before = store.getFileCacheStats();
      writeOld(planOf(worktreeSpecsRoot(), '001-a'), JSON.stringify(makePlan()));
      scan();
      expect(store.getFileCacheStats().misses - before.misses).toBe(1);
    });

    it('removeProject evicts the project entries', async () => {
      writeOld(planOf(specsRoot(), '001-a'), JSON.stringify(makePlan()));
      const { store, project, scan } = await setup();
      scan();

      store.removeProject(project.id);
      const readded = store.addProject(TEST_PROJECT_PATH);
      const before = store.getFileCacheStats();
      store.getTasks(readded.id);

      expect(store.getFileCacheStats().misses - before.misses).toBe(1);
    });

    it('serves an unrepairable plan as a human_review errors task without re-parsing', async () => {
      writeOld(planOf(specsRoot(), '001-bad'), '{{{ definitely not json');
      const { store, scan } = await setup();

      const first = scan();
      expect(first[0].status).toBe('human_review');
      expect(first[0].reviewReason).toBe('errors');
      const before = store.getFileCacheStats();

      const second = scan();
      expect(second[0].status).toBe('human_review');
      expect(second[0].reviewReason).toBe('errors');
      expect(store.getFileCacheStats().misses).toBe(before.misses);
    });
  });
});
