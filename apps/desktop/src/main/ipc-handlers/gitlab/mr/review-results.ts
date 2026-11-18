/**
 * GitLab MR review results: reading and writing saved review files.
 */

import path from 'path';
import fs from 'fs';
import { MODEL_ID_MAP, DEFAULT_FEATURE_MODELS, DEFAULT_FEATURE_THINKING } from '../../../../shared/constants';
import { readSettingsFile } from '../../../settings-utils';
import type { Project } from '../../../../shared/types';
import type { MRReviewResult } from '../types';
import { createContextLogger } from '../../github/utils/logger';

const { debug: debugLog } = createContextLogger('GitLab MR');

/**
 * Get the GitLab directory for a project
 */
export function getGitLabDir(project: Project): string {
  return path.join(project.path, '.auto-claude', 'gitlab');
}

/**
 * Get saved MR review result
 */
export function getReviewResult(project: Project, mrIid: number): MRReviewResult | null {
  const reviewPath = path.join(getGitLabDir(project), 'mr', `review_${mrIid}.json`);

  if (fs.existsSync(reviewPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'));
      return {
        mrIid: data.mr_iid,
        project: data.project,
        success: data.success,
        findings: data.findings?.map((f: Record<string, unknown>) => ({
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
        })) ?? [],
        summary: data.summary ?? '',
        overallStatus: data.overall_status ?? 'comment',
        reviewedAt: data.reviewed_at ?? new Date().toISOString(),
        reviewedCommitSha: data.reviewed_commit_sha,
        isFollowupReview: data.is_followup_review ?? false,
        previousReviewId: data.previous_review_id,
        resolvedFindings: data.resolved_findings ?? [],
        unresolvedFindings: data.unresolved_findings ?? [],
        newFindingsSinceLastReview: data.new_findings_since_last_review ?? [],
        hasPostedFindings: data.has_posted_findings ?? false,
        postedFindingIds: data.posted_finding_ids ?? [],
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Get GitLab MR model and thinking settings from app settings
 */
export function getGitLabMRSettings(): { model: string; thinkingLevel: string } {
  const rawSettings = readSettingsFile();

  // Get feature models/thinking with defaults
  const featureModels = rawSettings?.featureModels ?? DEFAULT_FEATURE_MODELS;
  const featureThinking = rawSettings?.featureThinking ?? DEFAULT_FEATURE_THINKING;

  // Use GitHub PRs settings as fallback (GitLab MRs not yet in settings)
  const modelShort = featureModels.githubPrs ?? DEFAULT_FEATURE_MODELS.githubPrs;
  const thinkingLevel = featureThinking.githubPrs ?? DEFAULT_FEATURE_THINKING.githubPrs;

  // Convert model short name to full model ID
  const model = MODEL_ID_MAP[modelShort] ?? MODEL_ID_MAP['opus'];

  debugLog('GitLab MR settings', { modelShort, model, thinkingLevel });

  return { model, thinkingLevel };
}

/**
 * Save MR review result to disk in the format expected by getReviewResult().
 */
export function saveMRReviewResultToDisk(
  project: Project,
  mrIid: number,
  result: MRReviewResult,
  reviewedCommitSha?: string
): void {
  const mrDir = path.join(getGitLabDir(project), 'mr');
  fs.mkdirSync(mrDir, { recursive: true });
  const reviewPath = path.join(mrDir, `review_${mrIid}.json`);

  const data = {
    mr_iid: result.mrIid,
    project: result.project,
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
      fixable: f.fixable ?? false,
    })),
    summary: result.summary,
    overall_status: result.overallStatus,
    reviewed_at: result.reviewedAt,
    reviewed_commit_sha: reviewedCommitSha ?? result.reviewedCommitSha,
    is_followup_review: result.isFollowupReview ?? false,
    previous_review_id: result.previousReviewId,
    resolved_findings: result.resolvedFindings ?? [],
    unresolved_findings: result.unresolvedFindings ?? [],
    new_findings_since_last_review: result.newFindingsSinceLastReview ?? [],
    has_posted_findings: result.hasPostedFindings ?? false,
    posted_finding_ids: result.postedFindingIds ?? [],
  };

  fs.writeFileSync(reviewPath, JSON.stringify(data, null, 2), 'utf-8');
}
