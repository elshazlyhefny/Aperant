import type {
  Idea,
  CodeImprovementIdea,
  UIUXImprovementIdea,
  DocumentationGapIdea,
  SecurityHardeningIdea,
  PerformanceOptimizationIdea,
  CodeQualityIdea,
  SeoIdea
} from '../../../shared/types';

export function isCodeImprovementIdea(idea: Idea): idea is CodeImprovementIdea {
  return idea.type === 'code_improvements';
}

export function isUIUXIdea(idea: Idea): idea is UIUXImprovementIdea {
  return idea.type === 'ui_ux_improvements';
}

export function isDocumentationGapIdea(idea: Idea): idea is DocumentationGapIdea {
  return idea.type === 'documentation_gaps';
}

export function isSecurityHardeningIdea(idea: Idea): idea is SecurityHardeningIdea {
  return idea.type === 'security_hardening';
}

export function isPerformanceOptimizationIdea(idea: Idea): idea is PerformanceOptimizationIdea {
  return idea.type === 'performance_optimizations';
}

export function isCodeQualityIdea(idea: Idea): idea is CodeQualityIdea {
  return idea.type === 'code_quality';
}

export function isSeoIdea(idea: Idea): idea is SeoIdea {
  return idea.type === 'seo_improvements';
}

/**
 * zeenha fork: the task an idea was turned into, or null. A converted idea is
 * stored as `archived` with its task link; `converted` is the legacy status.
 * The card and the detail panel both read this, so "Go to task" shows in both.
 */
export function linkedTaskIdOf(idea: Idea): string | null {
  return (idea.status === 'archived' || idea.status === 'converted') && idea.taskId ? idea.taskId : null;
}
