/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    getPath: () => '/tmp',
    isPackaged: false
  }
}));

const {
  mockLoadSession,
  mockCreateNewSession,
  mockSaveSession,
  mockExecute,
  mockCancelSession,
  mockGenerateTitle
} = vi.hoisted(() => ({
  mockLoadSession: vi.fn(),
  mockCreateNewSession: vi.fn(),
  mockSaveSession: vi.fn(),
  mockExecute: vi.fn(),
  mockCancelSession: vi.fn(),
  mockGenerateTitle: vi.fn((m: string) => `title:${m}`)
}));

vi.mock('../insights/config', () => ({
  InsightsConfig: class {}
}));
vi.mock('../insights/paths', () => ({
  InsightsPaths: class {}
}));
vi.mock('../insights/session-storage', () => ({
  SessionStorage: class {
    generateTitle = mockGenerateTitle;
  }
}));
vi.mock('../insights/session-manager', () => ({
  SessionManager: class {
    loadSession = mockLoadSession;
    createNewSession = mockCreateNewSession;
    saveSession = mockSaveSession;
  }
}));
vi.mock('../insights/insights-executor', async () => {
  const { EventEmitter } = await import('events');
  return {
    InsightsExecutor: class extends EventEmitter {
      execute = mockExecute;
      cancelSession = mockCancelSession;
    }
  };
});

import { InsightsService } from '../insights-service';

type Msg = { id: string; role: 'user' | 'assistant'; content: string; timestamp: Date };

const makeSession = (messages: Msg[]) => ({
  id: 's1',
  projectId: 'p1',
  title: 'New Conversation',
  messages,
  createdAt: new Date(),
  updatedAt: new Date()
});

const userMsg = (content: string): Msg => ({
  id: 'u1',
  role: 'user',
  content,
  timestamp: new Date()
});
const assistantMsg = (content: string): Msg => ({
  id: 'a1',
  role: 'assistant',
  content,
  timestamp: new Date()
});

describe('InsightsService.sendMessage retry', () => {
  let service: InsightsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ fullResponse: 'answer', suggestedTasks: undefined, toolsUsed: [] });
    service = new InsightsService();
  });

  it('normal send appends one user message and executes', async () => {
    const session = makeSession([]);
    mockLoadSession.mockReturnValue(session);

    await service.sendMessage('p1', '/project', 'hello');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][3]).toEqual([{ role: 'user', content: 'hello' }]);
    expect(session.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('retry with trailing user message does not duplicate it and still executes', async () => {
    const session = makeSession([userMsg('hello')]);
    mockLoadSession.mockReturnValue(session);

    await service.sendMessage('p1', '/project', 'hello', undefined, undefined, true);

    expect(session.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][2]).toBe('hello');
    expect(mockExecute.mock.calls[0][3]).toEqual([{ role: 'user', content: 'hello' }]);
    // Only the post-success save of the assistant reply; no pre-run save
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it('retry when last message is an assistant message falls back to appending', async () => {
    const session = makeSession([userMsg('first'), assistantMsg('reply')]);
    mockLoadSession.mockReturnValue(session);

    await service.sendMessage('p1', '/project', 'second', undefined, undefined, true);

    const users = session.messages.filter(m => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[1].content).toBe('second');
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('successful retry appends exactly one assistant message', async () => {
    const session = makeSession([userMsg('hello')]);
    mockLoadSession.mockReturnValue(session);

    await service.sendMessage('p1', '/project', 'hello', undefined, undefined, true);

    const assistants = session.messages.filter(m => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe('answer');
    expect(session.messages).toHaveLength(2);
  });
});
