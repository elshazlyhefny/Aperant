/**
 * Parallel Follow-up PR Reviewer
 * ===============================
 *
 * PR follow-up reviewer using parallel specialist analysis via Promise.allSettled().
 * See apps/desktop/src/main/ai/runners/github/parallel-followup.ts for the TypeScript implementation.
 *
 * The orchestrator analyzes incremental changes and delegates to specialized agents:
 * - resolution-verifier: Verifies previous findings are addressed
 * - new-code-reviewer: Reviews new code for issues
 * - comment-analyzer: Processes contributor and AI feedback
 *
 * Key Design:
 * - Replaces SDK `agents={}` with Promise.allSettled() pattern
 * - Each specialist runs as its own generateText() call
 * - Uses createSimpleClient() for lightweight parallel sessions
 */

import { generateText, Output } from 'ai';
import * as crypto from 'node:crypto';

import { createSimpleClient } from '../../client/factory';
import type { ModelShorthand, ThinkingLevel } from '../../config/types';
import { safeParseJson } from '../../../utils/json-repair';
import { ResolutionVerificationSchema, ReviewFindingsArraySchema } from '../../schema/pr-review';
import {
  ResolutionVerificationOutputSchema,
  ReviewFindingsOutputSchema,
} from '../../schema/output/pr-review.output';
import type {
  PRReviewFinding,
  ProgressCallback,
  ProgressUpdate,
} from './pr-review-engine';
import { ReviewCategory, ReviewSeverity } from './pr-review-engine';
import { MergeVerdict } from './parallel-orchestrator';

// =============================================================================
// Types
// =============================================================================

/** Previous review result for follow-up context. */
export interface PreviousReviewResult {
  reviewId?: string | number;
  prNumber: number;
  findings: PRReviewFinding[];
  summary?: string;
}

/** Context for a follow-up review. */
export interface FollowupReviewContext {
  prNumber: number;
  previousReview: PreviousReviewResult;
  previousCommitSha: string;
  currentCommitSha: string;
  commitsSinceReview: Array<Record<string, unknown>>;
  filesChangedSinceReview: string[];
  diffSinceReview: string;
  contributorCommentsSinceReview: Array<Record<string, unknown>>;
  aiBotCommentsSinceReview: Array<Record<string, unknown>>;
  prReviewsSinceReview: Array<Record<string, unknown>>;
  ciStatus?: Record<string, unknown>;
  hasMergeConflicts?: boolean;
  mergeStateStatus?: string;
}

/** Result from the follow-up review. */
export interface FollowupReviewResult {
  prNumber: number;
  success: boolean;
  findings: PRReviewFinding[];
  summary: string;
  overallStatus: string;
  verdict: MergeVerdict;
  verdictReasoning: string;
  blockers: string[];
  reviewedCommitSha: string;
  isFollowupReview: true;
  previousReviewId?: string | number;
  resolvedFindings: string[];
  unresolvedFindings: string[];
  newFindingsSinceLastReview: string[];
}

/** Configuration for the followup reviewer. */
export interface FollowupReviewerConfig {
  repo: string;
  model?: ModelShorthand;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
}

/**
 * zeenha fork: thrown when every scheduled follow-up specialist failed, so no
 * verdict exists. Escapes `review()` (it is not folded into `success: false`).
 */
export class FollowupReviewIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FollowupReviewIncompleteError';
  }
}

// =============================================================================
// Helpers
// =============================================================================

const SEVERITY_MAP: Record<string, PRReviewFinding['severity']> = {
  critical: ReviewSeverity.CRITICAL,
  high: ReviewSeverity.HIGH,
  medium: ReviewSeverity.MEDIUM,
  low: ReviewSeverity.LOW,
};

function mapSeverity(s: string): PRReviewFinding['severity'] {
  return SEVERITY_MAP[s.toLowerCase()] ?? ReviewSeverity.MEDIUM;
}

const CATEGORY_MAP: Record<string, PRReviewFinding['category']> = {
  security: ReviewCategory.SECURITY,
  quality: ReviewCategory.QUALITY,
  style: ReviewCategory.STYLE,
  test: ReviewCategory.TEST,
  docs: ReviewCategory.DOCS,
  pattern: ReviewCategory.PATTERN,
  performance: ReviewCategory.PERFORMANCE,
};

function mapCategory(c: string): PRReviewFinding['category'] {
  return CATEGORY_MAP[c.toLowerCase()] ?? ReviewCategory.QUALITY;
}

