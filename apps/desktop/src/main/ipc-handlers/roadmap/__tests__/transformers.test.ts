import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  loadRoadmapFromDisk,
  transformCompetitorAnalysis,
  transformRoadmapFromSnakeCase
} from '../transformers';
import { AUTO_BUILD_PATHS } from '../../../../shared/constants';

type RawRoadmapInput = Parameters<typeof transformRoadmapFromSnakeCase>[0];
type RawFeatureInput = NonNullable<RawRoadmapInput['features']>[number];

const baseFeature: RawFeatureInput = { id: 'f1', title: 'T', description: 'd' };

function featureOf(overrides: Partial<RawFeatureInput>) {
  const roadmap = transformRoadmapFromSnakeCase(
    { features: [{ ...baseFeature, ...overrides }] },
    'p1'
  );
  return roadmap.features[0];
}

describe('feature status normalisation', () => {
  const cases: Array<[string | undefined, string]> = [
    ['completed', 'done'],
    ['shipped', 'done'],
    ['complete', 'done'],
    ['backlog', 'under_review'],
    ['approved', 'planned'],
    ['active', 'in_progress'],
    ['In_Progress', 'in_progress'],
    ['DONE', 'done'],
    ['something-weird', 'under_review'],
    [undefined, 'under_review']
  ];
  for (const [input, expected] of cases) {
    it(`maps ${String(input)} to ${expected}`, () => {
      expect(featureOf({ status: input }).status).toBe(expected);
    });
  }
});

describe('transformFeature fields', () => {
  it('maps every snake_case field ROADMAP_GET returns', () => {
    const f = featureOf({
      rationale: 'why',
      priority: 'must',
      complexity: 'high',
      impact: 'low',
      phase_id: 'phase-1',
      dependencies: ['f0'],
      status: 'planned',
      acceptance_criteria: ['a'],
      user_stories: ['u'],
      linked_spec_id: '001-x',
      task_outcome: 'completed',
      previous_status: 'in_progress',
      competitor_insight_ids: ['c1']
    });
    expect(f).toEqual({
      id: 'f1',
      title: 'T',
      description: 'd',
      rationale: 'why',
      priority: 'must',
      complexity: 'high',
      impact: 'low',
      phaseId: 'phase-1',
      dependencies: ['f0'],
      status: 'planned',
      acceptanceCriteria: ['a'],
      userStories: ['u'],
      linkedSpecId: '001-x',
      taskOutcome: 'completed',
      previousStatus: 'in_progress',
      competitorInsightIds: ['c1']
    });
  });

  it('accepts camelCase keys', () => {
    const f = featureOf({
      phaseId: 'phase-2',
      acceptanceCriteria: ['a'],
      userStories: ['u'],
      linkedSpecId: '002-y',
      taskOutcome: 'archived',
      previousStatus: 'planned',
      competitorInsightIds: ['c2']
    });
    expect(f.phaseId).toBe('phase-2');
    expect(f.acceptanceCriteria).toEqual(['a']);
    expect(f.userStories).toEqual(['u']);
    expect(f.linkedSpecId).toBe('002-y');
    expect(f.taskOutcome).toBe('archived');
    expect(f.previousStatus).toBe('planned');
    expect(f.competitorInsightIds).toEqual(['c2']);
  });

  it('normalises previousStatus and leaves it undefined when absent', () => {
    expect(featureOf({ previous_status: 'completed' }).previousStatus).toBe('done');
    expect(featureOf({ previousStatus: 'backlog' }).previousStatus).toBe('under_review');
    expect(featureOf({}).previousStatus).toBeUndefined();
    expect(featureOf({}).taskOutcome).toBeUndefined();
  });

  it('applies defaults', () => {
    const f = featureOf({});
    expect(f).toMatchObject({
      rationale: '',
      priority: 'should',
      complexity: 'medium',
      impact: 'medium',
      phaseId: '',
      dependencies: [],
      status: 'under_review',
      acceptanceCriteria: [],
      userStories: []
    });
  });
});

