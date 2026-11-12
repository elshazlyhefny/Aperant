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
const mockMkdirSync = vi.fn();
const mockGetToolsForAgent = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  // The path stands in for the file descriptor, so readFileSync still sees it.
  openSync: (file: string) => file,
  fstatSync: (...args: unknown[]) => mockStatSync(...args),
  closeSync: () => undefined,
}));

/** The agent's output file: what a successful run leaves behind. */
let ideasFile: { name: string; mtimeMs: number; content: string } | null;
function agentWrote(type: string, name = `${type}_ideas.json`, mtimeMs = Date.now() + 60_000) {
  ideasFile = {
    name,
    mtimeMs,
    content: JSON.stringify({
      [type]: [{ id: 'x-001', type, title: 'An idea', description: 'What it is', rationale: 'Why it matters' }],
    }),
  };
}

/** A stream that, while running, leaves `file` behind as the agent's output. */
function streamThatWrites(file: { name: string; content: string } | null, parts: Array<Record<string, unknown>> = []) {
  return {
    fullStream: (async function* () {
      if (file) ideasFile = { name: file.name, mtimeMs: Date.now() + 60_000, content: file.content };
      for (const part of parts) yield part;
    })(),
  };
}

// Mock the tool registry so we don't need real tool initialization
vi.mock('../../tools/build-registry', () => ({
  buildToolRegistry: () => ({
    getToolsForAgent: (...args: unknown[]) => mockGetToolsForAgent(...args),
  }),
}));

// =============================================================================
// Import after mocking
// =============================================================================

import { runIdeation, IDEATION_EVIDENCE_RULES, IDEATION_MAX_STEPS, IDEATION_TYPES, IDEATION_TYPE_LABELS } from '../ideation';
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
    mockGetToolsForAgent.mockReturnValue({});
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

  it('confines Write to outputDir and creates it first', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    const config = baseConfig();

    await runIdeation(config);

    expect(mockMkdirSync).toHaveBeenCalledWith(config.outputDir, { recursive: true });
    const ctx = mockGetToolsForAgent.mock.calls[0][1];
    expect(ctx.writeRoot).toBe(config.outputDir);
  });

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

  // ---------------------------------------------------------------------------
  // Ideas file validation with one retry
  // ---------------------------------------------------------------------------

  const goodIdea = (type: string) => ({ id: 'x-001', type, title: 'T', description: 'D', rationale: 'R' });
  const goodFile = (type: string) => JSON.stringify({ [type]: [goodIdea(type)] });
  const noRationaleFile = (type: string) =>
    JSON.stringify({ [type]: [{ id: 'x-001', type, title: 'T', description: 'D' }] });

  it('repairs a trailing comma without a second agent run', async () => {
    ideasFile = null;
    const withComma = `{"code_improvements": [{"id": "x-001", "type": "code_improvements", "title": "T", "description": "D", "rationale": "R",}],}`;
    mockStreamText.mockReturnValue(streamThatWrites({ name: 'code_improvements_ideas.json', content: withComma }));

    const result = await runIdeation(baseConfig());

    expect(result.success).toBe(true);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('retries once when an idea lacks a rationale, and succeeds once the file is rewritten', async () => {
    ideasFile = null;
    const name = 'code_improvements_ideas.json';
    mockStreamText
      .mockReturnValueOnce(streamThatWrites({ name, content: noRationaleFile('code_improvements') }, [{ type: 'text-delta', text: 'one ' }]))
      .mockReturnValueOnce(streamThatWrites({ name, content: goodFile('code_improvements') }, [{ type: 'text-delta', text: 'two' }]));

    const result = await runIdeation(baseConfig());

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    const retryPrompt = mockStreamText.mock.calls[1][0].prompt as string;
    expect(retryPrompt).toContain(name);
    expect(retryPrompt).toContain('rationale');
    expect(retryPrompt).toContain('/project/.auto-claude/ideation');
    expect(result.success).toBe(true);
    expect(result.text).toBe('one two');
  });

  it('fails with a distinct error when the file is still invalid after the retry', async () => {
    ideasFile = null;
    const name = 'code_improvements_ideas.json';
    mockStreamText.mockImplementation(() =>
      streamThatWrites({ name, content: noRationaleFile('code_improvements') }),
    );
    const events: IdeationStreamEvent[] = [];

    const result = await runIdeation(baseConfig(), (e) => events.push(e));

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain(`wrote ${name} but it is still invalid after one retry`);
    expect(result.error).toContain('rationale');
    expect(result.error).not.toContain('run out of steps');
    expect(events.some((e) => e.type === 'error' && e.error === result.error)).toBe(true);
  });

  it('does not retry when no file was written', async () => {
    ideasFile = null;
    mockStreamText.mockReturnValue(makeStream([]));

    const result = await runIdeation(baseConfig());

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('run out of steps');
  });

  it('sends an unparseable file named after the category through the retry path', async () => {
    ideasFile = null;
    const name = 'code_improvements_ideas.json';
    mockStreamText
      .mockReturnValueOnce(streamThatWrites({ name, content: 'this is not json at all' }))
      .mockReturnValueOnce(streamThatWrites({ name, content: goodFile('code_improvements') }));

    const result = await runIdeation(baseConfig());

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockStreamText.mock.calls[1][0].prompt).toContain('Invalid JSON syntax');
    expect(result.success).toBe(true);
  });

  it('does not claim another category\'s unparseable file', async () => {
    ideasFile = null;
    mockStreamText.mockReturnValue(
      streamThatWrites({ name: 'code_quality_ideas.json', content: 'this is not json at all' }),
    );

    const result = await runIdeation(baseConfig());

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('run out of steps');
  });

  it('ignores another category\'s invalid idea in a mixed-type file', async () => {
    ideasFile = null;
    const content = JSON.stringify({
      ideas: [goodIdea('code_improvements'), { id: 'y-001', type: 'code_quality', title: 'no description' }],
    });
    mockStreamText.mockReturnValue(streamThatWrites({ name: 'code_improvements_ideas.json', content }));

    const result = await runIdeation(baseConfig());

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
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
    expect(IDEATION_TYPES).toContain('seo_improvements');
    expect(IDEATION_TYPES).toHaveLength(7);
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

  it('appends the stale-checkout note only when there is one', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    await runIdeation(baseConfig({ checkoutNote: '**Checkout is behind**: 5 commits' }));
    expect(mockStreamText.mock.calls[0][0].system).toContain('**Checkout is behind**: 5 commits');

    mockStreamText.mockClear();
    mockStreamText.mockReturnValue(makeStream([]));
    await runIdeation(baseConfig());
    expect(mockStreamText.mock.calls[0][0].system).not.toContain('Checkout is behind');
  });

  it('always appends the evidence rules, and the prior-work note when there is one', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    await runIdeation(baseConfig({ priorWorkNote: '## Work that already exists\n- 007-x' }));
    const system = mockStreamText.mock.calls[0][0].system as string;
    expect(system).toContain(IDEATION_EVIDENCE_RULES);
    expect(system).toContain('## Work that already exists\n- 007-x');

    mockStreamText.mockClear();
    mockStreamText.mockReturnValue(makeStream([]));
    await runIdeation(baseConfig());
    expect(mockStreamText.mock.calls[0][0].system).toContain('## Evidence rules');
    expect(mockStreamText.mock.calls[0][0].system).not.toContain('Work that already exists');
  });
});