function generateFindingId(file: string, line: number, title: string): string {
  const hash = crypto
    .createHash('md5')
    .update(`${file}:${line}:${title}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `FU-${hash}`;
}

function parseJsonResponse(text: string): unknown {
  const result = safeParseJson<unknown>(text.trim());
  if (result !== null) return result;
  // Try stripping fences and reparsing
  const fenceMatch = text.trim().match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    return safeParseJson<unknown>(fenceMatch[1]);
  }
  return null;
}

// =============================================================================
// Format helpers
// =============================================================================

function formatPreviousFindings(context: FollowupReviewContext): string {
  const findings = context.previousReview.findings;
  if (findings.length === 0) return 'No previous findings to verify.';
  return findings
    .map(
      (f) =>
        `- **${f.id}** [${f.severity}] ${f.title}\n  File: ${f.file}:${f.line}\n  ${f.description.slice(0, 200)}...`,
    )
    .join('\n');
}

function formatCommits(context: FollowupReviewContext): string {
  if (context.commitsSinceReview.length === 0) return 'No new commits.';
  return context.commitsSinceReview
    .slice(0, 20)
    .map((c) => {
      const sha = String(c.sha ?? '').slice(0, 7);
      const commit = c.commit as Record<string, unknown> | undefined;
      const message = String((commit?.message as string) ?? '').split('\n')[0];
      const author =
        ((commit?.author as Record<string, unknown>)?.name as string) ?? 'unknown';
      return `- \`${sha}\` by ${author}: ${message}`;
    })
    .join('\n');
}

function formatComments(context: FollowupReviewContext): string {
  if (context.contributorCommentsSinceReview.length === 0) {
    return 'No contributor comments since last review.';
  }
  return context.contributorCommentsSinceReview
    .slice(0, 15)
    .map((c) => {
      const user = (c.user as Record<string, unknown>)?.login ?? 'unknown';
      const body = String(c.body ?? '').slice(0, 300);
      return `**@${user}**: ${body}`;
    })
    .join('\n\n');
}

function formatCIStatus(context: FollowupReviewContext): string {
  const ci = context.ciStatus;
  if (!ci) return 'CI status not available.';

  const passing = (ci.passing as number) ?? 0;
  const failing = (ci.failing as number) ?? 0;
  const pending = (ci.pending as number) ?? 0;
  const failedChecks = (ci.failed_checks as string[]) ?? [];

  const lines: string[] = [];
  if (failing > 0) {
    lines.push(`⚠️ **${failing} CI check(s) FAILING**`);
    if (failedChecks.length > 0) {
      lines.push('Failed checks:');
      for (const check of failedChecks) lines.push(`  - ❌ ${check}`);
    }
  } else if (pending > 0) {
    lines.push(`⏳ **${pending} CI check(s) pending**`);
  } else if (passing > 0) {
    lines.push(`✅ **All ${passing} CI check(s) passing**`);
  } else {
    lines.push('No CI checks configured');
  }
  return lines.join('\n');
}

// =============================================================================
// Specialist prompts
// =============================================================================

function buildResolutionVerifierPrompt(context: FollowupReviewContext): string {
  const previousFindings = formatPreviousFindings(context);
  const MAX_DIFF = 100_000;
  const diff =
    context.diffSinceReview.length > MAX_DIFF
      ? `${context.diffSinceReview.slice(0, MAX_DIFF)}\n\n... (diff truncated)`
      : context.diffSinceReview;

  return `You are a resolution verification specialist for PR follow-up review.

## Task
Verify whether each previous finding has been addressed in the new changes.

## Previous Findings
${previousFindings}

## Diff Since Last Review
\`\`\`diff
${diff}
\`\`\`

## Output Format
Return ONLY valid JSON (no markdown fencing):
{
  "verifications": [
    {
      "finding_id": "string",
      "status": "resolved|unresolved|partially_resolved|cant_verify",
      "evidence": "Explanation of why you believe this finding is resolved or not"
    }
  ]
}`;
}

function buildNewCodeReviewerPrompt(context: FollowupReviewContext): string {
  const MAX_DIFF = 100_000;
  const diff =
    context.diffSinceReview.length > MAX_DIFF
      ? `${context.diffSinceReview.slice(0, MAX_DIFF)}\n\n... (diff truncated)`
      : context.diffSinceReview;

  return `You are a code review specialist analyzing new changes in a follow-up review.

## Files Changed
${context.filesChangedSinceReview.map((f) => `- ${f}`).join('\n')}

## Diff Since Last Review
\`\`\`diff
${diff}
\`\`\`

## Output Format
Return ONLY valid JSON (no markdown fencing):
{
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "security|quality|style|test|docs|pattern|performance",
      "title": "Brief title",
      "description": "Detailed explanation",
      "file": "path/to/file",
      "line": 42,
      "suggested_fix": "Optional fix",
      "fixable": true
    }
  ]
}`;
}