describe('transformRoadmapFromSnakeCase', () => {
  it('maps snake_case roadmap, phases and milestones', () => {
    const r = transformRoadmapFromSnakeCase(
      {
        id: 'rm-1',
        project_name: 'Proj',
        version: '2.0',
        vision: 'v',
        target_audience: { primary: 'devs', secondary: ['ops'] },
        phases: [
          {
            id: 'ph1',
            name: 'P1',
            description: 'pd',
            order: 1,
            status: 'in_progress',
            features: ['f1'],
            milestones: [
              { id: 'm1', title: 'M', description: 'md', features: ['f1'], status: 'achieved', target_date: '2025-01-02T00:00:00.000Z' }
            ]
          }
        ],
        status: 'active',
        metadata: { created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-03T00:00:00.000Z' }
      },
      'p1'
    );
    expect(r.id).toBe('rm-1');
    expect(r.projectId).toBe('p1');
    expect(r.projectName).toBe('Proj');
    expect(r.version).toBe('2.0');
    expect(r.targetAudience).toEqual({ primary: 'devs', secondary: ['ops'] });
    expect(r.status).toBe('active');
    expect(r.createdAt).toEqual(new Date('2025-01-01T00:00:00.000Z'));
    expect(r.updatedAt).toEqual(new Date('2025-01-03T00:00:00.000Z'));
    expect(r.phases[0].status).toBe('in_progress');
    expect(r.phases[0].milestones[0].targetDate).toEqual(new Date('2025-01-02T00:00:00.000Z'));
    expect(r.phases[0].milestones[0].status).toBe('achieved');
    expect(r.competitorAnalysis).toBeUndefined();
  });

  it('accepts camelCase roadmap and target audience keys', () => {
    const r = transformRoadmapFromSnakeCase(
      {
        projectName: 'Camel',
        targetAudience: { primary: 'p', secondary: ['s'] },
        createdAt: '2025-02-01T00:00:00.000Z',
        updatedAt: '2025-02-02T00:00:00.000Z'
      },
      'p1'
    );
    expect(r.projectName).toBe('Camel');
    expect(r.targetAudience).toEqual({ primary: 'p', secondary: ['s'] });
    expect(r.createdAt).toEqual(new Date('2025-02-01T00:00:00.000Z'));
    expect(r.updatedAt).toEqual(new Date('2025-02-02T00:00:00.000Z'));
  });

  it('applies phase and milestone defaults', () => {
    const r = transformRoadmapFromSnakeCase(
      {
        phases: [
          {
            id: 'ph',
            name: 'N',
            description: 'd',
            order: 2,
            milestones: [{ id: 'm', title: 't', description: 'd' }]
          }
        ]
      },
      'p1'
    );
    expect(r.phases[0].status).toBe('planned');
    expect(r.phases[0].features).toEqual([]);
    expect(r.phases[0].milestones[0]).toMatchObject({ features: [], status: 'planned', targetDate: undefined });
  });

  it('falls back for projectName: raw snake, raw camel, argument, empty', () => {
    expect(transformRoadmapFromSnakeCase({ project_name: 'a', projectName: 'b' }, 'p', 'c').projectName).toBe('a');
    expect(transformRoadmapFromSnakeCase({ projectName: 'b' }, 'p', 'c').projectName).toBe('b');
    expect(transformRoadmapFromSnakeCase({}, 'p', 'c').projectName).toBe('c');
    expect(transformRoadmapFromSnakeCase({}, 'p').projectName).toBe('');
  });

  it('applies roadmap defaults and sets the competitor analysis argument', () => {
    const analysis = transformCompetitorAnalysis({});
    const r = transformRoadmapFromSnakeCase({}, 'p', undefined, analysis);
    expect(r.version).toBe('1.0');
    expect(r.vision).toBe('');
    expect(r.status).toBe('draft');
    expect(r.id).toMatch(/^roadmap-/);
    expect(r.targetAudience).toEqual({ primary: '', secondary: [] });
    expect(r.competitorAnalysis).toBe(analysis);
  });
});

describe('transformCompetitorAnalysis', () => {
  it('maps a full document', () => {
    const out = transformCompetitorAnalysis({
      project_context: { project_name: 'P', project_type: 'app', target_audience: 'devs' },
      competitors: [
        {
          id: 'c1',
          name: 'Comp',
          url: 'https://x.test',
          description: 'd',
          relevance: 'high',
          pain_points: [
            { id: 'pp1', description: 'slow', source: 'reddit', severity: 'high', frequency: 'often', opportunity: 'fast' }
          ],
          strengths: ['s'],
          market_position: 'leader',
          source: 'manual'
        }
      ],
      market_gaps: [
        { id: 'g1', description: 'gap', affected_competitors: ['c1'], opportunity_size: 'low', suggested_feature: 'feat' }
      ],
      insights_summary: {
        top_pain_points: ['a'],
        differentiator_opportunities: ['b'],
        market_trends: ['c']
      },
      research_metadata: {
        search_queries_used: ['q'],
        sources_consulted: ['s'],
        limitations: ['l']
      },
      metadata: { created_at: '2025-03-01T00:00:00.000Z' }
    });
    expect(out).toEqual({
      projectContext: { projectName: 'P', projectType: 'app', targetAudience: 'devs' },
      competitors: [
        {
          id: 'c1',
          name: 'Comp',
          url: 'https://x.test',
          description: 'd',
          relevance: 'high',
          painPoints: [
            { id: 'pp1', description: 'slow', source: 'reddit', severity: 'high', frequency: 'often', opportunity: 'fast' }
          ],
          strengths: ['s'],
          marketPosition: 'leader',
          source: 'manual'
        }
      ],
      marketGaps: [
        { id: 'g1', description: 'gap', affectedCompetitors: ['c1'], opportunitySize: 'low', suggestedFeature: 'feat' }
      ],
      insightsSummary: { topPainPoints: ['a'], differentiatorOpportunities: ['b'], marketTrends: ['c'] },
      researchMetadata: { searchQueriesUsed: ['q'], sourcesConsulted: ['s'], limitations: ['l'] },
      createdAt: new Date('2025-03-01T00:00:00.000Z')
    });
  });

  it('applies defaults', () => {
    const out = transformCompetitorAnalysis({
      competitors: [
        {
          id: 'c',
          name: 'n',
          url: 'u',
          description: 'd',
          pain_points: [{ id: 'p', description: 'd', source: 's' }]
        }
      ],
      market_gaps: [{ id: 'g', description: 'd' }]
    });
    expect(out.projectContext).toEqual({ projectName: '', projectType: '', targetAudience: '' });
    expect(out.competitors[0]).toMatchObject({
      relevance: 'medium',
      strengths: [],
      marketPosition: '',
      source: undefined
    });
    expect(out.competitors[0].painPoints[0]).toMatchObject({ severity: 'medium', frequency: '', opportunity: '' });
    expect(out.marketGaps[0]).toMatchObject({ affectedCompetitors: [], opportunitySize: 'medium', suggestedFeature: '' });
    expect(out.insightsSummary).toEqual({ topPainPoints: [], differentiatorOpportunities: [], marketTrends: [] });
    expect(out.researchMetadata).toEqual({ searchQueriesUsed: [], sourcesConsulted: [], limitations: [] });
    expect(out.createdAt).toBeInstanceOf(Date);
  });
});

describe('loadRoadmapFromDisk', () => {
  let projectDir: string;
  let roadmapDir: string;
  const roadmapFile = () => path.join(roadmapDir, AUTO_BUILD_PATHS.ROADMAP_FILE);
  const competitorFile = () => path.join(roadmapDir, AUTO_BUILD_PATHS.COMPETITOR_ANALYSIS);

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'roadmap-transformers-'));
    roadmapDir = path.join(projectDir, AUTO_BUILD_PATHS.ROADMAP_DIR);
    mkdirSync(roadmapDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns null when roadmap.json is missing', async () => {
    expect(await loadRoadmapFromDisk(projectDir, 'p1', 'Name')).toBeNull();
  });

  it('loads a roadmap without competitor analysis', async () => {
    writeFileSync(roadmapFile(), JSON.stringify({ id: 'rm', features: [{ id: 'f', title: 't', description: 'd', status: 'shipped' }] }));
    const r = await loadRoadmapFromDisk(projectDir, 'p1', 'Name');
    expect(r?.id).toBe('rm');
    expect(r?.projectName).toBe('Name');
    expect(r?.features[0].status).toBe('done');
    expect(r?.competitorAnalysis).toBeUndefined();
  });

  it('loads a roadmap with competitor analysis', async () => {
    writeFileSync(roadmapFile(), JSON.stringify({ id: 'rm' }));
    writeFileSync(competitorFile(), JSON.stringify({ project_context: { project_name: 'CP' } }));
    const r = await loadRoadmapFromDisk(projectDir, 'p1');
    expect(r?.competitorAnalysis?.projectContext.projectName).toBe('CP');
  });

  it('ignores a malformed competitor analysis file', async () => {
    writeFileSync(roadmapFile(), JSON.stringify({ id: 'rm' }));
    writeFileSync(competitorFile(), '{not json');
    const r = await loadRoadmapFromDisk(projectDir, 'p1');
    expect(r?.id).toBe('rm');
    expect(r?.competitorAnalysis).toBeUndefined();
  });

  it('throws on a malformed roadmap file', async () => {
    writeFileSync(roadmapFile(), '{not json');
    await expect(loadRoadmapFromDisk(projectDir, 'p1')).rejects.toThrow();
  });
});
