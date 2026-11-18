/**
 * zeenha fork: outcome writers for headless callers (the CLI). They resolve
 * credentials from the project's .env with a fallback to the process
 * environment, and never import the desktop forges (those pull in Electron
 * through the gh/glab CLI token lookup).
 */

import { readGitHubEnvConfig } from '../github/github-api';
import { readGitLabEnvConfig } from '../gitlab/gitlab-api';
import { createGitHubWriter } from './github-writer';
import { createGitLabWriter } from './gitlab-writer';
import { linearWriter } from './linear-writer';
import type { OutcomeWriter } from './types';

export function createHeadlessWriters(env: NodeJS.ProcessEnv): OutcomeWriter[] {
  return [
    createGitHubWriter((project) =>
      readGitHubEnvConfig(project, () => env.GITHUB_TOKEN || env.GH_TOKEN || null)
    ),
    createGitLabWriter((project) =>
      readGitLabEnvConfig(project, () => env.GITLAB_TOKEN || null)
    ),
    linearWriter
  ];
}
