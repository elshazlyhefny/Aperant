/**
 * Project-related types
 */

export interface Project {
  id: string;
  name: string;
  path: string;
  autoBuildPath: string;
  settings: ProjectSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectSettings {
  model: string;
  memoryBackend: 'memory' | 'file';
  linearSync: boolean;
  linearTeamId?: string;
  notifications: NotificationSettings;
  /** zeenha fork: default token budget per task (input+output tokens). Unset = unlimited. */
  tokenBudget?: number;
  /** Main branch name for worktree creation (default: auto-detected or 'main') */
  mainBranch?: string;
  /** Whether newly created branches should be pushed to origin and track their remote branch (default: true) */
  pushNewBranches?: boolean;
  /** Include CLAUDE.md instructions in agent system prompt (default: true) */
  useClaudeMd?: boolean;
  /** Maximum parallel tasks allowed (default: 3) */
  maxParallelTasks?: number;
  /**
   * zeenha fork: land work only through pull requests (default: true).
   * Blocks local worktree merges and in-app PR merges. See shared/utils/landing-policy.ts.
   */
  prOnlyLanding?: boolean;
  /**
   * zeenha fork: remove a task's worktree once its PR has merged (default: true).
   * See main/worktree-auto-cleanup.ts for the checks.
   */
  autoCleanupMergedWorktrees?: boolean;
  /**
   * zeenha fork: names of environment variables an agent's Bash commands may
   * still see, even though they look like credentials (default: none). Only list
   * what a build really needs. See main/ai/security/child-env.ts.
   */
  envPassthrough?: string[];
  /**
   * zeenha fork: run agent Bash commands in an OS sandbox that hides the home
   * directory (bubblewrap on Linux, sandbox-exec on macOS, a restricted token plus a Job object on
   * Windows). 'home-hidden-no-network' also blocks network access (refused on Windows, which cannot
   * block it). Default 'off'. See main/ai/security/sandbox.ts.
   */
  bashSandbox?: 'off' | 'home-hidden' | 'home-hidden-no-network';
}

export interface NotificationSettings {
  onTaskComplete: boolean;
  onTaskFailed: boolean;
  onReviewNeeded: boolean;
  sound: boolean;
}

// ============================================
// Context Types (Project Index & Memories)
// ============================================

export interface ProjectIndex {
  project_root: string;
  project_type: 'single' | 'monorepo';
  services: Record<string, ServiceInfo>;
  infrastructure: InfrastructureInfo;
  conventions: ConventionsInfo;
}

export interface ServiceInfo {
  name: string;
  path: string;
  language?: string;
  framework?: string;
  type?: 'backend' | 'frontend' | 'worker' | 'scraper' | 'library' | 'proxy' | 'mobile' | 'desktop' | 'unknown';
  package_manager?: string;
  default_port?: number;
  entry_point?: string;
  key_directories?: Record<string, { path: string; purpose: string }>;
  dependencies?: string[];
  dev_dependencies?: string[];
  testing?: string;
  e2e_testing?: string;
  test_directory?: string;
  orm?: string;
  task_queue?: string;
  styling?: string;
  state_management?: string;
  build_tool?: string;
  // iOS/Swift specific
  apple_frameworks?: string[];
  spm_dependencies?: string[];
  dockerfile?: string;
  consumes?: string[];
  environment?: {
    detected_count: number;
    variables: Record<string, {
      type: string;
      sensitive: boolean;
      required: boolean;
    }>;
  };
  api?: {
    total_routes: number;
    routes: Array<{
      path: string;
      methods: string[];
      requires_auth?: boolean;
    }>;
  };
  database?: {
    total_models: number;
    model_names: string[];
    models: Record<string, {
      orm: string;
      fields: Record<string, unknown>;
    }>;
  };
  services?: {
    databases?: Array<{
      type?: string;
      client?: string;
    }>;
    email?: Array<{
      provider?: string;
      client?: string;
    }>;
    payments?: Array<{
      provider?: string;
      client?: string;
    }>;
    cache?: Array<{
      type?: string;
      client?: string;
    }>;
  };
  monitoring?: {
    metrics_endpoint?: string;
    metrics_type?: string;
    health_checks?: string[];
  };
}

export interface InfrastructureInfo {
  docker_compose?: string;
  docker_services?: string[];
  dockerfile?: string;
  docker_directory?: string;
  dockerfiles?: string[];
  ci?: string;
  ci_workflows?: string[];
  deployment?: string;
}

export interface ConventionsInfo {
  python_linting?: string;
  python_formatting?: string;
  js_linting?: string;
  formatting?: string;
  typescript?: boolean;
  git_hooks?: string;
}

export interface MemorySystemStatus {
  enabled: boolean;
  available: boolean;
  database?: string;
  dbPath?: string;
  embeddingProvider?: string;
  reason?: string;
  /** zeenha fork: live (not deprecated) memories stored for the asked project. */
  projectMemoryCount?: number;
}

/** zeenha fork: the local `ollama` Docker container that serves memory embeddings. */
export interface OllamaContainerStatus {
  docker: 'ok' | 'unavailable';
  /** Why Docker could not be asked (CLI missing, no socket permission…). */
  detail?: string;
  container: 'running' | 'stopped' | 'missing' | 'unknown';
  /** Docker's own state word: running, exited, restarting, paused… */
  state?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  image?: string;
  imageBytes?: number;
  /** As `docker stats` reports it: 100 = one full core. */
  cpuPercent?: number;
  /** Cores the container may use; undefined = no limit. */
  cpuLimit?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  apiReachable?: boolean;
  models?: { name: string; bytes: number }[];
  loadedModels?: { name: string; bytes: number; expiresAt?: string }[];
  /** The disk holding Docker's data (images, volumes). */
  diskFreeBytes?: number;
  diskTotalBytes?: number;
}

// Memory Infrastructure Types
export interface MemoryDatabaseStatus {
  kuzuInstalled: boolean;
  databasePath: string;
  databaseExists: boolean;
  databases: string[];
  error?: string;
}

export interface InfrastructureStatus {
  memory: MemoryDatabaseStatus;
  ready: boolean; // True if memory database is available
}

// Memory Validation Types
export interface MemoryValidationResult {
  success: boolean;
  message: string;
  details?: {
    provider?: string;
    model?: string;
    latencyMs?: number;
  };
}

export interface MemoryConnectionTestResult {
  database: MemoryValidationResult;
  llmProvider: MemoryValidationResult;
  ready: boolean;
}

// Memory Provider Types
// Embedding Providers: OpenAI, Voyage AI, Azure OpenAI, Ollama (local), Google, OpenRouter
// Note: LLM provider removed - Claude SDK handles RAG queries
export type MemoryEmbeddingProvider = 'openai' | 'voyage' | 'azure_openai' | 'ollama' | 'google' | 'openrouter';

export interface MemoryProviderConfig {
  // Embedding Provider (LLM provider removed - Claude SDK handles RAG)
  embeddingProvider: MemoryEmbeddingProvider;
  embeddingModel?: string;  // Embedding model, uses provider default if not specified