function buildCommentAnalyzerPrompt(context: FollowupReviewContext): string {
  const comments = formatComments(context);
  const aiContent = context.aiBotCommentsSinceReview
    .slice(0, 10)
    .map((c) => {
      const user = (c.user as Record<string, unknown>)?.login ?? 'unknown';
      const body = String(c.body ?? '').slice(0, 500);
      return `**${user}**: ${body}`;
    })
    .join('\n\n---\n\n');

  return `You are a comment analysis specialist for PR follow-up review.

## Contributor Comments
${comments}

## AI Tool Feedback
${aiContent || 'No AI tool feedback since last review.'}

## Output Format
Return ONLY valid JSON (no markdown fencing):
{
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "security|quality|style|test|docs|pattern|performance",
      "title": "Brief title from comment",
      "description": "What the comment raised and why it matters",
      "file": "path/to/file",
      "line": 0,
      "suggested_fix": "Optional",
      "fixable": true
    }
  ]
}`;
}

// =============================================================================
// Main Reviewer
// =============================================================================

export class ParallelFollowupReviewer {
  private readonly config: FollowupReviewerConfig;
  private readonly progressCallback?: ProgressCallback;

  constructor(config: FollowupReviewerConfig, progressCallback?: ProgressCallback) {
    this.config = config;
    this.progressCallback = progressCallback;
  }

  private reportProgress(update: ProgressUpdate): void {
    this.progressCallback?.(update);
  }

