import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, DEFAULT_APP_SETTINGS } from '../../shared/constants';
import type { IPCResult, ProjectEnvConfig, AppSettings } from '../../shared/types';
import path from 'path';
import { app } from 'electron';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { projectStore } from '../project-store';
import { parseEnvFile } from './utils';
import { describeProjectMcpTrust, parseSecureOrigins } from '../ai/mcp/project-settings';
import { approveChromeExecutable, approveServer, getApprovals } from '../mcp-approval-store';
import { isAutoBuildEnvTrackedByGit } from '../project-initializer';

// Bitbucket environment variable keys
const BITBUCKET_ENV_KEYS = {
  ENABLED: 'BITBUCKET_ENABLED',
  USERNAME: 'BITBUCKET_USERNAME',
  TOKEN: 'BITBUCKET_TOKEN',
  REPOSITORY: 'BITBUCKET_REPOSITORY'
} as const;

// Azure DevOps environment variable keys (must match azuredevops/utils.ts)
const AZURE_DEVOPS_ENV_KEYS = {
  ENABLED: 'AZURE_DEVOPS_ENABLED',
  ORGANIZATION: 'AZURE_DEVOPS_ORGANIZATION',
  PROJECT: 'AZURE_DEVOPS_PROJECT',
  REPOSITORY: 'AZURE_DEVOPS_REPOSITORY',
  PAT: 'AZURE_DEVOPS_PAT'
} as const;

// GitLab environment variable keys
const GITLAB_ENV_KEYS = {
  ENABLED: 'GITLAB_ENABLED',
  TOKEN: 'GITLAB_TOKEN',
  INSTANCE_URL: 'GITLAB_INSTANCE_URL',
  PROJECT: 'GITLAB_PROJECT',
  AUTO_SYNC: 'GITLAB_AUTO_SYNC'
} as const;

// Jira environment variable keys
const JIRA_ENV_KEYS = {
  ENABLED: 'JIRA_ENABLED',
  SITE_URL: 'JIRA_SITE_URL',
  EMAIL: 'JIRA_EMAIL',
  API_TOKEN: 'JIRA_API_TOKEN',
  PROJECT_KEY: 'JIRA_PROJECT_KEY'
} as const;

/**
 * Helper to generate .env line (DRY)
 */
function envLine(vars: Record<string, string>, key: string, defaultVal: string = ''): string {
  return vars[key] ? `${key}=${vars[key]}` : `# ${key}=${defaultVal}`;
}

/**
 * Register all env-related IPC handlers
 */
