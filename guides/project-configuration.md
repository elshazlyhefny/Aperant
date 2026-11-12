# Per-Project Configuration

Besides the Settings screen, the app reads two files that belong to a single project:

- `.aperant.json` in the project root. It declares the base branch and which dependency folders task worktrees reuse.
- `.auto-claude/.env` inside the project. It holds integration keys, MCP server switches and memory settings.

## `.aperant.json`

The file is optional. A project without it behaves as before. Put it in the root of the main checkout.

```json
{
  "baseBranch": "zeenha",
  "linkDependencies": ["node_modules", "apps/desktop/node_modules"]
}
```

| Key | Type | Purpose |
|-----|------|---------|
| `baseBranch` | string | Branch that task worktrees are based on and merged back into. |
| `linkDependencies` | array of strings | Folders, relative to the project root, that each task worktree gets as links to the main checkout's folders. |

A git worktree starts without gitignored folders such as `node_modules`. Linking the folders you list lets a task's agents run the project's tests without a full install per task. Folders you do not list are left alone.

### Validation rules

- The file is read only from the main checkout, never from a task worktree. An agent's edit to its own copy therefore cannot change what gets linked. Do not "fix" this by reading the file from the worktree.
- `baseBranch` must match the safe-name pattern `^[\w][\w./-]*$`. A value that does not match is ignored.
- A `linkDependencies` entry is silently dropped if it is not a string, is empty, is an absolute path, contains a `..` segment, or resolves outside the project.
- A missing file, invalid JSON, or a value that is not a JSON object means defaults: no base branch and no links.
- A listed folder that does not exist in the main checkout is skipped.
- The link is a relative symlink, so it survives the project folder moving. On Windows it is a junction.
- If `.gitignore` does not already ignore the link, its path is added to the repository's `info/exclude` file, so an agent's `git add` does not commit it. The common `node_modules/` pattern matches directories only, not a link, which is why this is needed.
- Linking is safe to repeat on an existing worktree. A dangling link from an earlier run is replaced.

### Precedence

A valid `baseBranch` overrides the main branch value in Settings everywhere. While the file declares one, changing the main branch in Settings has no effect, because the declared value is applied again whenever the project is loaded or its settings are saved. Remove the key from `.aperant.json` to go back to the Settings value.

### Troubleshooting

If a folder you expected is missing from a task worktree, the entry was most likely dropped or misspelled. Check that it is a relative path without `..`, that it matches the real folder name, and that the folder exists in the main checkout.

> **Warning:** Never run `npm install` or `npm ci` through a linked folder. The link points at the main checkout, so the command would change the shared dependencies of every task. If a task must change dependencies, remove the links in that worktree first, then run `npm ci` there.

## `.auto-claude/.env`

The file is at `<project>/<autoBuildPath>/.env`, normally `.auto-claude/.env`. The project must be initialized, because the Settings screen cannot read or write the file for a project that has no `autoBuildPath`.

You can edit the file by hand or from the project's Settings. Saving from the Settings UI regenerates the whole file from a fixed template. Values already in the file are kept, but a key that the template does not list is not carried over, so do not store unrelated variables here. Unset keys are written as commented lines such as `# DEFAULT_BRANCH=main`.

> **Note:** The task-outcome webhook is deliberately not a key in this file (there is no `WEBHOOK_URL`). It is configured only in the app's own Settings, so a repository cannot redirect task data. See [notifications-and-webhooks.md](notifications-and-webhooks.md).

The last column says whether the Settings UI also writes the key. Every key below is one the generator writes, so for each of them the answer is yes. No key is "file only".

### General

| Key | Purpose or example | Settings UI writes it |
|-----|--------------------|-----------------------|
| `AUTO_BUILD_MODEL` | Model override, for example `claude-opus-4-6` | Yes |
| `DEFAULT_BRANCH` | Default base branch for worktree creation, for example `main`. If unset, the app detects main or master, or falls back to the current branch. | Yes |
| `ENABLE_FANCY_UI` | `true` or `false`. Only `false` turns the fancy UI off. | Yes |

### Linear

| Key | Purpose or example | Settings UI writes it |
|-----|--------------------|-----------------------|
| `LINEAR_API_KEY` | Linear API key. Setting it enables the integration. | Yes |
| `LINEAR_TEAM_ID` | Team to use | Yes |
| `LINEAR_PROJECT_ID` | Project to use | Yes |
| `LINEAR_REALTIME_SYNC` | `true` or `false` | Yes |

### GitHub

| Key | Purpose or example | Settings UI writes it |
|-----|--------------------|-----------------------|
| `GITHUB_TOKEN` | Access token. Setting it enables the integration. | Yes |
| `GITHUB_REPO` | `owner/repo` | Yes |
| `GITHUB_AUTO_SYNC` | `true` or `false` | Yes |