  /**
   * Run the follow-up review with parallel specialist analysis.
   */
  async review(
    context: FollowupReviewContext,
    abortSignal?: AbortSignal,
  ): Promise<FollowupReviewResult> {
    const modelShorthand = this.config.model ?? 'sonnet';
    const thinkingLevel = this.config.thinkingLevel ?? 'medium';

    try {
      this.reportProgress({
        phase: 'orchestrating',
        progress: 35,
        message: 'Parallel followup analysis starting...',
        prNumber: context.prNumber,
      });

      // Run specialists in parallel
      const hasFindings = context.previousReview.findings.length > 0;
      const hasSubstantialDiff = context.diffSinceReview.length > 100;
      const hasComments =
        context.contributorCommentsSinceReview.length > 0 ||
        context.aiBotCommentsSinceReview.length > 0;

      const tasks: Array<Promise<{ type: string; result: string }>> = [];
      // zeenha fork: the name of each scheduled task, in order, so a rejected
      // task can still be named (a rejection carries no `value.type`).
      const taskTypes: string[] = [];

      if (hasFindings) {
        taskTypes.push('resolution-verifier');
        tasks.push(
          this.runSpecialist(
            'resolution-verifier',
            buildResolutionVerifierPrompt(context),
            modelShorthand,
            thinkingLevel,
            abortSignal,
          ),
        );
      }

      if (hasSubstantialDiff) {
        taskTypes.push('new-code-reviewer');
        tasks.push(
          this.runSpecialist(
            'new-code-reviewer',
            buildNewCodeReviewerPrompt(context),
            modelShorthand,
            thinkingLevel,
            abortSignal,
          ),
        );
      }

      if (hasComments) {
        taskTypes.push('comment-analyzer');
        tasks.push(
          this.runSpecialist(
            'comment-analyzer',
            buildCommentAnalyzerPrompt(context),
            modelShorthand,
            thinkingLevel,
            abortSignal,
          ),
        );
      }

      const settled = await Promise.allSettled(tasks);
      const agentsInvoked: string[] = [];

      this.reportProgress({
        phase: 'finalizing',
        progress: 50,
        message: 'Synthesizing follow-up findings...',
        prNumber: context.prNumber,
      });

      // Parse results
      const resolvedIds: string[] = [];
      const unresolvedIds: string[] = [];
      const newFindingIds: string[] = [];
      const findings: PRReviewFinding[] = [];

      // zeenha fork: a specialist that failed (rejected, unparseable output, or a
      // parse error) looked at nothing. These used to be skipped, so previous
      // findings were neither resolved nor unresolved and the verdict came out
      // READY_TO_MERGE: an approval for a PR nobody re-checked.
      const failedSpecialists: Array<{ name: string; reason: string }> = [];

      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        const type = taskTypes[i];
        agentsInvoked.push(type);
        if (s.status !== 'fulfilled') {
          const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
          failedSpecialists.push({ name: type, reason });
          continue;
        }
        const { result } = s.value;

        try {
          if (type === 'resolution-verifier') {
            // Validate with ResolutionVerificationSchema
            const rawData = parseJsonResponse(result);
            const verification = ResolutionVerificationSchema.safeParse(rawData);
            if (!verification.success) {
              // zeenha fork: unparseable output is a failure, not "nothing to verify".
              failedSpecialists.push({ name: type, reason: 'unparseable output' });
              continue;
            }
            const verifications = verification.data.verifications;

            for (const v of verifications) {
              if (!v.findingId) continue;
              if (v.status === 'resolved') {
                resolvedIds.push(v.findingId);
              } else {
                unresolvedIds.push(v.findingId);
                // Re-add unresolved finding from previous review
                const original = context.previousReview.findings.find(
                  (f) => f.id === v.findingId,
                );
                if (original) {
                  findings.push({
                    ...original,
                    title: `[UNRESOLVED] ${original.title}`,
                    description: `${original.description}\n\nResolution note: ${v.evidence || 'Not resolved'}`,
                  });
                }
              }
            }
          } else {
            // new-code-reviewer or comment-analyzer
            // Validate with ReviewFindingsArraySchema
            const rawData = parseJsonResponse(result);
            // zeenha fork: ReviewFindingsArraySchema coerces null to [], so
            // unparseable output used to read as "no findings".
            if (rawData === null || typeof rawData !== 'object') {
              failedSpecialists.push({ name: type, reason: 'unparseable output' });
              continue;
            }
            // The specialist returns { findings: [...] } — extract findings
            const rawFindings = rawData && typeof rawData === 'object' && 'findings' in rawData
              ? (rawData as Record<string, unknown>).findings
              : rawData;
            const validatedFindings = ReviewFindingsArraySchema.safeParse(rawFindings);
            if (!validatedFindings.success) {
              failedSpecialists.push({ name: type, reason: 'unparseable output' });
              continue;
            }
            const validFindings = validatedFindings.data;

            const prefix = type === 'comment-analyzer' ? '[FROM COMMENTS] ' : '';
            for (const f of validFindings) {
              if (!f.title || !f.file) continue;
              const id = generateFindingId(f.file, f.line ?? 0, f.title);
              newFindingIds.push(id);
              findings.push({
                id,
                severity: mapSeverity(f.severity ?? 'medium'),
                category: mapCategory(f.category ?? 'quality'),
                title: `${prefix}${f.title}`,
                description: f.description ?? '',
                file: f.file,
                line: f.line ?? 0,
                suggestedFix: f.suggestedFix,
                fixable: f.fixable ?? false,
              });
            }
          }
        } catch (error) {
          // zeenha fork: a parse error is a failed specialist, not a clean one.
          const reason = error instanceof Error ? error.message : String(error);
          failedSpecialists.push({ name: type, reason });
        }
      }

      if (failedSpecialists.length > 0 && failedSpecialists.length === settled.length) {
        throw new FollowupReviewIncompleteError(
          `Follow-up review could not run: all ${failedSpecialists.length} reviewers failed (${failedSpecialists[0].reason.slice(0, 200)})`,
        );
      }

      // zeenha fork: a previous finding the resolution verifier did not return a
      // verdict for (verifier failed, or omitted it) is carried forward as
      // UNRESOLVED. Nobody checked it, so it cannot silently disappear.
      if (hasFindings) {
        const verified = new Set([...resolvedIds, ...unresolvedIds]);
        for (const original of context.previousReview.findings) {
          if (original.id && verified.has(original.id)) continue;
          if (original.id) unresolvedIds.push(original.id);
          findings.push({
            ...original,
            title: `[UNRESOLVED] ${original.title}`,
            description: `${original.description}\n\nResolution note: not verified in this follow-up review, so it is carried forward as unresolved.`,
          });
        }
      }

      // Deduplicate
      const uniqueFindings = this.deduplicateFindings(findings);

      // Determine verdict
      let verdict = this.determineVerdict(uniqueFindings, unresolvedIds);
      let verdictReasoning = this.buildVerdictReasoning(
        verdict,
        resolvedIds,
        unresolvedIds,
        newFindingIds,
      );

      // Override for merge conflicts / CI
      const blockers: string[] = [];

      if (context.hasMergeConflicts) {
        blockers.push('Merge Conflicts: PR has conflicts with base branch');
        verdict = MergeVerdict.BLOCKED;
        verdictReasoning = 'Blocked: PR has merge conflicts with base branch.';
      } else if (context.mergeStateStatus === 'BEHIND') {
        blockers.push('Branch is behind base branch and needs update');
        if (
          verdict === MergeVerdict.READY_TO_MERGE ||
          verdict === MergeVerdict.MERGE_WITH_CHANGES
        ) {
          verdict = MergeVerdict.NEEDS_REVISION;
          verdictReasoning = 'Branch is behind base — update before merge.';
        }
      }

      // CI enforcement
      const ci = context.ciStatus ?? {};
      const failingCI = (ci.failing as number) ?? 0;
      const pendingCI = (ci.pending as number) ?? 0;

      if (failingCI > 0) {
        if (
          verdict === MergeVerdict.READY_TO_MERGE ||
          verdict === MergeVerdict.MERGE_WITH_CHANGES
        ) {
          verdict = MergeVerdict.BLOCKED;
          verdictReasoning = `Blocked: ${failingCI} CI check(s) failing.`;
          blockers.push(`CI Failing: ${failingCI} check(s) failing`);
        }
      } else if (pendingCI > 0) {
        if (
          verdict === MergeVerdict.READY_TO_MERGE ||
          verdict === MergeVerdict.MERGE_WITH_CHANGES
        ) {
          verdict = MergeVerdict.NEEDS_REVISION;
          verdictReasoning = `Ready once CI passes: ${pendingCI} check(s) still pending.`;
        }
      }

      for (const f of uniqueFindings) {
        if (
          f.severity === ReviewSeverity.CRITICAL ||
          f.severity === ReviewSeverity.HIGH ||
          f.severity === ReviewSeverity.MEDIUM
        ) {
          blockers.push(`${f.category}: ${f.title}`);
        }
      }

      if (failedSpecialists.length > 0) {
        // zeenha fork: an incomplete review never approves, and says what failed.
        const names = failedSpecialists.map((f) => f.name).join(', ');
        if (verdict === MergeVerdict.READY_TO_MERGE) {
          verdict = MergeVerdict.MERGE_WITH_CHANGES;
        }
        verdictReasoning = `Incomplete review: the ${names} reviewer(s) failed, so this PR was not fully checked. ${verdictReasoning}`;
      }

      const overallStatus =
        verdict === MergeVerdict.READY_TO_MERGE
          ? 'approve'
          : verdict === MergeVerdict.MERGE_WITH_CHANGES
            ? 'comment'
            : 'request_changes';

      const summary = this.generateSummary(
        verdict,
        verdictReasoning,
        blockers,
        resolvedIds.length,
        unresolvedIds.length,
        newFindingIds.length,
        agentsInvoked,
      );

      return {
        prNumber: context.prNumber,
        success: true,
        findings: uniqueFindings,
        summary,
        overallStatus,
        verdict,
        verdictReasoning,
        blockers,
        reviewedCommitSha: context.currentCommitSha,
        isFollowupReview: true,
        previousReviewId: context.previousReview.reviewId ?? context.previousReview.prNumber,
        resolvedFindings: resolvedIds,
        unresolvedFindings: unresolvedIds,
        newFindingsSinceLastReview: newFindingIds,
      };
    } catch (error) {
      // zeenha fork: the caller ignores `success` and saves this as a finished
      // review, so a review that could not run must reach the caller as an error.
      if (error instanceof FollowupReviewIncompleteError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        prNumber: context.prNumber,
        success: false,
        findings: [],
        summary: `Follow-up review failed: ${message}`,
        overallStatus: 'comment',
        verdict: MergeVerdict.NEEDS_REVISION,
        verdictReasoning: `Review failed: ${message}`,
        blockers: [message],
        reviewedCommitSha: context.currentCommitSha,
        isFollowupReview: true,
        previousReviewId: context.previousReview.reviewId ?? context.previousReview.prNumber,
        resolvedFindings: [],
        unresolvedFindings: [],
        newFindingsSinceLastReview: [],
      };
    }
  }

  private async runSpecialist(
    type: string,
    prompt: string,
    modelShorthand: ModelShorthand,
    thinkingLevel: ThinkingLevel,
    abortSignal?: AbortSignal,
  ): Promise<{ type: string; result: string }> {
    const client = await createSimpleClient({
      systemPrompt: `You are a ${type} specialist for PR follow-up review.`,
      modelShorthand,
      thinkingLevel,
    });

    // Use Output.object() with the schema appropriate for this specialist type.
    // ResolutionVerificationOutputSchema returns { verifications: [...] }.
    // ReviewFindingsOutputSchema returns { findings: [...] }.
    // Each branch uses the concrete schema type so TypeScript can infer the output type.
    if (type === 'resolution-verifier') {
      const result = await generateText({
        model: client.model,
        system: client.systemPrompt,
        prompt,
        output: Output.object({ schema: ResolutionVerificationOutputSchema }),
        abortSignal,
      });
      // Use structured output if available; serialize so downstream parsing is unchanged.
      if (result.output) {
        return { type, result: JSON.stringify(result.output) };
      }
      return { type, result: result.text };
    }

    // new-code-reviewer and comment-analyzer both return { findings: [...] }
    const result = await generateText({
      model: client.model,
      system: client.systemPrompt,
      prompt,
      output: Output.object({ schema: ReviewFindingsOutputSchema }),
      abortSignal,
    });
    // Use structured output if available; serialize so downstream parsing is unchanged.
    if (result.output) {
      return { type, result: JSON.stringify(result.output) };
    }
    // Fall back to raw text for providers that don't support Output.object()
    return { type, result: result.text };
  }

  private deduplicateFindings(findings: PRReviewFinding[]): PRReviewFinding[] {
    const seen = new Set<string>();
    const unique: PRReviewFinding[] = [];
    for (const f of findings) {
      const key = `${f.file}:${f.line}:${f.title.toLowerCase().trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(f);
      }
    }
    return unique;
  }

  private determineVerdict(
    findings: PRReviewFinding[],
    unresolvedIds: string[],
  ): MergeVerdict {
    const hasCritical = findings.some((f) => f.severity === ReviewSeverity.CRITICAL);
    const hasHigh = findings.some((f) => f.severity === ReviewSeverity.HIGH);

    if (hasCritical) return MergeVerdict.BLOCKED;
    if (hasHigh || unresolvedIds.length > 0) return MergeVerdict.NEEDS_REVISION;
    if (findings.length > 0) return MergeVerdict.MERGE_WITH_CHANGES;
    return MergeVerdict.READY_TO_MERGE;
  }

  private buildVerdictReasoning(
    verdict: MergeVerdict,
    resolvedIds: string[],
    unresolvedIds: string[],
    newFindingIds: string[],
  ): string {
    const parts: string[] = [];
    if (resolvedIds.length > 0) parts.push(`${resolvedIds.length} finding(s) resolved`);
    if (unresolvedIds.length > 0)
      parts.push(`${unresolvedIds.length} finding(s) still unresolved`);
    if (newFindingIds.length > 0)
      parts.push(`${newFindingIds.length} new issue(s) found`);
    return parts.length > 0 ? parts.join(', ') + '.' : 'No issues found.';
  }

  private generateSummary(
    verdict: MergeVerdict,
    verdictReasoning: string,
    blockers: string[],
    resolvedCount: number,
    unresolvedCount: number,
    newCount: number,
    agentsInvoked: string[],
  ): string {
    const statusEmoji: Record<MergeVerdict, string> = {
      [MergeVerdict.READY_TO_MERGE]: '✅',
      [MergeVerdict.MERGE_WITH_CHANGES]: '🟡',
      [MergeVerdict.NEEDS_REVISION]: '🟠',
      [MergeVerdict.BLOCKED]: '🔴',
    };

    const emoji = statusEmoji[verdict] ?? '📝';
    const agentsStr = agentsInvoked.length > 0 ? agentsInvoked.join(', ') : 'orchestrator only';

    const blockersSection =
      blockers.length > 0
        ? `\n### 🚨 Blocking Issues\n${blockers.map((b) => `- ${b}`).join('\n')}\n`
        : '';

    return `## ${emoji} Follow-up Review: ${verdict.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}

### Resolution Status
- ✅ **Resolved**: ${resolvedCount} previous findings addressed
- ❌ **Unresolved**: ${unresolvedCount} previous findings remain
- 🆕 **New Issues**: ${newCount} new findings in recent changes
${blockersSection}
### Verdict
${verdictReasoning}

### Review Process
Agents invoked: ${agentsStr}

---
*AI-generated follow-up review using parallel specialist analysis.*
`;
  }
}
