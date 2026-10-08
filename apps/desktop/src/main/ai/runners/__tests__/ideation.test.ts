import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks — must be declared before any imports that use them
// =============================================================================

const mockStreamText = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  stepCountIs: (n: number) => ({ type: 'stepCount', count: n }),
}));

const mockCreateSimpleClient = vi.fn();

vi.mock('../../client/factory', () => ({
  createSimpleClient: (...args: unknown[]) => mockCreateSimpleClient(...args),
}));

// Mock filesystem: prompt files exist by default
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

/** The agent's output file: what a successful run leaves behind. */
let ideasFile: { name: string; mtimeMs: number; content: string } | null;
function agentWrote(type: string, name = `${type}_ideas.json`, mtimeMs = Date.now() + 60_000) {
  ideasFile = { name, mtimeMs, content: JSON.stringify({ [type]: [{ id: 'x-001', type, title: 'An idea' }] }) };
}

// Mock the tool registry so we don't need real tool initialization
vi.mock('../../tools/build-registry', () => ({
  buildToolRegistry: () => ({
    getToolsForAgent: vi.fn().mockReturnValue({}),
  }),
}));

// =============================================================================
// Import after mocking
// =============================================================================

import { runIdeation, IDEATION_MAX_STEPS, IDEATION_TYPES, IDEATION_TYPE_LABELS } from '../ideation';
import type { IdeationConfig, IdeationStreamEvent } from '../ideation';

// =============================================================================
// Helpers
// =============================================================================

const fakeModel = { modelId: 'claude-sonnet-test' };

function makeMockClient() {
  return {
    model: fakeModel,
    systemPrompt: '',
    tools: {},
    maxSteps: 30,
  };
}

/**
 * Build an async generator that yields stream parts and then ends.
 */
function makeStream(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
  };
}

