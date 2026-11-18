# Notifications and Webhooks

Aperant can post a short message to a webhook URL when a task fails, finishes and is ready for review, is blocked, or has a pull or merge request opened. The message body is sent in the format of the receiver: Slack, Microsoft Teams or Discord. This guide covers how to set it up, what is sent, which URLs are accepted, and how delivery behaves. It ends with a short section on native desktop notifications, which are a separate feature.

## Turn it on and send a test

1. Open **Settings > App Settings > Notifications**.
2. Find the **Task outcome webhook** block.
3. Turn on **Enable webhook**. It is off by default.
4. Paste the address into **Webhook URL**. The field is masked. Use the show/hide button ("Show URL" / "Hide URL") to see what you typed.
5. Choose which events to send with the four toggles: **Review ready**, **Task failed**, **Task blocked** and **PR opened**. The first three are on by default. **PR opened** is off by default, because it is the only event that sends a link (see [Payload](#payload-slack)).
6. Leave **Format** on **Auto-detect**, or pick **Slack**, **Microsoft Teams** or **Discord** (see [Formats](#formats)).
7. Press **Send test message**.

The test shows one of two results:

- "Test message sent" when the receiver answered with a 2xx status.
- "Could not send the test message" when it did not.

The test message uses the selected format. The failure text gives no reason. The reason is in the app log (see [Delivery](#delivery)). A failing test can take about 30 seconds to report, because the app tries up to three times and each try can wait up to 10 seconds.

### Per-project webhook

A project can have its own webhook URL, set in the project's **Settings > Webhook** page or suggested in its project `.env`. The page has its own **Format** setting, and `WEBHOOK_FORMAT` in the project `.env` holds the same choice (`auto`, `slack`, `teams` or `discord`). The format is a safe, non-secret value and is not part of the approval. The URL is used only after you approve the exact URL. Until then the app-wide webhook is used. See [Approving a project webhook](project-configuration.md#approving-a-project-webhook).

## Events

| Task state | Webhook event | Event label | Outcome text | UI toggle |
|------------|---------------|-------------|--------------|-----------|
| Status `error` | `failed` | Failed | Error | Task failed |
| Human review, reason `completed` | `review_ready` | Ready for review | Completed | Review ready |
| Human review, reason `qa_rejected` or `errors` | `blocked` | Blocked | Needs attention | Task blocked |
| Status `pr_created` | `pr_opened` | PR opened | Awaiting review | PR opened |
| Any other state | none | none | none | none |

`pr_opened` fires once each time a task moves into the `pr_created` state. A PR follow-up (sending a task with an open PR back to coding) does not send it again while that follow-up starts. Every other state sends nothing. A message is sent only when **Enable webhook** is on, the toggle for that event is on, and the saved URL is valid.

The same `review_ready`, `failed` and `blocked` events can also be written back as a comment on the issue a task was imported from. This is off by default, and `pr_opened` is never written back. See [issue-writeback.md](issue-writeback.md).

## Payload (Slack)

The body is JSON with a `text` line and two Slack `blocks`. This is what a Ready for review event looks like for a project named "My App" and a task titled "Add login page":

```json
{
  "text": "Aperant task ready for review: Add login page (My App)",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Ready for review*\nAdd login page" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Project*\nMy App" },
        { "type": "mrkdwn", "text": "*Outcome*\nCompleted" }
      ]
    }
  ]
}
```

| Field | Content |
|-------|---------|
| `text` | `Aperant task <event label in lower case>: <title> (<project>)`. Use this as the plain-text line. |
| `blocks[0]` | A section with the event label in bold, then the task title. |
| `blocks[1]` | A section with two fields: **Project** (the project name) and **Outcome** (Completed, Error or Needs attention). |

What is sent, and what is not:

- Only the project name, the task title and the outcome are sent. The one exception is PR opened, which also sends the PR or MR link.
- The PR link is the one place a link leaves the app. It contains the repository owner and name and the PR number, so anyone who can read the channel can see them. This is why the **PR opened** toggle is off by default.
- The title and the project name are cut at 200 characters. A cut value ends in an ellipsis.
- Control characters become spaces.
- `&`, `<` and `>` are escaped as `&amp;`, `&lt;` and `&gt;`.
- No task id, file path, branch name, code or error text is sent.
- If the task title is empty, the spec id is used as the title.

A PR opened event for the same project and a task titled "Add login page" has one extra block and a link at the end of `text`:

```json
{
  "text": "Aperant task pr opened: Add login page (My App) https://github.com/acme/my-app/pull/42",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*PR opened*\nAdd login page" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Project*\nMy App" },
        { "type": "mrkdwn", "text": "*Outcome*\nAwaiting review" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        { "type": "button", "text": { "type": "plain_text", "text": "View PR" }, "url": "https://github.com/acme/my-app/pull/42" }
      ]
    }
  ]
}
```

The link is added only when the PR URL is a valid `https://` URL without embedded credentials. Otherwise the message is sent without the `actions` block and without the URL in `text`.

The test message body is:

```json
{
  "text": "Aperant test notification: your webhook is configured correctly.",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Test notification*\nThis is a test message from Aperant." }
    }
  ]
}
```

## Formats

The **Format** setting controls the shape of the body. It has four values:

| Value | Body |
|-------|------|
| Auto-detect (default) | Chosen from the URL, see below. |
| Slack | `{ text, blocks }` |
| Microsoft Teams | An Adaptive Card in a `message` envelope |
| Discord | An `embeds` array with one embed |

Auto-detect looks only at the host and path of the URL:

| URL | Format |
|-----|--------|
| `hooks.slack.com` | Slack |
| `discord.com/api/webhooks/...` | Discord |
| `*.webhook.office.com` | Microsoft Teams |
| Power Automate workflow URLs, such as `*.logic.azure.com` and `*.powerplatform.com` | Microsoft Teams |
| Anything else | Slack |

Notes:

- Unknown hosts default to Slack, so existing setups send the same body as before.
- A Discord URL that ends in `/slack` is Discord's Slack-compatible endpoint. Auto-detect keeps the Slack body for it.
- When you force **Discord**, a trailing `/slack` or `/github` on the URL is removed, so the embed goes to the native endpoint.
- To override the detection, pick a format other than Auto-detect. Do this for a relay or a custom domain that fronts Teams or Discord.

### Microsoft Teams

The body is an Adaptive Card, as accepted by Teams Workflows (Power Automate) and Office 365 connector URLs. A Ready for review event for "My App" and "Add login page":

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "contentUrl": null,
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
          { "type": "TextBlock", "text": "Ready for review", "weight": "Bolder", "size": "Medium" },
          { "type": "TextBlock", "text": "Add login page", "wrap": true },
          {
            "type": "FactSet",
            "facts": [
              { "title": "Project", "value": "My App" },
              { "title": "Outcome", "value": "Completed" }
            ]
          }
        ]
      }
    }
  ]
}
```

The PR opened event adds an `actions` array to the card, next to `body`:

```json
"actions": [
  { "type": "Action.OpenUrl", "title": "View PR", "url": "https://github.com/acme/my-app/pull/42" }
]
```

### Discord

The body is one embed. The color depends on the event. `allowed_mentions` is empty, so a title can never ping anyone. A Ready for review event:

```json
{
  "embeds": [
    {
      "title": "Ready for review",
      "description": "Add login page",
      "color": 3066993,
      "fields": [
        { "name": "Project", "value": "My App", "inline": true },
        { "name": "Outcome", "value": "Completed", "inline": true }
      ]
    }
  ],
  "allowed_mentions": { "parse": [] }
}
```

Discord has no button. For PR opened, the link is the embed `url` and one more field:

```json
{
  "embeds": [
    {
      "title": "PR opened",
      "description": "Add login page",
      "color": 3447003,
      "url": "https://github.com/acme/my-app/pull/42",
      "fields": [
        { "name": "Project", "value": "My App", "inline": true },
        { "name": "Outcome", "value": "Awaiting review", "inline": true },
        { "name": "Pull request", "value": "https://github.com/acme/my-app/pull/42" }
      ]
    }
  ],
  "allowed_mentions": { "parse": [] }
}
```

The same rules on what is sent apply to every format: only the project name, the task title, the outcome and, for PR opened, an `https://` link. For Teams and Discord, Markdown control characters in the title and project name are escaped with a backslash instead of the Slack `&`, `<`, `>` escaping.

## URL rules

| Rule | Detail |
|------|--------|
| Scheme | Must be `https`. |
| Plain http | Allowed only for `localhost`, `127.0.0.1` and `[::1]`. |
| Credentials | A URL with an embedded username or password is rejected. |
| Length | At most 2048 characters. |
| Redirects | Refused. A URL that answers with a redirect (301, 302, 307 or 308) fails. |

The Settings screen shows an inline error for an invalid URL: "Enter a valid https:// URL (http is only allowed for localhost) without credentials."

> **Warning:** Redirects are not followed. Some webhook gateways redirect to another address, and the only trace of the failure is a log line. If the test fails and you suspect a redirect, open the URL in a tool that shows the redirect target and paste the final URL instead.

## Delivery

- Each message is sent as a `POST` with `Content-Type: application/json`.
- Each attempt times out after 10 seconds.
- There are up to 3 attempts. The app waits 500 ms after the first failure and 1 second after the second.
- Any 2xx status counts as success.
- A non-2xx status, a timeout, a network error or a redirect counts as a failure and is retried.
- Each failed attempt is logged with the event, the attempt number and the reason (the HTTP status or the error name). The URL, the request body and the response are never logged.
- Delivery runs in the background. It never changes a task's status and never blocks the app.
- There is no queue. After 3 failed attempts the message is dropped and not sent again.

## Headless runs (cli.js run)

`cli.js run` (see [CLI-USAGE.md](CLI-USAGE.md)) can send the same webhook when the run ends. It never reads the app's settings, so it has its own configuration.

Add a `webhook` key to the `--config` JSON file:

```json
{
  "webhook": {
    "url": "https://hooks.example.com/services/XXX",
    "events": { "reviewReady": true, "failed": true, "blocked": true, "prOpened": false }
  }
}
```

- `url` is the webhook address.
- `format` is optional: `auto`, `slack`, `teams` or `discord`. When it is omitted, the format is detected from the URL (see [Formats](#formats)).
- `events` is optional, and so is each toggle in it. The defaults are the same as in the app: `reviewReady`, `failed` and `blocked` on, `prOpened` off.
- The environment variable `APERANT_WEBHOOK_URL` also sets the URL. When it is set and not empty, it overrides `webhook.url` in the config file. The `events` toggles still come from the config file.

Outcome to event:

| Run outcome | Exit code | Webhook event |
|-------------|-----------|---------------|
| QA passed | 0 | `review_ready` |
| QA failed after the maximum iterations | 2 | `blocked` |
| Error | 1 | `failed` |
| The run reports a PR link | any | `pr_opened`, in addition to the event above |

The CLI does not open the PR itself. `pr_opened` is sent only when the run reports a PR link, and only if the **prOpened** toggle is on.

Everything else is the same as in the app: the [URL rules](#url-rules), the [payload](#payload-slack) and the [retries](#delivery). The project name is the name of the `--project` directory, and the task title is the first `# ` heading of the spec's `spec.md`, or the spec id when there is none.

Behaviour to know:

- The URL is never read from `.aperant.json` or `.auto-claude/.env`. Only the config file you pass and the process environment are used.
- Delivery runs before the process exits and can add up to about 30 seconds to a run when the receiver is down.
- A webhook problem never changes the exit code. An invalid URL or a failed delivery prints a line starting with `warning:` on stderr and the run result stays as it was. The URL is not printed.

## Reporting back to the issue tracker (write-back)

`cli.js run` and `cli.js serve` can also report a task's outcome back to the issue it was imported from: a comment, and for Jira an optional move to the review status. This is separate from the webhook and has its own `writeback` key in the `--config` file. Everything is off by default.

```json
{
  "writeback": {
    "github": true,
    "gitlab": false,
    "linear": false,
    "jira": {
      "enabled": true,
      "comment": true,
      "transitionOnReview": true,
      "transitionStatusName": "In Review"
    }
  }
}
```

- `github`, `gitlab` and `linear` are booleans. `jira` is an object with `enabled`, `comment`, `transitionOnReview` and `transitionStatusName` (the name of the Jira status to move the issue to).
- Credentials come from the project's `.auto-claude/.env`:
  - GitHub: `GITHUB_TOKEN` and `GITHUB_REPO`.
  - GitLab: `GITLAB_TOKEN`, `GITLAB_PROJECT` and `GITLAB_INSTANCE_URL`.
  - Linear: `LINEAR_API_KEY`.
  - Jira: `JIRA_SITE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`.
- In CI, where there is no `.auto-claude/.env`, `GITHUB_TOKEN` or `GH_TOKEN` (GitHub) and `GITLAB_TOKEN` (GitLab) are also read from the process environment.
- Only tasks imported from that issue tracker are reported. The tracker is taken from `sourceType` in the task's `task_metadata.json`. Tasks created any other way are skipped.
- `run` reports after the webhook is sent. `serve` reports once the task's final status is known.
- A run that was interrupted is not reported.
- A write-back problem never changes the exit code. A failure prints a line starting with `warning:` on stderr.

## Security: user-level only

The app-wide webhook lives only in the app's own Settings. It is never read from `.aperant.json`, the project `.env` or any other file in a repository. A repository must not be able to send task data to an address it chooses.

A repository file can only suggest a per-project URL (`WEBHOOK_URL` in the project `.env`). That suggestion is ignored until you approve the exact URL in the project's Settings, and an unapproved project URL falls back to the app-wide webhook. Project URLs cannot be loopback addresses. See [Approving a project webhook](project-configuration.md#approving-a-project-webhook).

Headless commands still never read repository files. `cli.js run` reads `APERANT_WEBHOOK_URL` from its own process environment and the `--config` file (see [Headless runs](#headless-runs-clijs-run)), never a file in the repository.

The headless daemon (`cli.js serve`) does not read the app's `settings.json`. Its webhook comes from the `webhook` key of the `--config` file you pass to it (`enabled`, `url`, `format`, `events`), which is a file you control on that machine. Unlike `cli.js run`, the daemon sends the webhook only when `enabled` is `true`, does not read `APERANT_WEBHOOK_URL`, and stops at startup with exit code 1 when the URL is invalid. It sends one message per finished task. See [Config file keys](CLI-USAGE.md#config-file-keys). The same URL rules and delivery behaviour apply.

The URL is masked in the field and is never logged. Treat it like a secret: anyone who has it can post messages to the channel.

## Receivers other than Slack, Teams and Discord

Microsoft Teams and Discord get their native body (see [Formats](#formats)). Every other receiver gets the Slack shape, `{ text, blocks }`.

- A receiver that accepts the Slack format works directly.
- For other receivers, use the `text` field as the human-readable line and ignore `blocks`.
- If a receiver needs a different field name, put a relay or workflow in between, such as n8n or a small endpoint of your own, that maps `text` to the field the receiver expects.

## Desktop notifications

Native desktop notifications for task complete, task failed and review needed are a separate feature from the webhook. They have their own settings (per-project toggles and a sound option), and they do not use the webhook URL. Clicking a notification brings the app window to the front and opens that task.
