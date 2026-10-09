import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks — must be declared before any imports that use them
// =============================================================================

const mockGenerateText = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

const mockCreateSimpleClient = vi.fn();

vi.mock('../../client/factory', () => ({
  createSimpleClient: (...args: unknown[]) => mockCreateSimpleClient(...args),
}));

// Mock filesystem access so tests are hermetic
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// json-repair is used by the commit-message runner for safeParseJson
vi.mock('../../../utils/json-repair', () => ({
  safeParseJson: (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
}));

// =============================================================================
// Import after mocking
// =============================================================================

import { generateCommitMessage } from '../commit-message';
import type { CommitMessageConfig } from '../commit-message';

// =============================================================================
// Helpers
// =============================================================================

const fakeModel = { modelId: 'claude-haiku-test' };

function makeMockClient(systemPrompt = 'You are a Git expert.') {
  return { model: fakeModel, systemPrompt };
}

function baseConfig(overrides: Partial<CommitMessageConfig> = {}): CommitMessageConfig {
  return {
    projectDir: '/project',
    specName: '001-add-feature',
    diffSummary: '+5 -2 src/app.ts',
    filesChanged: ['src/app.ts', 'src/utils.ts'],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('generateCommitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue(makeMockClient());
    // By default, spec directory does not exist
    mockExistsSync.mockReturnValue(false);
  });

  // ---------------------------------------------------------------------------
  // Successful generation
  // ---------------------------------------------------------------------------

  it('returns trimmed AI-generated commit message on success', async () => {
    mockGenerateText.mockResolvedValue({
      text: '  feat(app): add authentication flow\n\nImplemented OAuth2.\n  ',
    });

    const result = await generateCommitMessage(baseConfig());

    expect(result).toBe('feat(app): add authentication flow\n\nImplemented OAuth2.');
  });

  it('passes model and systemPrompt from client to generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: 'feat: something' });

    await generateCommitMessage(baseConfig());

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.model).toBe(fakeModel);
    expect(callArgs.system).toBe('You are a Git expert.');
  });

  it('includes diffSummary in the prompt sent to generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: 'fix: resolve bug' });

    await generateCommitMessage(baseConfig({ diffSummary: 'removed null check in auth.ts' }));

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('removed null check in auth.ts');
  });

  it('includes filesChanged in the prompt', async () => {
    mockGenerateText.mockResolvedValue({ text: 'refactor: split utilities' });

    await generateCommitMessage(
      baseConfig({ filesChanged: ['src/auth.ts', 'src/utils.ts', 'src/index.ts'] }),
    );

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('src/auth.ts');
  });

  // ---------------------------------------------------------------------------
  // Default model / thinking level
  // ---------------------------------------------------------------------------

  it('uses haiku model and low thinking level by default', async () => {
    mockGenerateText.mockResolvedValue({ text: 'chore: update deps' });

    await generateCommitMessage(baseConfig());

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockGenerateText.mockResolvedValue({ text: 'feat: new endpoint' });

    await generateCommitMessage(baseConfig({ modelShorthand: 'sonnet', thinkingLevel: 'medium' }));

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('medium');
  });

  // ---------------------------------------------------------------------------
  // GitHub issue handling
  // ---------------------------------------------------------------------------

  it('includes Fixes reference when githubIssue is provided', async () => {
    mockGenerateText.mockResolvedValue({ text: 'fix: null pointer\n\nFixes #99' });

    const result = await generateCommitMessage(baseConfig({ githubIssue: 99 }));

    expect(result).toContain('Fixes #99');
  });

  // ---------------------------------------------------------------------------
  // Spec file context
  // ---------------------------------------------------------------------------

  it('reads spec.md for title when spec directory exists', async () => {
    // Spec directory at .auto-claude/specs/001-add-feature
    mockExistsSync.mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.includes('specs/001-add-feature')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('spec.md')) return '# Add OAuth Feature\n\n## Overview\nFull OAuth2 support.';
      return '{}';
    });
    mockGenerateText.mockResolvedValue({ text: 'feat(auth): add OAuth2' });

    const result = await generateCommitMessage(baseConfig());

    // Result should come from LLM (title from spec was available for context)
    expect(result).toBe('feat(auth): add OAuth2');
    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Add OAuth Feature');
  });

  // ---------------------------------------------------------------------------
  // Fallback message
  // ---------------------------------------------------------------------------

  it('returns fallback message when generateText throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('Network error'));

    const result = await generateCommitMessage(baseConfig({ specName: '001-add-feature' }));

    // Fallback format: "<type>: <title or specName>"
    expect(result).toMatch(/^(feat|fix|refactor|docs|test|perf|chore|style|ci|build):/);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes Fixes in fallback when githubIssue provided and LLM fails', async () => {
    mockGenerateText.mockRejectedValue(new Error('Timeout'));

    const result = await generateCommitMessage(baseConfig({ githubIssue: 77 }));

    expect(result).toContain('Fixes #77');
  });

  it('returns fallback when LLM returns empty text', async () => {
    mockGenerateText.mockResolvedValue({ text: '   ' });

    const result = await generateCommitMessage(baseConfig());

    // Should fall through to fallback
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Large filesChanged list
  // ---------------------------------------------------------------------------

  it('truncates filesChanged list when more than 20 files', async () => {
    mockGenerateText.mockResolvedValue({ text: 'refactor: big cleanup' });

    const manyFiles = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
    await generateCommitMessage(baseConfig({ filesChanged: manyFiles }));

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('and 10 more files');
  });
});

