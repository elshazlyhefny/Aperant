# Notifications and Webhooks

Aperant can post a short message to a webhook URL when a task fails, finishes and is ready for review, or is blocked. The message body is Slack-compatible. This guide covers how to set it up, what is sent, which URLs are accepted, and how delivery behaves. It ends with a short section on native desktop notifications, which are a separate feature.

## Turn it on and send a test

1. Open **Settings > App Settings > Notifications**.
2. Find the **Task outcome webhook** block.
3. Turn on **Enable webhook**. It is off by default.
4. Paste the address into **Webhook URL**. The field is masked. Use the show/hide button ("Show URL" / "Hide URL") to see what you typed.
5. Choose which events to send with the three toggles: **Review ready**, **Task failed** and **Task blocked**. All three are on by default.
6. Press **Send test message**.

The test shows one of two results:

- "Test message sent" when the receiver answered with a 2xx status.
- "Could not send the test message" when it did not.

The failure text gives no reason. The reason is in the app log (see [Delivery](#delivery)). A failing test can take about 30 seconds to report, because the app tries up to three times and each try can wait up to 10 seconds.

## Events

| Task state | Webhook event | Event label | Outcome text | UI toggle |
|------------|---------------|-------------|--------------|-----------|
| Status `error` | `failed` | Failed | Error | Task failed |
| Human review, reason `completed` | `review_ready` | Ready for review | Completed | Review ready |
| Human review, reason `qa_rejected` or `errors` | `blocked` | Blocked | Needs attention | Task blocked |
| Any other state | none | none | none | none |

Every other state sends nothing. A message is sent only when **Enable webhook** is on, the toggle for that event is on, and the saved URL is valid.

## Payload

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

- Only the project name, the task title and the outcome are sent.
- The title and the project name are cut at 200 characters. A cut value ends in an ellipsis.
- Control characters become spaces.
- `&`, `<` and `>` are escaped as `&amp;`, `&lt;` and `&gt;`.
- No task id, file path, branch name, code or error text is sent.
- If the task title is empty, the spec id is used as the title.

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

## Security: user-level only

The webhook is read only from the app's own user settings. It is never read from `.aperant.json`, `.auto-claude/.env` or any other file in a repository. A repository must not be able to send task data to an address it chooses. The same reasoning is why the `baseBranch` and `linkDependencies` settings are read only from the main checkout.

No `WEBHOOK_URL` environment key exists, and one must not be added.

The URL is masked in the field and is never logged. Treat it like a secret: anyone who has it can post messages to the channel.

## Receivers other than Slack

The body has the Slack shape, `{ text, blocks }`.

- A receiver that accepts the Slack format works directly.
- For other receivers, use the `text` field as the human-readable line and ignore `blocks`.
- If a receiver needs a different field name, put a relay or workflow in between, such as n8n or a small endpoint of your own, that maps `text` to the field the receiver expects.

The app cannot change the body shape.

## Desktop notifications

Native desktop notifications for task complete, task failed and review needed are a separate feature from the webhook. They have their own settings (per-project toggles and a sound option), and they do not use the webhook URL. Clicking a notification brings the app window to the front and opens that task.
