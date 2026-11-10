import { useTranslation } from 'react-i18next';
import type { Project, ProjectSettings as ProjectSettingsType, AutoBuildVersionInfo, ProjectEnvConfig, LinearSyncStatus, JiraSyncStatus, GitHubSyncStatus, GitLabSyncStatus, BitbucketSyncStatus } from '../../../../shared/types';
import { SettingsSection } from '../SettingsSection';
import { GeneralSettings } from '../../project-settings/GeneralSettings';
import { AgentMemorySettings } from '../../project-settings/AgentMemorySettings';
import { BashSandboxSettings } from '../../project-settings/BashSandboxSettings';
import { LinearIntegration } from '../integrations/LinearIntegration';
import { GitHubIntegration } from '../integrations/GitHubIntegration';
import { GitLabIntegration } from '../integrations/GitLabIntegration';
import { BitbucketIntegration } from '../integrations/BitbucketIntegration';
import { JiraIntegration } from '../integrations/JiraIntegration';
import { InitializationGuard } from '../common/InitializationGuard';
import type { ProjectSettingsSection } from '../ProjectSettingsContent';

interface SectionRouterProps {
  activeSection: ProjectSettingsSection;
  project: Project;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;
  envConfig: ProjectEnvConfig | null;
  isLoadingEnv: boolean;
  envError: string | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showLinearKey: boolean;
  setShowLinearKey: React.Dispatch<React.SetStateAction<boolean>>;
  showGitHubToken: boolean;
  setShowGitHubToken: React.Dispatch<React.SetStateAction<boolean>>;
  gitHubConnectionStatus: GitHubSyncStatus | null;
  isCheckingGitHub: boolean;
  showGitLabToken: boolean;
  setShowGitLabToken: React.Dispatch<React.SetStateAction<boolean>>;
  gitLabConnectionStatus: GitLabSyncStatus | null;
  isCheckingGitLab: boolean;
  showBitbucketToken: boolean;
  setShowBitbucketToken: React.Dispatch<React.SetStateAction<boolean>>;
  bitbucketConnectionStatus: BitbucketSyncStatus | null;
  isCheckingBitbucket: boolean;
  linearConnectionStatus: LinearSyncStatus | null;
  isCheckingLinear: boolean;
  showJiraToken: boolean;
  setShowJiraToken: React.Dispatch<React.SetStateAction<boolean>>;
  jiraConnectionStatus: JiraSyncStatus | null;
  isCheckingJira: boolean;
  handleInitialize: () => Promise<void>;
  onOpenLinearImport: () => void;
  onOpenJiraImport: () => void;
  appMemoryEnabled: boolean | undefined;
  onAppMemoryEnabledChange: (enabled: boolean) => void;
}

/**
 * Routes to the appropriate settings section based on activeSection.
 * Handles initialization guards and section-specific configurations.
 */
