import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Loader2, Send, Square } from 'lucide-react';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Progress } from '../../ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../ui/alert-dialog';
import { CollapsibleCard } from '../../github-prs/components/CollapsibleCard';
import { PRLogs } from '../../github-prs/components/PRLogs';
import { ReviewFindings } from '../../github-prs/components/ReviewFindings';
import type { useBitbucketPRReview } from '../hooks/useBitbucketPRReview';

type ReviewState = ReturnType<typeof useBitbucketPRReview>;

interface BitbucketReviewPanelProps {
  review: ReviewState;
  prId: number;
  prState: string;
}

export function BitbucketReviewPanel({ review, prId, prState }: BitbucketReviewPanelProps) {
  const { t } = useTranslation('bitbucket');
  const [postInline, setPostInline] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [posted, setPosted] = useState(false);

  const isReviewing = review.status === 'reviewing';
  const result = review.result?.success ? review.result : null;
  const canStart = prState === 'OPEN' && !isReviewing;
  const selectedCount = review.selectedIds.size;

  useEffect(() => {
    if (isReviewing) setLogsOpen(true);
  }, [isReviewing]);

  const handleConfirm = async () => {
    setConfirmOpen(false);
    setPosted(false);
    const ok = await review.postSelected({ postInline });
    setPosted(ok);
  };

  return (
    <div className="space-y-4" data-testid="bitbucket-review-panel">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-medium">
          <Bot className="h-4 w-4" />
          {t('pullRequests.review.title')}
        </h3>
        <div className="flex items-center gap-2">
          {isReviewing && (
            <Button variant="outline" size="sm" onClick={() => void review.cancelReview()}>
              <Square className="mr-2 h-4 w-4" />
              {t('pullRequests.review.cancel')}
            </Button>
          )}
          <Button
            size="sm"
            disabled={!canStart}
            title={prState === 'OPEN' ? undefined : t('pullRequests.review.notOpen')}
            onClick={review.startReview}
          >
            {isReviewing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Bot className="mr-2 h-4 w-4" />
            )}
            {isReviewing
              ? t('pullRequests.review.running')
              : review.result
                ? t('pullRequests.review.rerun')
                : t('pullRequests.review.start')}
          </Button>
        </div>
      </div>

      {isReviewing && (
        <div className="space-y-1" aria-label={t('pullRequests.review.progress')}>
          <Progress value={review.progress?.progress ?? 0} />
          <p className="text-xs text-muted-foreground">
            {review.progress?.message ?? t('pullRequests.review.running')}
          </p>
        </div>
      )}

      {(isReviewing || review.logs) && (
        <CollapsibleCard
          title={t('pullRequests.review.logsTitle')}
          open={logsOpen}
          onOpenChange={setLogsOpen}
        >
          <PRLogs
            prNumber={prId}
            logs={review.logs}
            isLoading={isReviewing && !review.logs}
            isStreaming={isReviewing}
          />
        </CollapsibleCard>
      )}

      {review.error && (
        <p role="alert" className="text-sm text-destructive">
          {t('pullRequests.review.errors.review', { error: review.error })}
        </p>
      )}

      {result && (
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">{t('pullRequests.review.summary')}</span>
              <span className="text-xs text-muted-foreground">
                {t(`pullRequests.review.status.${result.overallStatus}`)}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{result.summary}</p>
          </div>

          {result.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pullRequests.review.noFindings')}</p>
          ) : (
            <>
              <ReviewFindings
                findings={result.findings}
                selectedIds={review.selectedIds}
                postedIds={review.postedIds}
                onSelectionChange={review.setSelectedIds}
              />
              <div className="flex items-center gap-2">
                <Checkbox
                  id="bitbucket-post-inline"
                  checked={postInline}
                  onCheckedChange={(v) => setPostInline(v === true)}
                />
                <label htmlFor="bitbucket-post-inline" className="text-sm">
                  {t('pullRequests.review.inlineOption')}
                </label>
              </div>
              <Button
                disabled={selectedCount === 0 || review.isPosting}
                onClick={() => setConfirmOpen(true)}
              >
                {review.isPosting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {review.isPosting
                  ? t('pullRequests.review.posting')
                  : t('pullRequests.review.postButton')}
              </Button>
            </>
          )}
        </div>
      )}

      {review.postError && (
        <p role="alert" className="text-sm text-destructive">
          {t('pullRequests.review.errors.post', { error: review.postError })}
        </p>
      )}
      {posted && !review.postError && (
        <p role="status" className="text-sm text-green-600">
          {t('pullRequests.review.postSuccess')}
        </p>
      )}
      {review.inlineFailed.length > 0 && (
        <div className="text-sm text-amber-600">
          <p>{t('pullRequests.review.inlinePartial', { count: review.inlineFailed.length })}</p>
          <ul className="list-disc pl-5">
            {review.inlineFailed.map((f) => (
              <li key={f.findingId}>
                {f.findingId}: {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pullRequests.review.confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('pullRequests.review.confirm.description', { count: selectedCount })}{' '}
              {postInline
                ? t('pullRequests.review.confirm.inline')
                : t('pullRequests.review.confirm.noInline')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('pullRequests.review.confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirm()}>
              {t('pullRequests.review.confirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
