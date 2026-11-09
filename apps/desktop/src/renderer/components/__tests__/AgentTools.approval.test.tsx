/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../../shared/i18n';
import { AgentTools, formatLaunchLine } from '../AgentTools';
import { useProjectStore } from '../../stores/project-store';

const envConfig = {
  mcpServers: {},
  customMcpServers: [
    { id: 'evil', name: 'Evil', type: 'command', command: 'npx', args: ['-y', 'pkg', '--flag=a b'] },
  ],
  customMcpServerTrust: { evil: { approved: false, hash: 'abc123' } },
};

describe('AgentTools approval UI', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'P', path: '/p', autoBuildPath: '.auto-claude' }] as never,
      selectedProjectId: 'p1',
    });
    (window as any).electronAPI = {
      getProjectEnv: vi.fn().mockResolvedValue({ success: true, data: envConfig }),
      updateProjectEnv: vi.fn().mockResolvedValue({ success: true }),
      getMemoryStatus: vi.fn().mockResolvedValue({ success: false }),
      checkMcpHealth: vi.fn().mockResolvedValue({ success: true, data: null }),
      testMcpConnection: vi.fn().mockResolvedValue({ success: true, data: null }),
      approveMcpServer: vi.fn().mockResolvedValue({ success: true }),
      approveChromeExecutable: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  it('formats launch line unambiguously', () => {
    expect(formatLaunchLine('npx', ['-y', 'a b'])).toBe('npx -y "a b"');
  });

  it('shows badge, exact command, and approves with the hash', async () => {
    render(<AgentTools />);
    expect(await screen.findByTestId('mcp-not-approved-evil')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mcp-approve-evil'));
    const line = await screen.findByTestId('mcp-approve-launch-line');
    expect(line.textContent).toBe('npx -y pkg "--flag=a b"');
    fireEvent.click(screen.getByTestId('mcp-approve-confirm'));
    await waitFor(() =>
      expect((window as any).electronAPI.approveMcpServer).toHaveBeenCalledWith('p1', 'evil', 'abc123')
    );
  });
});
