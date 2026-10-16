## WEB BROWSER VALIDATION

For web frontend applications, validate in a real browser with the **Chrome DevTools** MCP tools, when they are in your tool list. They drive a headless Chrome with a throwaway profile: no signed-in sessions, nothing persists between runs.

If no browser tools are listed, browser automation is switched off for this project (Settings → MCP Server Overview → Chrome DevTools). Say so in your report; do not claim a visual check you could not run.

Tool names may carry a server prefix (for example `mcp__aperant__navigate_page`); the part after the last `__` is the tool.

### Available Tools (most used)

| Tool | Purpose |
|------|---------|
| `list_pages` / `new_page` / `select_page` | Find the page id every other tool needs |
| `navigate_page` | Go to a URL (`type: "url"`), back, forward or reload |
| `take_snapshot` | Accessibility-tree snapshot; each element gets a `uid` |
| `click` / `fill` / `fill_form` / `hover` / `press_key` | Interact by `uid` from the latest snapshot |
| `take_screenshot` | Visual capture of the page or one element |
| `list_console_messages` / `get_console_message` | Console errors and warnings |
| `list_network_requests` / `get_network_request` | Failed or unexpected API calls |
| `resize_page` / `emulate` | Viewport width, dark mode, CPU or network throttling |
| `evaluate_script` | Run JavaScript in the page when nothing else answers the question |
| `lighthouse_audit`, `performance_start_trace` | Accessibility and performance checks |

### Validation Flow

0. **Prove the page is your code.** A dev server that was already running may serve another checkout, not your task worktree. Check which directory it serves (see the QA prompt's 4.1a) before trusting anything below. If it is not your worktree and you cannot run your own, report the browser check as NOT RUN, never PASS.

1. **Find the page:** `list_pages`, then use its id as `pageId`.
2. **Open the URL:** `navigate_page` with `{"pageId": 1, "type": "url", "url": "<dev URL>"}`. Use the dev URL the project documents; do not guess a port.
3. **Read before you act:** `take_snapshot`. Interact by `uid`, never by a guessed CSS selector. Take a new snapshot after anything that changes the page.
4. **Exercise the change:** `click`, `fill`, `fill_form` along the path the spec describes, snapshotting after each step.
5. **Check for errors:** `list_console_messages` (no new errors) and `list_network_requests` (no 4xx/5xx the change caused).
6. **Check widths:** `resize_page` to a phone width (390) and a desktop width (1440) when the change is UI.
7. **Capture evidence:** `take_screenshot` of the final state.

### Document Findings

```
BROWSER VERIFICATION:
- [Page/Component]: PASS/FAIL
  - Console errors: [list or "None"]
  - Failed requests: [list or "None"]
  - Visual check (390 / 1440): PASS/FAIL
  - Interactions: PASS/FAIL
```

### Rules

- Only open the project's own local development URLs. Never a production site, and never sign in with real credentials.
- A green test suite is not a visual check. If the browser step could not run, report it as not run.

### Handling Common Issues

**Dev Server Not Running:**
If the development server is not running or the page cannot be loaded:

1. Check the project commands listed in the PROJECT CAPABILITIES section for the dev server command
2. Start the dev server and wait for it to be ready
3. If the server cannot be started:
   - **For specs with UI changes**: This is a CRITICAL blocking issue. Mark as **REJECTED** — visual verification is mandatory for UI changes
   - **For non-UI changes**: Document as "Browser validation skipped — no UI files changed" and proceed with code-based review
