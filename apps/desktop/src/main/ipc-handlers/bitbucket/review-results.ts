/**
 * Bitbucket PR review result storage.
 * Mirrors github/pr/review-results.ts: snake_case JSON under
 * .auto-claude/bitbucket/pr/review_<id>.json.
 */

import path from 'path';
import fs from 'fs';
import type { Project } from '../../../shared/types';
import type { PRReviewResult } from '../../../shared/types/pr-review';
import { sanitizeNetworkData } from '../github/pr/shared';

function getReviewPath(project: Project, prId: number): { dir: string; file: string } {
  const dir = path.join(project.path, '.auto-claude', 'bitbucket', 'pr');
  return { dir, file: path.join(dir, `review_${prId}.json`) };
}

export function saveBitbucketReviewResult(project: Project, prId: number, result: PRReviewResult): void {
  const { dir, file } = getReviewPath(project, prId);
  fs.mkdirSync(dir, { recursive: true });

  const data = {
    pr_number: result.prNumber,
    repo: result.repo,
    success: result.success,
    findings: result.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      title: f.title,
      description: f.description,
      file: f.file,
      line: f.line,
      end_line: f.endLine,
      suggested_fix: f.suggestedFix,
      fixable: f.fixable,
      validation_status: f.validationStatus ?? null,
      validation_explanation: f.validationExplanation,
      source_agents: f.sourceAgents ?? [],
      cross_validated: f.crossValidated ?? false
    })),
    summary: result.summary,
    overall_status: result.overallStatus,
    review_id: result.reviewId,
    reviewed_at: result.reviewedAt,
    error: result.error,
    reviewed_commit_sha: result.reviewedCommitSha,
    reviewed_file_blobs: result.reviewedFileBlobs,
    is_followup_review: result.isFollowupReview ?? false,
    previous_review_id: result.previousReviewId,
    resolved_findings: result.resolvedFindings ?? [],
    unresolved_findings: result.unresolvedFindings ?? [],
    new_findings_since_last_review: result.newFindingsSinceLastReview ?? [],
    has_posted_findings: result.hasPostedFindings ?? false,
    posted_finding_ids: result.postedFindingIds ?? [],
    posted_at: result.postedAt,
    in_progress_since: result.inProgressSince
  };

  // Re-serializing guarantees plain data (no prototype pollution) is written
  fs.writeFileSync(file, JSON.stringify(JSON.parse(JSON.stringify(data)), null, 2), 'utf-8');
}

export function getBitbucketReviewResult(project: Project, prId: number): PRReviewResult | null {
  const { file } = getReviewPath(project, prId);
  try {
    const data = JSON.parse(sanitizeNetworkData(fs.readFileSync(file, 'utf-8')));
    return {
      prNumber: data.pr_number,
      repo: data.repo,
      success: data.success,
      findings:
        data.findings?.map((f: Record<string, unknown>) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          title: f.title,
          description: f.description,
          file: f.file,
          line: f.line,
          endLine: f.end_line,
          suggestedFix: f.suggested_fix,
          fixable: f.fixable ?? false,
          validationStatus: f.validation_status ?? null,
          validationExplanation: f.validation_explanation ?? undefined,
          sourceAgents: f.source_agents ?? [],
          crossValidated: f.cross_validated ?? false
        })) ?? [],
      summary: data.summary ?? '',
      overallStatus: data.overall_status ?? 'comment',
      reviewId: data.review_id,
      reviewedAt: data.reviewed_at ?? new Date().toISOString(),
      error: data.error,
      reviewedCommitSha: data.reviewed_commit_sha,
      reviewedFileBlobs: data.reviewed_file_blobs,
      isFollowupReview: data.is_followup_review ?? false,
      previousReviewId: data.previous_review_id,
      resolvedFindings: data.resolved_findings ?? [],
      unresolvedFindings: data.unresolved_findings ?? [],
      newFindingsSinceLastReview: data.new_findings_since_last_review ?? [],
      hasPostedFindings: data.has_posted_findings ?? false,
      postedFindingIds: data.posted_finding_ids ?? [],
      postedAt: data.posted_at,
      inProgressSince: data.in_progress_since
    };
  } catch {
    // Missing or corrupt file
    return null;
  }
}

/**
 * Record finding ids as posted to Bitbucket. Returns the updated result, or null
 * when there is no stored review.
 */
export function markFindingsPosted(
  project: Project,
  prId: number,
  findingIds: string[]
): PRReviewResult | null {
  const existing = getBitbucketReviewResult(project, prId);
  if (!existing) return null;
  const posted = Array.from(new Set([...(existing.postedFindingIds ?? []), ...findingIds]));
  const updated: PRReviewResult = {
    ...existing,
    hasPostedFindings: posted.length > 0,
    postedFindingIds: posted,
    postedAt: new Date().toISOString()
  };
  saveBitbucketReviewResult(project, prId, updated);
  return updated;
}
