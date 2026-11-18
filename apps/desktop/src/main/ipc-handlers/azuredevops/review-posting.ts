/**
 * zeenha fork: posts a confirmed Azure DevOps PR review as PR comment threads
 * (optional inline threads plus one summary thread).
 * Comment bodies and tokens are never logged.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, Project } from '../../../shared/types';
import type { AzureDevOpsPostReviewOptions, AzureDevOpsPostReviewResult } from '../../../shared/types/integrations';
import type { PRReviewFinding, PRReviewResult } from '../../../shared/types/pr-review';
import { projectStore } from '../../project-store';
import { createDebugLog } from '../../../shared/utils/debug-logger';
import { getAzureDevOpsConfig, postAzureDevOpsThread, MAX_COMMENT_LENGTH } from './utils';
import type { AzureDevOpsConfig } from './types';
import { getAzureDevOpsReviewResult, markFindingsPosted } from './review-results';
import { isValidPrId } from './pull-request-handlers';

const debugLog = createDebugLog('Azure DevOps PR Review Posting');

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_EMOJI: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };

function emojiFor(severity: string): string {
  return SEVERITY_EMOJI[severity] ?? '⚪';
}

function severityRank(severity: string): number {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

function location(f: PRReviewFinding): string {
  return f.line > 0 ? `${f.file}:${f.line}` : f.file;
}

function compactLine(f: PRReviewFinding, note: string): string {
  return `- ${emojiFor(f.severity)} **${f.severity.toUpperCase()}** ${f.title} (\`${location(f)}\`)${note}\n`;
}

function fullBlock(f: PRReviewFinding): string {
  let body = `#### ${emojiFor(f.severity)} [${f.severity.toUpperCase()}] ${f.title}\n`;
  body += `📁 \`${location(f)}\`\n\n${f.description}\n`;
  if (f.suggestedFix) body += `\n**Suggested fix:**\n${f.suggestedFix}\n`;
  return `${body}\n`;
}

/** Short markdown body for a single inline comment. */
export function buildInlineComment(finding: PRReviewFinding): string {
  let body = `${emojiFor(finding.severity)} **[${finding.severity.toUpperCase()}] ${finding.title}**\n\n${finding.description}`;
  if (finding.suggestedFix) body += `\n\n**Suggested fix:** ${finding.suggestedFix}`;
  body += '\n\n_Aperant PR Review_';
  return body.length > MAX_COMMENT_LENGTH ? `${body.slice(0, MAX_COMMENT_LENGTH - 4)}...` : body;
}

/**
 * Build the single summary comment. Findings posted inline are listed compactly;
 * when over MAX_COMMENT_LENGTH the lowest-severity detail is dropped first.
 */
export function buildSummaryComment(
  result: Pick<PRReviewResult, 'summary' | 'overallStatus'>,
  findings: PRReviewFinding[],
  opts: { inlinePostedIds?: string[] } = {}
): string {
  const inlineIds = new Set(opts.inlinePostedIds ?? []);
  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  let head = `## Aperant PR Review\n\n${result.summary}\n\n`;
  if (sorted.length > 0) head += `### Findings (${sorted.length})\n\n`;

  // Reserve room for the omitted-findings line
  const reserve = 64;
  const limit = MAX_COMMENT_LENGTH - reserve;
  let out = head.length > limit ? head.slice(0, limit) : head;
  let omitted = 0;

  for (const f of sorted) {
    const block = inlineIds.has(f.id) ? compactLine(f, ' — posted as an inline comment') : fullBlock(f);
    if (out.length + block.length <= limit) {
      out += block;
      continue;
    }
    const compact = compactLine(f, inlineIds.has(f.id) ? ' — posted inline' : '');
    if (out.length + compact.length <= limit) {
      out += compact;
    } else {
      omitted += 1;
    }
  }

  if (omitted > 0) out += `\n... ${omitted} more findings omitted\n`;
  return out.length > MAX_COMMENT_LENGTH ? out.slice(0, MAX_COMMENT_LENGTH) : out;
}

function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Core posting flow (exported for tests). */
export async function postAzureDevOpsReview(
  project: Project,
  config: AzureDevOpsConfig,
  prId: number,
  selectedFindingIds: string[] | undefined,
  options: AzureDevOpsPostReviewOptions
): Promise<IPCResult<AzureDevOpsPostReviewResult>> {
  if (!options || options.confirmed !== true) {
    return { success: false, error: 'Posting a review requires explicit confirmation' };
  }
  if (!Array.isArray(selectedFindingIds) || selectedFindingIds.length === 0) {
    return { success: false, error: 'No findings selected to post' };
  }

  const review = getAzureDevOpsReviewResult(project, prId);
  if (!review) return { success: false, error: 'No review found for this pull request' };

  const selected = new Set(selectedFindingIds);
  const alreadyPosted = new Set(review.postedFindingIds ?? []);
  const findings = review.findings.filter((f) => selected.has(f.id) && !alreadyPosted.has(f.id));
  if (findings.length === 0) {
    return { success: false, error: 'No unposted findings among the selection' };
  }

  const inlinePostedIds: string[] = [];
  const inlineFailed: Array<{ findingId: string; reason: string }> = [];

  if (options.postInline) {
    for (const f of findings) {
      if (!f.file || !(f.line > 0)) continue;
      try {
        await postAzureDevOpsThread(config, prId, buildInlineComment(f), { path: f.file, line: f.line, endLine: f.line });
        inlinePostedIds.push(f.id);
      } catch (error) {
        inlineFailed.push({ findingId: f.id, reason: errMsg(error, 'Failed to post inline comment') });
      }
    }
  }

  const summary = buildSummaryComment(review, findings, { inlinePostedIds });
  let summaryCommentId: number;
  try {
    const thread = await postAzureDevOpsThread(config, prId, summary);
    summaryCommentId = thread.id;
  } catch (error) {
    if (inlinePostedIds.length > 0) markFindingsPosted(project, prId, inlinePostedIds);
    const base = errMsg(error, 'Failed to post summary comment');
    return {
      success: false,
      error:
        inlinePostedIds.length > 0
          ? `${base}. ${inlinePostedIds.length} inline comment(s) were already posted (findings: ${inlinePostedIds.join(', ')})`
          : base
    };
  }

  const postedFindingIds = findings.map((f) => f.id);
  markFindingsPosted(project, prId, postedFindingIds);

  return {
    success: true,
    data: { summaryCommentId, inlinePosted: inlinePostedIds.length, inlineFailed, postedFindingIds }
  };
}

export function registerAzureDevOpsPostReview(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_PR_POST_REVIEW,
    async (
      _event,
      projectId: string,
      prId: number,
      selectedFindingIds: string[] | undefined,
      options: AzureDevOpsPostReviewOptions
    ): Promise<IPCResult<AzureDevOpsPostReviewResult>> => {
      debugLog('postReview handler called', { prId });
      if (!isValidPrId(prId)) return { success: false, error: 'Invalid pull request id' };
      if (!options || options.confirmed !== true) {
        return { success: false, error: 'Posting a review requires explicit confirmation' };
      }
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: 'Azure DevOps not configured' };
      try {
        return await postAzureDevOpsReview(project, config, prId, selectedFindingIds, options);
      } catch (error) {
        debugLog('Failed to post review', { error: errMsg(error, 'unknown') });
        return { success: false, error: errMsg(error, 'Failed to post review') };
      }
    }
  );
}
