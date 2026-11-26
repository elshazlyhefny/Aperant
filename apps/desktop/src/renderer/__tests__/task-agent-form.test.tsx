/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskCreationWizard } from '../components/TaskCreationWizard';
import { TaskEditDialog } from '../components/TaskEditDialog';
import { TooltipProvider } from '../components/ui/tooltip';
import { taskAgentPreset } from '../../shared/utils/task-agent';
import { useSettingsStore } from '../stores/settings-store';
import { DEFAULT_PHASE_MODELS, DEFAULT_PHASE_THINKING } from '../../shared/constants';
import type { Task, TaskMetadata } from '../../shared/types';
import type { PhaseModelConfig, PhaseThinkingConfig } from '../../shared/types/settings';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, args?: { phase?: string }) => args?.phase ?? key, i18n: {language: 'en'} }),
}));
// The real selector is a Radix Select; this stand-in picks a new coding model or coding
// thinking level in one click.
vi.mock('../components/AgentProfileSelector', () => ({
  AgentProfileSelector: ({ phaseModels, phaseThinking, onPhaseModelsChange, onPhaseThinkingChange }: {
    phaseModels?: PhaseModelConfig; onPhaseModelsChange?: (models: PhaseModelConfig) => void;
    phaseThinking?: PhaseThinkingConfig; onPhaseThinkingChange?: (thinking: PhaseThinkingConfig) => void;
  }) => (
    <>
      <button type="button" onClick={() => phaseModels && onPhaseModelsChange?.({ ...phaseModels, coding: 'gpt-5.2' })}>
        pick-model
      </button>
      <button type="button" onClick={() => phaseThinking && onPhaseThinkingChange?.({ ...phaseThinking, coding: 'high' })}>
        pick-thinking
      </button>
    </>
  ),
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

// zeenha fork: a profile-based task saves the provider its models came from.
const editProfileTask = async (pick?: 'pick-model' | 'pick-thinking') => {
  useSettingsStore.setState({ providerAccounts: [{ id: 'oa', provider: 'openai', name: 'OpenAI', createdAt: 0, updatedAt: 0,
    authType: 'api-key', billingModel: 'pay-per-use', apiKey: 'fixture' }] });
  const task: Task = { id: 't', projectId: 'p', specId: '001-test', status: 'backlog', title: 'Task',
    description: 'Change the title', subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date(),
    metadata: { provider: 'anthropic', model: 'sonnet', thinkingLevel: 'medium',
      phaseModels: DEFAULT_PHASE_MODELS, phaseThinking: DEFAULT_PHASE_THINKING } };
  const update = vi.fn(async (_id: string, _updates: { metadata?: TaskMetadata }) => ({ success: true, data: task }));
  vi.stubGlobal('electronAPI', { updateTask: update });
  render(<TooltipProvider><TaskEditDialog open task={task} onOpenChange={() => {}} /></TooltipProvider>);
  expect(screen.getByLabelText<HTMLSelectElement>('taskAgent.label').value).toBe('profile');
  fireEvent.change(screen.getByDisplayValue('Change the title'), { target: { value: 'Change the heading' } });
  if (pick) fireEvent.click(screen.getByText(pick));
  fireEvent.click(screen.getByText('tasks:edit.saveChanges'));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  useSettingsStore.setState({ providerAccounts: [] });
  return update.mock.calls[0][1].metadata;
};

it('keeps the saved provider when only the title of a profile-based task changes', async () => {
  const metadata = await editProfileTask();
  expect(metadata?.provider).toBe('anthropic');
  expect(metadata?.phaseModels).toEqual(DEFAULT_PHASE_MODELS);
}, 20000);

it('saves the active provider when the models of a profile-based task are changed', async () => {
  const metadata = await editProfileTask('pick-model');
  expect(metadata?.provider).toBe('openai');
  expect(metadata?.phaseModels?.coding).toBe('gpt-5.2');
}, 20000);

it('keeps the saved provider when only the thinking of a profile-based task changes', async () => {
  const metadata = await editProfileTask('pick-thinking');
  expect(metadata?.provider).toBe('anthropic');
  expect(metadata?.phaseModels).toEqual(DEFAULT_PHASE_MODELS);
  expect(metadata?.phaseThinking?.coding).toBe('high');
}, 20000);
