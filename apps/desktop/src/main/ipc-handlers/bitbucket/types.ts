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
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
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
}
