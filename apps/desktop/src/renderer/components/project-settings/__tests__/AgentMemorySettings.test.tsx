/**
 * @vitest-environment jsdom
 */
/**
 * zeenha fork: the Memory page shows the built-in agent memory and its
 * app-wide switch, not upstream's Graphiti toggle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18n from '../../../../shared/i18n';
import { AgentMemorySettings, agentMemoryState, embeddingLabel } from '../AgentMemorySettings';
import type { MemorySystemStatus } from '../../../../shared/types';

const running: MemorySystemStatus = {
  enabled: true,
  available: true,
  embeddingProvider: 'ollama-0.6b',
  dbPath: '/home/user/.config/aperant/memory.db',
  projectMemoryCount: 12,
};

function mockStatus(result: unknown) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getMemoryStatus: vi.fn().mockResolvedValue(result),
  };
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('agentMemoryState', () => {
  it('is off whenever the app switch is off, whatever the database says', () => {
    expect(agentMemoryState(false, running)).toBe('off');
  });

  it('treats an absent switch as on', () => {
    expect(agentMemoryState(undefined, running)).toBe('on');
  });

  it('separates a check in flight from a failed one', () => {
    expect(agentMemoryState(true, undefined)).toBe('checking');
    expect(agentMemoryState(true, null)).toBe('unavailable');
    expect(agentMemoryState(true, { enabled: false, available: false })).toBe('unavailable');
  });
});

describe('embeddingLabel', () => {
  it('names the qwen3 model the Ollama tier stands for', () => {
    expect(embeddingLabel('ollama-0.6b')).toEqual({
      key: 'projectSections.memory.agent.embedding.ollama',
      params: { model: 'qwen3-embedding:0.6b' },
    });
    expect(embeddingLabel('ollama-8b').params).toEqual({ model: 'qwen3-embedding:8b' });
  });

  it('names hosted providers and the keyword fallback', () => {
    expect(embeddingLabel('azure').params).toEqual({ name: 'Azure OpenAI' });
    expect(embeddingLabel('none').key).toBe('projectSections.memory.agent.embedding.none');
  });

  it('passes an unknown provider through as is', () => {
    expect(embeddingLabel('onnx')).toEqual({
      key: 'projectSections.memory.agent.embedding.unknown',
      params: { provider: 'onnx' },
    });
  });
});

describe('AgentMemorySettings', () => {
  it('shows what is running for this project', async () => {
    mockStatus({ success: true, data: running });
    render(<AgentMemorySettings projectId="p1" memoryEnabled={undefined} onMemoryEnabledChange={vi.fn()} />);

    expect(await screen.findByText('12 memories stored')).toBeInTheDocument();
    expect(screen.getByText('Ollama, qwen3-embedding:0.6b (local)')).toBeInTheDocument();
    expect(screen.getByText('/home/user/.config/aperant/memory.db')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(window.electronAPI.getMemoryStatus).toHaveBeenCalledWith('p1');
    expect(screen.queryByText(/LadybugDB|Graphiti|JSON files/)).not.toBeInTheDocument();
  });

  it('uses the singular for one memory', async () => {
    mockStatus({ success: true, data: { ...running, projectMemoryCount: 1 } });
    render(<AgentMemorySettings projectId="p1" memoryEnabled={true} onMemoryEnabledChange={vi.fn()} />);
    expect(await screen.findByText('1 memory stored')).toBeInTheDocument();
  });

  it('hands the switch to the app settings draft', async () => {
    mockStatus({ success: true, data: running });
    const onChange = vi.fn();
    render(<AgentMemorySettings projectId="p1" memoryEnabled={undefined} onMemoryEnabledChange={onChange} />);
    await screen.findByText('12 memories stored');

    const toggle = screen.getByRole('switch');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('shows Off with the switch unchecked when the app switch is off', async () => {
    mockStatus({ success: true, data: running });
    render(<AgentMemorySettings projectId="p1" memoryEnabled={false} onMemoryEnabledChange={vi.fn()} />);
    await screen.findByText('12 memories stored');
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('shows the reason when the database could not start', async () => {
    mockStatus({ success: true, data: { enabled: false, available: false, reason: 'Memory service initialization failed' } });
    render(<AgentMemorySettings projectId="p1" memoryEnabled={undefined} onMemoryEnabledChange={vi.fn()} />);
    expect(await screen.findByText('Memory service initialization failed')).toBeInTheDocument();
    expect(screen.getByText('Not running')).toBeInTheDocument();
    expect(screen.queryByText(/memories stored/)).not.toBeInTheDocument();
  });

  it('warns when search falls back to keywords', async () => {
    mockStatus({ success: true, data: { ...running, embeddingProvider: 'none' } });
    render(<AgentMemorySettings projectId="p1" memoryEnabled={undefined} onMemoryEnabledChange={vi.fn()} />);
    expect(await screen.findByText(/memory search matches keywords only/)).toBeInTheDocument();
  });

  it('is translated into French, plural included', async () => {
    await i18n.changeLanguage('fr');
    mockStatus({ success: true, data: running });
    render(<AgentMemorySettings projectId="p1" memoryEnabled={undefined} onMemoryEnabledChange={vi.fn()} />);
    expect(await screen.findByText('12 mémoires enregistrées')).toBeInTheDocument();
    expect(screen.getByText('Activée')).toBeInTheDocument();
  });
});