  // OpenAI Embeddings
  openaiApiKey?: string;
  openaiEmbeddingModel?: string;

  // Azure OpenAI Embeddings
  azureOpenaiApiKey?: string;
  azureOpenaiBaseUrl?: string;
  azureOpenaiEmbeddingDeployment?: string;

  // Voyage AI Embeddings
  voyageApiKey?: string;
  voyageEmbeddingModel?: string;

  // Google AI Embeddings
  googleApiKey?: string;
  googleEmbeddingModel?: string;

  // OpenRouter (multi-provider aggregator)
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;  // Default: https://openrouter.ai/api/v1
  openrouterLlmModel?: string;  // LLM model selection (e.g., 'anthropic/claude-sonnet-4')
  openrouterEmbeddingModel?: string;

  // Ollama Embeddings (local, no API key required)
  ollamaBaseUrl?: string;  // Default: http://localhost:11434
  ollamaEmbeddingModel?: string;
  ollamaEmbeddingDim?: number;

  // LadybugDB settings (embedded database - no Docker required)
  database?: string;  // Database name (default: auto_claude_memory)
  dbPath?: string;    // Database storage path (default: ~/.auto-claude/memories)
}

export interface MemoryProviderInfo {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  defaultModel: string;
  supportedModels: string[];
}

export interface MemorySystemState {
  initialized: boolean;
  database?: string;
  episodeCount: number;
  lastSessionAt?: string;
  createdAt?: string;
  errorLog: Array<{ timestamp: string; error: string }>;
}


export type MemoryType =
  | 'gotcha'
  | 'decision'
  | 'preference'
  | 'pattern'
  | 'requirement'
  | 'error_pattern'
  | 'module_insight'
  | 'prefetch_pattern'
  | 'work_state'
  | 'causal_dependency'
  | 'task_calibration'
  | 'e2e_observation'
  | 'dead_end'
  | 'work_unit_outcome'
  | 'workflow_recipe'
  | 'context_cost';

export interface RendererMemory {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  tags: string[];
  relatedFiles: string[];
  relatedModules: string[];
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  scope: 'global' | 'module' | 'work_unit' | 'session';
  source: 'agent_explicit' | 'observer_inferred' | 'qa_auto' | 'mcp_auto' | 'commit_auto' | 'user_taught';
  needsReview?: boolean;
  userVerified?: boolean;
  citationText?: string;
  pinned?: boolean;
  methodology?: string;
  deprecated?: boolean;
  // Search score (added by search results)
  score?: number;
}

// Backward compatibility alias
export type MemoryEpisode = RendererMemory;

export interface ContextSearchResult {
  content: string;
  score: number;
  type: string;
}

export interface ProjectContextData {
  projectIndex: ProjectIndex | null;
  memoryStatus: MemorySystemStatus | null;
  memoryState: MemorySystemState | null;
  recentMemories: RendererMemory[];
  isLoading: boolean;
  error?: string;
}

// Environment Configuration for project .env files
export interface ProjectEnvConfig {
  // Model Override
  autoBuildModel?: string;

