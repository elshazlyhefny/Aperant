import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { Idea } from '../../../shared/types';
import { linkedTaskIdOf } from './type-guards';

/** zeenha fork: `038-low-stock-reorder` -> `038`; any other id is shown whole. */
function shortTaskId(id: string): string {
  return /^(\d+)-/.exec(id)?.[1] ?? id;
}

/**
 * zeenha fork: flags a new idea that may repeat an existing task or idea.
 * Shown only while the user can still act on the idea (not converted,
 * archived or dismissed), and shared by the card and the detail panel.
 */
export function PossibleDuplicateBadge({ idea }: { idea: Idea }) {
  const { t } = useTranslation('common');
  const dup = idea.possibleDuplicateOf;
  if (!dup || linkedTaskIdOf(idea) || idea.status === 'dismissed' || idea.status === 'archived') {
    return null;
  }

  const label =
    dup.kind === 'task'
      ? t('ideation.possibleDuplicate.task', { id: shortTaskId(dup.id) })
      : t('ideation.possibleDuplicate.idea', { title: dup.title || dup.id });
  const score = t('ideation.possibleDuplicate.score', { score: Math.round(dup.score * 100) });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400"
        >
          <Copy className="h-3 w-3" />
          <span className="ml-1">{label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{score}</TooltipContent>
    </Tooltip>
  );
}
