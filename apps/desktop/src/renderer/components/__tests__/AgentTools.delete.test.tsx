/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../../shared/i18n';
import { AgentTools } from '../AgentTools';
import { Toaster } from '../ui/toaster';
import { useProjectStore } from '../../stores/project-store';

const server = { id: 'srv1', name: 'Srv', type: 'command', command: 'npx' };
const trusted = { srv1: { approved: true, hash: 'h1' } };

function setEnv(overrides: Record<string, unknown>) {
  return {
    mcpServers: {},
    customMcpServers: [server],
    customMcpServerTrust: trusted,
    agentMcpOverrides: overrides,
  };
}

function mockApi(env: unknown, updateProjectEnv = vi.fn().mockResolvedValue({ success: true })) {
  (window as any).electronAPI = {
    getProjectEnv: vi.fn().mockResolvedValue({ success: true, data: env }),
    updateProjectEnv,
    getMemoryStatus: vi.fn().mockResolvedValue({ success: false }),
    checkMcpHealth: vi.fn().mockResolvedValue({ success: true, data: null }),
    testMcpConnection: vi.fn().mockResolvedValue({ success: true, data: null }),
  };
  return updateProjectEnv;
}

function renderUi() {
  return render(
    <>
      <AgentTools />
      <Toaster />
    </>
  );
}

vi.setConfig({ testTimeout: 30000 });

describe('AgentTools custom MCP delete confirmation', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'P', path: '/p', autoBuildPath: '.auto-claude' }] as never,
      selectedProjectId: 'p1',
    });
  });

  it('opens a dialog naming the server and agent without deleting', async () => {
    const update = mockApi(setEnv({ coder: { add: ['srv1'] } }));
    renderUi();
    fireEvent.click(await screen.findByTestId('mcp-delete-srv1'));
    const dialog = await screen.findByTestId('mcp-delete-dialog');
    expect(dialog.textContent).toContain('Srv');
    expect(dialog.textContent).toContain('Coder');
    expect(update).not.toHaveBeenCalled();
  });

  it('cancel closes the dialog without deleting', async () => {
    const update = mockApi(setEnv({ coder: { add: ['srv1'] } }));
    renderUi();
    fireEvent.click(await screen.findByTestId('mcp-delete-srv1'));
    await screen.findByTestId('mcp-delete-dialog');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByTestId('mcp-delete-dialog')).toBeNull());
    expect(update).not.toHaveBeenCalled();
  });

  it('confirm deletes the server and its overrides', async () => {
    const update = mockApi(setEnv({ coder: { add: ['srv1'] } }));
    renderUi();
    fireEvent.click(await screen.findByTestId('mcp-delete-srv1'));
    fireEvent.click(await screen.findByTestId('mcp-delete-confirm'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('p1', { customMcpServers: [], agentMcpOverrides: {} })
    );
  });

  it('shows a toast and restores the row when the save returns success: false', async () => {
    mockApi(
      setEnv({ coder: { add: ['srv1'] } }),
      vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    );
    renderUi();
    fireEvent.click(await screen.findByTestId('mcp-delete-srv1'));
    fireEvent.click(await screen.findByTestId('mcp-delete-confirm'));
    expect(await screen.findByText('Could not delete the MCP server')).toBeTruthy();
    expect(await screen.findByTestId('mcp-delete-srv1')).toBeTruthy();
  });

  it('shows a toast and restores the row when the save rejects', async () => {
    mockApi(
      setEnv({ coder: { add: ['srv1'] } }),
      vi.fn().mockRejectedValue(new Error('boom'))
    );
    renderUi();
    fireEvent.click(await screen.findByTestId('mcp-delete-srv1'));
    fireEvent.click(await screen.findByTestId('mcp-delete-confirm'));
    expect(await screen.findByText('Could not delete the MCP server')).toBeTruthy();
    expect(await screen.findByTestId('mcp-delete-srv1')).toBeTruthy();
  });

  it('says no agents use a server without overrides', async () => {
    mockApi(setEnv({}));
    renderUi();
    fireEvent.click(await screen.findByTestId('mcp-delete-srv1'));
    const dialog = await screen.findByTestId('mcp-delete-dialog');
    expect(dialog.textContent).toContain('No agents use this server.');
  });

  it('labels the edit and delete buttons', async () => {
    mockApi(setEnv({}));
    renderUi();
    const del = await screen.findByTestId('mcp-delete-srv1');
    expect(del.getAttribute('aria-label')).toBe('Delete');
    expect(screen.getByLabelText('Edit')).toBeTruthy();
  });
});
