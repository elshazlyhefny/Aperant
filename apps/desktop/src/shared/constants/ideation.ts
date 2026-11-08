/**
 * Ideation-related constants
 * Types, categories, and configuration for AI-generated project improvements
 */

// ============================================
// Ideation Types
// ============================================

// Ideation type labels and descriptions
// Values are i18n keys (common namespace); resolve them with t() at render time
// Note: high_value_features removed - strategic features belong to Roadmap
// low_hanging_fruit renamed to code_improvements to cover all code-revealed opportunities
export const IDEATION_TYPE_LABELS: Record<string, string> = {
  code_improvements: 'common:ideation.types.code_improvements',
  ui_ux_improvements: 'common:ideation.types.ui_ux_improvements',
  documentation_gaps: 'common:ideation.types.documentation_gaps',
  security_hardening: 'common:ideation.types.security_hardening',
  performance_optimizations: 'common:ideation.types.performance_optimizations',
  code_quality: 'common:ideation.types.code_quality',
  seo_improvements: 'common:ideation.types.seo_improvements'
};

export const IDEATION_TYPE_DESCRIPTIONS: Record<string, string> = {
  code_improvements: 'common:ideation.typeDescriptions.code_improvements',
  ui_ux_improvements: 'common:ideation.typeDescriptions.ui_ux_improvements',
  documentation_gaps: 'common:ideation.typeDescriptions.documentation_gaps',
  security_hardening: 'common:ideation.typeDescriptions.security_hardening',
  performance_optimizations: 'common:ideation.typeDescriptions.performance_optimizations',
  code_quality: 'common:ideation.typeDescriptions.code_quality',
  seo_improvements: 'common:ideation.typeDescriptions.seo_improvements'
};

// Ideation type colors
export const IDEATION_TYPE_COLORS: Record<string, string> = {
  code_improvements: 'bg-success/10 text-success border-success/30',
  ui_ux_improvements: 'bg-info/10 text-info border-info/30',
  documentation_gaps: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
  security_hardening: 'bg-destructive/10 text-destructive border-destructive/30',
  performance_optimizations: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  code_quality: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  seo_improvements: 'bg-pink-500/10 text-pink-400 border-pink-500/30'
};

// Ideation type icons (Lucide icon names)
export const IDEATION_TYPE_ICONS: Record<string, string> = {
  code_improvements: 'Zap',
  ui_ux_improvements: 'Palette',
  documentation_gaps: 'BookOpen',
  security_hardening: 'Shield',
  performance_optimizations: 'Gauge',
  code_quality: 'Code2',
  seo_improvements: 'Search'
};

// ============================================
// Ideation Status
// ============================================

export const IDEATION_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  selected: 'bg-primary/10 text-primary',
  converted: 'bg-success/10 text-success',
  dismissed: 'bg-destructive/10 text-destructive line-through',
  archived: 'bg-violet-500/10 text-violet-400'
};

// ============================================
// Ideation Effort/Complexity
// ============================================

// Ideation effort colors (full spectrum for code_improvements)
export const IDEATION_EFFORT_COLORS: Record<string, string> = {
  trivial: 'bg-success/10 text-success',
  small: 'bg-info/10 text-info',
  medium: 'bg-warning/10 text-warning',
  large: 'bg-orange-500/10 text-orange-400',
  complex: 'bg-destructive/10 text-destructive'
};

// ============================================
// Ideation Impact
// ============================================

export const IDEATION_IMPACT_COLORS: Record<string, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-info/10 text-info',
  high: 'bg-warning/10 text-warning',
  critical: 'bg-destructive/10 text-destructive'
};

// ============================================
// Category-Specific Labels
// ============================================

// Security severity colors
export const SECURITY_SEVERITY_COLORS: Record<string, string> = {
  low: 'bg-info/10 text-info',
  medium: 'bg-warning/10 text-warning',
  high: 'bg-orange-500/10 text-orange-500',
  critical: 'bg-destructive/10 text-destructive'
};

