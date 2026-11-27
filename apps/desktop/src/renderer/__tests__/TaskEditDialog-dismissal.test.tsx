/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PHASE_MODELS, DEFAULT_PHASE_THINKING, DEFAULT_PROJECT_SETTINGS } from '../../shared/constants';
import common from '../../shared/i18n/locales/en/common.json';
import settings from '../../shared/i18n/locales/en/settings.json';
import tasks from '../../shared/i18n/locales/en/tasks.json';
import type { ImageAttachment, IPCResult, Task } from '../../shared/types';
import { TaskEditDialog } from '../components/TaskEditDialog';
import { TooltipProvider } from '../components/ui/tooltip';
import { useProjectStore } from '../stores/project-store';
import { useSettingsStore } from '../stores/settings-store';
import { useTaskStore } from '../stores/task-store';

// The scenario tests chain several prompt round-trips through real Radix dialogs;
// give them headroom so they don't hit the 5s default on a loaded machine or CI runner.
vi.setConfig({ testTimeout: 20_000 });

const i18n = createInstance();
const projectPath = '/fixture/project';
const thumbnail = 'data:image/png;base64,dGh1bWJuYWls';
const image: ImageAttachment = {
  id: 'image-1', filename: 'reference.png', mimeType: 'image/png', size: 10, path: 'images/reference.png'
};
const task: Task = {
  id: 'task-1', projectId: 'project-1', specId: '001-task', status: 'backlog',
  title: 'Example task', description: 'Persisted description', subtasks: [], logs: [],
  createdAt: new Date(0), updatedAt: new Date(0)
};
const editedDescription = 'New unsaved description';
const updateTask = vi.fn<typeof window.electronAPI.updateTask>();
const loadImageThumbnail = vi.fn<typeof window.electronAPI.loadImageThumbnail>();

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { common, settings, tasks } }, interpolation: { escapeValue: false } });
});

beforeEach(() => {
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getInitialState().settings,
      selectedAgentProfile: 'auto',
      providerAgentConfig: { google: { selectedAgentProfile: 'quick' } },
      globalPriorityOrder: ['google-fixture']
    },
    providerAccounts: [{
      id: 'google-fixture', provider: 'google', name: 'Google', createdAt: 0, updatedAt: 0,
      authType: 'api-key', billingModel: 'pay-per-use', hasApiKey: true
    }]
  });
  useProjectStore.setState({ projects: [{
    id: task.projectId, path: projectPath, name: 'Fixture project', autoBuildPath: '.auto-claude',
    settings: DEFAULT_PROJECT_SETTINGS, createdAt: new Date(0), updatedAt: new Date(0)
  }] });
  updateTask.mockReset().mockResolvedValue({ success: false, error: 'Update was not configured' });
  loadImageThumbnail.mockReset().mockResolvedValue({ success: true, data: thumbnail });
  vi.stubGlobal('electronAPI', { updateTask, loadImageThumbnail });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useTaskStore.setState(useTaskStore.getInitialState());
  useProjectStore.setState(useProjectStore.getInitialState());
  useSettingsStore.setState(useSettingsStore.getInitialState());
});

function renderEditor(initialTask = task) {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const onSaved = vi.fn();
  useTaskStore.setState({ tasks: [initialTask], error: null });

  function Harness() {
    const [open, setOpen] = useState(true);
    const currentTask = useTaskStore(state => state.tasks[0]);
    return (
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>
          <button type="button" onClick={() => setOpen(true)}>Reopen editor</button>
          <TaskEditDialog task={currentTask} open={open} onSaved={onSaved} onOpenChange={nextOpen => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }} />
        </TooltipProvider>
      </I18nextProvider>
    );
  }

  render(<Harness />);
  return { onOpenChange, onSaved };
}

const editor = () => screen.getByRole('dialog', { name: 'Edit Task' });
const description = () => within(editor()).getByRole<HTMLTextAreaElement>('textbox', { name: /^Description/ });
const cancel = () => within(editor()).getByRole('button', { name: 'Cancel' });
const headerClose = () => within(editor()).getByRole('button', { name: 'Close' });
const save = () => within(editor()).getByRole('button', { name: 'Save Changes' });
const reopen = () => fireEvent.click(screen.getByRole('button', { name: 'Reopen editor' }));
const pressEscape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
const editDescription = (value = editedDescription) => fireEvent.change(description(), { target: { value } });
const showImages = () => fireEvent.click(within(editor()).getByRole('button', { name: /^Reference Images/ }));
const removeImage = () => within(editor()).getByRole('button', { name: 'Remove image reference.png' });
const taskWithImage = { ...task, metadata: { attachedImages: [image] } };

