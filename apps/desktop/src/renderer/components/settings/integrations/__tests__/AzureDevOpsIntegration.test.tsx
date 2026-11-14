/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';
import '../../../../../shared/i18n';
import { AzureDevOpsIntegration } from '../AzureDevOpsIntegration';
import type { ProjectEnvConfig, AzureDevOpsSyncStatus } from '../../../../../shared/types';

const envConfig = {
  azureDevOpsEnabled: true,
  azureDevOpsOrganization: 'org',
  azureDevOpsProject: 'proj',
  azureDevOpsRepository: 'repo',
  azureDevOpsPat: 'secret'
} as ProjectEnvConfig;

function Harness({ status }: { status: AzureDevOpsSyncStatus | null }) {
  const [show, setShow] = useState(false);
  return (
    <AzureDevOpsIntegration
      projectId="p1"
      envConfig={envConfig}
      updateEnvConfig={vi.fn()}
      showAzureDevOpsPat={show}
      setShowAzureDevOpsPat={setShow}
      azureDevOpsConnectionStatus={status}
      isCheckingAzureDevOps={false}
    />
  );
}

describe('AzureDevOpsIntegration', () => {
  it('shows connected status', () => {
    render(<Harness status={{ connected: true, repoFullName: 'org/proj/repo' }} />);
    expect(screen.getByText('Connected to org/proj/repo')).toBeInTheDocument();
  });

  it('shows failed status', () => {
    render(<Harness status={{ connected: false, error: 'Bad token' }} />);
    expect(screen.getByText('Bad token')).toBeInTheDocument();
  });

  it('keeps the PAT hidden until toggled', () => {
    render(<Harness status={null} />);
    const input = screen.getByPlaceholderText('Paste your personal access token');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show token' }));
    expect(input).toHaveAttribute('type', 'text');
  });
});
