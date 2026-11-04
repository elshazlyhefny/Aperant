/**
 * @vitest-environment jsdom
 */
/**
 * zeenha fork: the Memory page's Ollama panel — state, resources, disk, and
 * the Start button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18n from '../../../../shared/i18n';
import { OllamaContainerPanel, formatBytes, ollamaBadge } from '../OllamaContainerPanel';
import type { OllamaContainerStatus } from '../../../../shared/types';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const running: OllamaContainerStatus = {
  docker: 'ok',
  container: 'running',
  state: 'running',
  startedAt: '2026-11-04T08:21:14Z',
  cpuPercent: 1.5,
  cpuLimit: 4,
  memoryBytes: 146 * MiB,
  memoryLimitBytes: 3 * GiB,
  apiReachable: true,
  imageBytes: 8.7 * GiB,
  models: [{ name: 'qwen3-embedding:0.6b', bytes: 610 * MiB }],
  loadedModels: [{ name: 'qwen3-embedding:0.6b', bytes: 700 * MiB }],
  diskFreeBytes: 52 * GiB,
  diskTotalBytes: 193 * GiB,
};

const stopped: OllamaContainerStatus = {
  docker: 'ok',
  container: 'stopped',
  state: 'exited',
  finishedAt: '2026-10-25T02:10:55Z',
  exitCode: 0,
  apiReachable: false,
  imageBytes: 8.7 * GiB,
  diskFreeBytes: 52 * GiB,
  diskTotalBytes: 193 * GiB,
};

function mockApi(status: unknown, start: unknown = { success: true, data: running }) {
  const api = {
    getOllamaContainerStatus: vi.fn().mockResolvedValue({ success: true, data: status }),
    startOllamaContainer: vi.fn().mockResolvedValue(start),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('formatBytes', () => {
  it('uses binary units like Docker and df -h', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(146 * MiB)).toBe('146 MiB');
    expect(formatBytes(3 * GiB)).toBe('3.0 GiB');
    expect(formatBytes(undefined)).toBe('?');
  });
});

describe('ollamaBadge', () => {
  it('names each state', () => {
    expect(ollamaBadge(undefined)).toBe('checking');
    expect(ollamaBadge(null)).toBe('unavailable');
    expect(ollamaBadge({ docker: 'unavailable', container: 'unknown' })).toBe('unavailable');
    expect(ollamaBadge(running)).toBe('running');
    expect(ollamaBadge(stopped)).toBe('stopped');
    expect(ollamaBadge({ docker: 'ok', container: 'missing' })).toBe('missing');
  });
});

describe('OllamaContainerPanel', () => {
  it('shows CPU, memory, models and disk for a running container', async () => {
    mockApi(running);
    render(<OllamaContainerPanel onStarted={vi.fn()} />);

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('1.5% · limit 4 cores')).toBeInTheDocument();
    expect(screen.getByText('146 MiB of 3.0 GiB')).toBeInTheDocument();
    expect(screen.getByText('qwen3-embedding:0.6b')).toBeInTheDocument();
    expect(screen.getByText(/loaded in memory/)).toBeInTheDocument();
    expect(screen.getByText("models 610 MiB · image 8.7 GiB · 52.0 GiB free of 193 GiB on Docker's disk")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start/ })).not.toBeInTheDocument();
  });

  it('offers Start for a stopped container and reports the start', async () => {
    const api = mockApi(stopped);
    const onStarted = vi.fn();
    render(<OllamaContainerPanel onStarted={onStarted} />);

    expect(await screen.findByText(/Stopped \(exited\) since .*exit code 0/)).toBeInTheDocument();
    expect(screen.queryByText(/limit 4 cores/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));

    await screen.findByText('Running');
    expect(api.startOllamaContainer).toHaveBeenCalledWith();
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('shows Docker\'s reason when the start fails', async () => {
    mockApi(stopped, { success: false, error: 'Error response from daemon: boom' });
    const onStarted = vi.fn();
    render(<OllamaContainerPanel onStarted={onStarted} />);

    fireEvent.click(await screen.findByRole('button', { name: /Start/ }));
    expect(await screen.findByText('Error response from daemon: boom')).toBeInTheDocument();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('explains a missing container and an unreachable Docker', async () => {
    mockApi({ docker: 'ok', container: 'missing' });
    const { unmount } = render(<OllamaContainerPanel onStarted={vi.fn()} />);
    expect(await screen.findByText(/no Docker container named "ollama"/)).toBeInTheDocument();
    unmount();

    mockApi({ docker: 'unavailable', container: 'unknown', detail: 'Docker CLI not found on PATH' });
    render(<OllamaContainerPanel onStarted={vi.fn()} />);
    expect(await screen.findByText('Docker could not be asked: Docker CLI not found on PATH')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start/ })).not.toBeInTheDocument();
  });

  it('warns when the container runs but its API does not answer', async () => {
    mockApi({ ...running, apiReachable: false, models: undefined });
    render(<OllamaContainerPanel onStarted={vi.fn()} />);
    expect(await screen.findByText(/the Ollama API is not answering yet/)).toBeInTheDocument();
  });

  it('refreshes on demand', async () => {
    const api = mockApi(running);
    render(<OllamaContainerPanel onStarted={vi.fn()} />);
    await screen.findByText('Running');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.getOllamaContainerStatus).toHaveBeenCalledTimes(2));
  });

  it('is translated into French', async () => {
    await i18n.changeLanguage('fr');
    mockApi(stopped);
    render(<OllamaContainerPanel onStarted={vi.fn()} />);
    expect(await screen.findByText('Arrêté')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Démarrer/ })).toBeInTheDocument();
  });
});
