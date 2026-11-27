/**
 * @vitest-environment jsdom
 *
 * zeenha fork: expanded phase entries are virtualized so huge logs stay cheap.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { useSettingsStore } from '../../../stores/settings-store';
import { TaskLogs } from '../TaskLogs';

function makeLogs(count: number) {
  const entries = Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    type: 'text',
    content: `entry-${i}`,
    phase: 'coding',
  }));
  const empty = { phase: 'x', status: 'pending', started_at: null, completed_at: null, entries: [] };
  return {
    spec_id: 's',
    created_at: '',
    updated_at: '',
    phases: {
      planning: { ...empty, phase: 'planning' },
      coding: { ...empty, phase: 'coding', status: 'active', entries },
      validation: { ...empty, phase: 'validation' },
    },
  } as never;
}

function renderLogs(count: number) {
  const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
  const endRef = { current: null } as React.RefObject<HTMLDivElement | null>;
  return render(
    <TaskLogs
      task={{ id: 't', status: 'in_progress' } as never}
      phaseLogs={makeLogs(count)}
      isLoadingLogs={false}
      expandedPhases={new Set(['coding'])}
      isStuck={false}
      logsEndRef={endRef}
      logsContainerRef={ref}
      isAwayFromLatest={false}
      onJumpToLatest={() => {}}
      onLogsScroll={() => {}}
      onTogglePhase={() => {}}
    />
  );
}

beforeEach(() => {
  // jsdom has no layout: give every element a 400px-tall viewport / 28px rows
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
});

describe('TaskLogs virtualization', () => {
  it('renders only a bounded number of rows for a large phase', () => {
    const { container } = renderLogs(500);
    const rows = container.querySelectorAll('[data-index]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it('renders every entry of a small phase', () => {
    const { container, getByText } = renderLogs(10);
    expect(container.querySelectorAll('[data-index]').length).toBe(0);
    for (let i = 0; i < 10; i++) expect(getByText(`entry-${i}`)).toBeInTheDocument();
  });
});

function renderWith(phaseLogs: unknown, expanded: string[] = []) {
  const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
  const endRef = { current: null } as React.RefObject<HTMLDivElement | null>;
  return render(
    <TaskLogs
      task={{ id: 'empty-task', status: 'in_progress' } as never}
      phaseLogs={phaseLogs as never}
      isLoadingLogs={false}
      expandedPhases={new Set(expanded) as never}
      isStuck={false}
      logsEndRef={endRef}
      logsContainerRef={ref}
      isAwayFromLatest={false}
      onJumpToLatest={() => {}}
      onLogsScroll={() => {}}
      onTogglePhase={() => {}}
    />
  );
}

function logsWithEntries(entries: unknown[]) {
  const empty = { status: 'pending', started_at: null, completed_at: null, entries: [] };
  return {
    spec_id: 's',
    created_at: '',
    updated_at: '',
    phases: {
      planning: { ...empty, phase: 'planning' },
      coding: { ...empty, phase: 'coding', status: 'active', entries },
      validation: { ...empty, phase: 'validation' },
    },
  };
}

const ts = new Date(2026, 0, 1).toISOString();

describe('TaskLogs i18n', () => {
  it('renders phase headers as translation keys', () => {
    renderWith(makeLogs(1));
    expect(screen.getByText('tasks:execution.phases.planning')).toBeInTheDocument();
    expect(screen.getByText('tasks:execution.phases.coding')).toBeInTheDocument();
    expect(screen.getByText('tasks:execution.phases.validation')).toBeInTheDocument();
  });

  it('renders the empty state keys when there are no logs', () => {
    renderWith(null);
    expect(screen.getByText('tasks:logs.empty.title')).toBeInTheDocument();
    expect(screen.getByText('tasks:logs.empty.hint')).toBeInTheDocument();
  });

  it('translates known tool names and leaves unknown ones as-is', () => {
    renderWith(
      logsWithEntries([
        { timestamp: ts, type: 'tool_start', content: 'a', phase: 'coding', tool_name: 'Read' },
        { timestamp: ts, type: 'tool_start', content: 'b', phase: 'coding', tool_name: 'CustomMcpTool' },
      ]),
      ['coding']
    );
    expect(screen.getByText('tasks:logs.tools.reading')).toBeInTheDocument();
    expect(screen.getByText('CustomMcpTool')).toBeInTheDocument();
  });

  it('renders the done label for tool_end entries', () => {
    renderWith(
      logsWithEntries([{ timestamp: ts, type: 'tool_end', content: 'c', phase: 'coding', tool_name: 'Read' }]),
      ['coding']
    );
    expect(screen.getByText('tasks:logs.done')).toBeInTheDocument();
  });
});

describe('TaskLogs jump to latest', () => {
  const initialLogOrder = useSettingsStore.getState().settings.logOrder;

  beforeEach(() => {
    useSettingsStore.setState(({ settings }) => ({ settings: { ...settings, logOrder: 'chronological' } }));
  });

  afterEach(() => {
    useSettingsStore.setState(({ settings }) => ({ settings: { ...settings, logOrder: initialLogOrder } }));
    vi.restoreAllMocks();
  });

  function renderJumpButton(isAwayFromLatest = true) {
    const logsContainerRef: React.RefObject<HTMLDivElement | null> = { current: null };
    const logsEndRef: React.RefObject<HTMLDivElement | null> = { current: null };
    const onJumpToLatest = vi.fn();
    const props: React.ComponentProps<typeof TaskLogs> = {
      task: { id: 't', status: 'in_progress' } as never,
      phaseLogs: makeLogs(1),
      isLoadingLogs: false,
      expandedPhases: new Set(['coding']),
      isStuck: false,
      logsContainerRef,
      logsEndRef,
      isAwayFromLatest,
      onJumpToLatest,
      onLogsScroll: vi.fn(),
      onTogglePhase: vi.fn(),
    };
    const { rerender } = render(<TaskLogs {...props} />);
    const viewport = logsContainerRef.current;
    const endSentinel = logsEndRef.current;
    if (!viewport || !endSentinel) throw new Error('Expected the log viewport and end sentinel to be mounted');

    return {
      viewport,
      endSentinel,
      onJumpToLatest,
      resumeFollowing: () => rerender(<TaskLogs {...props} isAwayFromLatest={false} />),
    };
  }

  function getJumpButton() {
    return screen.getByRole('button', { name: 'tasks:logs.jumpToLatest' });
  }

  it('hides the button while following the latest logs', () => {
    renderJumpButton(false);
    expect(screen.queryByTestId('task-logs-jump-to-latest')).not.toBeInTheDocument();
  });

  it('shows a keyboard-focusable button outside the scroll viewport when away from the latest logs', () => {
    const { viewport } = renderJumpButton();
    const button = getJumpButton();
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(viewport.contains(button)).toBe(false);
    expect(button.tabIndex).toBe(0);

    button.focus();
    expect(button).toHaveFocus();
  });

  it('calls onJumpToLatest once when clicked', () => {
    const { onJumpToLatest } = renderJumpButton();
    fireEvent.click(getJumpButton());
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the viewport without scrolling when the focused button disappears', () => {
    const { viewport, endSentinel, resumeFollowing } = renderJumpButton();
    const focus = vi.spyOn(viewport, 'focus');
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    Object.assign(viewport, { scrollTo, scrollIntoView });
    Object.assign(endSentinel, { scrollIntoView });
    viewport.scrollTop = 200;

    const button = getJumpButton();
    button.focus();
    expect(button).toHaveFocus();
    resumeFollowing();

    expect(button).not.toBeInTheDocument();
    expect(viewport).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(200);
  });

  it('preserves focus elsewhere when the button disappears after losing focus', () => {
    const { viewport, resumeFollowing } = renderJumpButton();
    const focus = vi.spyOn(viewport, 'focus');
    const button = getJumpButton();
    const phaseButton = screen.getByRole('button', { name: /tasks:execution\.phases\.coding/ });
    button.focus();
    expect(button).toHaveFocus();
    phaseButton.focus();
    expect(phaseButton).toHaveFocus();

    resumeFollowing();

    expect(button).not.toBeInTheDocument();
    expect(phaseButton).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });
});