// zeenha fork: the GitHub import writes githubIssueNumber and category to
// task_metadata.json, never to implementation_plan.json, so the runner must read it.
describe('generateCommitMessage — task_metadata.json', () => {
  function specFiles(files: Record<string, string>) {
    mockExistsSync.mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('.auto-claude/specs/001-add-feature')) return true;
      return Object.keys(files).some((name) => normalized.endsWith(`specs/001-add-feature/${name}`));
    });
    mockReadFileSync.mockImplementation((p: string) => {
      const normalized = p.replace(/\\/g, '/');
      const name = Object.keys(files).find((n) => normalized.endsWith(`/${n}`));
      return name ? files[name] : '{}';
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue(makeMockClient());
  });

  it('asks for "Fixes #N" from the issue number in task_metadata.json', async () => {
    specFiles({ 'task_metadata.json': JSON.stringify({ sourceType: 'github', githubIssueNumber: 77 }) });
    mockGenerateText.mockResolvedValue({ text: 'fix: x\n\nFixes #77' });

    await generateCommitMessage(baseConfig());

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("include 'Fixes #77'");
  });

  it('puts every task_metadata.json issue in the fallback', async () => {
    specFiles({
      'task_metadata.json': JSON.stringify({ githubIssueNumber: 5, githubIssueNumbers: [5, 9] }),
    });
    mockGenerateText.mockRejectedValue(new Error('down'));

    const result = await generateCommitMessage(baseConfig());

    expect(result).toContain('Fixes #5\nFixes #9');
  });

  it('maps the task_metadata.json category to the commit type, over requirements.json', async () => {
    specFiles({
      'requirements.json': JSON.stringify({ workflow_type: 'feature' }),
      'task_metadata.json': JSON.stringify({ category: 'bug_fix' }),
    });
    mockGenerateText.mockResolvedValue({ text: 'fix: x' });

    await generateCommitMessage(baseConfig());

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Type: fix');
  });

  it.each([
    ['infrastructure', 'build'],
    ['ui_ux', 'feat'],
    ['security', 'fix'],
    ['testing', 'test'],
  ])('maps category %s to %s', async (category, type) => {
    specFiles({ 'task_metadata.json': JSON.stringify({ category }) });
    mockGenerateText.mockRejectedValue(new Error('down'));

    const result = await generateCommitMessage(baseConfig());

    expect(result.startsWith(`${type}:`)).toBe(true);
  });

  it('still reads the issue from implementation_plan.json when task_metadata.json has none', async () => {
    specFiles({ 'implementation_plan.json': JSON.stringify({ metadata: { githubIssueNumber: 12 } }) });
    mockGenerateText.mockRejectedValue(new Error('down'));

    const result = await generateCommitMessage(baseConfig());

    expect(result).toContain('Fixes #12');
  });

  it('ignores issue numbers that are not positive integers', async () => {
    specFiles({ 'task_metadata.json': JSON.stringify({ githubIssueNumber: '42; rm -rf /' }) });
    mockGenerateText.mockRejectedValue(new Error('down'));

    const result = await generateCommitMessage(baseConfig());

    expect(result).not.toContain('Fixes');
  });

  it('lets the caller override the spec issue', async () => {
    specFiles({ 'task_metadata.json': JSON.stringify({ githubIssueNumber: 77 }) });
    mockGenerateText.mockRejectedValue(new Error('down'));

    const result = await generateCommitMessage(baseConfig({ githubIssue: 3 }));

    expect(result).toContain('Fixes #3');
    expect(result).not.toContain('Fixes #77');
  });
});