  // Linear Integration
  linearEnabled: boolean;
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linearRealtimeSync?: boolean; // Enable real-time sync of new Linear tasks

  // Jira Integration
  jiraEnabled: boolean;
  jiraSiteUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  jiraProjectKey?: string;

  // GitHub Integration
  githubEnabled: boolean;
  githubToken?: string;
  githubRepo?: string; // Format: owner/repo
  githubAutoSync?: boolean; // Auto-sync issues on project load
  githubAuthMethod?: 'oauth' | 'pat'; // How the token was obtained

  // GitLab Integration
  gitlabEnabled: boolean;
  gitlabInstanceUrl?: string; // Default: https://gitlab.com, or self-hosted URL
  gitlabToken?: string;
  gitlabProject?: string; // Format: group/project or numeric ID
  gitlabAutoSync?: boolean; // Auto-sync issues on project load

  // Bitbucket Integration
  bitbucketEnabled: boolean;
  bitbucketUsername?: string;
  bitbucketToken?: string;
  bitbucketRepository?: string; // Format: workspace/repo_slug

  // Git/Worktree Settings
  defaultBranch?: string; // Base branch for worktree creation (e.g., 'main', 'develop')

  // Memory Integration (V2 - Multi-provider support)
  // Uses LadybugDB embedded database (no Docker required)
  memoryEnabled: boolean;
  memoryProviderConfig?: MemoryProviderConfig;  // Provider configuration
  // Legacy fields (still supported for backward compatibility)
  openaiApiKey?: string;
  // Indicates if the OpenAI key is from global settings (not project-specific)
  openaiKeyIsGlobal?: boolean;
  memoryDatabase?: string;
  memoryDbPath?: string;

  // UI Settings
  enableFancyUi: boolean;

  // MCP Server Configuration (per-project overrides)
  mcpServers?: {
    /** Context7 documentation lookup - default: true */
    context7Enabled?: boolean;
    /** Memory knowledge graph - default: true (if memoryProviderConfig set) */
    memoryEnabled?: boolean;
    /** Electron desktop automation (QA only) - default: false */
    electronEnabled?: boolean;
    /** Chrome DevTools browser automation (QA only) - default: false */
    chromeDevtoolsEnabled?: boolean;
    /** Absolute path of the Chrome binary to launch - default: installed Chrome */
    chromeDevtoolsExecutable?: string;
    /** Expose pages' WebMCP tools (Chrome 150+) - default: false */
    chromeDevtoolsWebmcp?: boolean;
    /** http:// dev origins the QA browser treats as secure (comma-separated) */
    chromeDevtoolsSecureOrigins?: string;
  };

  // Per-agent MCP overrides (add/remove MCPs from specific agents)
  agentMcpOverrides?: AgentMcpOverrides;

