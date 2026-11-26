/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskCreationWizard } from '../components/TaskCreationWizard';
import { TaskEditDialog } from '../components/TaskEditDialog';
import { TooltipProvider } from '../components/ui/tooltip';
import { taskAgentPreset } from '../../shared/utils/task-agent';
import { useSettingsStore } from '../stores/settings-store';
import type { Task, TaskMetadata } from '../../shared/types';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, args?: { phase?: string }) => args?.phase ?? key, i18n: {language: 'en'} }),
}));
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it('restores a customized draft and replaces all four routes when an existing task switches to Codex', async () => {
  const original = taskAgentPreset('both', {});
  useSettingsStore.getState().updateSettings({ defaultTaskAgent: original });
  const task: Task = { id: 't', projectId: 'p', specId: '001-test', status: 'backlog',
    title: 'Task', description: 'Change the title', subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date() };
  const create = vi.fn(async (_p, _title, _description, metadata: TaskMetadata) => ({success: true, data: {...task, metadata}}));
  const update = vi.fn(async () => ({ success: true, data: task }));
  vi.stubGlobal('electronAPI', { createTask: create, updateTask: update });
  const wizard = <TooltipProvider><TaskCreationWizard projectId="p" open onOpenChange={() => {}} /></TooltipProvider>;
  const first = render(wizard);
  const agent = () => screen.getByLabelText<HTMLSelectElement>('taskAgent.label');
  expect(agent().value).toBe('both');
  fireEvent.click(screen.getByText('taskAgent.customize'));
  fireEvent.change(screen.getByLabelText('agentProfile.phases.planning.label'), {target: {value: 'openai'}});
  fireEvent.change(screen.getByPlaceholderText('tasks:wizard.descriptionPlaceholder'), { target: { value: task.description } });
  fireEvent.click(screen.getByText('common:buttons.cancel'));
  first.unmount();
  useSettingsStore.getState().updateSettings({ defaultTaskAgent: taskAgentPreset('claude', {}) });
  const second = render(wizard);
  expect(agent().value).toBe('both');
  fireEvent.click(screen.getByText('tasks:wizard.createTask'));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  const metadata = create.mock.calls[0][3];
  expect(metadata.phaseProviders).toEqual({spec: 'anthropic', planning: 'openai', coding: 'openai', qa: 'anthropic'});
  second.unmount();
  render(<TooltipProvider><TaskEditDialog open task={{...task, metadata}} onOpenChange={() => {}} /></TooltipProvider>);
  expect(agent().value).toBe('both');
  fireEvent.change(agent(), { target: { value: 'codex' } });
  fireEvent.click(screen.getByText('tasks:edit.saveChanges'));
  await waitFor(() => expect(update).toHaveBeenCalledWith('t', expect.objectContaining({
    metadata: expect.objectContaining({ taskAgentMode: 'codex', phaseProviders: {
      spec: 'openai', planning: 'openai', coding: 'openai', qa: 'openai',
    } }),
  })));
}, 20000);
