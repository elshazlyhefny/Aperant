# Windows unit tests in CI

The `test-frontend-windows` job in `.github/workflows/ci.yml` runs the unit suite
(same selection as `npm run test:unit`) on `windows-latest`. It is advisory: it
does not gate `ci-complete`.

## Reading the job summary

The last step, "Windows test summary", runs `scripts/windows-test-summary.cjs` on
the JSON report and writes to the job summary: totals, plus each failing test
with its file and message. Start there, not in the raw log.

## Skip rule

Every Windows-only skip uses `skipOnWindows(reason)` from `helpers/windows-skip.ts`:

```ts
it.skipIf(skipOnWindows('uses POSIX file modes'))('...', () => {});
```

The reason is mandatory (an empty one throws), so each skip is greppable and
justified. Never use a bare `it.skip` or an inline `process.platform` check.

## Turning a failure into a fix or a skip

1. Find the cause. Typical ones: hardcoded `/` paths, `\r\n` line endings, POSIX
   file modes, symlinks, bash-only commands, case-insensitive paths.
2. If the code under test is wrong on Windows, fix the code (use `src/main/platform/`).
3. If the test is wrong, make it portable (`path.join`, normalize separators).
4. If the behavior is POSIX-only by nature, skip it with `skipOnWindows(reason)`
   and state why.

## Promotion to a gating job

After two weeks green on `zeenha`: add `test-frontend-windows` to the `needs` of
`ci-complete` and to its result check in `ci.yml`, and remove `continue-on-error`.
