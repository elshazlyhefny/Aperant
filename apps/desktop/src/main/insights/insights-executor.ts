import { EventEmitter } from 'events';
import type {
  InsightsChatMessage,
  InsightsChatStatus,
  InsightsStreamChunk,
  InsightsToolUsage,
  InsightsModelConfig,
  ImageAttachment
} from '../../shared/types';
import type { TaskCategory, TaskComplexity, TaskMetadata } from '../../shared/types/task';
import { InsightsConfig } from './config';
import { detectRateLimit, createSDKRateLimitInfo } from '../rate-limit-detector';
import { runInsightsQuery } from '../ai/runners/insights';
import type { ModelShorthand } from '../ai/config/types';
import { modelSupportsVision } from '../../shared/constants/models';

/**
 * Message processor result
 */
interface ProcessorResult {
  fullResponse: string;
  suggestedTasks?: InsightsChatMessage['suggestedTasks'];
  toolsUsed: InsightsToolUsage[];
  /** True when the user stopped this run with the Stop button */
  stopped: boolean;
}

/**
 * TypeScript executor for insights
 * Handles running the TypeScript insights runner via Vercel AI SDK
 */
export class InsightsExecutor extends EventEmitter {
  private config: InsightsConfig;
  private abortControllers: Map<string, AbortController> = new Map();
  // Controllers aborted by the user (Stop button), as opposed to superseded by a new run
  private userStopped = new WeakSet<AbortController>();

  constructor(config: InsightsConfig) {
    super();
    this.config = config;
  }

  /**
   * Check if a session is currently active
   */
  isSessionActive(projectId: string): boolean {
    return this.abortControllers.has(projectId);
  }

  /**
   * Cancel an active session
   */
  cancelSession(projectId: string): boolean {
    const controller = this.abortControllers.get(projectId);
    if (!controller) return false;

    controller.abort();
    this.abortControllers.delete(projectId);
    return true;
  }

  /**
   * Stop the active run at the user's request. Unlike a supersede (cancelSession
   * from execute/sendMessage), the stopped run finishes cleanly: it emits 'done'
   * and a 'complete' status, and its partial answer is returned with stopped: true.
   */
  stopSession(projectId: string): boolean {
    const controller = this.abortControllers.get(projectId);
    if (!controller) return false;

    this.userStopped.add(controller);
    return this.cancelSession(projectId);
  }

