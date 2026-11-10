# Aperant (formerly Auto Claude)

Aperant is the current name of the product formerly called Auto Claude. It is a desktop application. All functionality is accessed through the Electron desktop UI.

## Getting Started

1. Install the app by following the [Install section of the README](../README.md#install)
2. Install and launch the application
3. Open your project (a git repository folder)
4. Connect Claude via the OAuth setup guide in the app
5. Create a task and let the agents work

## Running the App from Source

```bash
# Install dependencies
npm run install:all

# Development mode (hot reload)
npm run dev

# Production build + run
npm start
```

## Configuration

App-wide configuration is done through the app's Settings UI. Two per-project files, `.aperant.json` and `.auto-claude/.env`, also affect behaviour; see [project-configuration.md](project-configuration.md). In the Settings UI you can:

- Connect Claude accounts (OAuth or API key)
- Configure multiple provider profiles (Anthropic, OpenAI, Google, etc.)
- Turn the memory system on or off (the `memoryEnabled` setting; memory is stored locally in the app's data folder)
- Set default models and thinking budgets
- Configure Linear/GitHub/GitLab integrations
