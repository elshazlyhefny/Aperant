/**
 * Task session helpers
 * ====================
 *
 * Pure, Electron-free helpers shared by the desktop AgentManager and the
 * headless runner, so both build a task session the same way.
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { resolveModelId } from '../config/phase-config';
import { resolveModelEquivalent } from '../../../shared/constants/models';
import type { BuiltinProvider } from '../../../shared/types/provider-account';
import { getSecurityProfile } from '../security/security-profile';
import type { SerializedSecurityProfile } from './types';

export type TaskPhase = 'planning' | 'coding' | 'qa' | 'spec';

export interface SecurityProfileSettings {
  prOnlyLanding: boolean;
  envPassthrough: string[];
  bashSandbox: string;
}

/**
 * Returns the per-provider custom phase models (settings.providerAgentConfig[provider].customPhaseModels).
 */
export type ProviderPhaseModelsReader = (provider: string) => Record<string, string> | undefined;

/**
 * Serialize a project's SecurityProfile (Sets) into a SerializedSecurityProfile (arrays)
 * for transfer across worker thread boundaries.
 */
export function serializeSecurityProfile(
  projectDir: string,
  { prOnlyLanding, envPassthrough, bashSandbox }: SecurityProfileSettings,
): SerializedSecurityProfile {
  const profile = getSecurityProfile(projectDir);
  return {
    // zeenha fork: the worker cannot read the project store, so the setting travels here.
    prOnlyLanding,
    envPassthrough,
    bashSandbox,
    baseCommands: [...profile.baseCommands],
    stackCommands: [...profile.stackCommands],
    scriptCommands: [...profile.scriptCommands],
    customCommands: [...profile.customCommands],
    customScripts: {
      shellScripts: profile.customScripts.shellScripts,
    },
  };
}

/**
 * Minimal planner/build-orchestrator system prompt, used when planner.md
 * cannot be found.
 */
export function buildDefaultPlannerPrompt(specId: string, projectPath: string): string {
  return `You are a planning agent. Your job is to review the spec and create an implementation plan for spec ${specId} in project ${projectPath}. Read the spec.md and create implementation_plan.json with phases and subtasks.`;
}

/**
 * Build initial messages for task execution (build_orchestrator).
 * Includes the spec.md and implementation_plan.json content for agent context.
 */
export function buildTaskExecutionMessages(
  specDir: string,
  specId: string,
  projectPath: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const parts: string[] = [];

  parts.push(`You are implementing spec ${specId} in project: ${projectPath}`);
  parts.push(`Spec directory: ${specDir}`);
  parts.push('');

  // Read spec.md
  const specPath = path.join(specDir, 'spec.md');
  try {
    if (existsSync(specPath)) {
      const specContent = readFileSync(specPath, 'utf-8');
      parts.push('## Specification (spec.md)');
      parts.push('');
      parts.push(specContent);
      parts.push('');
    }
  } catch {
    // Not critical — agent can read spec itself
  }

  // Read implementation_plan.json if it exists (resume scenario)
  const planPath = path.join(specDir, 'implementation_plan.json');
  try {
    if (existsSync(planPath)) {
      const planContent = readFileSync(planPath, 'utf-8');
      parts.push('## Implementation Plan (implementation_plan.json)');
      parts.push('');
      parts.push('```json');
      parts.push(planContent);
      parts.push('```');
      parts.push('');
      parts.push('Resume implementing the pending/in-progress subtasks. Do NOT redo completed subtasks. Update each subtask status to "completed" in implementation_plan.json after finishing it.');
    } else {
      parts.push('No implementation plan exists yet. Start by creating implementation_plan.json with phases and subtasks, then implement each subtask.');
    }
  } catch {
    // Fall through
  }

  return [{ role: 'user', content: parts.join('\n') }];
}

export interface TaskMetadata {
  isAutoProfile?: boolean;
  phaseModels?: Record<string, string>;
  phaseProviders?: Record<string, string>;
  provider?: string;
  model?: string;
}

/**
 * Read task_metadata.json from a spec directory.
 * Returns null if it does not exist or cannot be parsed.
 */
export function readTaskMetadata(specDir: string): TaskMetadata | null {
  try {
    const metadataPath = path.join(specDir, 'task_metadata.json');
    if (existsSync(metadataPath)) {
      return JSON.parse(readFileSync(metadataPath, 'utf-8')) as TaskMetadata;
    }
  } catch {
    // Fall through
  }
  return null;
}

/**
 * Resolve the provider override for a phase from task_metadata.json.
 * Returns null if no per-phase provider is specified (use default queue).
 */
export function resolveTaskPhaseProvider(specDir: string, phase: TaskPhase): string | null {
  const metadata = readTaskMetadata(specDir);
  if (!metadata) return null;
  // Per-phase provider (cross-provider mode) takes precedence,
  // then fall back to the single task-level provider (e.g. 'ollama')
  return metadata.phaseProviders?.[phase] ?? metadata.provider ?? null;
}

/**
 * Resolve the model ID for a task by reading task_metadata.json.
 * Falls back to the default sonnet model if metadata is not available.
 *
 * @param specDir - The spec directory path
 * @param phase - The execution phase ('planning', 'coding', 'qa', 'spec')
 * @param getProviderPhaseModels - Injected reader for the user's per-provider phase config
 */
export async function resolveTaskModelId(
  specDir: string,
  phase: TaskPhase,
  getProviderPhaseModels: ProviderPhaseModelsReader,
): Promise<string> {
  try {
    const metadata = readTaskMetadata(specDir);
    if (metadata) {
      // Determine the target provider for this phase
      const targetProvider = (metadata.phaseProviders?.[phase] ?? metadata.provider ?? null) as BuiltinProvider | null;

      let shorthand: string | undefined;
      if (metadata.phaseModels?.[phase]) {
        shorthand = metadata.phaseModels[phase];
      } else if (metadata.model) {
        shorthand = metadata.model;
      }

      // If shorthand is empty (e.g., Ollama presets use '' because models are dynamic),
      // try reading the user's per-provider phase config from settings
      if (!shorthand && targetProvider) {
        const providerPhaseModels = getProviderPhaseModels(targetProvider);
        if (providerPhaseModels?.[phase]) {
          shorthand = providerPhaseModels[phase];
        }
      }

      if (shorthand) {
        // First resolve to a full model ID (handles Anthropic shorthands like 'opus' → 'claude-opus-4-6')
        const baseModelId = resolveModelId(shorthand);

        // If the target provider is non-Anthropic, translate the model ID to the
        // target provider's equivalent. This ensures the queue resolution succeeds
        // when the user has swapped away from Anthropic.
        if (targetProvider && targetProvider !== 'anthropic') {
          const equiv = resolveModelEquivalent(shorthand, targetProvider)
            ?? resolveModelEquivalent(baseModelId, targetProvider);
          if (equiv) {
            return equiv.modelId;
          }
          // If no equivalence found and the model is already a raw model name
          // (e.g., user-configured Ollama model), pass it through unchanged
          return shorthand;
        }

        return baseModelId;
      }

      // Still no model but have a target provider — resolve 'sonnet' equivalent
      if (targetProvider && targetProvider !== 'anthropic') {
        const equiv = resolveModelEquivalent('sonnet', targetProvider);
        if (equiv) return equiv.modelId;
      }
    }
  } catch {
    // Fall through to default
  }

  // Default: resolve 'sonnet' (Anthropic fallback)
  return resolveModelId('sonnet');
}
