# Insights Module

This directory contains the modular architecture for the AI-powered codebase insights feature.

## Architecture Overview

The insights module follows a clean separation of concerns with each module handling a specific responsibility:

```
insights-service.ts (186 lines)
├── config.ts (109 lines) - Configuration & Environment Management
├── paths.ts (46 lines) - Path Resolution Utilities
├── session-storage.ts (212 lines) - Filesystem Persistence
├── session-manager.ts (151 lines) - Session Lifecycle Management
└── insights-executor.ts (267 lines) - Python Process Execution
```

## Module Responsibilities

### InsightsConfig (`config.ts`)
- Manages Python and auto-claude source path configuration
- Detects auto-claude installation automatically
- Loads environment variables from auto-claude .env file
- Provides complete process environment with profile support

### InsightsPaths (`paths.ts`)
- Provides consistent path resolution for insights data
- Manages session directory structure
- Handles migration paths for old session format

### SessionStorage (`session-storage.ts`)
- Handles filesystem persistence of sessions
- Loads and saves session JSON files
- Manages session file operations (create, read, update, delete)
- Handles old session format migration
- Generates session titles from first user message

### SessionManager (`session-manager.ts`)
- Manages in-memory session cache
- Coordinates session lifecycle operations
- Provides high-level session operations (create, switch, delete, rename)
- Manages current session pointer

### InsightsExecutor (`insights-executor.ts`)
- Spawns and manages Python insights_runner.py process
- Handles streaming output parsing
- Detects and emits tool usage events
- Detects and handles rate limiting
- Emits status updates and stream chunks

## Usage

The main `InsightsService` class (in `insights-service.ts`) coordinates all these modules:

```typescript
import { InsightsService } from './insights-service';

const service = new InsightsService();

// Configure paths
service.configure(pythonPath, autoBuildSourcePath);

// Load session
const session = service.loadSession(projectId, projectPath);

// Send message
await service.sendMessage(projectId, projectPath, message);
```

## Event Flow

1. User sends message via `sendMessage()`
2. Service loads/creates session via `SessionManager`
3. Service executes query via `InsightsExecutor`
4. Executor emits streaming events (status, chunks, tools)
5. Service saves assistant response via `SessionManager`

## Attaching images

### In Insights chat

- Images that carry data are sent inline on the current turn to vision-capable models (`InsightsExecutor.execute` -> `runInsightsQuery` in `ai/runners/insights.ts`).
- For a text-only model, the images are dropped and the note `[User attached N image(s); this model cannot view images]` is appended to the message. The request still succeeds.
- Before sending, the renderer shows a notice (`insights.images.analysisUnsupported`) when images are pending and the selected model is text-only. After sending, the message shows "not analyzed" (`insights.images.notAnalyzed`).

### How vision support is decided

`modelSupportsVision()` in `shared/constants/models.ts` reads the `capabilities.vision` flag from the model catalog:

- No model id, or an id that is not in the catalog (a custom model), is assumed vision-capable.
- Only catalog entries marked `vision: false` are text-only, for example `llama-3.3-70b-versatile`, `grok-3`, `grok-3-mini`, `glm-5`, `glm-4.7` and `glm-4.5-flash`.

Caveat: a custom text-only model is assumed capable. Images are sent to it and the provider may reject them. No pre-send warning appears for it, because `Insights.tsx` only shows the warning when `modelSupportsVision()` returns false, which only happens for catalog text-only models.

### Persistence and follow-up questions

Saved Insights history keeps image metadata (`id`, `filename`, `mimeType`, `size`, `thumbnail`) but drops the image `data` and `path` (`stripImageDataForPersistence` in `session-storage.ts`). The history passed to the model is text-only (`role: content` lines). A follow-up question in the same session therefore cannot refer back to an earlier image; attach it again.

### In tasks

- Attachments are saved in the spec's `attachments/` folder (`<specDir>/attachments/`) and recorded in `task_metadata.json` under `attachedImages`.
- Planner and coder prompts get a `## REFERENCE IMAGES` section that lists the image paths (`buildReferenceImagesSection` in `ai/prompts/prompt-loader.ts`). Spec-level prompts list absolute paths; subtask prompts list paths relative to the project directory. The agent opens them with the `Read` tool. The images are not inlined into the prompt.
- The coder only sees an image if its model can read images through `Read`. For a text-only model, `Read` returns a "cannot view images" message. For an SVG it suggests using `cat`, and it reports files over the size limit as too large. In those cases the agent relies on the task description.

### Metadata fields

- `attachedImages` in `task_metadata.json` is read first. `attached_images` in `requirements.json` is used if the first is missing or empty.
- Each entry has a `path` field relative to the spec directory.
- Entries whose file is missing, or whose path escapes the spec directory, are skipped.

## Benefits of This Architecture

- **Maintainability**: Each module has a single, clear responsibility
- **Testability**: Modules can be unit tested independently
- **Reusability**: Modules can be used independently if needed
- **Readability**: Much easier to understand and navigate
- **Extensibility**: Easy to add new features to specific modules

## Migration Notes

This refactoring maintains 100% backward compatibility. All functionality from the original 659-line file is preserved, just better organized across 5 focused modules.
