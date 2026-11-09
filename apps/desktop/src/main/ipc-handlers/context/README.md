# Context Handlers Module

This directory contains the refactored context-related IPC handlers for the Auto Claude UI application. The handlers manage project context, the memory system, and project index operations.

> **Note:** These handlers still read the legacy `GRAPHITI_*` env names (for example `GRAPHITI_ENABLED`, `GRAPHITI_DB_PATH`) for compatibility. The memory service itself comes from `memory-service-factory.ts` and is backed by libSQL (see [the memory README](../../ai/memory/README.md)). Whether agents use memory is decided by `isAgentMemoryEnabled()` in `memory-service-factory.ts`, not by `isMemoryEnabled()` in `utils.ts`.

## Architecture

The module is organized into focused, single-responsibility files:

### Core Modules

#### `utils.ts` (148 lines)
Shared utility functions for environment configuration and parsing.

**Exports:**
- `getAutoBuildSourcePath()` - Get auto-build source path from settings
- `parseEnvFile(content)` - Parse .env file content into key-value pairs
- `loadProjectEnvVars(projectPath, autoBuildPath)` - Load project-specific environment variables
- `loadGlobalSettings()` - Load global application settings
- `isMemoryEnabled(projectEnvVars)` - Check if `GRAPHITI_ENABLED` is `true` in the project or process env (`isGraphitiEnabled` is a deprecated alias)
- `hasOpenAIKey(projectEnvVars, globalSettings)` - Check if OpenAI API key is available
- `validateEmbeddingConfiguration(...)` - Validate the embedding provider configuration
- `getMemoryDatabaseDetails(projectEnvVars)` - Get memory database path and name (from `GRAPHITI_DB_PATH` / `GRAPHITI_DATABASE`)

**Types:**
- `EnvironmentVars` - Environment variable dictionary
- `GlobalSettings` - Global application settings
- `MemoryDatabaseDetails` - Memory database path and name

#### `memory-status-handlers.ts` (130 lines)
Handlers for checking memory system configuration status.

**Exports:**
- `buildMemoryStatus(projectId?)` - Build the memory system status
- `registerMemoryStatusHandlers(getMainWindow)` - Register IPC handlers

**IPC Channels:**
- `CONTEXT_MEMORY_STATUS` - Get memory system status
- `OLLAMA_CONTAINER_STATUS` / `OLLAMA_CONTAINER_START` - Ollama container status and start

#### `memory-data-handlers.ts` (242 lines)
Handlers for retrieving, searching and managing memories through the memory service.

**Exports:**
- `registerMemoryDataHandlers(getMainWindow)` - Register IPC handlers

**IPC Channels:**
- `CONTEXT_GET_MEMORIES` - Get recent memories
- `CONTEXT_SEARCH_MEMORIES` - Search memories by query
- `CONTEXT_MEMORY_VERIFY` / `CONTEXT_MEMORY_PIN` / `CONTEXT_MEMORY_DEPRECATE` / `CONTEXT_MEMORY_DELETE` - Manage individual memories

**Features:**
- Memories are read and written through `getMemoryService()` from `memory-service-factory.ts`
- Semantic search via the memory service

#### `project-context-handlers.ts` (199 lines)
Handlers for project context and index operations.

**Exports:**
- `registerProjectContextHandlers(getMainWindow)` - Register IPC handlers

**IPC Channels:**
- `CONTEXT_GET` - Get full project context (index, memory status, recent memories)
- `CONTEXT_REFRESH_INDEX` - Refresh project index by running analyzer

**Features:**
- Project index loading and caching
- Memory status aggregation
- Analyzer script execution for index regeneration

#### `memory-service-factory.ts`
Lazily creates the memory service singleton (libSQL database plus embedding service).

**Exports:**
- `getMemoryService()` - Get or create the memory service
- `getEmbeddingProvider()` - Detected embedding provider, or null before init
- `isAgentMemoryEnabled()` - Whether agents read and write memory (the switch for agent memory)
- `resetMemoryService()` - Reset the singleton

#### `index.ts` (21 lines)
Main entry point that aggregates all context handlers.

**Exports:**
- `registerContextHandlers(getMainWindow)` - Register all context-related handlers
- Re-exports all utility functions and handler functions

## Refactoring Benefits

### Before (676 lines in single file)
- All context logic in one large file
- Difficult to navigate and maintain
- Repeated code for environment parsing
- Hard to test individual components
- No clear separation of concerns

### After (29 lines main + 740 lines in 5 focused modules)
- **Single Responsibility**: Each module has one clear purpose
- **Reusability**: Utility functions can be imported and tested independently
- **Maintainability**: Easier to find and fix issues in specific areas
- **Testability**: Each module can be unit tested in isolation
- **Readability**: Clear module boundaries with descriptive names
- **Scalability**: Easy to add new handlers without cluttering existing files

## Module Dependencies

```
context-handlers.ts (main entry)
    ↓
context/index.ts (aggregator)
    ↓
    ├── utils.ts (no dependencies, pure utilities)
    ├── memory-status-handlers.ts (depends on: memory-service-factory, ai/memory/db)
    ├── memory-data-handlers.ts (depends on: memory-service-factory)
    └── project-context-handlers.ts (depends on: utils, memory-status-handlers, memory-data-handlers)
```

## Usage Example

```typescript
import { registerContextHandlers } from './ipc-handlers/context-handlers';

// In main process setup
const getMainWindow = () => mainWindow;
registerContextHandlers(getMainWindow);
```

## Testing Strategy

Each module can be tested independently:

```typescript
// Example: Testing utility functions
import { parseEnvFile, isMemoryEnabled } from './utils';

test('parseEnvFile handles quotes correctly', () => {
  const content = 'API_KEY="test-key"\nDEBUG=true';
  const vars = parseEnvFile(content);
  expect(vars.API_KEY).toBe('test-key');
  expect(vars.DEBUG).toBe('true');
});

// Example: Testing memory status
import { buildMemoryStatus } from './memory-status-handlers';

test('buildMemoryStatus returns correct status', () => {
  const status = buildMemoryStatus('/path/to/project', 'auto-claude');
  expect(status).toHaveProperty('enabled');
  expect(status).toHaveProperty('available');
});
```

## Future Enhancements

- Add TypeScript interface documentation for all data structures
- Implement caching layer for frequently accessed context data
- Add telemetry for memory system performance
- Support additional memory providers beyond libSQL
- Implement memory compression for large session insights

## Related Documentation

- [Memory system (ai/memory)](../../ai/memory/README.md)
- [Memory service factory](./memory-service-factory.ts)
- [IPC Channels](../../../shared/constants/ipc.ts)