// Category labels below are also i18n keys (common namespace)
// UI/UX category labels
export const UIUX_CATEGORY_LABELS: Record<string, string> = {
  usability: 'common:ideation.categories.uiux.usability',
  accessibility: 'common:ideation.categories.uiux.accessibility',
  performance: 'common:ideation.categories.uiux.performance',
  visual: 'common:ideation.categories.uiux.visual',
  interaction: 'common:ideation.categories.uiux.interaction'
};

// Documentation category labels
export const DOCUMENTATION_CATEGORY_LABELS: Record<string, string> = {
  readme: 'common:ideation.categories.documentation.readme',
  api_docs: 'common:ideation.categories.documentation.api_docs',
  inline_comments: 'common:ideation.categories.documentation.inline_comments',
  examples: 'common:ideation.categories.documentation.examples',
  architecture: 'common:ideation.categories.documentation.architecture',
  troubleshooting: 'common:ideation.categories.documentation.troubleshooting'
};

// Security category labels
export const SECURITY_CATEGORY_LABELS: Record<string, string> = {
  authentication: 'common:ideation.categories.security.authentication',
  authorization: 'common:ideation.categories.security.authorization',
  input_validation: 'common:ideation.categories.security.input_validation',
  data_protection: 'common:ideation.categories.security.data_protection',
  dependencies: 'common:ideation.categories.security.dependencies',
  configuration: 'common:ideation.categories.security.configuration',
  secrets_management: 'common:ideation.categories.security.secrets_management'
};

// Performance category labels
export const PERFORMANCE_CATEGORY_LABELS: Record<string, string> = {
  bundle_size: 'common:ideation.categories.performance.bundle_size',
  runtime: 'common:ideation.categories.performance.runtime',
  memory: 'common:ideation.categories.performance.memory',
  database: 'common:ideation.categories.performance.database',
  network: 'common:ideation.categories.performance.network',
  rendering: 'common:ideation.categories.performance.rendering',
  caching: 'common:ideation.categories.performance.caching'
};

// Code quality category labels
export const CODE_QUALITY_CATEGORY_LABELS: Record<string, string> = {
  large_files: 'common:ideation.categories.codeQuality.large_files',
  code_smells: 'common:ideation.categories.codeQuality.code_smells',
  complexity: 'common:ideation.categories.codeQuality.complexity',
  duplication: 'common:ideation.categories.codeQuality.duplication',
  naming: 'common:ideation.categories.codeQuality.naming',
  structure: 'common:ideation.categories.codeQuality.structure',
  linting: 'common:ideation.categories.codeQuality.linting',
  testing: 'common:ideation.categories.codeQuality.testing',
  types: 'common:ideation.categories.codeQuality.types',
  dependencies: 'common:ideation.categories.codeQuality.dependencies',
  dead_code: 'common:ideation.categories.codeQuality.dead_code',
  git_hygiene: 'common:ideation.categories.codeQuality.git_hygiene'
};

// SEO category labels
export const SEO_CATEGORY_LABELS: Record<string, string> = {
  metadata: 'common:ideation.categories.seo.metadata',
  structured_data: 'common:ideation.categories.seo.structured_data',
  crawlability: 'common:ideation.categories.seo.crawlability',
  indexing: 'common:ideation.categories.seo.indexing',
  internationalization: 'common:ideation.categories.seo.internationalization',
  social_sharing: 'common:ideation.categories.seo.social_sharing',
  page_experience: 'common:ideation.categories.seo.page_experience'
};

// Code quality severity colors
export const CODE_QUALITY_SEVERITY_COLORS: Record<string, string> = {
  suggestion: 'bg-info/10 text-info',
  minor: 'bg-warning/10 text-warning',
  major: 'bg-orange-500/10 text-orange-500',
  critical: 'bg-destructive/10 text-destructive'
};

// ============================================
// Default Configuration
// ============================================

// Default ideation config
// Note: high_value_features removed, low_hanging_fruit renamed to code_improvements
export const DEFAULT_IDEATION_CONFIG = {
  enabledTypes: ['code_improvements', 'ui_ux_improvements', 'security_hardening'] as const,
  includeRoadmapContext: true,
  includeKanbanContext: true,
  maxIdeasPerType: 5
};