export function registerEnvHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Environment Configuration Operations
  // ============================================

  // Get settings file path
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');

  /**
   * Generate .env file content from config
   */
  const generateEnvContent = (
    config: Partial<ProjectEnvConfig>,
    existingContent?: string
  ): string => {
    // Parse existing content to preserve comments and structure
    const existingVars = existingContent ? parseEnvFile(existingContent) : {};

    // Update with new values
    if (config.autoBuildModel !== undefined) {
      existingVars['AUTO_BUILD_MODEL'] = config.autoBuildModel;
    }
    if (config.linearApiKey !== undefined) {
      existingVars['LINEAR_API_KEY'] = config.linearApiKey;
    }
    if (config.linearTeamId !== undefined) {
      existingVars['LINEAR_TEAM_ID'] = config.linearTeamId;
    }
    if (config.linearProjectId !== undefined) {
      existingVars['LINEAR_PROJECT_ID'] = config.linearProjectId;
    }
    if (config.linearRealtimeSync !== undefined) {
      existingVars['LINEAR_REALTIME_SYNC'] = config.linearRealtimeSync ? 'true' : 'false';
    }
    // GitHub Integration
    if (config.githubToken !== undefined) {
      existingVars['GITHUB_TOKEN'] = config.githubToken;
    }
    if (config.githubRepo !== undefined) {
      existingVars['GITHUB_REPO'] = config.githubRepo;
    }
    if (config.githubAutoSync !== undefined) {
      existingVars['GITHUB_AUTO_SYNC'] = config.githubAutoSync ? 'true' : 'false';
    }
    // Bitbucket Integration
    if (config.bitbucketEnabled !== undefined) {
      existingVars[BITBUCKET_ENV_KEYS.ENABLED] = config.bitbucketEnabled ? 'true' : 'false';
    }
    if (config.bitbucketUsername !== undefined) {
      existingVars[BITBUCKET_ENV_KEYS.USERNAME] = config.bitbucketUsername;
    }
    if (config.bitbucketToken !== undefined) {
      existingVars[BITBUCKET_ENV_KEYS.TOKEN] = config.bitbucketToken;
    }
    if (config.bitbucketRepository !== undefined) {
      existingVars[BITBUCKET_ENV_KEYS.REPOSITORY] = config.bitbucketRepository;
    }

    // Azure DevOps Integration
    if (config.azureDevOpsEnabled !== undefined) {
      existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED] = config.azureDevOpsEnabled ? 'true' : 'false';
    }
    if (config.azureDevOpsOrganization !== undefined) {
      existingVars[AZURE_DEVOPS_ENV_KEYS.ORGANIZATION] = config.azureDevOpsOrganization;
    }
    if (config.azureDevOpsProject !== undefined) {
      existingVars[AZURE_DEVOPS_ENV_KEYS.PROJECT] = config.azureDevOpsProject;
    }
    if (config.azureDevOpsRepository !== undefined) {
      existingVars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY] = config.azureDevOpsRepository;
    }
    if (config.azureDevOpsPat !== undefined) {
      existingVars[AZURE_DEVOPS_ENV_KEYS.PAT] = config.azureDevOpsPat;
    }

    // GitLab Integration
    if (config.gitlabEnabled !== undefined) {
      existingVars[GITLAB_ENV_KEYS.ENABLED] = config.gitlabEnabled ? 'true' : 'false';
    }
    if (config.gitlabToken !== undefined) {
      existingVars[GITLAB_ENV_KEYS.TOKEN] = config.gitlabToken;
    }
    if (config.gitlabInstanceUrl !== undefined) {
      existingVars[GITLAB_ENV_KEYS.INSTANCE_URL] = config.gitlabInstanceUrl;
    }
    if (config.gitlabProject !== undefined) {
      existingVars[GITLAB_ENV_KEYS.PROJECT] = config.gitlabProject;
    }
    if (config.gitlabAutoSync !== undefined) {
      existingVars[GITLAB_ENV_KEYS.AUTO_SYNC] = config.gitlabAutoSync ? 'true' : 'false';
    }
    // Jira Integration
    if (config.jiraEnabled !== undefined) {
      existingVars[JIRA_ENV_KEYS.ENABLED] = config.jiraEnabled ? 'true' : 'false';
    }
    if (config.jiraSiteUrl !== undefined) {
      existingVars[JIRA_ENV_KEYS.SITE_URL] = config.jiraSiteUrl;
    }
    if (config.jiraEmail !== undefined) {
      existingVars[JIRA_ENV_KEYS.EMAIL] = config.jiraEmail;
    }
    if (config.jiraApiToken !== undefined) {
      existingVars[JIRA_ENV_KEYS.API_TOKEN] = config.jiraApiToken;
    }
    if (config.jiraProjectKey !== undefined) {
      existingVars[JIRA_ENV_KEYS.PROJECT_KEY] = config.jiraProjectKey;
    }
    // Git/Worktree Settings
    if (config.defaultBranch !== undefined) {
      existingVars['DEFAULT_BRANCH'] = config.defaultBranch;
    }
    if (config.memoryEnabled !== undefined) {
      existingVars['GRAPHITI_ENABLED'] = config.memoryEnabled ? 'true' : 'false';
    }
    // Memory Provider Configuration (embeddings only - LLM uses Claude SDK)
    if (config.memoryProviderConfig) {
      const pc = config.memoryProviderConfig;
      // Embedding provider only (LLM provider removed - Claude SDK handles RAG)
      if (pc.embeddingProvider) existingVars['GRAPHITI_EMBEDDER_PROVIDER'] = pc.embeddingProvider;
      // OpenAI Embeddings
      if (pc.openaiApiKey) existingVars['OPENAI_API_KEY'] = pc.openaiApiKey;
      if (pc.openaiEmbeddingModel) existingVars['OPENAI_EMBEDDING_MODEL'] = pc.openaiEmbeddingModel;
      // Azure OpenAI Embeddings
      if (pc.azureOpenaiApiKey) existingVars['AZURE_OPENAI_API_KEY'] = pc.azureOpenaiApiKey;
      if (pc.azureOpenaiBaseUrl) existingVars['AZURE_OPENAI_BASE_URL'] = pc.azureOpenaiBaseUrl;
      if (pc.azureOpenaiEmbeddingDeployment) existingVars['AZURE_OPENAI_EMBEDDING_DEPLOYMENT'] = pc.azureOpenaiEmbeddingDeployment;
      // Voyage Embeddings
      if (pc.voyageApiKey) existingVars['VOYAGE_API_KEY'] = pc.voyageApiKey;
      if (pc.voyageEmbeddingModel) existingVars['VOYAGE_EMBEDDING_MODEL'] = pc.voyageEmbeddingModel;
      // Google Embeddings
      if (pc.googleApiKey) existingVars['GOOGLE_API_KEY'] = pc.googleApiKey;
      if (pc.googleEmbeddingModel) existingVars['GOOGLE_EMBEDDING_MODEL'] = pc.googleEmbeddingModel;
      // Ollama Embeddings
      if (pc.ollamaBaseUrl) existingVars['OLLAMA_BASE_URL'] = pc.ollamaBaseUrl;
      if (pc.ollamaEmbeddingModel) existingVars['OLLAMA_EMBEDDING_MODEL'] = pc.ollamaEmbeddingModel;
      if (pc.ollamaEmbeddingDim) existingVars['OLLAMA_EMBEDDING_DIM'] = String(pc.ollamaEmbeddingDim);
      // LadybugDB (embedded database)
      if (pc.dbPath) existingVars['GRAPHITI_DB_PATH'] = pc.dbPath;
      if (pc.database) existingVars['GRAPHITI_DATABASE'] = pc.database;
    }
    // Legacy fields (still supported)
    if (config.openaiApiKey !== undefined) {
      existingVars['OPENAI_API_KEY'] = config.openaiApiKey;
    }
    if (config.memoryDatabase !== undefined) {
      existingVars['GRAPHITI_DATABASE'] = config.memoryDatabase;
    }
    if (config.memoryDbPath !== undefined) {
      existingVars['GRAPHITI_DB_PATH'] = config.memoryDbPath;
    }
    if (config.enableFancyUi !== undefined) {
      existingVars['ENABLE_FANCY_UI'] = config.enableFancyUi ? 'true' : 'false';
    }

    // MCP Server Configuration
    if (config.mcpServers) {
      if (config.mcpServers.context7Enabled !== undefined) {
        existingVars['CONTEXT7_ENABLED'] = config.mcpServers.context7Enabled ? 'true' : 'false';
      }
      if (config.mcpServers.electronEnabled !== undefined) {
        existingVars['ELECTRON_MCP_ENABLED'] = config.mcpServers.electronEnabled ? 'true' : 'false';
      }
      if (config.mcpServers.chromeDevtoolsEnabled !== undefined) {
        existingVars['CHROME_DEVTOOLS_MCP_ENABLED'] = config.mcpServers.chromeDevtoolsEnabled ? 'true' : 'false';
      }
      if (config.mcpServers.chromeDevtoolsWebmcp !== undefined) {
        existingVars['CHROME_DEVTOOLS_WEBMCP'] = config.mcpServers.chromeDevtoolsWebmcp ? 'true' : 'false';
      }
      if (config.mcpServers.chromeDevtoolsSecureOrigins !== undefined) {
        const origins = parseSecureOrigins(config.mcpServers.chromeDevtoolsSecureOrigins);
        if (origins.length > 0) existingVars['CHROME_DEVTOOLS_SECURE_ORIGINS'] = origins.join(',');
        else delete existingVars['CHROME_DEVTOOLS_SECURE_ORIGINS'];
      }
      if (config.mcpServers.chromeDevtoolsExecutable !== undefined) {
        // One line in a .env file: a newline here would inject another key.
        const exe = config.mcpServers.chromeDevtoolsExecutable.replace(/[\r\n]/g, '').trim();
        if (exe) existingVars['CHROME_DEVTOOLS_EXECUTABLE'] = exe;
        else delete existingVars['CHROME_DEVTOOLS_EXECUTABLE'];
      }
      // zeenha fork: the Linear and Puppeteer MCP servers were removed (their
      // npm packages do not exist); drop their stale keys on the next save.
      delete existingVars['LINEAR_MCP_ENABLED'];
      delete existingVars['PUPPETEER_MCP_ENABLED'];
      // Note: memoryEnabled is already handled via GRAPHITI_ENABLED above
    }

    // Per-agent MCP overrides (add/remove MCPs from specific agents)
    if (config.agentMcpOverrides) {
      // First, clear any existing AGENT_MCP_* entries
      Object.keys(existingVars).forEach(key => {
        if (key.startsWith('AGENT_MCP_')) {
          delete existingVars[key];
        }
      });

      // Add new overrides
      Object.entries(config.agentMcpOverrides).forEach(([agentId, override]) => {
        if (override.add && override.add.length > 0) {
          existingVars[`AGENT_MCP_${agentId}_ADD`] = override.add.join(',');
        }
        if (override.remove && override.remove.length > 0) {
          existingVars[`AGENT_MCP_${agentId}_REMOVE`] = override.remove.join(',');
        }
      });
    }

    // Custom MCP servers (user-defined)
    if (config.customMcpServers !== undefined) {
      if (config.customMcpServers.length > 0) {
        existingVars['CUSTOM_MCP_SERVERS'] = JSON.stringify(config.customMcpServers);
      } else {
        delete existingVars['CUSTOM_MCP_SERVERS'];
      }
    }

    // Generate content with sections
    const content = `# Auto Claude Framework Environment Variables
# Managed by Auto Claude UI

# Model override (OPTIONAL)
${existingVars['AUTO_BUILD_MODEL'] ? `AUTO_BUILD_MODEL=${existingVars['AUTO_BUILD_MODEL']}` : '# AUTO_BUILD_MODEL=claude-opus-4-6'}

# =============================================================================
# LINEAR INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars['LINEAR_API_KEY'] ? `LINEAR_API_KEY=${existingVars['LINEAR_API_KEY']}` : '# LINEAR_API_KEY='}
${existingVars['LINEAR_TEAM_ID'] ? `LINEAR_TEAM_ID=${existingVars['LINEAR_TEAM_ID']}` : '# LINEAR_TEAM_ID='}
${existingVars['LINEAR_PROJECT_ID'] ? `LINEAR_PROJECT_ID=${existingVars['LINEAR_PROJECT_ID']}` : '# LINEAR_PROJECT_ID='}
${existingVars['LINEAR_REALTIME_SYNC'] !== undefined ? `LINEAR_REALTIME_SYNC=${existingVars['LINEAR_REALTIME_SYNC']}` : '# LINEAR_REALTIME_SYNC=false'}

# =============================================================================
# GITHUB INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars['GITHUB_TOKEN'] ? `GITHUB_TOKEN=${existingVars['GITHUB_TOKEN']}` : '# GITHUB_TOKEN='}
${existingVars['GITHUB_REPO'] ? `GITHUB_REPO=${existingVars['GITHUB_REPO']}` : '# GITHUB_REPO=owner/repo'}
${existingVars['GITHUB_AUTO_SYNC'] !== undefined ? `GITHUB_AUTO_SYNC=${existingVars['GITHUB_AUTO_SYNC']}` : '# GITHUB_AUTO_SYNC=false'}

# =============================================================================
# GITLAB INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars[GITLAB_ENV_KEYS.ENABLED] !== undefined ? `${GITLAB_ENV_KEYS.ENABLED}=${existingVars[GITLAB_ENV_KEYS.ENABLED]}` : `# ${GITLAB_ENV_KEYS.ENABLED}=true`}
${envLine(existingVars, GITLAB_ENV_KEYS.INSTANCE_URL, 'https://gitlab.com')}
${envLine(existingVars, GITLAB_ENV_KEYS.TOKEN)}
${envLine(existingVars, GITLAB_ENV_KEYS.PROJECT, 'group/project')}
${envLine(existingVars, GITLAB_ENV_KEYS.AUTO_SYNC, 'false')}

