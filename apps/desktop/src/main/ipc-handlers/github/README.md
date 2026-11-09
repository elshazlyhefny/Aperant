# GitHub Handlers Module

This directory contains the modularized GitHub integration handlers, originally split out of a single 742-line `github-handlers.ts`. It has since grown (PR review, autofix, triage, OAuth); the current layout is listed below.

## Module Structure

```
github/
├── README.md                      # This file
├── ARCHITECTURE.md                # Architecture notes
├── index.ts                       # Main entry point, registers all handlers (49 lines)
├── types.ts                       # TypeScript type definitions (51 lines)
├── utils.ts                       # Shared utility functions (355 lines)
├── utils/                         # Logger, IPC communicator, project middleware
├── spec-utils.ts                  # Spec creation and management utilities (249 lines)
├── repository-handlers.ts         # Repository and connection handlers (141 lines)
├── issue-handlers.ts              # Issue fetching and retrieval handlers (300 lines)
├── investigation-handlers.ts      # AI-powered issue investigation handlers (214 lines)
├── import-handlers.ts             # Bulk issue import handlers (110 lines)
├── release-handlers.ts            # GitHub release creation handlers (266 lines)
├── oauth-handlers.ts              # gh CLI / OAuth handlers (907 lines, large)
├── autofix-handlers.ts            # Auto-fix handlers (964 lines, large)
├── triage-handlers.ts             # Issue triage handlers (728 lines)
├── pr-handlers.ts                 # Barrel re-exporting pr/ (stable import path, 17 lines)
└── pr/                            # PR review handlers
    ├── index.ts                   # registerPRHandlers entry (45 lines)
    ├── types.ts                   # Public PR types (132 lines)
    ├── shared.ts                  # Logger, runningReviews / ciWaitAbortControllers state (93 lines)
    ├── graphql.ts                 # GraphQL helpers (197 lines)
    ├── query-handlers.ts          # List/fetch PRs, diffs, review state (190 lines)
    ├── review-handlers.ts         # Start/cancel review, registers follow-up (260 lines)
    ├── followup-handlers.ts       # Follow-up review handlers (333 lines)
    ├── review-runner.ts           # Runs the AI review (330 lines)
    ├── review-results.ts          # Review result load/save (308 lines)
    ├── review-logs.ts             # PRLogCollector and log handling (535 lines)
    ├── ci-wait.ts                 # CI wait logic (284 lines)
    ├── posting-handlers.ts        # Post reviews/comments (423 lines)
    ├── merge-handlers.ts          # Merge and readiness (443 lines)
    └── polling-handlers.ts        # Polling and status updates (228 lines)
```

## File Descriptions

### Core Files

**index.ts** (37 lines)
- Main entry point that orchestrates all handler registrations
- Re-exports utilities for external use
- Clean interface for the parent module

**types.ts** (48 lines)
- Shared TypeScript interfaces and types
- GitHub API response types
- Configuration interfaces

**utils.ts** (60 lines)
- `getGitHubConfig()` - Extract GitHub configuration from project
- `githubFetch()` - Wrapper for GitHub API requests with authentication

**spec-utils.ts** (169 lines)
- `createSpecForIssue()` - Create spec directory and initial files
- `buildIssueContext()` - Build context string from issue data
- `buildInvestigationTask()` - Generate task description for AI
- Helper functions for spec numbering and slug generation

### Handler Modules

**repository-handlers.ts** (127 lines)
- `GITHUB_CHECK_CONNECTION` - Verify GitHub connection status
- `GITHUB_GET_REPOSITORIES` - Fetch user's repositories

**issue-handlers.ts** (125 lines)
- `GITHUB_GET_ISSUES` - Fetch issues with filtering
- `GITHUB_GET_ISSUE` - Fetch single issue details
- `transformIssue()` - Transform API response to app format

**investigation-handlers.ts** (211 lines)
- `GITHUB_INVESTIGATE_ISSUE` - AI-powered issue investigation
- Progress tracking and event emission
- Integration with AgentManager for task creation

