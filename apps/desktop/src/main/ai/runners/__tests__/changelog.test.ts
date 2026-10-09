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

// =============================================================================
// Import after mocking
// =============================================================================

import { generateChangelog } from '../changelog';
import type { ChangelogConfig } from '../changelog';

// =============================================================================
// Helpers
// =============================================================================

/** A fake model object used by the mock client */
const fakeModel = { modelId: 'claude-haiku-test' };

function makeMockClient(systemPrompt = 'You are a technical writer.') {
  return { model: fakeModel, systemPrompt };
}

function baseConfig(overrides: Partial<ChangelogConfig> = {}): ChangelogConfig {
  return {
    projectName: 'TestProject',
    version: '1.0.0',
    sourceMode: 'tasks',
    tasks: [
      { title: 'Add dark mode', description: 'Implemented dark mode toggle', category: 'feature' },
    ],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('generateChangelog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue(makeMockClient());
  });

  // ---------------------------------------------------------------------------
  // Successful generation
  // ---------------------------------------------------------------------------

  it('returns success with trimmed text when LLM responds', async () => {
    mockGenerateText.mockResolvedValue({ text: '  ## [1.0.0]\n\n### Added\n- Dark mode\n  ' });

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(true);
    expect(result.text).toBe('## [1.0.0]\n\n### Added\n- Dark mode');
    expect(result.error).toBeUndefined();
  });

  it('passes project name and version in the prompt to createSimpleClient', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [2.0.0]' });

    await generateChangelog(baseConfig({ projectName: 'MyApp', version: '2.0.0' }));

    // createSimpleClient receives system-level configuration
    expect(mockCreateSimpleClient).toHaveBeenCalledOnce();
    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs).toHaveProperty('modelShorthand');
    expect(clientArgs).toHaveProperty('thinkingLevel');
  });

  it('passes model and systemPrompt from client to generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig());

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.model).toBe(fakeModel);
    expect(callArgs.system).toBe('You are a technical writer.');
    expect(callArgs.prompt).toContain('TestProject');
    expect(callArgs.prompt).toContain('1.0.0');
  });

  // ---------------------------------------------------------------------------
  // Task mode — prompt content
  // ---------------------------------------------------------------------------

  it('includes task titles and categories in prompt for tasks mode', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    const config = baseConfig({
      tasks: [
        { title: 'My feature', description: 'desc', category: 'feature', issueNumber: 42 },
      ],
    });
    await generateChangelog(config);

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('My feature');
    expect(prompt).toContain('feature');
    expect(prompt).toContain('#42');
  });

  // ---------------------------------------------------------------------------
  // Git history / branch-diff modes
  // ---------------------------------------------------------------------------

  it('includes commit messages in prompt for git-history mode', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(
      baseConfig({ sourceMode: 'git-history', commits: 'feat: add login\nfix: bug #5' }),
    );

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('feat: add login');
  });

  it('truncates commits to 5000 chars', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });
    const longCommits = 'x'.repeat(10_000);

    await generateChangelog(baseConfig({ sourceMode: 'branch-diff', commits: longCommits }));

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    // The 'x'.repeat(10000) block should be truncated — prompt must not exceed
    // 5000 'x' chars plus surrounding text
    const xCount = (prompt.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(5000);
  });

  // ---------------------------------------------------------------------------
  // Previous changelog style reference
  // ---------------------------------------------------------------------------

  it('includes previousChangelog when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(
      baseConfig({ previousChangelog: '## [0.9.0]\n\n### Added\n- Old feature' }),
    );

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Previous Changelog');
    expect(prompt).toContain('0.9.0');
  });

  // ---------------------------------------------------------------------------
  // Default model / thinking level
  // ---------------------------------------------------------------------------

  it('uses sonnet model and low thinking level by default', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig());

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'high' }));

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Empty response handling
  // ---------------------------------------------------------------------------

  it('returns failure when LLM returns empty text', async () => {
    mockGenerateText.mockResolvedValue({ text: '   ' });

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('Empty response from AI');
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('returns failure with error message when generateText throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('Rate limit exceeded');
  });

  it('returns failure with string coercion when non-Error is thrown', async () => {
    mockGenerateText.mockRejectedValue('timeout');

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
  });

  it('returns failure when createSimpleClient throws', async () => {
    mockCreateSimpleClient.mockRejectedValue(new Error('No auth available'));

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('No auth available');
  });
});

// zeenha fork: the request's style options used to be dropped before they reached
// the prompt, so every changelog was an undated Keep a Changelog entry.
describe('generateChangelog — style options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue(makeMockClient());
    mockGenerateText.mockResolvedValue({ text: '## 1.0.0' });
  });

  async function promptFor(overrides: Partial<ChangelogConfig>): Promise<string> {
    await generateChangelog(baseConfig(overrides));
    return mockGenerateText.mock.calls[0][0].prompt as string;
  }

  it('uses the requested date in the version header', async () => {
    const prompt = await promptFor({ format: 'keep-a-changelog', date: '2026-03-14' });
    expect(prompt).toContain('released **2026-03-14**');
    expect(prompt).toContain('## [1.0.0] - 2026-03-14');
  });

  it('carries the date even when no format is given', async () => {
    const prompt = await promptFor({ date: '2026-03-14' });
    expect(prompt).toContain('Use 2026-03-14 as the release date');
  });

  it('follows the simple-list format when asked', async () => {
    const prompt = await promptFor({ format: 'simple-list', date: '2026-03-14' });
    expect(prompt).toContain('# Release v1.0.0 (2026-03-14)');
    expect(prompt).not.toContain('## [1.0.0] - 2026-03-14');
  });

  it('follows the github-release format when asked', async () => {
    const prompt = await promptFor({ format: 'github-release', date: '2026-03-14' });
    expect(prompt).toContain("## What's Changed");
  });

  it('writes for the requested audience', async () => {
    const technical = await promptFor({ format: 'keep-a-changelog', audience: 'technical' });
    expect(technical).toContain('changelog for developers');
    mockGenerateText.mockClear();
    const marketing = await promptFor({ format: 'keep-a-changelog', audience: 'marketing' });
    expect(marketing).toContain('marketing specialist');
    expect(marketing).not.toContain('changelog for developers');
  });

  it('includes emoji instructions only when an emoji level is set', async () => {
    const withEmoji = await promptFor({ format: 'keep-a-changelog', emojiLevel: 'high' });
    expect(withEmoji).toContain('## Emoji Usage');
    expect(withEmoji).toContain('every line item');
    mockGenerateText.mockClear();
    const without = await promptFor({ format: 'keep-a-changelog', emojiLevel: 'none' });
    expect(without).not.toContain('## Emoji Usage');
  });

  it('includes the custom instructions', async () => {
    const prompt = await promptFor({ customInstructions: 'Mention the Arabic locale work first.' });
    expect(prompt).toContain('## Additional Instructions');
    expect(prompt).toContain('Mention the Arabic locale work first.');
  });

  it('adds no style sections when no options are given', async () => {
    const prompt = await promptFor({});
    expect(prompt).not.toContain('## Format');
    expect(prompt).not.toContain('## Audience');
    expect(prompt).not.toContain('## Additional Instructions');
  });
});