# =============================================================================
# BITBUCKET INTEGRATION (OPTIONAL)
# ======================================================================
# =============================================================================
${existingVars[BITBUCKET_ENV_KEYS.ENABLED] !== undefined ? `${BITBUCKET_ENV_KEYS.ENABLED}=${existingVars[BITBUCKET_ENV_KEYS.ENABLED]}` : `# ${BITBUCKET_ENV_KEYS.ENABLED}=true`}
${envLine(existingVars, BITBUCKET_ENV_KEYS.USERNAME)}
${envLine(existingVars, BITBUCKET_ENV_KEYS.TOKEN)}
${envLine(existingVars, BITBUCKET_ENV_KEYS.REPOSITORY, 'workspace/repo_slug')}

# =============================================================================
# AZURE DEVOPS INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED] !== undefined ? `${AZURE_DEVOPS_ENV_KEYS.ENABLED}=${existingVars[AZURE_DEVOPS_ENV_KEYS.ENABLED]}` : `# ${AZURE_DEVOPS_ENV_KEYS.ENABLED}=true`}
${envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.ORGANIZATION)}
${envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.PROJECT)}
${envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.REPOSITORY)}
${envLine(existingVars, AZURE_DEVOPS_ENV_KEYS.PAT)}
=======
# JIRA INTEGRATION (OPTIONAL)
# =============================================================================
${existingVars[JIRA_ENV_KEYS.ENABLED] !== undefined ? `${JIRA_ENV_KEYS.ENABLED}=${existingVars[JIRA_ENV_KEYS.ENABLED]}` : `# ${JIRA_ENV_KEYS.ENABLED}=true`}
${envLine(existingVars, JIRA_ENV_KEYS.SITE_URL, 'https://your-site.atlassian.net')}
${envLine(existingVars, JIRA_ENV_KEYS.EMAIL)}
${envLine(existingVars, JIRA_ENV_KEYS.API_TOKEN)}
${envLine(existingVars, JIRA_ENV_KEYS.PROJECT_KEY, 'PROJ')}

