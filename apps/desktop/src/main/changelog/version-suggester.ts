import type { ChildProcess } from 'child_process';
import * as os from 'os';
import type { GitCommit } from '../../shared/types';
import { getBestAvailableProfileEnv } from '../rate-limit-detector';

import { getAugmentedEnv } from '../env-utils';
import { isWindows } from '../platform';
import { spawnClaudeWithPrompt } from './claude-cli';

interface VersionSuggestion {
  version: string;
  reason: string;
  bumpType: 'major' | 'minor' | 'patch';
}

/**
 * AI-powered version bump suggester using Claude SDK with haiku model
 * Analyzes commits to intelligently suggest semantic version bumps
 */
export class VersionSuggester {
  private debugEnabled: boolean;

  constructor(
    _pythonPath: string,
    private claudePath: string,
    private autoBuildSourcePath: string,
    debugEnabled: boolean
  ) {
    this.debugEnabled = debugEnabled;
  }

  private debug(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[VersionSuggester]', ...args);
    }
  }

  /**
   * Suggest version bump using AI analysis of commits
   */
  async suggestVersionBump(
    commits: GitCommit[],
    currentVersion: string
  ): Promise<VersionSuggestion> {
    this.debug('suggestVersionBump called', {
      commitCount: commits.length,
      currentVersion
    });

    // Build prompt for Claude to analyze commits
    const prompt = this.buildPrompt(commits, currentVersion);

    // Build environment
    const spawnEnv = this.buildSpawnEnvironment();

    return new Promise((resolve, _reject) => {
      // zeenha fork: the prompt goes to the CLI via stdin, never on the command line
      let childProcess: ChildProcess;
      try {
        childProcess = spawnClaudeWithPrompt({
          claudePath: this.claudePath,
          prompt,
          cwd: this.autoBuildSourcePath,
          env: spawnEnv
        });
      } catch (err) {
        this.debug('Failed to spawn Claude CLI', err);
        resolve(this.fallbackSuggestion(currentVersion));
        return;
      }

      let output = '';
      let errorOutput = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        output += data.toString('utf-8');
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        errorOutput += data.toString('utf-8');
      });

      childProcess.on('exit', (code: number | null) => {
        if (code === 0 && output.trim()) {
          try {
            const result = this.parseAIResponse(output.trim(), currentVersion);
            this.debug('AI suggestion parsed', result);
            resolve(result);
          } catch (error) {
            this.debug('Failed to parse AI response', error);
            // Fallback to simple bump
            resolve(this.fallbackSuggestion(currentVersion));
          }
        } else {
          this.debug('AI analysis failed', { code, error: errorOutput });
          // Fallback to simple bump
          resolve(this.fallbackSuggestion(currentVersion));
        }
      });

      childProcess.on('error', (err: Error) => {
        this.debug('Process error', err);
        resolve(this.fallbackSuggestion(currentVersion));
      });
    });
  }

  /**
   * Build prompt for Claude to analyze commits and suggest version bump
   */
  private buildPrompt(commits: GitCommit[], currentVersion: string): string {
    const commitSummary = commits
      .map((c, i) => `${i + 1}. ${c.hash} - ${c.subject}`)
      .join('\n');

    return `You are a semantic versioning expert analyzing git commits to suggest the appropriate version bump.

Current version: ${currentVersion}

Analyze these ${commits.length} commits and determine the appropriate semantic version bump:

${commitSummary}

Consider:
- MAJOR (X.0.0): Breaking changes, API changes, removed features, architectural changes
- MINOR (0.X.0): New features, enhancements, additions that maintain backward compatibility
- PATCH (0.0.X): Bug fixes, small tweaks, documentation updates, refactoring without new features

Respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{
  "bumpType": "major|minor|patch",
  "reason": "Brief explanation of the decision"
}`;
  }

  /**
   * Parse AI response to extract version suggestion
   */
  private parseAIResponse(output: string, currentVersion: string): VersionSuggestion {
    // Extract JSON from output (Claude might wrap it in markdown or other text)
    const jsonMatch = output.match(/\{[\s\S]*"bumpType"[\s\S]*"reason"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const bumpType = parsed.bumpType as 'major' | 'minor' | 'patch';
    const reason = parsed.reason || 'AI analysis of commits';

    // Calculate new version
    const [major, minor, patch] = currentVersion.split('.').map(Number);

    let newVersion: string;
    switch (bumpType) {
      case 'major':
        newVersion = `${major + 1}.0.0`;
        break;
      case 'minor':
        newVersion = `${major}.${minor + 1}.0`;
        break;
      default:
        newVersion = `${major}.${minor}.${patch + 1}`;
        break;
    }

    return {
      version: newVersion,
      reason,
      bumpType
    };
  }

  /**
   * Fallback suggestion if AI analysis fails
   */
  private fallbackSuggestion(currentVersion: string): VersionSuggestion {
    const [major, minor, patch] = currentVersion.split('.').map(Number);
    return {
      version: `${major}.${minor}.${patch + 1}`,
      reason: 'Patch version bump (default)',
      bumpType: 'patch'
    };
  }

  /**
   * Build spawn environment with proper PATH and auth settings
   */
  private buildSpawnEnvironment(): Record<string, string> {
    const homeDir = os.homedir();

    // Use getAugmentedEnv() to ensure common tool paths are available
    // even when app is launched from Finder/Dock
    const augmentedEnv = getAugmentedEnv();

    // Get best available Claude profile environment (automatically handles rate limits)
    const profileResult = getBestAvailableProfileEnv();
    const profileEnv = profileResult.env;

    const spawnEnv: Record<string, string> = {
      ...augmentedEnv,
      ...profileEnv,
      // Ensure critical env vars are set for claude CLI
      ...(isWindows() ? { USERPROFILE: homeDir } : { HOME: homeDir }),
      USER: process.env.USER || process.env.USERNAME || 'user'
    };

    return spawnEnv;
  }
}
