/**
 * Bitbucket module types and interfaces
 */

export interface BitbucketConfig {
  username: string;
  token: string;
  /** Repository in "workspace/repo_slug" format */
  repository: string;
}

export interface BitbucketAPIUser {
  display_name?: string;
  nickname?: string;
  links?: { avatar?: { href?: string } };
}

export interface BitbucketAPIPullRequest {
  id: number;
  title?: string;
  description?: string | null;
  state?: string;
  // zeenha fork: commit hash is needed to match pipelines to the PR head
  source?: {
    branch?: { name?: string };
    commit?: { hash?: string };
    repository?: { full_name?: string };
  };
  destination?: { branch?: { name?: string }; commit?: { hash?: string } };
  author?: BitbucketAPIUser | null;
  reviewers?: Array<BitbucketAPIUser | null>;
  participants?: Array<{ user?: BitbucketAPIUser | null; role?: string }>;
  comment_count?: number;
  links?: { html?: { href?: string } };
  created_on?: string;
  updated_on?: string;
}

export interface BitbucketAPIPage<T> {
  values?: T[];
  next?: string;
  pagelen?: number;
  page?: number;
}

export interface BitbucketAPIRepository {
  full_name?: string;
  slug?: string;
  name?: string;
}

export interface BitbucketAPIComment {
  id: number;
  content?: { raw?: string };
  // zeenha fork: fields used to build PR feedback threads
  deleted?: boolean;
  parent?: { id: number };
  inline?: { path?: string; from?: number | null; to?: number | null };
  resolution?: unknown;
  user?: BitbucketAPIUser | null;
  links?: { html?: { href?: string } };
  created_on?: string;
}

// zeenha fork: pipeline API types
export interface BitbucketAPIPipelineState {
  name?: string;
  result?: { name?: string };
}

export interface BitbucketAPIPipeline {
  uuid: string;
  build_number?: number;
  target?: { ref_name?: string; commit?: { hash?: string } };
  state?: BitbucketAPIPipelineState;
}

export interface BitbucketAPIPipelineStep {
  uuid: string;
  name?: string;
  state?: BitbucketAPIPipelineState;
}

export interface BitbucketAPIDiffStat {
  status?: string;
  lines_added?: number;
  lines_removed?: number;
  old?: { path?: string } | null;
  new?: { path?: string } | null;
}

export interface BitbucketAPICommit {
  hash: string;
  message?: string;
  date?: string;
}
