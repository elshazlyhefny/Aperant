/**
 * Azure DevOps module types and interfaces
 *
 * zeenha fork: Azure DevOps support does not exist upstream.
 */

export interface AzureDevOpsConfig {
  organization: string;
  /** Team project name (may contain spaces) */
  project: string;
  /** Git repository name (may contain spaces) */
  repository: string;
  /** Personal access token */
  pat: string;
}

export interface AzureDevOpsAPIIdentity {
  id?: string;
  displayName?: string;
  uniqueName?: string;
  imageUrl?: string;
}

export interface AzureDevOpsAPICommitRef {
  commitId?: string;
}

export interface AzureDevOpsAPIPullRequest {
  pullRequestId: number;
  title?: string;
  description?: string | null;
  status?: string;
  isDraft?: boolean;
  sourceRefName?: string;
  targetRefName?: string;
  url?: string;
  createdBy?: AzureDevOpsAPIIdentity | null;
  creationDate?: string;
  closedDate?: string;
  reviewers?: AzureDevOpsAPIIdentity[];
  lastMergeSourceCommit?: AzureDevOpsAPICommitRef;
  lastMergeTargetCommit?: AzureDevOpsAPICommitRef;
  forkSource?: { repository?: { id?: string; name?: string } };
  repository?: { id?: string; name?: string };
}

export interface AzureDevOpsAPIThreadComment {
  id?: number;
  parentCommentId?: number;
  content?: string;
  commentType?: string | number;
  author?: AzureDevOpsAPIIdentity;
}

export interface AzureDevOpsAPIThreadPosition {
  line: number;
  offset: number;
}

export interface AzureDevOpsAPIThread {
  id: number;
  status?: string | number;
  comments?: AzureDevOpsAPIThreadComment[];
  threadContext?: {
    filePath?: string;
    rightFileStart?: AzureDevOpsAPIThreadPosition;
    rightFileEnd?: AzureDevOpsAPIThreadPosition;
  } | null;
}

export interface AzureDevOpsAPIIteration {
  id: number;
  sourceRefCommit?: AzureDevOpsAPICommitRef;
  targetRefCommit?: AzureDevOpsAPICommitRef;
  commonRefCommit?: AzureDevOpsAPICommitRef;
}

export interface AzureDevOpsAPIChange {
  changeType?: string;
  item?: { path?: string; objectId?: string; originalObjectId?: string };
  originalPath?: string;
}

export interface AzureDevOpsAPIChangesPage {
  changeEntries?: AzureDevOpsAPIChange[];
  nextSkip?: number;
  nextTop?: number;
}

export interface AzureDevOpsAPIInlineAnchor {
  path: string;
  line: number;
  endLine?: number;
}

export interface AzureDevOpsAPIPage<T> {
  value?: T[];
  count?: number;
}

export interface AzureDevOpsRepoRef {
  organization: string;
  project: string;
  repository: string;
}