### GitLab

| Key | Purpose or example | Settings UI writes it |
|-----|--------------------|-----------------------|
| `GITLAB_ENABLED` | `true` or `false`. With a token present, the integration is on unless this is `false`. | Yes |
| `GITLAB_INSTANCE_URL` | `https://gitlab.com` or your own instance | Yes |
| `GITLAB_TOKEN` | Access token | Yes |
| `GITLAB_PROJECT` | `group/project` | Yes |
| `GITLAB_AUTO_SYNC` | `true` or `false` | Yes |

### MCP servers

| Key | Purpose or example | Settings UI writes it |
|-----|--------------------|-----------------------|
| `CONTEXT7_ENABLED` | Documentation lookup. On unless set to `false`. | Yes |
| `ELECTRON_MCP_ENABLED` | Electron desktop automation for QA agents. Default off. It applies only to projects detected as Electron. | Yes |
| `CHROME_DEVTOOLS_MCP_ENABLED` | Chrome DevTools browser automation for QA agents. Default off. | Yes |
| `CHROME_DEVTOOLS_EXECUTABLE` | Absolute path of the Chrome to launch. Default is the installed Chrome. | Yes |
| `CHROME_DEVTOOLS_SECURE_ORIGINS` | Comma-separated `http://` dev origins that the QA browser treats as secure contexts. Full Chrome only. | Yes |
| `CHROME_DEVTOOLS_WEBMCP` | Expose pages' WebMCP tools to QA agents. Needs Chrome 150 or later. Default off. | Yes |
| `CUSTOM_MCP_SERVERS` | JSON array of user-defined servers, for example `[{"id":"...","name":"...","type":"command|http",...}]` | Yes |

Per-agent overrides use the `AGENT_MCP_` prefix and are described in the next section.

### Memory and embeddings

Embeddings are optional, and keyword search works without them.

| Key | Purpose or example | Settings UI writes it |
|-----|--------------------|-----------------------|
| `GRAPHITI_ENABLED` | Turns the memory system on | Yes |
| `GRAPHITI_EMBEDDER_PROVIDER` | `openai`, `voyage`, `azure_openai`, `ollama` or `google` | Yes |
| `GRAPHITI_DATABASE` | Database name, for example `auto_claude_memory` | Yes |
| `GRAPHITI_DB_PATH` | Database location, for example `~/.auto-claude/memories` | Yes |
| `OPENAI_API_KEY` | OpenAI embeddings key. If unset, the Settings screen falls back to the global OpenAI key. | Yes |
| `OPENAI_EMBEDDING_MODEL` | For example `text-embedding-3-small` | Yes |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key | Yes |
| `AZURE_OPENAI_BASE_URL` | Azure OpenAI endpoint | Yes |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Embedding deployment name | Yes |
| `VOYAGE_API_KEY` | Voyage AI key | Yes |
| `VOYAGE_EMBEDDING_MODEL` | For example `voyage-3` | Yes |
| `GOOGLE_API_KEY` | Google AI key | Yes |
| `GOOGLE_EMBEDDING_MODEL` | For example `text-embedding-004` | Yes |
| `OLLAMA_BASE_URL` | For example `http://localhost:11434` | Yes |
| `OLLAMA_EMBEDDING_MODEL` | For example `embeddinggemma` | Yes |
| `OLLAMA_EMBEDDING_DIM` | For example `768` | Yes |

## Per-agent MCP overrides

You can add MCP servers to a specific agent, or remove them from it, with two keys per agent:

```
AGENT_MCP_<agent>_ADD=server1,server2
AGENT_MCP_<agent>_REMOVE=server1,server2
```

`<agent>` is an agent type from the app's agent configuration, such as `planner`, `coder`, `qa_reviewer` or `qa_fixer`. For example, to give the coder the Chrome DevTools server and take Context7 away from the QA reviewer:

```
AGENT_MCP_coder_ADD=chrome-devtools
AGENT_MCP_qa_reviewer_REMOVE=context7
```

Rules:

- Values are comma-separated server names. Spaces around names are trimmed and empty items are ignored.
- Recognized names are `context7`, `memory` (also `graphiti` and `graphiti-memory`), `electron`, and `chrome-devtools` (also `chrome`). Matching is case-insensitive.
- The id of a server defined in `CUSTOM_MCP_SERVERS` is also accepted, as written.
- A name that is not recognized is ignored.
- `ADD` skips servers the agent already has.
- `REMOVE` runs after `ADD`, so a server named in both ends up removed.
- Saving from the Settings UI replaces every `AGENT_MCP_*` line with the overrides it holds.

## Secrets

`.auto-claude/.env` can hold API keys and tokens, such as `GITHUB_TOKEN`, `GITLAB_TOKEN`, `LINEAR_API_KEY` and the embedding provider keys. Do not commit it to version control.