# =============================================================================
# GIT/WORKTREE SETTINGS (OPTIONAL)
# =============================================================================
# Default base branch for worktree creation
# If not set, Auto Claude will auto-detect main/master, or fall back to current branch
${existingVars['DEFAULT_BRANCH'] ? `DEFAULT_BRANCH=${existingVars['DEFAULT_BRANCH']}` : '# DEFAULT_BRANCH=main'}

# =============================================================================
# UI SETTINGS (OPTIONAL)
# =============================================================================
${existingVars['ENABLE_FANCY_UI'] !== undefined ? `ENABLE_FANCY_UI=${existingVars['ENABLE_FANCY_UI']}` : '# ENABLE_FANCY_UI=true'}

# =============================================================================
# MCP SERVER CONFIGURATION (per-project overrides)
# =============================================================================
# Context7 documentation lookup (default: enabled)
${existingVars['CONTEXT7_ENABLED'] !== undefined ? `CONTEXT7_ENABLED=${existingVars['CONTEXT7_ENABLED']}` : '# CONTEXT7_ENABLED=true'}
# Electron desktop automation - QA agents only (default: disabled)
${existingVars['ELECTRON_MCP_ENABLED'] !== undefined ? `ELECTRON_MCP_ENABLED=${existingVars['ELECTRON_MCP_ENABLED']}` : '# ELECTRON_MCP_ENABLED=false'}
# Chrome DevTools browser automation - QA agents only (default: disabled)
${existingVars['CHROME_DEVTOOLS_MCP_ENABLED'] !== undefined ? `CHROME_DEVTOOLS_MCP_ENABLED=${existingVars['CHROME_DEVTOOLS_MCP_ENABLED']}` : '# CHROME_DEVTOOLS_MCP_ENABLED=false'}
# Absolute path of the Chrome to launch (default: the installed Chrome)
${existingVars['CHROME_DEVTOOLS_EXECUTABLE'] !== undefined ? `CHROME_DEVTOOLS_EXECUTABLE=${existingVars['CHROME_DEVTOOLS_EXECUTABLE']}` : '# CHROME_DEVTOOLS_EXECUTABLE='}
# http:// dev origins the QA browser treats as secure contexts (comma-separated; full Chrome only)
${existingVars['CHROME_DEVTOOLS_SECURE_ORIGINS'] !== undefined ? `CHROME_DEVTOOLS_SECURE_ORIGINS=${existingVars['CHROME_DEVTOOLS_SECURE_ORIGINS']}` : '# CHROME_DEVTOOLS_SECURE_ORIGINS='}
# Expose pages' WebMCP tools to QA agents - needs Chrome 150+ (default: disabled)
${existingVars['CHROME_DEVTOOLS_WEBMCP'] !== undefined ? `CHROME_DEVTOOLS_WEBMCP=${existingVars['CHROME_DEVTOOLS_WEBMCP']}` : '# CHROME_DEVTOOLS_WEBMCP=false'}

