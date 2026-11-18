import path from 'path';
import { existsSync } from 'fs';
import { AUTO_BUILD_PATHS } from '../../../shared/constants';
import type {
  Roadmap,
  RoadmapFeature,
  RoadmapPhase,
  RoadmapMilestone,
  CompetitorAnalysis,
  Competitor,
  CompetitorPainPoint,
  CompetitorMarketGap
} from '../../../shared/types';
import { readFileWithRetry } from '../../utils/atomic-file';

interface RawCompetitorPainPoint {
  id: string;
  description: string;
  source: string;
  severity?: string;
  frequency?: string;
  opportunity?: string;
}

interface RawCompetitor {
  id: string;
  name: string;
  url: string;
  description: string;
  relevance?: string;
  pain_points?: RawCompetitorPainPoint[];
  strengths?: string[];
  market_position?: string;
  source?: string;
}

interface RawMarketGap {
  id: string;
  description: string;
  affected_competitors?: string[];
  opportunity_size?: string;
  suggested_feature?: string;
}

interface RawCompetitorAnalysis {
  project_context?: {
    project_name?: string;
    project_type?: string;
    target_audience?: string;
  };
  competitors?: RawCompetitor[];
  market_gaps?: RawMarketGap[];
  insights_summary?: {
    top_pain_points?: string[];
    differentiator_opportunities?: string[];
    market_trends?: string[];
  };
  research_metadata?: {
    search_queries_used?: string[];
    sources_consulted?: string[];
    limitations?: string[];
  };
  metadata?: {
    created_at?: string;
  };
}

interface RawRoadmapMilestone {
  id: string;
  title: string;
  description: string;
  features?: string[];
  status?: string;
  target_date?: string;
}

interface RawRoadmapPhase {
  id: string;
  name: string;
  description: string;
  order: number;
  status?: string;
  features?: string[];
  milestones?: RawRoadmapMilestone[];
}

interface RawRoadmapFeature {
  id: string;
  title: string;
  description: string;
  rationale?: string;
  priority?: string;
  complexity?: string;
  impact?: string;
  phase_id?: string;
  phaseId?: string;
  dependencies?: string[];
  status?: string;
  acceptance_criteria?: string[];
  acceptanceCriteria?: string[];
  user_stories?: string[];
  userStories?: string[];
  linked_spec_id?: string;
  linkedSpecId?: string;
  task_outcome?: RoadmapFeature['taskOutcome'];
  taskOutcome?: RoadmapFeature['taskOutcome'];
  previous_status?: string;
  previousStatus?: string;
  competitor_insight_ids?: string[];
  competitorInsightIds?: string[];
}

interface RawRoadmap {
  id?: string;
  project_name?: string;
  projectName?: string;
  version?: string;
  vision?: string;
  target_audience?: {
    primary?: string;
    secondary?: string[];
  };
  targetAudience?: {
    primary?: string;
    secondary?: string[];
  };
  phases?: RawRoadmapPhase[];
  features?: RawRoadmapFeature[];
  status?: string;
  metadata?: {
    created_at?: string;
    updated_at?: string;
  };
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
}

function transformMilestone(raw: RawRoadmapMilestone): RoadmapMilestone {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    features: raw.features || [],
    status: (raw.status as 'planned' | 'achieved') || 'planned',
    targetDate: raw.target_date ? new Date(raw.target_date) : undefined
  };
}

function transformPhase(raw: RawRoadmapPhase): RoadmapPhase {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    order: raw.order,
    status: (raw.status as RoadmapPhase['status']) || 'planned',
    features: raw.features || [],
    milestones: (raw.milestones || []).map(transformMilestone)
  };
}

/**
 * Maps all known backend status values to canonical Kanban column statuses.
 * Includes valid statuses as identity mappings for consistent lookup.
 * Module-level constant for efficiency (not recreated on each call).
 */
const STATUS_MAP: Record<string, RoadmapFeature['status']> = {
  // Canonical Kanban statuses (identity mappings)
  'under_review': 'under_review',
  'planned': 'planned',
  'in_progress': 'in_progress',
  'done': 'done',
  // Early-stage / ideation statuses → under_review
  'idea': 'under_review',
  'backlog': 'under_review',
  'proposed': 'under_review',
  'pending': 'under_review',
  // Approved / scheduled statuses → planned
  'approved': 'planned',
  'scheduled': 'planned',
  // Active development statuses → in_progress
  'active': 'in_progress',
  'building': 'in_progress',
  // Completed statuses → done
  'complete': 'done',
  'completed': 'done',
  'shipped': 'done'
};

/**
 * Normalizes a feature status string to a valid Kanban column status.
 * Handles case-insensitive matching and maps backend values to canonical statuses.
 *
 * @param status - The raw status string from the backend
 * @returns A valid RoadmapFeature status for Kanban display
 */
