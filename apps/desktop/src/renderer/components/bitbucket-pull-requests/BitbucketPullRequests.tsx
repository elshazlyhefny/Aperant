import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Settings } from 'lucide-react';
import { Button } from '../ui/button';
import { PullRequestList } from './components/PullRequestList';
import { PullRequestDetail } from './components/PullRequestDetail';
import { useBitbucketPRReview } from './hooks/useBitbucketPRReview';
import { useBitbucketPRs, type BitbucketStateFilter } from './hooks/useBitbucketPRs';

interface BitbucketPullRequestsProps {
  projectId: string;
  onOpenSettings?: () => void;
}

export function BitbucketPullRequests({ projectId, onOpenSettings }: BitbucketPullRequestsProps) {
  const { t } = useTranslation('bitbucket');
  const [stateFilter, setStateFilter] = useState<BitbucketStateFilter>('OPEN');

  const {
    pullRequests,
    isLoading,
    isLoadingDetail,
    error,
    detailError,
    notConfigured,
    selectedPR,
    selectedPRId,
    diff,
    selectPR,
    refresh,
    postComment
  } = useBitbucketPRs(projectId, { stateFilter });

  const review = useBitbucketPRReview(projectId, selectedPRId);

  if (notConfigured) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 gap-3">
        <Settings className="h-12 w-12 text-muted-foreground" />
        <p className="text-sm font-medium">{t('pullRequests.notConfigured.title')}</p>
        <p className="text-sm text-muted-foreground text-center">{t('pullRequests.notConfigured.description')}</p>
        {onOpenSettings && (
          <Button variant="outline" onClick={onOpenSettings}>
            {t('pullRequests.notConfigured.action')}
          </Button>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <p className="text-sm text-muted-foreground text-center">{error}</p>
        <Button variant="outline" onClick={refresh} className="mt-4">
          {t('pullRequests.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-1/2 border-r border-border flex flex-col">
        <PullRequestList
          pullRequests={pullRequests}
          isLoading={isLoading}
          selectedPRId={selectedPRId}
          onSelectPR={(pr) => selectPR(pr.id)}
          onRefresh={refresh}
          stateFilter={stateFilter}
          onStateFilterChange={setStateFilter}
        />
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        {selectedPR ? (
          <PullRequestDetail
            pr={selectedPR}
            review={review}
            diff={diff}
            isLoading={isLoadingDetail}
            error={detailError}
            onPostComment={(body) => postComment(selectedPR.id, body)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {detailError ?? t('pullRequests.selectPrompt')}
          </div>
        )}
      </div>
    </div>
  );
}
