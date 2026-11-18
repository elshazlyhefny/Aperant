# Usage Monitor and Automatic Account Switching

The usage monitor shows how much of each account's quota you have used. Automatic account switching can use that data, or a rate limit or auth failure, to move work to another account. This guide covers what is measured, which settings control switching, and what each one does by default.

## What the usage monitor does

The monitor polls the usage endpoint of the active account and shows the result as a usage badge. It also refreshes the other accounts, with a cache of about 5 minutes for inactive ones. The badge and the account list update whether or not automatic switching is on. Switching is a separate step that only runs when you turn it on.

## What is measured, per provider

A profile is matched to a provider by the hostname of its base URL (an exact match or a subdomain of it).

| Provider | Matched hosts | What is shown |
|----------|---------------|---------------|
| anthropic | `api.anthropic.com` (Claude OAuth accounts) | 5-hour session % and 7-day weekly % |
| openai | `chatgpt.com`, `api.openai.com` | ChatGPT / Codex usage |
| zai | `api.z.ai`, `z.ai` | Quota percentages |
| zhipu | `open.bigmodel.cn`, `dev.bigmodel.cn`, `bigmodel.cn` | Quota percentages |
| openrouter | `openrouter.ai` | USD spend. A percentage only when the key has a spend cap |
| anything else | | Unsupported: the badge shows "Usage data unavailable" |

## Settings

Open Settings > Accounts. The section is called "Automatic Account Switching".

| Setting (as the UI shows it) | Stored as | Default | Effect |
|------------------------------|-----------|---------|--------|
| Enable automatic switching ("Master switch for all auto-swap features") | `enabled` | **Off** | Nothing below has any effect while this is off. |
| Proactive Monitoring | `proactiveSwapEnabled` | **Off** | Swap before a limit is hit, based on usage thresholds. |
| Check usage every | `usageCheckInterval` | 30 seconds | How often usage is polled. The choices are 15 seconds, 30 seconds, 1 minute and Disabled. A stored value of 0 is treated as 60 seconds when the monitor starts, so "Disabled" does not stop the usage badge from updating. |
| Session usage threshold | `sessionThreshold` | 95 | Session usage at which the account counts as exhausted. |
| Weekly usage threshold | `weeklyThreshold` | 99 | Weekly usage at which the account counts as exhausted. |
| Reactive Recovery | `autoSwitchOnRateLimit` | **Off** | Swap automatically when an unexpected rate limit is hit. |
| Auto-switch on auth failure | `autoSwitchOnAuthFailure` | **Off** | Swap automatically to another authenticated account when authentication fails. |

Things that are easy to get wrong:

- **Everything is off by default.** The master switch, proactive swapping and both reactive toggles all start off. Turning on one of them does nothing until the master switch is on.
- **A threshold trips at or above its value.** Usage of exactly 95% trips a 95 threshold. Either threshold is enough: the session threshold or the weekly threshold, whichever is reached first.
- **Proactive swapping only starts from a Claude OAuth account.** It runs only while the active profile is a Claude OAuth account. If the active profile is an API-key profile (OpenRouter, z.ai or ZHIPU key), its usage is shown but it never starts a proactive swap, even if it has a spend cap.
- **Unconfirmed API keys are used last, not never.** When choosing the next account, keys with status "rejected" are excluded. Keys not yet confirmed (no status means unverified) are tried last, after every OAuth account and every confirmed key.

## Proactive versus reactive switching

- **Proactive** swapping watches usage. When the active OAuth account reaches a threshold, the monitor moves to the best available other account before a limit is hit. It needs the master switch and "Proactive Monitoring" on.
- **Reactive** swapping happens after an agent hits a rate limit. With the master switch and "Reactive Recovery" on, the agent restarts on the best available account. If the reactive toggle is off, the manual rate-limit modal is shown instead, and you choose what to do.
- **With only one account**, there is nothing to swap to. The agent pauses until the limit resets and the interface shows a paused state rather than the manual modal.

The headless daemon (`cli.js serve`) uses these same stored settings, so what you configure in the app applies there as well.

## Pending-auth indicator

An indicator appears in the sidebar while an authentication failure is unresolved. This happens when an API key was rejected or an OAuth refresh failed.

- **Expanded sidebar:** a warning box with the title "Account needs attention", the profile name and "Click to fix".
- **Collapsed sidebar:** a small warning icon with a red dot. Hover it for the same text.

Clicking either one reopens the auth failure modal. The indicator disappears once the failure is resolved.

## OpenRouter

- **Key with a spend cap:** the percentage is used / limit. The USD amount used, the limit, the amount remaining and the reset period (daily, weekly or monthly) are shown with it.
- **Key without a cap:** only USD spend is shown. The percentage stays at 0.

Either way, an OpenRouter key never starts a proactive swap (see above), because proactive swapping only runs from a Claude OAuth account. The usage is for your information.

## Privacy

Usage requests go only to the domains the adapters allow: `api.anthropic.com`, `chatgpt.com`, `api.z.ai`, `open.bigmodel.cn` and `openrouter.ai`. Requests to any other host are blocked.

## Troubleshooting

| Symptom | Likely cause and what to do |
|---------|-----------------------------|
| "Usage data unavailable" | The base URL host is not one of the supported providers, or the usage request failed. Check the profile's base URL. |
| It never swaps | The master switch is off, or the relevant toggle is off (all default to off). Proactive swapping also needs the active profile to be a Claude OAuth account, and another account must be available (not rejected, not rate limited, under both thresholds). |
| It swaps too early | Either threshold is enough, and it trips at or above its value. Raise the session or weekly threshold. |
| Usage endpoint rate limited | After a 429 the monitor waits 10 minutes before asking again. |
| Usage endpoint failing | After a failed usage request, the monitor retries after 2 minutes. |
| Auth failure keeps coming back | After an auth failure for a profile, the monitor leaves it alone for 5 minutes. Re-authenticate the account or replace the key. A replaced key resets its status. |
