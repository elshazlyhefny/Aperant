import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { ScrollArea } from '../../ui/scroll-area';
import { Textarea } from '../../ui/textarea';
import type { BitbucketPullRequest } from '../../../../shared/types';

export function PullRequestStateBadge({ state }: { state: BitbucketPullRequest['state'] }) {
  const { t } = useTranslation('bitbucket');
  const variant = state === 'OPEN' ? 'default' : state === 'MERGED' ? 'secondary' : 'outline';
  return (
    <Badge variant={variant} className="shrink-0 text-xs">
      {t(`pullRequests.states.${state}`)}
    </Badge>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground';
  if (line.startsWith('+')) return 'bg-green-500/10 text-green-600 dark:text-green-400';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-600 dark:text-red-400';
  if (line.startsWith('@@')) return 'text-blue-600 dark:text-blue-400';
  return '';
}

interface PullRequestDetailProps {
  pr: BitbucketPullRequest;
  diff: string | null;
  isLoading: boolean;
  error: string | null;
  onPostComment: (body: string) => Promise<boolean>;
}

export function PullRequestDetail({ pr, diff, isLoading, error, onPostComment }: PullRequestDetailProps) {
  const { t } = useTranslation('bitbucket');
  const [comment, setComment] = useState('');
  const [isPosting, setIsPosting] = useState(false);

  const handlePost = async () => {
    const body = comment.trim();
    if (!body) return;
    setIsPosting(true);
    const ok = await onPostComment(body);
    setIsPosting(false);
    if (ok) setComment('');
  };

  const openExternal = () => {
    Promise.resolve(window.electronAPI.openExternal(pr.webUrl)).catch(() => {
      // Opening the browser is best-effort.
    });
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-lg font-semibold">
              #{pr.id} {pr.title}
            </h2>
            <PullRequestStateBadge state={pr.state} />
          </div>
          <div className="text-sm text-muted-foreground space-y-1">
            <div className="font-mono">
              {pr.sourceBranch} → {pr.targetBranch}
            </div>
            <div>{t('pullRequests.author', { name: pr.author.displayName })}</div>
            <div>
              {pr.reviewers.length > 0
                ? t('pullRequests.reviewers', { names: pr.reviewers.map((r) => r.displayName).join(', ') })
                : t('pullRequests.noReviewers')}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={openExternal} className="gap-2">
            <ExternalLink className="h-4 w-4" />
            {t('pullRequests.openInBitbucket')}
          </Button>
        </div>

        {pr.description && <p className="text-sm whitespace-pre-wrap">{pr.description}</p>}

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('pullRequests.diff')}</h3>
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : diff ? (
            <pre className="text-xs font-mono overflow-x-auto border border-border rounded-md py-2">
              {diff.split('\n').map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and ordered
                <div key={index} className={`px-3 whitespace-pre ${diffLineClass(line)}`}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">{t('pullRequests.noDiff')}</p>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('pullRequests.addComment')}</h3>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('pullRequests.commentPlaceholder')}
            rows={3}
          />
          <Button size="sm" onClick={handlePost} disabled={isPosting || !comment.trim()}>
            {isPosting ? t('pullRequests.posting') : t('pullRequests.postComment')}
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}
