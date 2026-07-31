# Contributing

Thanks for helping make Codex Reset Kit safer and easier to use.

## Development setup

Use Node.js 22 or 24 and npm:

```sh
npm ci
npm run check
```

Keep the runtime dependency budget to `cross-spawn` and `zod` unless a pull request demonstrates a concrete security or maintenance benefit.

## Safety rules

- Keep `list` and `doctor` strictly read-only.
- Require an explicit selector and confirmation for every redemption.
- Preserve one idempotency key across retries of the same logical attempt.
- Fail closed when precise selection cannot be proven.
- Never read credentials or call private ChatGPT endpoints.
- Never add a live-account test to `npm test` or CI.
- Add protocol fixtures and regression tests for every redemption-path change.

Run formatting, type checks, tests, the Skill bundle build, and Skill validation before submitting a change. Generated `skills/redeem-codex-reset/scripts/codex-reset.mjs` must match the TypeScript source.
