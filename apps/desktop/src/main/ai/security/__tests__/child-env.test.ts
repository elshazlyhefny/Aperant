import { describe, expect, it } from 'vitest';
import { buildChildEnv, parseEnvPassthrough } from '../child-env';

describe('buildChildEnv', () => {
  it.each([
    'GITHUB_TOKEN',
    'MY_SERVICE_TOKEN',
    'STRIPE_API_KEY',
    'APP_SECRET',
    'DB_PASSWORD',
    'DB_PASSWD',
    'SVC_CREDENTIALS',
    'S3_ACCESS_KEY',
    'DEPLOY_PRIVATE_KEY',
    'AWS_REGION',
    'AWS_SESSION_TOKEN',
    'AZURE_CLIENT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GCP_PROJECT_KEY',
    'GCLOUD_SERVICE_KEY',
    'GH_TOKEN',
    'GITLAB_TOKEN',
    'JIRA_API_TOKEN',
    'WEBHOOK_URL',
    'NPM_TOKEN',
    'SSH_AUTH_SOCK',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_ORG_ID',
  ])('removes %s', (name) => {
    const env = buildChildEnv({ [name]: 'x', PATH: '/bin' });
    expect(env[name]).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('matches case-insensitively', () => {
    const env = buildChildEnv({ github_token: 'x', Aws_Region: 'y', my_api_key: 'z' });
    expect(Object.keys(env)).toEqual([]);
  });

  it('preserves basic runtime variables', () => {
    const base = {
      PATH: '/bin',
      HOME: '/home/u',
      USER: 'u',
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      TERM: 'xterm',
      TMPDIR: '/tmp',
      TEMP: '/tmp',
      TMP: '/tmp',
      PWD: '/w',
      SYSTEMROOT: 'C:\\Windows',
      ComSpec: 'cmd.exe',
      EDITOR: 'vim',
    };
    expect(buildChildEnv(base)).toEqual(base);
  });

  it('keeps passthrough and keep names', () => {
    const env = buildChildEnv(
      { NPM_TOKEN: 'a', AWS_PROFILE: 'b', OTHER_SECRET: 'c' },
      { passthrough: ['NPM_TOKEN'], keep: ['aws_profile'] },
    );
    expect(env).toEqual({ NPM_TOKEN: 'a', AWS_PROFILE: 'b' });
  });

  it('does not mutate the input', () => {
    const base = { GH_TOKEN: 'x', PATH: '/bin' };
    const copy = { ...base };
    const env = buildChildEnv(base);
    expect(base).toEqual(copy);
    expect(env).not.toBe(base);
  });

  it('defaults to process.env', () => {
    const env = buildChildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('parseEnvPassthrough', () => {
  it('trims, de-duplicates and ignores non-strings', () => {
    expect(parseEnvPassthrough([' FOO ', 'FOO', 'BAR', 1, null, {}])).toEqual(['FOO', 'BAR']);
  });

  it('rejects invalid names', () => {
    expect(parseEnvPassthrough(['1ABC', 'A-B', 'A B', '', 'A=B', 'OK_1'])).toEqual(['OK_1']);
  });

  it('returns [] for non-arrays', () => {
    expect(parseEnvPassthrough('FOO')).toEqual([]);
    expect(parseEnvPassthrough(undefined)).toEqual([]);
  });
});
