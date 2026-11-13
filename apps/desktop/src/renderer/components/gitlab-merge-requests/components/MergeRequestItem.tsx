import { useTranslation } from 'react-i18next';
import { GitMerge, GitPullRequest, Lock, ExternalLink } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { GitLabMergeRequest } from '../../../../shared/types';

interface MergeRequestItemProps {
  mr: GitLabMergeRequest;
  isSelected: boolean;
  onClick: () => void;
}

export function MergeRequestItem({ mr, isSelected, onClick }: MergeRequestItemProps) {
  const { t, i18n } = useTranslation(['gitlab']);
  const stateColors = {
    opened: 'text-success',
    closed: 'text-destructive',
    merged: 'text-info',
    locked: 'text-warning'
  };

  const stateIcons = {
    opened: GitPullRequest,
    closed: GitPullRequest,
    merged: GitMerge,
    locked: Lock
  };

  const StateIcon = stateIcons[mr.state] || GitPullRequest;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' });
  };

  return (
    <div
      className={cn(
        'w-full flex items-start gap-3 p-3 rounded-lg border transition-colors',
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-transparent hover:bg-muted/50'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={isSelected || undefined}
        className="flex-1 min-w-0 text-left flex items-start gap-3 rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <StateIcon
          aria-hidden="true"
          className={cn('h-5 w-5 mt-0.5 shrink-0', stateColors[mr.state])}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">!{mr.iid}</span>
            <h4 className="text-sm font-medium text-foreground truncate">{mr.title}</h4>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span>{mr.sourceBranch}</span>
            <span>→</span>
            <span>{mr.targetBranch}</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {mr.labels.slice(0, 3).map((label) => (
              <span
                key={label}
                className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {mr.labels.length > 3 && (
              <span className="text-xs text-muted-foreground">
                +{mr.labels.length - 3}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <span>{t('gitlab:mergeRequests.byAuthor', { username: mr.author.username })}</span>
            <span>•</span>
            <span>{formatDate(mr.createdAt)}</span>
          </div>
        </div>
      </button>
      <a
        href={mr.webUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('gitlab:mergeRequests.openInGitLab', { iid: mr.iid })}
        className="text-muted-foreground hover:text-foreground rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
      </a>
    </div>
  );
}
