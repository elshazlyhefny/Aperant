/**
 * @vitest-environment jsdom
 *
 * zeenha fork: file rows in the explorer can be added as a reference from the
 * keyboard or by double-click, and the drawer forwards onFileActivate.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const fileTreeProps: Array<Record<string, unknown>> = [];
vi.mock('../FileTree', () => ({
  FileTree: (props: Record<string, unknown>) => {
    fileTreeProps.push(props);
    return <div data-testid="file-tree" />;
  },
}));

vi.mock('../../stores/file-explorer-store', () => ({
  useFileExplorerStore: () => ({ clearCache: vi.fn(), loadDirectory: vi.fn() }),
}));

import { FileTreeItem } from '../FileTreeItem';
import { TaskFileExplorerDrawer } from '../TaskFileExplorerDrawer';
import type { FileNode } from '../../../shared/types';

const fileNode = { path: '/p/a.ts', name: 'a.ts', isDirectory: false } as FileNode;
const dirNode = { path: '/p/src', name: 'src', isDirectory: true } as FileNode;

function renderItem(node: FileNode, opts: { activate?: boolean } = {}) {
  const onToggle = vi.fn();
  const onFileActivate = vi.fn();
  const utils = render(
    <FileTreeItem
      node={node}
      depth={0}
      isExpanded={false}
      isLoading={false}
      onToggle={onToggle}
      onFileActivate={opts.activate === false ? undefined : onFileActivate}
    />
  );
  return { ...utils, onToggle, onFileActivate, row: utils.container.firstElementChild as HTMLElement };
}

afterEach(() => {
  cleanup();
  fileTreeProps.length = 0;
});

describe('FileTreeItem file activation', () => {
  it('exposes an activatable file row as a button', () => {
    const { row } = renderItem(fileNode);
    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveAttribute('aria-label', 'accessibility.addFileReference');
  });

  it.each([
    ['Enter', (row: HTMLElement) => fireEvent.keyDown(row, { key: 'Enter' })],
    ['Space', (row: HTMLElement) => fireEvent.keyDown(row, { key: ' ' })],
    ['double-click', (row: HTMLElement) => fireEvent.doubleClick(row)],
  ])('%s activates the file once', (_name, act) => {
    const { row, onFileActivate, onToggle } = renderItem(fileNode);
    act(row);
    expect(onFileActivate).toHaveBeenCalledTimes(1);
    expect(onFileActivate).toHaveBeenCalledWith({
      type: 'file-reference',
      path: '/p/a.ts',
      name: 'a.ts',
      isDirectory: false,
    });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('single click does not activate', () => {
    const { row, onFileActivate } = renderItem(fileNode);
    fireEvent.click(row);
    expect(onFileActivate).not.toHaveBeenCalled();
  });

  it('without onFileActivate the file row is not interactive', () => {
    const { row } = renderItem(fileNode, { activate: false });
    expect(row).not.toHaveAttribute('role');
    expect(row).not.toHaveAttribute('tabindex');
    expect(() => fireEvent.keyDown(row, { key: 'Enter' })).not.toThrow();
  });

  it('directory rows toggle on Enter and double-click, never activate', () => {
    const { row, onToggle, onFileActivate } = renderItem(dirNode);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(row);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onFileActivate).not.toHaveBeenCalled();
  });

  it('stays draggable', () => {
    const { row } = renderItem(fileNode);
    expect(row).toHaveAttribute('draggable', 'true');
  });
});

describe('TaskFileExplorerDrawer', () => {
  it('forwards onFileActivate and renders labelled controls', () => {
    const onFileActivate = vi.fn();
    render(
      <TaskFileExplorerDrawer
        isOpen
        onClose={vi.fn()}
        projectPath="/p"
        onFileActivate={onFileActivate}
      />
    );
    expect(fileTreeProps.at(-1)?.onFileActivate).toBe(onFileActivate);
    expect(screen.getByText('tasks:fileExplorer.title')).toBeInTheDocument();
    expect(screen.getByText('tasks:fileExplorer.hint')).toBeInTheDocument();
    expect(screen.getByLabelText('common:buttons.refresh')).toBeInTheDocument();
    expect(screen.getByLabelText('common:buttons.close')).toBeInTheDocument();
  });
});