**import-handlers.ts** (107 lines)
- `GITHUB_IMPORT_ISSUES` - Bulk import of multiple issues
- Error handling and progress tracking
- Task creation for each imported issue

**release-handlers.ts** (126 lines)
- `GITHUB_CREATE_RELEASE` - Create GitHub releases via gh CLI
- CLI availability and authentication checks
- Support for draft and prerelease options

## Benefits of This Structure

### 1. Improved Maintainability
- Each module has a single, clear responsibility
- Easy to locate and update specific functionality
- Reduced cognitive load when working on specific features

### 2. Better Code Organization
- Logical grouping of related handlers
- Shared utilities extracted to dedicated files
- Clear separation between data types, utilities, and handlers

### 3. Enhanced Testability
- Individual modules can be tested in isolation
- Mock dependencies at module boundaries
- Easier to write focused unit tests

### 4. Scalability
- Easy to add new handler types as separate modules
- Can extend functionality without modifying existing modules
- Clear patterns for new contributors to follow

### 5. Reduced Complexity
- Registration entry (`index.ts`) is 49 lines
- Not every file is small: `autofix-handlers.ts` (964) and `oauth-handlers.ts` (907) are still large and are candidates for further splitting
- Each module is focused and comprehensible

## Usage

The module maintains the same public interface as the original file:

```typescript
import { registerGithubHandlers } from './github-handlers';
import { AgentManager } from '../agent';
import type { BrowserWindow } from 'electron';

const agentManager = new AgentManager();
const getMainWindow = () => mainWindow;

registerGithubHandlers(agentManager, getMainWindow);
```

## Dependencies

- `electron` - IPC communication
- `child_process` - For gh CLI operations
- `fs` - File system operations
- `path` - Path manipulation
- Project modules:
  - `../../shared/constants` - Constants and configuration
  - `../../shared/types` - Type definitions
  - `../project-store` - Project data access
  - `../agent` - Agent management

## Handler Registration Flow

```
registerGithubHandlers()
  ├── registerRepositoryHandlers()
  │   ├── registerCheckConnection()
  │   └── registerGetRepositories()
  ├── registerIssueHandlers()
  │   ├── registerGetIssues()
  │   └── registerGetIssue()
  ├── registerInvestigationHandlers()
  │   └── registerInvestigateIssue()
  ├── registerImportHandlers()
  │   └── registerImportIssues()
  └── registerReleaseHandlers()
      └── registerCreateRelease()
```

## IPC Channels

All handlers use channels defined in `IPC_CHANNELS`:

- `GITHUB_CHECK_CONNECTION`
- `GITHUB_GET_REPOSITORIES`
- `GITHUB_GET_ISSUES`
- `GITHUB_GET_ISSUE`
- `GITHUB_INVESTIGATE_ISSUE`
- `GITHUB_INVESTIGATION_PROGRESS`
- `GITHUB_INVESTIGATION_COMPLETE`
- `GITHUB_INVESTIGATION_ERROR`
- `GITHUB_IMPORT_ISSUES`
- `GITHUB_CREATE_RELEASE`

## Future Enhancements

Potential areas for further improvement:

1. **Error Handling** - Centralized error handling middleware
2. **Caching** - Add response caching for frequently accessed data
3. **Rate Limiting** - Implement GitHub API rate limit handling
4. **Testing** - Add comprehensive unit and integration tests
5. **Logging** - Enhanced logging and debugging capabilities
6. **Webhooks** - Support for GitHub webhook integration
7. **PR Handlers** - Separate module for pull request operations

## PR Review Module (`pr/`)

`pr-handlers.ts` is a thin barrel kept for a stable import path; the implementation lives in `pr/`. `pr/index.ts` exports `registerPRHandlers`, which creates one `PRReviewStateManager` and registers query, review (which also registers follow-up), posting, merge and polling handlers. Running-review state (`runningReviews`, `ciWaitAbortControllers`) lives in `pr/shared.ts` so every module shares the same maps.