function normalizeFeatureStatus(status: string | undefined): RoadmapFeature['status'] {
  if (!status) return 'under_review';

  const normalized = STATUS_MAP[status.toLowerCase()];

  if (!normalized) {
    // Debug log for unmapped statuses to aid future mapping additions
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[Roadmap] normalizeFeatureStatus: unmapped status "${status}", defaulting to "under_review"`);
    }
    return 'under_review';
  }

  return normalized;
}

function transformFeature(raw: RawRoadmapFeature): RoadmapFeature {
  const rawPreviousStatus = raw.previous_status ?? raw.previousStatus;
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    rationale: raw.rationale || '',
    priority: (raw.priority as RoadmapFeature['priority']) || 'should',
    complexity: (raw.complexity as RoadmapFeature['complexity']) || 'medium',
    impact: (raw.impact as RoadmapFeature['impact']) || 'medium',
    phaseId: raw.phase_id || raw.phaseId || '',
    dependencies: raw.dependencies || [],
    status: normalizeFeatureStatus(raw.status),
    acceptanceCriteria: raw.acceptance_criteria || raw.acceptanceCriteria || [],
    userStories: raw.user_stories || raw.userStories || [],
    linkedSpecId: raw.linked_spec_id || raw.linkedSpecId,
    taskOutcome: raw.task_outcome ?? raw.taskOutcome,
    previousStatus: rawPreviousStatus ? normalizeFeatureStatus(rawPreviousStatus) : undefined,
    competitorInsightIds: raw.competitor_insight_ids || raw.competitorInsightIds
  };
}

/**
 * Transforms the snake_case competitor_analysis.json content to the camelCase
 * CompetitorAnalysis shape used by the renderer.
 */
export function transformCompetitorAnalysis(raw: RawCompetitorAnalysis): CompetitorAnalysis {
  return {
    projectContext: {
      projectName: raw.project_context?.project_name || '',
      projectType: raw.project_context?.project_type || '',
      targetAudience: raw.project_context?.target_audience || ''
    },
    competitors: (raw.competitors || []).map((c): Competitor => ({
      id: c.id,
      name: c.name,
      url: c.url,
      description: c.description,
      relevance: (c.relevance as Competitor['relevance']) || 'medium',
      painPoints: (c.pain_points || []).map((p): CompetitorPainPoint => ({
        id: p.id,
        description: p.description,
        source: p.source,
        severity: (p.severity as CompetitorPainPoint['severity']) || 'medium',
        frequency: p.frequency || '',
        opportunity: p.opportunity || ''
      })),
      strengths: c.strengths || [],
      marketPosition: c.market_position || '',
      source: (c.source as Competitor['source']) || undefined
    })),
    marketGaps: (raw.market_gaps || []).map((g): CompetitorMarketGap => ({
      id: g.id,
      description: g.description,
      affectedCompetitors: g.affected_competitors || [],
      opportunitySize: (g.opportunity_size as CompetitorMarketGap['opportunitySize']) || 'medium',
      suggestedFeature: g.suggested_feature || ''
    })),
    insightsSummary: {
      topPainPoints: raw.insights_summary?.top_pain_points || [],
      differentiatorOpportunities: raw.insights_summary?.differentiator_opportunities || [],
      marketTrends: raw.insights_summary?.market_trends || []
    },
    researchMetadata: {
      searchQueriesUsed: raw.research_metadata?.search_queries_used || [],
      sourcesConsulted: raw.research_metadata?.sources_consulted || [],
      limitations: raw.research_metadata?.limitations || []
    },
    createdAt: raw.metadata?.created_at ? new Date(raw.metadata.created_at) : new Date()
  };
}

export function transformRoadmapFromSnakeCase(
  raw: RawRoadmap,
  projectId: string,
  projectName?: string,
  competitorAnalysis?: CompetitorAnalysis
): Roadmap {
  const targetAudience = raw.target_audience || raw.targetAudience;
  const createdAt = raw.metadata?.created_at || raw.created_at || raw.createdAt;
  const updatedAt = raw.metadata?.updated_at || raw.updated_at || raw.updatedAt;

  return {
    id: raw.id || `roadmap-${Date.now()}`,
    projectId,
    projectName: raw.project_name || raw.projectName || projectName || '',
    version: raw.version || '1.0',
    vision: raw.vision || '',
    targetAudience: {
      primary: targetAudience?.primary || '',
      secondary: targetAudience?.secondary || []
    },
    phases: (raw.phases || []).map(transformPhase),
    features: (raw.features || []).map(transformFeature),
    status: (raw.status as Roadmap['status']) || 'draft',
    competitorAnalysis,
    createdAt: createdAt ? new Date(createdAt) : new Date(),
    updatedAt: updatedAt ? new Date(updatedAt) : new Date()
  };
}

/**
 * Loads roadmap.json (and the optional competitor_analysis.json) from a project
 * and returns the transformed Roadmap, or null when roadmap.json does not exist.
 * Read/parse errors on roadmap.json propagate; competitor analysis errors are ignored.
 */
export async function loadRoadmapFromDisk(
  projectPath: string,
  projectId: string,
  projectName?: string
): Promise<Roadmap | null> {
  const roadmapDir = path.join(projectPath, AUTO_BUILD_PATHS.ROADMAP_DIR);
  const roadmapPath = path.join(roadmapDir, AUTO_BUILD_PATHS.ROADMAP_FILE);

  if (!existsSync(roadmapPath)) {
    return null;
  }

  const content = await readFileWithRetry(roadmapPath, { encoding: 'utf-8' }) as string;
  const rawRoadmap = JSON.parse(content) as RawRoadmap;

  let competitorAnalysis: CompetitorAnalysis | undefined;
  const competitorPath = path.join(roadmapDir, AUTO_BUILD_PATHS.COMPETITOR_ANALYSIS);
  if (existsSync(competitorPath)) {
    try {
      const competitorContent = await readFileWithRetry(competitorPath, { encoding: 'utf-8' }) as string;
      competitorAnalysis = transformCompetitorAnalysis(JSON.parse(competitorContent) as RawCompetitorAnalysis);
    } catch {
      // competitor_analysis.json is optional; ignore read/parse errors
    }
  }

  return transformRoadmapFromSnakeCase(rawRoadmap, projectId, projectName, competitorAnalysis);
}
