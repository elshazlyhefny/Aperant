/**
 * Review result storage: read/write review JSON, notify the renderer, and persist
 * review insights to memory.
 */

import path from "path";
import fs from "fs";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS, DEFAULT_FEATURE_MODELS, DEFAULT_FEATURE_THINKING } from "../../../../shared/constants";
import { readSettingsFile } from "../../../settings-utils";
import { getMemoryService, isAgentMemoryEnabled } from "../../context/memory-service-factory";
import type { Project, AppSettings } from "../../../../shared/types";
import { createIPCCommunicators } from "../utils/ipc-communicator";
import type { PRReviewResult, PRReviewProgress } from "./types";
import { debugLog, sanitizeNetworkData } from "./shared";
import { getGitHubDir } from "./review-logs";

/**
 * Save PR review insights to the Electron memory layer (LadybugDB)
 *
 * Called after a PR review completes to persist learnings for cross-session context.
 * Extracts key findings, patterns, and gotchas from the review result.
 *
 * @param result The completed PR review result
 * @param repo Repository name (owner/repo)
 * @param isFollowup Whether this is a follow-up review
 * @param projectId Aperant project id. zeenha fork: the Context page lists
 *   memories by this id, so storing under `repo` made them invisible there.
 */
export async function savePRReviewToMemory(
  result: PRReviewResult,
  repo: string,
  isFollowup: boolean,
  projectId: string
): Promise<void> {
  if (!isAgentMemoryEnabled()) {
    debugLog("Memory not enabled, skipping PR review memory save");
    return;
  }

  try {
    const memoryService = await getMemoryService();

    // Prioritize findings: critical > high > medium > low
    // Include all critical/high, top 5 medium, top 3 low
    const criticalFindings = result.findings.filter((f) => f.severity === "critical");
    const highFindings = result.findings.filter((f) => f.severity === "high");
    const mediumFindings = result.findings.filter((f) => f.severity === "medium").slice(0, 5);
    const lowFindings = result.findings.filter((f) => f.severity === "low").slice(0, 3);

    const keyFindingsToSave = [
      ...criticalFindings,
      ...highFindings,
      ...mediumFindings,
      ...lowFindings,
    ].map((f) => ({
      severity: f.severity,
      category: f.category,
      title: f.title,
      description: f.description.substring(0, 500),
      file: f.file,
      line: f.line,
    }));

    // Extract gotchas: security issues, critical bugs, and common mistakes
    const gotchaCategories = ["security", "error_handling", "data_validation", "race_condition"];
    const gotchasToSave = result.findings
      .filter(
        (f) =>
          f.severity === "critical" ||
          f.severity === "high" ||
          gotchaCategories.includes(f.category?.toLowerCase() || "")
      )
      .map((f) => `[${f.category}] ${f.title}: ${f.description.substring(0, 300)}`);

    // Extract patterns: group findings by category to identify recurring issues
    const categoryGroups = result.findings.reduce(
      (acc, f) => {
        const cat = f.category || "general";
        acc[cat] = (acc[cat] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    // Patterns are categories that appear multiple times (indicates a systematic issue)
    const patternsToSave = Object.entries(categoryGroups)
      .filter(([_, count]) => count >= 2)
      .map(([category, count]) => `${category}: ${count} occurrences`);

    // Build content string for new memory system
    const episodeName = `PR #${result.prNumber} ${isFollowup ? "Follow-up " : ""}Review - ${repo}`;
    const contentParts = [
      episodeName,
      `Verdict: ${result.overallStatus || "unknown"}`,
      `Findings: ${result.findings.length} total (${criticalFindings.length} critical, ${highFindings.length} high)`,
    ];

    if (patternsToSave.length > 0) {
      contentParts.push(`Patterns: ${patternsToSave.join('; ')}`);
    }

    if (gotchasToSave.length > 0) {
      contentParts.push(`Gotchas: ${gotchasToSave.slice(0, 3).join('; ')}`);
    }

    if (keyFindingsToSave.length > 0) {
      contentParts.push(`Key findings: ${keyFindingsToSave.slice(0, 5).map(f => `[${f.severity}] ${f.title}`).join('; ')}`);
    }

    if (isFollowup && result.resolvedFindings && result.unresolvedFindings) {
      contentParts.push(`Resolved: ${result.resolvedFindings.length}, Unresolved: ${result.unresolvedFindings.length}`);
    }

    const contentString = contentParts.join('\n');

    // Store using the new memory service
    await memoryService.store({
      type: 'module_insight',
      content: contentString,
      source: 'agent_explicit',
      confidence: 0.8,
      projectId,
      relatedFiles: keyFindingsToSave.map(f => f.file).filter(Boolean).slice(0, 10),
      relatedModules: [],
      tags: ['pr_review', repo.replace('/', '_'), `pr_${result.prNumber}`],
    });

    debugLog("PR review saved to memory", { prNumber: result.prNumber });
  } catch (error) {
    debugLog("Error saving PR review to memory", {
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Get saved PR review result
 */
export function getReviewResult(project: Project, prNumber: number): PRReviewResult | null {
  const reviewPath = path.join(getGitHubDir(project), "pr", `review_${prNumber}.json`);

  try {
    const rawData = fs.readFileSync(reviewPath, "utf-8");
    const sanitizedData = sanitizeNetworkData(rawData);
    const data = JSON.parse(sanitizedData);
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
          crossValidated: f.cross_validated ?? false,
        })) ?? [],
      summary: data.summary ?? "",
      overallStatus: data.overall_status ?? "comment",
      reviewId: data.review_id,
      reviewedAt: data.reviewed_at ?? new Date().toISOString(),
      error: data.error,
      // Follow-up review fields (snake_case -> camelCase)
      reviewedCommitSha: data.reviewed_commit_sha,
      reviewedFileBlobs: data.reviewed_file_blobs,
      isFollowupReview: data.is_followup_review ?? false,
      previousReviewId: data.previous_review_id,
      resolvedFindings: data.resolved_findings ?? [],
      unresolvedFindings: data.unresolved_findings ?? [],
      newFindingsSinceLastReview: data.new_findings_since_last_review ?? [],
      // Track posted findings for follow-up review eligibility
      hasPostedFindings: data.has_posted_findings ?? false,
      postedFindingIds: data.posted_finding_ids ?? [],
      postedAt: data.posted_at,
      // In-progress review tracking
      inProgressSince: data.in_progress_since,
    };
  } catch {
    // File doesn't exist or couldn't be read
    return null;
  }
}

/**
 * Send a PR review state update event to the renderer to refresh the UI immediately.
 * Used after operations that modify review state (post, mark posted, delete).
 */
export function sendReviewStateUpdate(
  project: Project,
  prNumber: number,
  projectId: string,
  getMainWindow: () => BrowserWindow | null,
  context: string
): void {
  try {
    const updatedResult = getReviewResult(project, prNumber);
    if (!updatedResult) {
      debugLog("Could not retrieve updated review result for UI notification", { prNumber, context });
      return;
    }
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const { sendComplete } = createIPCCommunicators<PRReviewProgress, PRReviewResult>(
      mainWindow,
      {
        progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
        error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
        complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
      },
      projectId
    );
    sendComplete(updatedResult);
    debugLog(`Sent PR review state update ${context}`, { prNumber });
  } catch (uiError) {
    debugLog("Failed to send UI update (non-critical)", {
      prNumber,
      context,
      error: uiError instanceof Error ? uiError.message : uiError,
    });
  }
}

/**
 * Get GitHub PR model and thinking settings from app settings
 */
export function getGitHubPRSettings(): { model: string; thinkingLevel: string } {
  const rawSettings = readSettingsFile() as Partial<AppSettings> | undefined;

  // Get feature models/thinking with defaults
  const featureModels = rawSettings?.featureModels ?? DEFAULT_FEATURE_MODELS;
  const featureThinking = rawSettings?.featureThinking ?? DEFAULT_FEATURE_THINKING;

  // Get PR-specific settings (with fallback to defaults)
  // Return the raw shorthand — createSimpleClient() handles model-to-provider resolution
  // via resolveModelId() and the priority queue. Do NOT resolve through MODEL_ID_MAP
  // which is Anthropic-only and would silently replace non-Anthropic models.
  const model = featureModels.githubPrs ?? DEFAULT_FEATURE_MODELS.githubPrs;
  const thinkingLevel = featureThinking.githubPrs ?? DEFAULT_FEATURE_THINKING.githubPrs;

  debugLog("GitHub PR settings", { model, thinkingLevel });

  return { model, thinkingLevel };
}

/**
 * Save PR review result to disk in the format expected by getReviewResult().
 */
export function saveReviewResultToDisk(
  project: Project,
  prNumber: number,
  result: PRReviewResult
): void {
  const prDir = path.join(getGitHubDir(project), "pr");
  fs.mkdirSync(prDir, { recursive: true });
  const reviewPath = path.join(prDir, `review_${prNumber}.json`);

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
      cross_validated: f.crossValidated ?? false,
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
    in_progress_since: result.inProgressSince,
  };

  // CodeQL: network data validated before write - data object is constructed from typed PRReviewResult
  // fields with explicit property mapping; re-serializing ensures no prototype pollution
  fs.writeFileSync(reviewPath, JSON.stringify(JSON.parse(JSON.stringify(data)), null, 2), "utf-8");
}
