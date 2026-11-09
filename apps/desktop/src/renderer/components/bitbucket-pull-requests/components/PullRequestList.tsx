import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, GitPullRequest, MessageSquare } from 'lucide-react';
import { Button } from '../../ui/button';
import { ScrollArea } from '../../ui/scroll-area';
import { PullRequestStateBadge } from './PullRequestDetail';
import type { BitbucketPullRequest } from '../../../../shared/types';
import type { BitbucketStateFilter } from '../hooks/useBitbucketPRs';

interface PullRequestListProps {
  pullRequests: BitbucketPullRequest[];
  isLoading: boolean;
  selectedPRId: number | null;
  onSelectPR: (pr: BitbucketPullRequest) => void;
  onRefresh: () => void;
  stateFilter: BitbucketStateFilter;
  onStateFilterChange: (state: BitbucketStateFilter) => void;
}

const STATE_FILTERS: BitbucketStateFilter[] = ['OPEN', 'MERGED', 'DECLINED', 'ALL'];

export function PullRequestList({
  pullRequests,
  isLoading,
  selectedPRId,
  onSelectPR,
  onRefresh,
  stateFilter,
  onStateFilterChange
}: PullRequestListProps) {
  const { t } = useTranslation('bitbucket');

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <GitPullRequest className="h-4 w-4" />
            {t('pullRequests.title')}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading}
            className="h-7 px-2"
            aria-label={t('pullRequests.refresh')}
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="flex gap-1">
          {STATE_FILTERS.map((state) => (
            <Button
              key={state}
              variant={stateFilter === state ? 'default' : 'ghost'}
              size="sm"
              onClick={() => onStateFilterChange(state)}
              className="h-7 text-xs"
            >
              {t(`pullRequests.filters.${state}`)}
            </Button>
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1">
        {isLoading && pullRequests.length === 0 ? (
          <div className="flex items-center justify-center py-8" role="status" aria-label={t('pullRequests.loading')}>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : pullRequests.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t('pullRequests.empty')}</div>
        ) : (
          <div className="p-2 space-y-1">
            {pullRequests.map((pr) => (
              <button
                type="button"
                key={pr.id}
                onClick={() => onSelectPR(pr)}
                className={`w-full text-left p-3 rounded-md border transition-colors ${
                  pr.id === selectedPRId
                    ? 'bg-accent border-primary/40'
                    : 'border-transparent hover:bg-accent/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">
                    #{pr.id} {pr.title}
                  </span>
                  <PullRequestStateBadge state={pr.state} />
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="truncate">{pr.author.displayName}</span>
                  <span className="truncate font-mono">
                    {pr.sourceBranch} → {pr.targetBranch}
                  </span>
                  <span className="flex items-center gap-1 ml-auto">
                    <MessageSquare className="h-3 w-3" />
                    {pr.commentCount}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