function click(button: HTMLElement) {
  // fireEvent.click doesn't focus the button as a real pointer click would.
  act(() => button.focus());
  fireEvent.click(button);
}

async function expectDiscardPrompt() {
  const prompt = screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  const keepEditing = within(prompt).getByRole('button', { name: 'Keep editing' });
  await waitFor(() => expect(document.activeElement).toBe(keepEditing));
  const discard = within(prompt).getByRole('button', { name: 'Discard edits' });
  // The data-loss action must render with destructive styling, not the primary variant.
  expect(discard.className).toContain('bg-destructive');
  expect(discard.className).not.toContain('bg-primary');
  return { keepEditing, discard };
}

function expectClosedWithoutPrompt() {
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  expect(screen.queryByRole('alertdialog', { hidden: true })).toBeNull();
}

describe.each(['Escape', 'Cancel'] as const)('%s dismissal', (method) => {
  function requestDismissal() {
    const origin = method === 'Cancel' ? cancel() : description();
    if (method === 'Cancel') click(origin);
    else {
      act(() => origin.focus());
      pressEscape();
    }
    return origin;
  }

  it('keeps description edits and restores focus after Keep editing or Escape', async () => {
    const { onOpenChange, onSaved } = renderEditor();
    const originalEditor = editor();
    editDescription();

    const origin = requestDismissal();
    const { keepEditing } = await expectDiscardPrompt();
    expect(originalEditor.isConnected).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    click(keepEditing);
    await waitFor(() => expect(document.activeElement).toBe(origin));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(description().value).toBe(editedDescription);

    requestDismissal();
    await expectDiscardPrompt();
    pressEscape();
    await waitFor(() => expect(document.activeElement).toBe(origin));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(editor()).toBe(originalEditor);
    expect(description().value).toBe(editedDescription);
    expect(onOpenChange).not.toHaveBeenCalled();

    requestDismissal();
    click((await expectDiscardPrompt()).discard);
    expectClosedWithoutPrompt();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(updateTask).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    reopen();
    expect(description().value).toBe(task.description);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('guards removing a persisted attachment without editing the text', async () => {
    const { onOpenChange, onSaved } = renderEditor(taskWithImage);
    showImages();
    await screen.findByRole('img', { name: image.filename });
    click(removeImage());
    expect(description().value).toBe(task.description);

    const originalEditor = editor();
    const origin = requestDismissal();
    const { keepEditing } = await expectDiscardPrompt();
    expect(originalEditor.isConnected).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    click(keepEditing);
    await waitFor(() => expect(document.activeElement).toBe(origin));
    expect(screen.queryByRole('button', { name: 'Remove image reference.png' })).toBeNull();
    expect(description().value).toBe(task.description);

    requestDismissal();
    click((await expectDiscardPrompt()).discard);
    expectClosedWithoutPrompt();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(updateTask).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    reopen();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    showImages();
    expect(await screen.findByRole('img', { name: image.filename })).toBeTruthy();
  });

  it('closes an unchanged task even though its model settings came from the active provider preset', () => {
    const { onOpenChange, onSaved } = renderEditor();
    expect(within(editor()).getByText('Quick Edits')).toBeTruthy();
    expect(within(editor()).getAllByText('Gemini 2.5 Flash-Lite')).toHaveLength(4);
    requestDismissal();
    expectClosedWithoutPrompt();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(updateTask).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

// jsdom doesn't hit-test the overlay. Target the actual Radix overlay and allow
// the dismissable layer's deferred document pointer listener to register first.
async function pointerDownOutsideEditor() {
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  const overlay = editor().previousElementSibling;
  expect(overlay?.getAttribute('data-state')).toBe('open');
  if (!overlay) throw new Error('Missing editor overlay');
  fireEvent.pointerDown(overlay, { pointerType: 'mouse', button: 0 });
}

it.each(['header Close', 'outside pointer'] as const)('guards dirty dismissal via %s', async (method) => {
  const { onOpenChange } = renderEditor();
  editDescription();
  const originalEditor = editor();
  if (method === 'header Close') click(headerClose());
  else await pointerDownOutsideEditor();
  await expectDiscardPrompt();
  expect(originalEditor.isConnected).toBe(true);
  expect(onOpenChange).not.toHaveBeenCalled();
});

it('closes without a prompt once the edit is undone (ignoring edge whitespace)', () => {
  const { onOpenChange } = renderEditor();
  editDescription();
  editDescription(`  ${task.description}  `);
  click(cancel());
  expectClosedWithoutPrompt();
  expect(onOpenChange.mock.calls).toEqual([[false]]);
});

it('does not count automatically hydrated thumbnails or expanding the image section as edits', async () => {
  const { onOpenChange } = renderEditor(taskWithImage);
  showImages();
  const preview = await screen.findByRole('img', { name: image.filename });
  expect(preview.getAttribute('src')).toBe(thumbnail);
  expect(loadImageThumbnail).toHaveBeenCalledWith(projectPath, task.specId, image.path);
  click(cancel());
  expectClosedWithoutPrompt();
  expect(onOpenChange.mock.calls).toEqual([[false]]);
});

it('keeps the edited values and original baseline during same-task store and settings changes', async () => {
  const refreshedTask = { ...task, description: 'Refreshed persisted description' };
  const { onOpenChange } = renderEditor();
  // An edited value that later matches the store must still be dirty for this session.
  editDescription(refreshedTask.description);
  act(() => {
    useTaskStore.setState({ tasks: [refreshedTask] });
    useSettingsStore.getState().updateSettings({ providerAgentConfig: { google: { selectedAgentProfile: 'balanced' } } });
  });
  expect(description().value).toBe(refreshedTask.description);
  expect(within(editor()).getByText('Quick Edits')).toBeTruthy();
  click(cancel());
  click((await expectDiscardPrompt()).keepEditing);
  await waitFor(() => expect(document.activeElement).toBe(cancel()));

  editDescription(task.description);
  click(cancel());
  expectClosedWithoutPrompt();
  expect(onOpenChange.mock.calls).toEqual([[false]]);
  reopen();
  expect(description().value).toBe(refreshedTask.description);
  expect(within(editor()).getByText('Balanced')).toBeTruthy();
});

it('blocks dismissal during Save, then closes and calls onSaved on success', async () => {
  let resolveUpdate!: (result: IPCResult<Task>) => void;
  updateTask.mockReturnValueOnce(new Promise(resolve => { resolveUpdate = resolve; }));
  const { onOpenChange, onSaved } = renderEditor();
  editDescription();
  click(save());
  expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, expect.objectContaining({ description: editedDescription }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving...' }).disabled).toBe(true);
  expect((cancel() as HTMLButtonElement).disabled).toBe(true);
  expect((headerClose() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(cancel());
  fireEvent.click(headerClose());
  pressEscape();
  await pointerDownOutsideEditor();
  expect(editor()).toBeTruthy();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();

  await act(async () => resolveUpdate({ success: true, data: { ...task, description: editedDescription } }));
  expectClosedWithoutPrompt();
  expect(onOpenChange.mock.calls).toEqual([[false]]);
  expect(onSaved).toHaveBeenCalledOnce();
  reopen();
  expect(description().value).toBe(editedDescription);
});

it('keeps the error and edited values visible and still guards dismissal after a failed Save', async () => {
  updateTask.mockResolvedValueOnce({ success: false, error: 'Fixture write failed' });
  const { onOpenChange, onSaved } = renderEditor();
  editDescription();
  click(save());
  const error = await screen.findByText('Failed to update task. Please try again.');
  expect(description().value).toBe(editedDescription);
  click(cancel());
  click((await expectDiscardPrompt()).keepEditing);
  await waitFor(() => expect(document.activeElement).toBe(cancel()));
  expect(error.isConnected).toBe(true);
  expect(description().value).toBe(editedDescription);
  expect(updateTask).toHaveBeenCalledOnce();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

it('closes an unchanged task with saved model metadata on Save without writing', () => {
  const { onOpenChange, onSaved } = renderEditor({ ...task, metadata: {
    model: 'sonnet', thinkingLevel: 'medium', phaseModels: DEFAULT_PHASE_MODELS, phaseThinking: DEFAULT_PHASE_THINKING
  } });
  click(save());
  expectClosedWithoutPrompt();
  expect(onOpenChange.mock.calls).toEqual([[false]]);
  expect(updateTask).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});
