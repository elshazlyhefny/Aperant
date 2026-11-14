/**
 * Shared auto-fix on-disk store (config, queue, batches) for GitHub and GitLab.
 *
 * Deliberately free of electron imports so it stays unit-testable.
 */

import path from 'path';
import fs from 'fs';
import type { Project } from '../../../shared/types';

export interface AutoFixConfigBase {
  enabled: boolean;
  labels: string[];
  requireHumanApproval: boolean;
  model: string;
  thinkingLevel: string;
}

/**
 * Single source of the auto-fix defaults. Frozen; use getDefaultAutoFixConfig()
 * to obtain a mutable copy.
 */
export const DEFAULT_AUTOFIX_CONFIG: Readonly<AutoFixConfigBase> = Object.freeze({
  enabled: false,
  labels: Object.freeze(['auto-fix']) as unknown as string[],
  requireHumanApproval: true,
  model: 'claude-sonnet-4-6',
  thinkingLevel: 'medium',
});

/** Fresh copy of the defaults (labels array cloned) so callers cannot mutate them. */
export function getDefaultAutoFixConfig(): AutoFixConfigBase {
  return { ...DEFAULT_AUTOFIX_CONFIG, labels: [...DEFAULT_AUTOFIX_CONFIG.labels] };
}

/**
 * Validate that a resolved path stays within the project directory
 * Prevents path traversal attacks via malicious project.path values
 */
export function validatePathWithinProject(projectPath: string, resolvedPath: string): void {
  const normalizedProject = path.resolve(projectPath);
  const normalizedResolved = path.resolve(resolvedPath);

  if (!normalizedResolved.startsWith(normalizedProject + path.sep) && normalizedResolved !== normalizedProject) {
    throw new Error('Invalid path: path traversal detected');
  }
}

export interface AutoFixStoreOptions<TQueueItem, TBatch> {
  providerDir: 'github' | 'gitlab';
  mapQueueItem: (data: Record<string, any>) => TQueueItem;
  mapBatch: (data: Record<string, any>) => TBatch;
  /** Maps a camelCase config field to its snake_case JSON key, e.g. { botToken: 'bot_token' } */
  extraConfigKeys?: Record<string, string>;
  compareBatches?: (a: TBatch, b: TBatch) => number;
}

export function createAutoFixStore<
  TConfigExtra extends object = Record<string, never>,
  TQueueItem extends { createdAt: string } = { createdAt: string },
  TBatch = unknown,
>(options: AutoFixStoreOptions<TQueueItem, TBatch>) {
  const { providerDir, mapQueueItem, mapBatch, extraConfigKeys = {}, compareBatches } = options;

  type Config = AutoFixConfigBase & TConfigExtra;

  function getDir(project: Project): string {
    const dir = path.join(project.path, '.auto-claude', providerDir);
    validatePathWithinProject(project.path, dir);
    return dir;
  }

  function getConfig(project: Project): Config {
    const configPath = path.join(getDir(project), 'config.json');

    // Use try/catch instead of existsSync to avoid TOCTOU race condition
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const defaults = getDefaultAutoFixConfig();
      const config: Record<string, unknown> = {
        enabled: data.auto_fix_enabled ?? defaults.enabled,
        labels: data.auto_fix_labels ?? defaults.labels,
        requireHumanApproval: data.require_human_approval ?? defaults.requireHumanApproval,
        model: data.model ?? defaults.model,
        thinkingLevel: data.thinking_level ?? defaults.thinkingLevel,
      };
      for (const [field, key] of Object.entries(extraConfigKeys)) {
        config[field] = data[key];
      }
      return config as Config;
    } catch {
      // File doesn't exist or is invalid - return defaults
    }

    return getDefaultAutoFixConfig() as Config;
  }

  function saveConfig(project: Project, config: Config): void {
    const dir = getDir(project);
    fs.mkdirSync(dir, { recursive: true });

    const configPath = path.join(dir, 'config.json');
    let existingConfig: Record<string, unknown> = {};

    // Use try/catch instead of existsSync to avoid TOCTOU race condition
    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // File doesn't exist or is invalid - use empty config
    }

    const updatedConfig: Record<string, unknown> = {
      ...existingConfig,
      auto_fix_enabled: config.enabled,
      auto_fix_labels: config.labels,
      require_human_approval: config.requireHumanApproval,
      model: config.model,
      thinking_level: config.thinkingLevel,
    };
    for (const [field, key] of Object.entries(extraConfigKeys)) {
      updatedConfig[key] = (config as Record<string, unknown>)[field];
    }

    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf-8');
  }

  function readMatching<T>(
    dir: string,
    prefix: string,
    map: (data: Record<string, any>) => T
  ): T[] {
    // Use try/catch instead of existsSync to avoid TOCTOU race condition
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      // Directory doesn't exist or can't be read
      return [];
    }

    const results: T[] = [];
    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          results.push(map(data));
        } catch {
          // Skip invalid files
        }
      }
    }
    return results;
  }

  function getQueue(project: Project): TQueueItem[] {
    const issuesDir = path.join(getDir(project), 'issues');
    return readMatching(issuesDir, 'autofix_', mapQueueItem).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  function getBatches(project: Project): TBatch[] {
    const batchesDir = path.join(getDir(project), 'batches');
    const batches = readMatching(batchesDir, 'batch_', mapBatch);
    return compareBatches ? batches.sort(compareBatches) : batches;
  }

  return { getDir, getConfig, saveConfig, getQueue, getBatches };
}