function baseConfig(overrides: Partial<IdeationConfig> = {}): IdeationConfig {
  return {
    projectDir: '/project',
    outputDir: '/project/.auto-claude/ideation',
    promptsDir: '/app/prompts',
    ideationType: 'code_improvements',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runIdeation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue(makeMockClient());
    // Prompt file exists and has content by default
    mockExistsSync.mockReturnValue(true);
    agentWrote('code_improvements');
    mockReadFileSync.mockImplementation((file: string) =>
      ideasFile && String(file).endsWith(ideasFile.name) ? ideasFile.content : 'Analyze the codebase for improvements.',
    );
    mockReaddirSync.mockImplementation(() => (ideasFile ? [ideasFile.name, 'ideation.json'] : ['ideation.json']));
    mockStatSync.mockImplementation(() => ({ mtimeMs: ideasFile?.mtimeMs ?? 0 }));
  });

  // ---------------------------------------------------------------------------
  // A finished stream is not success without the ideas file (zeenha fork)
  // ---------------------------------------------------------------------------

  it('fails when the agent finished without writing its ideas file', async () => {
    ideasFile = null;
    mockStreamText.mockReturnValue(makeStream([{ type: 'text-delta', text: 'Still exploring...' }]));
    const events: IdeationStreamEvent[] = [];

    const result = await runIdeation(baseConfig({ ideationType: 'performance_optimizations' }), (e) => events.push(e));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Performance Optimizations agent finished without writing any ideas');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('fails when only an older file or another category was written', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    agentWrote('performance_optimizations', 'performance_optimizations_ideas.json', Date.now() - 3_600_000);
    expect((await runIdeation(baseConfig({ ideationType: 'performance_optimizations' }))).success).toBe(false);

    mockStreamText.mockReturnValue(makeStream([]));
    agentWrote('code_quality');
    expect((await runIdeation(baseConfig({ ideationType: 'performance_optimizations' }))).success).toBe(false);
  });

  it('accepts a file whose name differs from the type it holds', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    agentWrote('ui_ux_improvements', 'ui_ux_ideas.json');
    expect((await runIdeation(baseConfig({ ideationType: 'ui_ux_improvements' }))).success).toBe(true);
  });

  it('gives the agent the raised step budget and tells it so', async () => {
    mockCreateSimpleClient.mockResolvedValue({ ...makeMockClient(), maxSteps: IDEATION_MAX_STEPS });
    mockStreamText.mockReturnValue(makeStream([]));
    await runIdeation(baseConfig());
    expect(mockCreateSimpleClient.mock.calls[0][0].maxSteps).toBe(60);
    expect(mockStreamText.mock.calls[0][0].prompt).toContain('at most 60 tool-using steps');
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  it('exports all expected IDEATION_TYPES', () => {
    expect(IDEATION_TYPES).toContain('code_improvements');
    expect(IDEATION_TYPES).toContain('ui_ux_improvements');
    expect(IDEATION_TYPES).toContain('documentation_gaps');
    expect(IDEATION_TYPES).toContain('security_hardening');
    expect(IDEATION_TYPES).toContain('performance_optimizations');
    expect(IDEATION_TYPES).toContain('code_quality');
    expect(IDEATION_TYPES).toHaveLength(6);
  });

  it('exports human-readable labels for all ideation types', () => {
    for (const type of IDEATION_TYPES) {
      expect(IDEATION_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------------------
  // Successful run
  // ---------------------------------------------------------------------------

  it('returns success with accumulated text from stream', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        { type: 'text-delta', text: 'Found ' },
        { type: 'text-delta', text: '3 improvements.' },
      ]),
    );

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(true);
    expect(result.text).toBe('Found 3 improvements.');
    expect(result.error).toBeUndefined();
  });

  it('calls createSimpleClient with sonnet and medium thinking by default', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runIdeation(baseConfig());

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('medium');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runIdeation(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'low' }));

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('passes tools from client to streamText', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runIdeation(baseConfig());

    const streamArgs = mockStreamText.mock.calls[0][0];
    expect(streamArgs).toHaveProperty('tools');
    expect(streamArgs).toHaveProperty('model');
  });

  // ---------------------------------------------------------------------------
  // Stream callbacks
  // ---------------------------------------------------------------------------

  it('forwards text-delta events to onStream callback', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        { type: 'text-delta', text: 'hello' },
        { type: 'text-delta', text: ' world' },
      ]),
    );

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    const textEvents = events.filter((e) => e.type === 'text-delta');
    expect(textEvents).toHaveLength(2);
    expect((textEvents[0] as { type: 'text-delta'; text: string }).text).toBe('hello');
  });

  it('forwards tool-use events from tool-call stream parts', async () => {
    mockStreamText.mockReturnValue(
      makeStream([{ type: 'tool-call', toolName: 'Glob', toolCallId: 'c1', input: {} }]),
    );

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    const toolEvents = events.filter((e) => e.type === 'tool-use');
    expect(toolEvents).toHaveLength(1);
    expect((toolEvents[0] as { type: 'tool-use'; name: string }).name).toBe('Glob');
  });

  it('forwards error events from stream error parts', async () => {
    mockStreamText.mockReturnValue(
      makeStream([{ type: 'error', error: new Error('stream error') }]),
    );

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { type: 'error'; error: string }).error).toBe('stream error');
  });

  // ---------------------------------------------------------------------------
  // Prompt file not found
  // ---------------------------------------------------------------------------

  it('returns failure when prompt file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toContain('Prompt not found');
  });

  it('returns failure when prompt file cannot be read', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });

  // ---------------------------------------------------------------------------
  // Error handling — streamText throws
  // ---------------------------------------------------------------------------

  it('returns failure when streamText iteration throws', async () => {
    mockStreamText.mockReturnValue({
      // biome-ignore lint/correctness/useYield: intentionally throwing before yield to test error path
      fullStream: (async function* () {
        throw new Error('API error');
      })(),
    });

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('API error');
  });

  it('emits error event to callback when streamText throws', async () => {
    mockStreamText.mockReturnValue({
      // biome-ignore lint/correctness/useYield: intentionally throwing before yield to test error path
      fullStream: (async function* () {
        throw new Error('network failure');
      })(),
    });

    const events: IdeationStreamEvent[] = [];
    await runIdeation(baseConfig(), (e) => events.push(e));

    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Ideation type routing — checks the correct prompt file is loaded
  // ---------------------------------------------------------------------------

  it.each(IDEATION_TYPES)('loads the correct prompt file for ideation type: %s', async (type) => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runIdeation(baseConfig({ ideationType: type }));

    // The prompt file for each type should have been checked for existence
    expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('.md'));
  });

  // ---------------------------------------------------------------------------
  // Context injection
  // ---------------------------------------------------------------------------

  it('includes projectDir and outputDir in the prompt passed to streamText', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runIdeation(
      baseConfig({ projectDir: '/my/project', outputDir: '/my/project/.auto-claude/ideation' }),
    );

    // The system prompt passed to streamText should contain the project dir
    const streamArgs = mockStreamText.mock.calls[0][0];
    const systemPrompt = streamArgs.system as string;
    expect(systemPrompt).toContain('/my/project');
  });

  it('injects maxIdeasPerType into the context', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runIdeation(baseConfig({ maxIdeasPerType: 10 }));

    const streamArgs = mockStreamText.mock.calls[0][0];
    const systemPrompt = streamArgs.system as string;
    expect(systemPrompt).toContain('10');
  });
});
