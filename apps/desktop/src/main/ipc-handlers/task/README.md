# Task Handlers Module

This directory contains the refactored task-related IPC handlers, previously consolidated in a single 1,873-line file. The code has been reorganized into smaller, focused modules for better maintainability.

## Module Structure

### Core Modules

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `crud-handlers.ts` | ~795 | Task CRUD operations (Create, Read, Update, Delete, List) |
| `execution-handlers.ts` | ~1407 | Task execution lifecycle (Start, Stop, Review, Status, Recovery) |
| `worktree-handlers.ts` | ~1062 | Git worktree management (Status, Diff, Discard, List) and handler registration |
| `worktree-merge.ts` | ~606 | Worktree merge and merge preview |
| `worktree-pr.ts` | ~252 | Worktree pull request creation |
| `worktree-git-utils.ts` | ~272 | Git helpers shared by the worktree modules |
| `tool-handlers.ts` | ~85 | IDE/terminal detection and launch IPC handlers for worktrees |
| `tool-detection/` | ~1170 (5 files) | Pure IDE/terminal detection tables, detection, launch and path safety logic |
| `logs-handlers.ts` | ~198 | Task logs operations (Get, Watch, Unwatch) |
| `shared.ts` | small | Shared utilities and helper functions |
| `index.ts` | ~52 | Main module exports and registration |

### Main Entry Point

The main `task-handlers.ts` file (a few lines) serves as a simple re-export of the modular implementation.

## Module Responsibilities

### CRUD Handlers (`crud-handlers.ts`)
Handles basic task lifecycle operations:
- **TASK_LIST** - List all tasks for a project
- **TASK_CREATE** - Create new task with spec directory
- **TASK_DELETE** - Delete task and associated files
- **TASK_UPDATE** - Update task metadata, title, description

Features:
- Auto-generates task titles using Claude AI
- Manages attached images (save to disk, maintain references)
- Creates spec directories with proper structure
- Updates implementation plans and requirements

### Execution Handlers (`execution-handlers.ts`)
Manages task execution lifecycle:
- **TASK_START** - Start task execution (spec creation or implementation)
- **TASK_STOP** - Stop running task
- **TASK_REVIEW** - Approve or reject task results
- **TASK_UPDATE_STATUS** - Update task status manually
- **TASK_CHECK_RUNNING** - Check if task has active process
- **TASK_RECOVER_STUCK** - Recover tasks stuck in inconsistent state

Features:
- Handles spec creation phase vs implementation phase
- Auto-starts tasks when moved to in_progress
- Intelligent recovery with subtask analysis
- File watcher integration

### Worktree Handlers (`worktree-handlers.ts`)
Manages git worktree operations:
- **TASK_WORKTREE_STATUS** - Get worktree status and git info
- **TASK_WORKTREE_DIFF** - Get detailed file-level diff
- **TASK_WORKTREE_MERGE** - Merge worktree into main branch
- **TASK_WORKTREE_MERGE_PREVIEW** - Preview merge conflicts
- **TASK_WORKTREE_DISCARD** - Discard worktree and branch
- **TASK_LIST_WORKTREES** - List all project worktrees

The three tool channels (`TASK_WORKTREE_DETECT_TOOLS`, `TASK_WORKTREE_OPEN_IN_IDE`, `TASK_WORKTREE_OPEN_IN_TERMINAL`) live in `tool-handlers.ts`, backed by `tool-detection/`.

Features:
- Per-spec worktree architecture (`.worktrees/{spec-name}/`)
- Smart merge with AI-powered conflict resolution
- Merge preview with conflict analysis
- Stage-only merge option (--no-commit)
- Comprehensive git statistics

### Logs Handlers (`logs-handlers.ts`)
Manages task logs and streaming:
- **TASK_LOGS_GET** - Get task logs organized by phase
- **TASK_LOGS_WATCH** - Start watching spec for log changes
- **TASK_LOGS_UNWATCH** - Stop watching spec

Features:
- Real-time log streaming to renderer
- Event forwarding for logs-changed
- Phase-organized logs (planning, coding, validation)

### Shared Utilities (`shared.ts`)
Common helper functions:
- `findTaskAndProject()` - Locate task and project by ID

## Usage

Import the main registration function:

```typescript
import { registerTaskHandlers } from './ipc-handlers/task-handlers';

// Register all task handlers
registerTaskHandlers(agentManager, pythonEnvManager, getMainWindow);
```

## Benefits of Refactoring

### Code Quality
- **Single Responsibility**: Each module has one clear purpose
- **Readability**: Smaller files are easier to understand
- **Maintainability**: Changes are isolated to relevant modules
- **Testability**: Modules can be tested independently

### Developer Experience
- **Navigation**: Find specific handlers quickly
- **Context**: Related functionality grouped together
- **Documentation**: Clear module boundaries
- **Scalability**: Easy to add new handlers

### Metrics

| Metric | Before | After |
|--------|--------|-------|
| Main file size | 1,885 lines | 22 lines |
| Number of files | 1 | 12 handler/helper files + `tool-detection/` |
| Largest module | 1,885 lines | ~1,407 lines (execution-handlers.ts) |

## Dependencies

### External
- `electron` - IPC communication
- `fs` - File system operations
- `child_process` - Process management
- `path` - Path utilities

### Internal
- `../../shared/constants` - IPC channels, paths
- `../../shared/types` - TypeScript types
- `../../agent` - Agent management
- `../../project-store` - Project state
- `../../file-watcher` - File watching
- `../../task-log-service` - Log service
- `../../title-generator` - AI title generation
- `../../python-env-manager` - Python environment
- `../../auto-claude-updater` - Source paths
- `../../rate-limit-detector` - Profile environment

## Architecture Notes

### Worktree Architecture
Each task spec has its own isolated worktree at `.worktrees/{spec-name}/`:
- Enables safe parallel development
- Each spec has dedicated branch: `auto-claude/{spec-name}`
- Branches stay local until user explicitly pushes
- User reviews in worktree before merging to main

### Status Management
Tasks maintain status in `implementation_plan.json`:
- UI statuses: `backlog`, `in_progress`, `ai_review`, `human_review`, `done`
- Python statuses: `pending`, `in_progress`, `review`, `completed`
- Status mapping handled by project-store

### Recovery System
Intelligent stuck task recovery:
- Analyzes subtask completion status
- Resets interrupted subtasks to pending
- Preserves completed work for resumption
- Auto-restart option available

## Future Enhancements

Potential improvements:
- Extract more shared utilities
- Add comprehensive unit tests
- Create handler factory patterns
- Implement middleware for common operations
- Add detailed error handling utilities
