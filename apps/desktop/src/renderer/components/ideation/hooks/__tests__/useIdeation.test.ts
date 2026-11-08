/**
 * Unit tests for useIdeation hook
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type {
  IdeationConfig,
  IdeationGenerationStatus,
  IdeationType
} from '../../../../../shared/types';
import { useIdeation } from '../useIdeation';

const mockGenerateIdeation = vi.hoisted(() => vi.fn());
const mockRefreshIdeation = vi.hoisted(() => vi.fn());
const mockAppendIdeation = vi.hoisted(() => vi.fn());
const mockLoadIdeation = vi.hoisted(() => vi.fn());
const mockSetupListeners = vi.hoisted(() => vi.fn(() => () => {}));
const mockAuthState = vi.hoisted(() => ({
  hasToken: true as boolean | null,
  isLoading: false,
}));
const mockToast = vi.hoisted(() => vi.fn());
const mockLoadTasks = vi.hoisted(() => vi.fn());
const mockSetIdeaTaskId = vi.hoisted(() => vi.fn());
const mockClearSelection = vi.hoisted(() => vi.fn());
const mockConvertIdeaToTask = vi.hoisted(() => vi.fn());
const mockStoreState = vi.hoisted(() => ({
  session: null as { ideas: Array<{ id: string; status: string }> } | null,
  selectedIds: new Set<string>()
}));

vi.mock('../useIdeationAuth', () => ({
  useIdeationAuth: () => mockAuthState
}));

vi.mock('../../../../hooks/use-toast', () => ({
  toast: mockToast
}));

vi.mock('../../../../stores/task-store', () => ({
  loadTasks: mockLoadTasks
}));

vi.mock('../../../../stores/ideation-store', () => {
  const state = {
    session: null,
    generationStatus: {} as IdeationGenerationStatus,
    isGenerating: false,
    config: {
      enabledTypes: [],
      includeRoadmapContext: false,
      includeKanbanContext: false,
      maxIdeasPerType: 3
    } as IdeationConfig,
    logs: [],
    typeStates: {},
    selectedIds: new Set()
  };

  const useIdeationStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    {
      getState: () => ({
        session: mockStoreState.session,
        selectedIds: mockStoreState.selectedIds,
        setIdeaTaskId: mockSetIdeaTaskId,
        clearSelection: mockClearSelection
      })
    }
  );

  return {
    useIdeationStore,
    loadIdeation: mockLoadIdeation,
    generateIdeation: mockGenerateIdeation,
    refreshIdeation: mockRefreshIdeation,
    stopIdeation: vi.fn(),
    appendIdeation: mockAppendIdeation,
    dismissAllIdeasForProject: vi.fn(),
    deleteMultipleIdeasForProject: vi.fn(),
    getIdeasByType: vi.fn(() => []),
    getActiveIdeas: vi.fn(() => []),
    getArchivedIdeas: vi.fn(() => []),
    getIdeationSummary: vi.fn(() => ({ totalIdeas: 0, byType: {}, byStatus: {} })),
    setupIdeationListeners: mockSetupListeners
  };
});

describe('useIdeation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.session = null;
    mockStoreState.selectedIds = new Set<string>();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      convertIdeaToTask: mockConvertIdeaToTask
    } as never;
  });

  it('should set up and clean up listeners on unmount', () => {
    const cleanupFn = vi.fn();
    mockSetupListeners.mockReturnValueOnce(cleanupFn);

    const { unmount } = renderHook(() => useIdeation('project-1'));

    expect(mockLoadIdeation).toHaveBeenCalledWith('project-1');

    unmount();

    expect(cleanupFn).toHaveBeenCalled();
  });

  it('should show a toast and not generate when no provider is configured', () => {
    mockAuthState.hasToken = false;
    mockAuthState.isLoading = false;

    const { result } = renderHook(() => useIdeation('project-1'));

    act(() => {
      result.current.handleGenerate();
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' })
    );
    expect(mockGenerateIdeation).not.toHaveBeenCalled();
  });

  it('should generate when provider is configured', () => {
    mockAuthState.hasToken = true;
    mockAuthState.isLoading = false;

    const { result } = renderHook(() => useIdeation('project-1'));

    act(() => {
      result.current.handleGenerate();
    });

    expect(mockToast).not.toHaveBeenCalled();
    expect(mockGenerateIdeation).toHaveBeenCalledWith('project-1');
  });

  it('should show a toast and not refresh when no provider is configured', () => {
    mockAuthState.hasToken = false;
    mockAuthState.isLoading = false;

    const { result } = renderHook(() => useIdeation('project-1'));

    act(() => {
      result.current.handleRefresh();
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' })
    );
    expect(mockRefreshIdeation).not.toHaveBeenCalled();
  });

  it('should refresh when provider is configured', () => {
    mockAuthState.hasToken = true;
    mockAuthState.isLoading = false;

    const { result } = renderHook(() => useIdeation('project-1'));

    act(() => {
      result.current.handleRefresh();
    });

    expect(mockToast).not.toHaveBeenCalled();
    expect(mockRefreshIdeation).toHaveBeenCalledWith('project-1');
  });

  it('should show a toast and not append ideas when no provider is configured', () => {
    mockAuthState.hasToken = false;
    mockAuthState.isLoading = false;

    const { result } = renderHook(() => useIdeation('project-1'));
    const typesToAdd = ['code_improvements'] as IdeationType[];

    act(() => {
      result.current.setTypesToAdd(typesToAdd);
    });

    act(() => {
      result.current.handleAddMoreIdeas();
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' })
    );
    expect(mockAppendIdeation).not.toHaveBeenCalled();
  });

  it('should append ideas when provider is configured', () => {
    mockAuthState.hasToken = true;
    mockAuthState.isLoading = false;

    const { result } = renderHook(() => useIdeation('project-1'));
    const typesToAdd = ['code_improvements'] as IdeationType[];

    act(() => {
      result.current.setTypesToAdd(typesToAdd);
    });

    act(() => {
      result.current.handleAddMoreIdeas();
    });

    expect(mockToast).not.toHaveBeenCalled();
    expect(mockAppendIdeation).toHaveBeenCalledWith('project-1', typesToAdd);
    expect(result.current.typesToAdd).toHaveLength(0);
  });

  it('should not expose showEnvConfigModal or handleEnvConfigured in return value', () => {
    const { result } = renderHook(() => useIdeation('project-1'));

    expect('showEnvConfigModal' in result.current).toBe(false);
    expect('handleEnvConfigured' in result.current).toBe(false);
    expect('setShowEnvConfigModal' in result.current).toBe(false);
  });

  describe('handleConvertSelected', () => {
    const setIdeas = (statuses: Record<string, string>, selected: string[]) => {
      mockStoreState.session = {
        ideas: Object.entries(statuses).map(([id, status]) => ({ id, status }))
      };
      mockStoreState.selectedIds = new Set(selected);
    };
    const ok = (id: string) => ({ success: true, data: { id: `task-${id}` } });

    it('converts only eligible selected ideas', async () => {
      setIdeas(
        { draft: 'draft', gone: 'dismissed', old: 'archived', done: 'converted' },
        ['draft', 'gone', 'old', 'done']
      );
      mockConvertIdeaToTask.mockResolvedValue(ok('draft'));
      const { result } = renderHook(() => useIdeation('project-1'));

      await act(async () => {
        await result.current.handleConvertSelected();
      });

      expect(mockConvertIdeaToTask).toHaveBeenCalledTimes(1);
      expect(mockConvertIdeaToTask).toHaveBeenCalledWith('project-1', 'draft');
    });

    it('converts sequentially', async () => {
      setIdeas({ a: 'draft', b: 'draft' }, ['a', 'b']);
      let resolveFirst: (v: unknown) => void = () => {};
      mockConvertIdeaToTask
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
        .mockResolvedValueOnce(ok('b'));
      const { result } = renderHook(() => useIdeation('project-1'));

      let promise: Promise<void> = Promise.resolve();
      act(() => {
        promise = result.current.handleConvertSelected();
      });
      expect(mockConvertIdeaToTask).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirst(ok('a'));
        await promise;
      });
      expect(mockConvertIdeaToTask).toHaveBeenCalledTimes(2);
      expect(mockConvertIdeaToTask).toHaveBeenNthCalledWith(2, 'project-1', 'b');
    });

    it('reloads tasks, clears selection and shows one success toast', async () => {
      setIdeas({ a: 'draft', b: 'draft', c: 'draft' }, ['a', 'b', 'c']);
      mockConvertIdeaToTask.mockImplementation((_p: string, id: string) => Promise.resolve(ok(id)));
      const { result } = renderHook(() => useIdeation('project-1'));

      await act(async () => {
        await result.current.handleConvertSelected();
      });

      expect(mockLoadTasks).toHaveBeenCalledTimes(1);
      expect(mockClearSelection).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast.mock.calls[0][0].variant).not.toBe('destructive');
    });

    it('reports a partial failure with a destructive toast', async () => {
      setIdeas({ a: 'draft', b: 'draft' }, ['a', 'b']);
      mockConvertIdeaToTask
        .mockResolvedValueOnce(ok('a'))
        .mockResolvedValueOnce({ success: false, error: 'boom' });
      const { result } = renderHook(() => useIdeation('project-1'));

      await act(async () => {
        await result.current.handleConvertSelected();
      });

      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          description: 'ideation.bulkConvertPartial'
        })
      );
      expect(mockLoadTasks).toHaveBeenCalledTimes(1);
      expect(mockClearSelection).toHaveBeenCalledTimes(1);
    });

    it('does not reload tasks when all conversions fail', async () => {
      setIdeas({ a: 'draft', b: 'draft' }, ['a', 'b']);
      mockConvertIdeaToTask.mockResolvedValue({ success: false, error: 'nope' });
      const { result } = renderHook(() => useIdeation('project-1'));

      await act(async () => {
        await result.current.handleConvertSelected();
      });

      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          description: 'ideation.bulkConvertFailed'
        })
      );
      expect(mockLoadTasks).not.toHaveBeenCalled();
    });

    it('counts a thrown error as a failure and continues', async () => {
      setIdeas({ a: 'draft', b: 'draft' }, ['a', 'b']);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockConvertIdeaToTask
        .mockRejectedValueOnce(new Error('ipc down'))
        .mockResolvedValueOnce(ok('b'));
      const { result } = renderHook(() => useIdeation('project-1'));

      await act(async () => {
        await result.current.handleConvertSelected();
      });
      errorSpy.mockRestore();

      expect(mockConvertIdeaToTask).toHaveBeenCalledTimes(2);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'destructive',
          description: 'ideation.bulkConvertPartial'
        })
      );
    });

    it('shows a toast and keeps the selection when nothing is eligible', async () => {
      setIdeas({ gone: 'dismissed', done: 'converted' }, ['gone', 'done']);
      const { result } = renderHook(() => useIdeation('project-1'));

      await act(async () => {
        await result.current.handleConvertSelected();
      });

      expect(mockConvertIdeaToTask).not.toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast.mock.calls[0][0].variant).not.toBe('destructive');
      expect(mockClearSelection).not.toHaveBeenCalled();
    });

    it('does nothing when the selection is empty', async () => {
      setIdeas({ a: 'draft' }, []);
      const { result } = renderHook(() => useIdeation('project-1'));

      await act(async () => {
        await result.current.handleConvertSelected();
      });

      expect(mockConvertIdeaToTask).not.toHaveBeenCalled();
      expect(mockToast).not.toHaveBeenCalled();
      expect(mockClearSelection).not.toHaveBeenCalled();
    });
  });
});