# =============================================================================
# PER-AGENT MCP OVERRIDES
# Add or remove MCP servers for specific agents
# Format: AGENT_MCP_<agent_type>_ADD=server1,server2
# Format: AGENT_MCP_<agent_type>_REMOVE=server1,server2
# =============================================================================
${Object.entries(existingVars)
  .filter(([key]) => key.startsWith('AGENT_MCP_'))
  .map(([key, value]) => `${key}=${value}`)
  .join('\n') || '# No per-agent overrides configured'}

# =============================================================================
# CUSTOM MCP SERVERS
# User-defined MCP servers (command-based or HTTP-based)
# JSON format: [{"id":"...","name":"...","type":"command|http",...}]
# =============================================================================
${existingVars['CUSTOM_MCP_SERVERS'] ? `CUSTOM_MCP_SERVERS=${existingVars['CUSTOM_MCP_SERVERS']}` : '# CUSTOM_MCP_SERVERS=[]'}

# =============================================================================
# MEMORY INTEGRATION
# Embedding providers: OpenAI, Google AI, Azure OpenAI, Ollama, Voyage
# =============================================================================
${existingVars['GRAPHITI_ENABLED'] ? `GRAPHITI_ENABLED=${existingVars['GRAPHITI_ENABLED']}` : '# GRAPHITI_ENABLED=true'}

# Embedding Provider (for semantic search - optional, keyword search works without)
${existingVars['GRAPHITI_EMBEDDER_PROVIDER'] ? `GRAPHITI_EMBEDDER_PROVIDER=${existingVars['GRAPHITI_EMBEDDER_PROVIDER']}` : '# GRAPHITI_EMBEDDER_PROVIDER=ollama'}

# OpenAI Embeddings
${existingVars['OPENAI_API_KEY'] ? `OPENAI_API_KEY=${existingVars['OPENAI_API_KEY']}` : '# OPENAI_API_KEY='}
${existingVars['OPENAI_EMBEDDING_MODEL'] ? `OPENAI_EMBEDDING_MODEL=${existingVars['OPENAI_EMBEDDING_MODEL']}` : '# OPENAI_EMBEDDING_MODEL=text-embedding-3-small'}

# Azure OpenAI Embeddings
${existingVars['AZURE_OPENAI_API_KEY'] ? `AZURE_OPENAI_API_KEY=${existingVars['AZURE_OPENAI_API_KEY']}` : '# AZURE_OPENAI_API_KEY='}
${existingVars['AZURE_OPENAI_BASE_URL'] ? `AZURE_OPENAI_BASE_URL=${existingVars['AZURE_OPENAI_BASE_URL']}` : '# AZURE_OPENAI_BASE_URL='}
${existingVars['AZURE_OPENAI_EMBEDDING_DEPLOYMENT'] ? `AZURE_OPENAI_EMBEDDING_DEPLOYMENT=${existingVars['AZURE_OPENAI_EMBEDDING_DEPLOYMENT']}` : '# AZURE_OPENAI_EMBEDDING_DEPLOYMENT='}

# Voyage AI Embeddings
${existingVars['VOYAGE_API_KEY'] ? `VOYAGE_API_KEY=${existingVars['VOYAGE_API_KEY']}` : '# VOYAGE_API_KEY='}
${existingVars['VOYAGE_EMBEDDING_MODEL'] ? `VOYAGE_EMBEDDING_MODEL=${existingVars['VOYAGE_EMBEDDING_MODEL']}` : '# VOYAGE_EMBEDDING_MODEL=voyage-3'}

# Google AI Embeddings
${existingVars['GOOGLE_API_KEY'] ? `GOOGLE_API_KEY=${existingVars['GOOGLE_API_KEY']}` : '# GOOGLE_API_KEY='}
${existingVars['GOOGLE_EMBEDDING_MODEL'] ? `GOOGLE_EMBEDDING_MODEL=${existingVars['GOOGLE_EMBEDDING_MODEL']}` : '# GOOGLE_EMBEDDING_MODEL=text-embedding-004'}