  // Custom MCP servers defined by the user
  customMcpServers?: CustomMcpServer[];
  /** zeenha fork: approval state per custom server id (absent = not launchable) */
  customMcpServerTrust?: Record<string, { approved: boolean; hash: string }>;
  /** zeenha fork: whether the declared Chrome executable is approved */
  chromeDevtoolsExecutableApproved?: boolean;
  /** zeenha fork: .auto-claude/.env is tracked by git */
  envTrackedByGit?: boolean;
}

/**
 * Per-agent MCP override configuration.
 * Stored in .auto-claude/.env as AGENT_MCP_<agent>_ADD and AGENT_MCP_<agent>_REMOVE
 */
export interface AgentMcpOverride {
  /** MCP servers to add beyond the agent's defaults */
  add?: string[];
  /** MCP servers to remove from the agent's defaults */
  remove?: string[];
}

/**
 * Map of agent type to their MCP overrides.
 * Agent types match backend AGENT_CONFIGS keys (e.g., 'planner', 'coder', 'qa_reviewer')
 */
export interface AgentMcpOverrides {
  [agentType: string]: AgentMcpOverride;
}

/**
 * Custom MCP server configuration.
 * Users can add command-based (npx/npm) or HTTP-based servers.
 */
export interface CustomMcpServer {
  /** Unique identifier (used for agent overrides: AGENT_MCP_<agent>_ADD=myserver) */
  id: string;
  /** Display name shown in UI */
  name: string;
  /** Server type */
  type: 'command' | 'http';
  /** Command to execute (for type: 'command'). e.g., 'npx', 'npm', 'node' */
  command?: string;
  /** Arguments for the command (for type: 'command'). e.g., ['-y', 'my-mcp-server'] */
  args?: string[];
  /** HTTP URL (for type: 'http'). e.g., 'https://mcp.example.com/mcp' */
  url?: string;
  /** HTTP headers (for type: 'http'). e.g., { "Authorization": "Bearer ..." } */
  headers?: Record<string, string>;
  /** Optional description shown in UI */
  description?: string;
}

/**
 * MCP server health check status.
 */
export type McpHealthStatus = 'healthy' | 'unhealthy' | 'needs_auth' | 'unknown' | 'checking';

/**
 * Result of a quick health check for a custom MCP server.
 */
export interface McpHealthCheckResult {
  /** Server ID */
  serverId: string;
  /** Health status */
  status: McpHealthStatus;
  /** HTTP status code (for HTTP servers) */
  statusCode?: number;
  /** Human-readable message */
  message?: string;
  /** Response time in milliseconds */
  responseTime?: number;
  /** Timestamp of the check */
  checkedAt: string;
}

/**
 * Result of a full MCP connection test.
 */
export interface McpTestConnectionResult {
  /** Server ID */
  serverId: string;
  /** Whether the connection was successful */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** Detailed error if any */
  error?: string;
  /** List of tools discovered (for successful connections) */
  tools?: string[];
  /** Response time in milliseconds */
  responseTime?: number;
}

// Auto Claude Initialization Types
export interface AutoBuildVersionInfo {
  isInitialized: boolean;
  updateAvailable: boolean; // Always false - .auto-claude only contains data, no code to update
}

export interface InitializationResult {
  success: boolean;
  error?: string;
}

export interface GitStatus {
  isGitRepo: boolean;
  hasCommits: boolean;
  currentBranch: string | null;
  error?: string;
}

export interface CreateProjectFolderResult {
  path: string;
  name: string;
  gitInitialized: boolean;
}

// File Explorer Types
export interface FileNode {
  path: string;
  name: string;
  isDirectory: boolean;
}

// zeenha fork: whether the OS-level Bash sandbox tool can run on this machine
export type BashSandboxMode = NonNullable<ProjectSettings['bashSandbox']>;
export type SandboxStatusKind = 'active' | 'available-off' | 'tool-missing' | 'unsupported' | 'mode-unsupported';
export interface SandboxAvailability {
  state: 'available' | 'tool-missing' | 'unsupported';
  tool: 'bwrap' | 'sandbox-exec' | 'powershell' | null;
  installHint: 'bubblewrap' | null;
  /** zeenha fork: modes this platform cannot enforce; the Bash tool refuses them (Windows: no network blocking). */
  unsupportedModes?: BashSandboxMode[];
}
