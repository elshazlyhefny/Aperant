/**
 * Azure DevOps module types and interfaces
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

export interface AzureDevOpsAPIPullRequest {
  pullRequestId: number;
  title?: string;
  description?: string | null;
  status?: string;
  isDraft?: boolean;
  sourceRefName?: string;
  targetRefName?: string;
  url?: string;
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