# Ollama Embeddings (Local - free)
${existingVars['OLLAMA_BASE_URL'] ? `OLLAMA_BASE_URL=${existingVars['OLLAMA_BASE_URL']}` : '# OLLAMA_BASE_URL=http://localhost:11434'}
${existingVars['OLLAMA_EMBEDDING_MODEL'] ? `OLLAMA_EMBEDDING_MODEL=${existingVars['OLLAMA_EMBEDDING_MODEL']}` : '# OLLAMA_EMBEDDING_MODEL=embeddinggemma'}
${existingVars['OLLAMA_EMBEDDING_DIM'] ? `OLLAMA_EMBEDDING_DIM=${existingVars['OLLAMA_EMBEDDING_DIM']}` : '# OLLAMA_EMBEDDING_DIM=768'}

# LadybugDB Database (embedded - no Docker required)
${existingVars['GRAPHITI_DATABASE'] ? `GRAPHITI_DATABASE=${existingVars['GRAPHITI_DATABASE']}` : '# GRAPHITI_DATABASE=auto_claude_memory'}
${existingVars['GRAPHITI_DB_PATH'] ? `GRAPHITI_DB_PATH=${existingVars['GRAPHITI_DB_PATH']}` : '# GRAPHITI_DB_PATH=~/.auto-claude/memories'}
`;

    return content;
  };

  ipcMain.handle(
    IPC_CHANNELS.ENV_GET,
    async (_, projectId: string): Promise<IPCResult<ProjectEnvConfig>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const envPath = path.join(project.path, project.autoBuildPath, '.env');

      // Load global settings for fallbacks
      let globalSettings: AppSettings = { ...DEFAULT_APP_SETTINGS };
      if (existsSync(settingsPath)) {
        try {
          const content = readFileSync(settingsPath, 'utf-8');
          globalSettings = { ...globalSettings, ...JSON.parse(content) };
        } catch {
          // Use defaults
        }
      }

      // Default config
      const config: ProjectEnvConfig = {
        linearEnabled: false,
        jiraEnabled: false,
        githubEnabled: false,
        gitlabEnabled: false,
        bitbucketEnabled: false,
        azureDevOpsEnabled: false,
        memoryEnabled: false,
        enableFancyUi: true,
        openaiKeyIsGlobal: false
      };

      // Parse project-specific .env if it exists
      let vars: Record<string, string> = {};
      if (existsSync(envPath)) {
        try {
          const content = readFileSync(envPath, 'utf-8');
          vars = parseEnvFile(content);
        } catch {
          // Continue with empty vars
        }
      }

      if (vars['AUTO_BUILD_MODEL']) {
        config.autoBuildModel = vars['AUTO_BUILD_MODEL'];
      }

      if (vars['LINEAR_API_KEY']) {
        config.linearEnabled = true;
        config.linearApiKey = vars['LINEAR_API_KEY'];
      }
      if (vars['LINEAR_TEAM_ID']) {
        config.linearTeamId = vars['LINEAR_TEAM_ID'];
      }
      if (vars['LINEAR_PROJECT_ID']) {
        config.linearProjectId = vars['LINEAR_PROJECT_ID'];
      }
      if (vars['LINEAR_REALTIME_SYNC']?.toLowerCase() === 'true') {
        config.linearRealtimeSync = true;
      }

      // GitHub config
      if (vars['GITHUB_TOKEN']) {
        config.githubEnabled = true;
        config.githubToken = vars['GITHUB_TOKEN'];
      }
      if (vars['GITHUB_REPO']) {
        config.githubRepo = vars['GITHUB_REPO'];
      }
      if (vars['GITHUB_AUTO_SYNC']?.toLowerCase() === 'true') {
        config.githubAutoSync = true;
      }

      // GitLab config
      if (vars[GITLAB_ENV_KEYS.TOKEN]) {
        config.gitlabToken = vars[GITLAB_ENV_KEYS.TOKEN];
        // Enable by default if token exists and GITLAB_ENABLED is not explicitly false
        config.gitlabEnabled = vars[GITLAB_ENV_KEYS.ENABLED]?.toLowerCase() !== 'false';
      }
      if (vars[GITLAB_ENV_KEYS.INSTANCE_URL]) {
        config.gitlabInstanceUrl = vars[GITLAB_ENV_KEYS.INSTANCE_URL];
      }
      if (vars[GITLAB_ENV_KEYS.PROJECT]) {
        config.gitlabProject = vars[GITLAB_ENV_KEYS.PROJECT];
      }
      if (vars[GITLAB_ENV_KEYS.AUTO_SYNC]?.toLowerCase() === 'true') {
        config.gitlabAutoSync = true;
      }

      // Bitbucket config
      if (vars[BITBUCKET_ENV_KEYS.TOKEN]) {
        config.bitbucketToken = vars[BITBUCKET_ENV_KEYS.TOKEN];
        // Enable by default if token exists and BITBUCKET_ENABLED is not explicitly false
        config.bitbucketEnabled = vars[BITBUCKET_ENV_KEYS.ENABLED]?.toLowerCase() !== 'false';
      }
      if (vars[BITBUCKET_ENV_KEYS.USERNAME]) {
        config.bitbucketUsername = vars[BITBUCKET_ENV_KEYS.USERNAME];
      }
      if (vars[BITBUCKET_ENV_KEYS.REPOSITORY]) {
        config.bitbucketRepository = vars[BITBUCKET_ENV_KEYS.REPOSITORY];
      }

      // Azure DevOps config
      if (vars[AZURE_DEVOPS_ENV_KEYS.PAT]) {
        config.azureDevOpsPat = vars[AZURE_DEVOPS_ENV_KEYS.PAT];
        // Enable by default if PAT exists and AZURE_DEVOPS_ENABLED is not explicitly false
        config.azureDevOpsEnabled = vars[AZURE_DEVOPS_ENV_KEYS.ENABLED]?.toLowerCase() !== 'false';
      }
      if (vars[AZURE_DEVOPS_ENV_KEYS.ORGANIZATION]) {
        config.azureDevOpsOrganization = vars[AZURE_DEVOPS_ENV_KEYS.ORGANIZATION];
      }
      if (vars[AZURE_DEVOPS_ENV_KEYS.PROJECT]) {
        config.azureDevOpsProject = vars[AZURE_DEVOPS_ENV_KEYS.PROJECT];
      }
      if (vars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY]) {
        config.azureDevOpsRepository = vars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY];
      }

      // Jira config
      if (vars[JIRA_ENV_KEYS.API_TOKEN]) {
        config.jiraApiToken = vars[JIRA_ENV_KEYS.API_TOKEN];
        // Enable by default if token exists and JIRA_ENABLED is not explicitly false
        config.jiraEnabled = vars[JIRA_ENV_KEYS.ENABLED]?.toLowerCase() !== 'false';
      }
      if (vars[JIRA_ENV_KEYS.SITE_URL]) {
        config.jiraSiteUrl = vars[JIRA_ENV_KEYS.SITE_URL];
      }
      if (vars[JIRA_ENV_KEYS.EMAIL]) {
        config.jiraEmail = vars[JIRA_ENV_KEYS.EMAIL];
      }
      if (vars[JIRA_ENV_KEYS.PROJECT_KEY]) {
        config.jiraProjectKey = vars[JIRA_ENV_KEYS.PROJECT_KEY];
      }

      // Git/Worktree config
      if (vars['DEFAULT_BRANCH']) {
        config.defaultBranch = vars['DEFAULT_BRANCH'];
      }

      if (vars['GRAPHITI_ENABLED']?.toLowerCase() === 'true') {
        config.memoryEnabled = true;
      }

      // OpenAI API Key: project-specific takes precedence, then global
      if (vars['OPENAI_API_KEY']) {
        config.openaiApiKey = vars['OPENAI_API_KEY'];
        config.openaiKeyIsGlobal = false;
      } else if (globalSettings.globalOpenAIApiKey) {
        config.openaiApiKey = globalSettings.globalOpenAIApiKey;
        config.openaiKeyIsGlobal = true;
      }

      if (vars['GRAPHITI_DATABASE']) {
        config.memoryDatabase = vars['GRAPHITI_DATABASE'];
      }
      if (vars['GRAPHITI_DB_PATH']) {
        config.memoryDbPath = vars['GRAPHITI_DB_PATH'];
      }

      if (vars['ENABLE_FANCY_UI']?.toLowerCase() === 'false') {
        config.enableFancyUi = false;
      }

      // Populate memoryProviderConfig from .env file (embeddings only - no LLM provider)
      const embeddingProvider = vars['GRAPHITI_EMBEDDER_PROVIDER'];
      if (embeddingProvider || vars['AZURE_OPENAI_API_KEY'] ||
          vars['VOYAGE_API_KEY'] || vars['GOOGLE_API_KEY'] || vars['OLLAMA_BASE_URL']) {
        config.memoryProviderConfig = {
          embeddingProvider: (embeddingProvider as 'openai' | 'voyage' | 'azure_openai' | 'ollama' | 'google') || 'ollama',
          // OpenAI Embeddings
          openaiApiKey: vars['OPENAI_API_KEY'],
          openaiEmbeddingModel: vars['OPENAI_EMBEDDING_MODEL'],
          // Azure OpenAI Embeddings
          azureOpenaiApiKey: vars['AZURE_OPENAI_API_KEY'],
          azureOpenaiBaseUrl: vars['AZURE_OPENAI_BASE_URL'],
          azureOpenaiEmbeddingDeployment: vars['AZURE_OPENAI_EMBEDDING_DEPLOYMENT'],
          // Voyage Embeddings
          voyageApiKey: vars['VOYAGE_API_KEY'],
          voyageEmbeddingModel: vars['VOYAGE_EMBEDDING_MODEL'],
          // Google Embeddings
          googleApiKey: vars['GOOGLE_API_KEY'],
          googleEmbeddingModel: vars['GOOGLE_EMBEDDING_MODEL'],
          // Ollama Embeddings
          ollamaBaseUrl: vars['OLLAMA_BASE_URL'],
          ollamaEmbeddingModel: vars['OLLAMA_EMBEDDING_MODEL'],
          ollamaEmbeddingDim: vars['OLLAMA_EMBEDDING_DIM'] ? parseInt(vars['OLLAMA_EMBEDDING_DIM'], 10) : undefined,
          // LadybugDB
          database: vars['GRAPHITI_DATABASE'],   // env key kept for backward compat
          dbPath: vars['GRAPHITI_DB_PATH'],        // env key kept for backward compat
        };
      }

      // MCP Server Configuration (per-project overrides)
      // Default: context7=true, electron/chrome-devtools=false
      config.mcpServers = {
        context7Enabled: vars['CONTEXT7_ENABLED']?.toLowerCase() !== 'false', // default true
        memoryEnabled: config.memoryEnabled, // follows GRAPHITI_ENABLED
        electronEnabled: vars['ELECTRON_MCP_ENABLED']?.toLowerCase() === 'true', // default false
        chromeDevtoolsEnabled: vars['CHROME_DEVTOOLS_MCP_ENABLED']?.toLowerCase() === 'true', // default false
        chromeDevtoolsWebmcp: vars['CHROME_DEVTOOLS_WEBMCP']?.toLowerCase() === 'true', // default false
        chromeDevtoolsExecutable: vars['CHROME_DEVTOOLS_EXECUTABLE'] || undefined,
        chromeDevtoolsSecureOrigins: vars['CHROME_DEVTOOLS_SECURE_ORIGINS'] || undefined,
      };

      // Parse per-agent MCP overrides (AGENT_MCP_<agent>_ADD/REMOVE)
      const agentMcpOverrides: Record<string, { add?: string[]; remove?: string[] }> = {};
      Object.entries(vars).forEach(([key, value]) => {
        if (key.startsWith('AGENT_MCP_') && key.endsWith('_ADD')) {
          const agentId = key.replace('AGENT_MCP_', '').replace('_ADD', '');
          if (!agentMcpOverrides[agentId]) agentMcpOverrides[agentId] = {};
          agentMcpOverrides[agentId].add = value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (key.startsWith('AGENT_MCP_') && key.endsWith('_REMOVE')) {
          const agentId = key.replace('AGENT_MCP_', '').replace('_REMOVE', '');
          if (!agentMcpOverrides[agentId]) agentMcpOverrides[agentId] = {};
          agentMcpOverrides[agentId].remove = value.split(',').map(s => s.trim()).filter(Boolean);
        }
      });

      if (Object.keys(agentMcpOverrides).length > 0) {
        config.agentMcpOverrides = agentMcpOverrides;
      }

      // Parse custom MCP servers (user-defined)
      if (vars['CUSTOM_MCP_SERVERS']) {
        try {
          config.customMcpServers = JSON.parse(vars['CUSTOM_MCP_SERVERS']);
        } catch {
          // Invalid JSON, ignore
          config.customMcpServers = [];
        }
      }

      // zeenha fork: approval state of what the file declares. Servers that fail
      // validation or variable expansion have no entry: shown as not launchable.
      const trust = describeProjectMcpTrust(project.path, project.autoBuildPath, getApprovals(project.path));
      config.customMcpServerTrust = Object.fromEntries(
        trust.servers.map((t) => [t.server.id, { approved: t.approved, hash: t.hash }])
      );
      if (trust.chromeExecutable) config.chromeDevtoolsExecutableApproved = trust.chromeExecutable.approved;
      config.envTrackedByGit = isAutoBuildEnvTrackedByGit(project.path, project.autoBuildPath);

      return { success: true, data: config };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ENV_UPDATE,
    async (_, projectId: string, config: Partial<ProjectEnvConfig>): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const envPath = path.join(project.path, project.autoBuildPath, '.env');

      try {
        // Read existing content if file exists (atomic read, no TOCTOU)
        let existingContent: string | undefined;
        try {
          existingContent = readFileSync(envPath, 'utf-8');
        } catch (readErr: unknown) {
          if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') throw readErr;
          // File doesn't exist yet - existingContent stays undefined
        }

        // zeenha fork: diff rule. A server the user adds or edits on this page has a
        // hash that did not exist before the write, so it is approved with no extra
        // step. Servers already in the file (e.g. committed by a hostile repo) keep
        // their hash, so saving unrelated settings never approves them. Same rule
        // for the Chrome executable: approved only when its value changed.
        const before = describeProjectMcpTrust(project.path, project.autoBuildPath, undefined);

        // Generate new content
        const newContent = generateEnvContent(config, existingContent);

        // Write to file
        // zeenha fork: this file holds integration tokens (GitHub, GitLab, ...).
        // Agents are kept away from it by path containment, the credential-path
        // validators and the OS sandbox; owner-only mode is defence in depth.
        // Long-term plan: move tokens to the encrypted store
        // (claude-profile/token-encryption.ts).
        writeFileSync(envPath, newContent, { encoding: 'utf-8', mode: 0o600 });
        try {
          // mode only applies on creation; chmod covers existing files (no-op on Windows)
          chmodSync(envPath, 0o600);
        } catch {
          // best-effort
        }

        const after = describeProjectMcpTrust(project.path, project.autoBuildPath, undefined);
        const knownHashes = new Set(before.servers.map((t) => t.hash));
        for (const t of after.servers) {
          if (!knownHashes.has(t.hash)) approveServer(project.path, t.hash);
        }
        if (after.chromeExecutable && after.chromeExecutable.path !== before.chromeExecutable?.path) {
          approveChromeExecutable(project.path, after.chromeExecutable.path);
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update .env file'
        };
      }
    }
  );

}