export function SectionRouter({
  activeSection,
  project,
  settings,
  setSettings,
  versionInfo,
  isCheckingVersion,
  isUpdating,
  envConfig,
  isLoadingEnv,
  envError,
  updateEnvConfig,
  showLinearKey,
  setShowLinearKey,
  showGitHubToken,
  setShowGitHubToken,
  gitHubConnectionStatus,
  isCheckingGitHub,
  showGitLabToken,
  setShowGitLabToken,
  gitLabConnectionStatus,
  isCheckingGitLab,
  showBitbucketToken,
  setShowBitbucketToken,
  bitbucketConnectionStatus,
  isCheckingBitbucket,
  linearConnectionStatus,
  isCheckingLinear,
  showJiraToken,
  setShowJiraToken,
  jiraConnectionStatus,
  isCheckingJira,
  handleInitialize,
  onOpenLinearImport,
  onOpenJiraImport,
  appMemoryEnabled,
  onAppMemoryEnabledChange
}: SectionRouterProps) {
  const { t } = useTranslation('settings');

  switch (activeSection) {
    case 'general':
      return (
        <SettingsSection
          title="General"
          description={`Configure Auto-Build, agent model, and notifications for ${project.name}`}
        >
          <GeneralSettings
            project={project}
            settings={settings}
            setSettings={setSettings}
            versionInfo={versionInfo}
            isCheckingVersion={isCheckingVersion}
            isUpdating={isUpdating}
            handleInitialize={handleInitialize}
          />
        </SettingsSection>
      );

    case 'linear':
      return (
        <SettingsSection
          title={t('projectSections.linear.integrationTitle')}
          description={t('projectSections.linear.integrationDescription')}
        >
          <InitializationGuard
            initialized={!!project.autoBuildPath}
            title={t('projectSections.linear.integrationTitle')}
            description={t('projectSections.linear.syncDescription')}
          >
            <LinearIntegration
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
              showLinearKey={showLinearKey}
              setShowLinearKey={setShowLinearKey}
              linearConnectionStatus={linearConnectionStatus}
              isCheckingLinear={isCheckingLinear}
              onOpenLinearImport={onOpenLinearImport}
            />
          </InitializationGuard>
        </SettingsSection>
      );

    case 'github':
      return (
        <SettingsSection
          title={t('projectSections.github.integrationTitle')}
          description={t('projectSections.github.integrationDescription')}
        >
          <InitializationGuard
            initialized={!!project.autoBuildPath}
            title={t('projectSections.github.integrationTitle')}
            description={t('projectSections.github.syncDescription')}
          >
            <GitHubIntegration
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
              showGitHubToken={showGitHubToken}
              setShowGitHubToken={setShowGitHubToken}
              gitHubConnectionStatus={gitHubConnectionStatus}
              isCheckingGitHub={isCheckingGitHub}
              projectPath={project.path}
              settings={settings}
              setSettings={setSettings}
            />
          </InitializationGuard>
        </SettingsSection>
      );

    case 'gitlab':
      return (
        <SettingsSection
          title={t('projectSections.gitlab.integrationTitle')}
          description={t('projectSections.gitlab.integrationDescription')}
        >
          <InitializationGuard
            initialized={!!project.autoBuildPath}
            title={t('projectSections.gitlab.integrationTitle')}
            description={t('projectSections.gitlab.syncDescription')}
          >
            <GitLabIntegration
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
              showGitLabToken={showGitLabToken}
              setShowGitLabToken={setShowGitLabToken}
              gitLabConnectionStatus={gitLabConnectionStatus}
              isCheckingGitLab={isCheckingGitLab}
              projectPath={project.path}
              settings={settings}
              setSettings={setSettings}
            />
          </InitializationGuard>
        </SettingsSection>
      );

    case 'bitbucket':
      return (
        <SettingsSection
          title={t('projectSections.bitbucket.integrationTitle')}
          description={t('projectSections.bitbucket.integrationDescription')}
        >
          <InitializationGuard
            initialized={!!project.autoBuildPath}
            title={t('projectSections.bitbucket.integrationTitle')}
            description={t('projectSections.bitbucket.syncDescription')}
          >
            <BitbucketIntegration
              projectId={project.id}
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
              showBitbucketToken={showBitbucketToken}
              setShowBitbucketToken={setShowBitbucketToken}
              bitbucketConnectionStatus={bitbucketConnectionStatus}
              isCheckingBitbucket={isCheckingBitbucket}
            />
          </InitializationGuard>
        </SettingsSection>
      );

    case 'jira':
      return (
        <SettingsSection
          title={t('projectSections.jira.integrationTitle')}
          description={t('projectSections.jira.integrationDescription')}
        >
          <InitializationGuard
            initialized={!!project.autoBuildPath}
            title={t('projectSections.jira.integrationTitle')}
            description={t('projectSections.jira.syncDescription')}
          >
            <JiraIntegration
              envConfig={envConfig}
              updateEnvConfig={updateEnvConfig}
              showJiraToken={showJiraToken}
              setShowJiraToken={setShowJiraToken}
              jiraConnectionStatus={jiraConnectionStatus}
              isCheckingJira={isCheckingJira}
              onOpenJiraImport={onOpenJiraImport}
            />
          </InitializationGuard>
        </SettingsSection>
      );

    case 'memory':
      return (
        <SettingsSection
          title={t('projectSections.memory.integrationTitle')}
          description={t('projectSections.memory.integrationDescription')}
        >
          <InitializationGuard
            initialized={!!project.autoBuildPath}
            title={t('projectSections.memory.integrationTitle')}
            description={t('projectSections.memory.syncDescription')}
          >
            {/* zeenha fork: the built-in agent memory, not upstream's Graphiti toggle */}
            <AgentMemorySettings
              projectId={project.id}
              memoryEnabled={appMemoryEnabled}
              onMemoryEnabledChange={onAppMemoryEnabledChange}
            />
          </InitializationGuard>
        </SettingsSection>
      );

    case 'security':
      return (
        <SettingsSection
          title={t('projectSections.security.title')}
          description={t('projectSections.security.description')}
        >
          <BashSandboxSettings settings={settings} setSettings={setSettings} />
        </SettingsSection>
      );

    default:
      return null;
  }
}
