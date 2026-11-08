import { useTranslation } from 'react-i18next';
import {
  Search,
  AlertCircle,
  TrendingUp,
  Wrench,
  Globe,
  FileCode,
  ExternalLink
} from 'lucide-react';
import { Badge } from '../../ui/badge';
import { Card } from '../../ui/card';
import {
  IDEATION_IMPACT_COLORS,
  IDEATION_EFFORT_COLORS,
  SEO_CATEGORY_LABELS
} from '../../../../shared/constants';
import type { SeoIdea } from '../../../../shared/types';

interface SeoDetailsProps {
  idea: SeoIdea;
}

export function SeoDetails({ idea }: SeoDetailsProps) {
  const { t } = useTranslation('common');
  return (
    <>
      {/* Metrics */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-3 text-center">
          <div className={`text-lg font-semibold ${IDEATION_IMPACT_COLORS[idea.impact]}`}>
            {t(`ideation.impact.${idea.impact}`, { defaultValue: idea.impact })}
          </div>
          <div className="text-xs text-muted-foreground">{t('ideation.labels.impact')}</div>
        </Card>
        <Card className="p-3 text-center">
          <div className={`text-lg font-semibold ${IDEATION_EFFORT_COLORS[idea.estimatedEffort]}`}>
            {t(`ideation.effort.${idea.estimatedEffort}`, { defaultValue: idea.estimatedEffort })}
          </div>
          <div className="text-xs text-muted-foreground">{t('ideation.labels.effort')}</div>
        </Card>
      </div>

      {/* Category */}
      <div>
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Search className="h-4 w-4" />
          {t('ideation.labels.category')}
        </h3>
        <Badge variant="outline">
          {SEO_CATEGORY_LABELS[idea.category]
            ? t(SEO_CATEGORY_LABELS[idea.category], { defaultValue: idea.category })
            : idea.category}
        </Badge>
      </div>

      {/* Current State */}
      {idea.currentState && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {t('ideation.labels.currentState')}
          </h3>
          <p className="text-sm text-muted-foreground">{idea.currentState}</p>
        </div>
      )}

      {/* Proposed Change */}
      {idea.proposedChange && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            {t('ideation.labels.proposedChange')}
          </h3>
          <p className="text-sm text-muted-foreground whitespace-pre-line">{idea.proposedChange}</p>
        </div>
      )}

      {/* Expected Outcome */}
      {idea.expectedOutcome && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-success" />
            {t('ideation.details.seo.expectedOutcome')}
          </h3>
          <p className="text-sm text-muted-foreground">{idea.expectedOutcome}</p>
        </div>
      )}

      {/* Affected Pages */}
      {idea.affectedPages && idea.affectedPages.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Globe className="h-4 w-4" />
            {t('ideation.details.seo.affectedPages')}
          </h3>
          <ul className="space-y-1">
            {idea.affectedPages.map((page, i) => (
              <li key={i} className="text-sm font-mono text-muted-foreground">
                {page}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Affected Files */}
      {idea.affectedFiles && idea.affectedFiles.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <FileCode className="h-4 w-4" />
            {t('ideation.labels.affectedFiles')}
          </h3>
          <ul className="space-y-1">
            {idea.affectedFiles.map((file, i) => (
              <li key={i} className="text-sm font-mono text-muted-foreground">
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* References */}
      {idea.references && idea.references.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <ExternalLink className="h-4 w-4" />
            {t('ideation.labels.references')}
          </h3>
          <ul className="space-y-1">
            {idea.references.map((ref, i) => (
              <li key={i} className="text-sm text-muted-foreground">
                {ref}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