  /**
   * Execute insights query using TypeScript runner (Vercel AI SDK)
   */
  async execute(
    projectId: string,
    projectPath: string,
    message: string,
    conversationHistory: Array<{ role: string; content: string }>,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[]
  ): Promise<ProcessorResult> {
    // Cancel any existing session
    this.cancelSession(projectId);

    // Emit thinking status
    this.emit('status', projectId, {
      phase: 'thinking',
      message: 'Processing your message...'
    } as InsightsChatStatus);

    const controller = new AbortController();
    this.abortControllers.set(projectId, controller);

    const fullResponse = '';
    const suggestedTasks: InsightsChatMessage['suggestedTasks'] = [];
    const toolsUsed: InsightsToolUsage[] = [];
    let accumulatedText = '';
    let allOutput = '';

    // Map InsightsModelConfig to ModelShorthand/ThinkingLevel
    const modelShorthand: ModelShorthand = (modelConfig?.model as ModelShorthand) ?? 'sonnet';
    const thinkingLevel: 'low' | 'medium' | 'high' | 'xhigh' = modelConfig?.thinkingLevel ?? 'medium';

    // Map history to InsightsMessage format
    const history = conversationHistory
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // Only entries that carry data can be delivered to the model
    const deliverable = (images ?? []).filter(
      (img): img is ImageAttachment & { data: string } => !!img.data
    );
    const canSeeImages = modelSupportsVision(modelConfig?.model);
    let effectiveMessage = message;
    if (deliverable.length > 0 && !canSeeImages) {
      // Text-only model: drop the images and add a note to the message instead, so the
      // request still succeeds. Unknown/custom model ids are assumed vision-capable
      // (see modelSupportsVision), so only catalog models marked vision: false land here.
      effectiveMessage = `${message}\n[User attached ${deliverable.length} image(s); this model cannot view images]`;
    }
    const imagePayload =
      deliverable.length > 0 && canSeeImages
        ? deliverable.map((img) => ({ data: img.data, mimeType: img.mimeType }))
        : undefined;

    const finishStopped = (text: string): ProcessorResult => {
      this.emit('stream-chunk', projectId, {
        type: 'done',
        stopped: true,
      } as InsightsStreamChunk);
      this.emit('status', projectId, {
        phase: 'complete',
      } as InsightsChatStatus);
      return {
        fullResponse: text,
        suggestedTasks: undefined,
        toolsUsed,
        stopped: true,
      };
    };

    const releaseController = (): void => {
      // A late-finishing run must not delete the controller of a newer run
      if (this.abortControllers.get(projectId) === controller) {
        this.abortControllers.delete(projectId);
      }
    };

    try {
      const result = await runInsightsQuery(
        {
          projectDir: projectPath,
          message: effectiveMessage,
          history,
          images: imagePayload,
          modelShorthand,
          thinkingLevel,
          abortSignal: controller.signal,
        },
        (event) => {
          switch (event.type) {
            case 'text-delta': {
              accumulatedText += event.text;
              allOutput = (allOutput + event.text).slice(-10000);
              this.emit('stream-chunk', projectId, {
                type: 'text',
                content: event.text,
              } as InsightsStreamChunk);
              break;
            }
            case 'tool-start': {
              toolsUsed.push({
                name: event.name,
                input: event.input,
                timestamp: new Date(),
              });
              this.emit('stream-chunk', projectId, {
                type: 'tool_start',
                tool: { name: event.name, input: event.input },
              } as InsightsStreamChunk);
              break;
            }
            case 'tool-end': {
              this.emit('stream-chunk', projectId, {
                type: 'tool_end',
                tool: { name: event.name },
              } as InsightsStreamChunk);
              break;
            }
            case 'error': {
              // An aborted run reports its abort as an error; it is not one
              if (controller.signal.aborted) break;
              allOutput = (allOutput + event.error).slice(-10000);
              this.emit('stream-chunk', projectId, {
                type: 'error',
                error: event.error,
              } as InsightsStreamChunk);
              break;
            }
          }
        },
      );

      releaseController();

      if (this.userStopped.has(controller)) {
        return finishStopped(result.text?.trim() || accumulatedText.trim() || fullResponse);
      }

      // Superseded by a newer run: return what we have, emit nothing
      if (controller.signal.aborted) {
        return {
          fullResponse: result.text?.trim() || accumulatedText.trim(),
          suggestedTasks: undefined,
          toolsUsed,
          stopped: false,
        };
      }

      // Extract task suggestion from the full result
      if (result.taskSuggestion) {
        const task: { title: string; description: string; metadata?: TaskMetadata } = {
          title: result.taskSuggestion.title,
          description: result.taskSuggestion.description,
          metadata: {
            category: result.taskSuggestion.metadata.category as TaskCategory,
            complexity: result.taskSuggestion.metadata.complexity as TaskComplexity,
          },
        };
        suggestedTasks.push(task);
        this.emit('stream-chunk', projectId, {
          type: 'task_suggestion',
          suggestedTasks: [task],
        } as InsightsStreamChunk);
      }

      this.emit('stream-chunk', projectId, {
        type: 'done',
      } as InsightsStreamChunk);

      this.emit('status', projectId, {
        phase: 'complete',
      } as InsightsChatStatus);

      return {
        fullResponse: result.text.trim() || accumulatedText.trim() || fullResponse,
        suggestedTasks: suggestedTasks.length > 0 ? suggestedTasks : undefined,
        toolsUsed,
        stopped: false,
      };
    } catch (error) {
      releaseController();

      // Check for rate limit in accumulated output
      this.handleRateLimit(projectId, allOutput);

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Don't emit error if aborted (user cancelled)
      if (error instanceof Error && error.name === 'AbortError') {
        if (this.userStopped.has(controller)) {
          return finishStopped(accumulatedText.trim());
        }
        return {
          fullResponse: accumulatedText.trim(),
          suggestedTasks: suggestedTasks.length > 0 ? suggestedTasks : undefined,
          toolsUsed,
          stopped: false,
        };
      }

      this.emit('stream-chunk', projectId, {
        type: 'error',
        error: errorMsg,
      } as InsightsStreamChunk);

      this.emit('error', projectId, errorMsg);
      throw error;
    }
  }

  /**
   * Handle rate limit detection
   */
  private handleRateLimit(projectId: string, output: string): void {
    const rateLimitDetection = detectRateLimit(output);
    if (rateLimitDetection.isRateLimited) {
      const rateLimitInfo = createSDKRateLimitInfo('other', rateLimitDetection, {
        projectId,
      });
      this.emit('sdk-rate-limit', rateLimitInfo);
    }
  }
}
