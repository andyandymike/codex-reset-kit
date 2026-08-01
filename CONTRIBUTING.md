# Contributing

Thanks for helping make Codex Reset Kit safer and easier to use.

## Development setup

Use Node.js 22 or 24 and npm. Install without dependency lifecycle scripts:

```sh
npm ci --ignore-scripts
npm run audit
npm run check
npm run package:smoke
```

Keep the runtime dependency budget to `cross-spawn` and `zod` unless a pull request demonstrates a concrete security or maintenance benefit.

## Safety rules

- Keep `list` and `doctor` strictly read-only.
- Resolve every selector to an exact supported ID before confirmation; do not add service-selected redemption.
- Keep CLI irreversible commands local-TTY-only. Remote redemption may run only through the destructive MCP tools after host approval and the bound form elicitation. Do not add `--yes` or caller-supplied idempotency keys.
- Persist the account-bound intent and idempotency key before a consume request can be sent.
- Preserve the append-only compare-and-swap account lock; never delete-and-recreate a stale lock around a send.
- Preserve one key and canonical parameter set across recovery of the same journaled attempt.
- Keep unknown ownership until same-attempt recovery, or an explicit post-deadline `closed-unknown` TTY/form decision; never auto-abandon uncertainty.
- Fail closed when precise selection cannot be proven.
- Keep redemption limited to known personal plans until workspace client identity and compliance support are explicit.
- Treat every possibly-sent error or unknown outcome as uncertain, never as an explicit rejection.
- Verify the exact target rather than combining unrelated count and window changes.
- Bind post-send reconciliation to the same account and fail closed on account or plan drift.
- Never read credentials or call private ChatGPT endpoints.
- Never add a live-account test to `npm test` or CI.
- Add protocol fixtures and regression tests for every redemption-path change.
- Preserve accurate MCP annotations and per-tool `approval_mode = "prompt"` for redemption and recovery.
- Preserve `policy.allow_implicit_invocation: false`; the Skill may redeem only through the bundled MCP tools and must never execute CLI commit/redeem/recover or the MCP bundle through a shell.

Any runtime dependency change must update exact versions, `package-lock.json`, both third-party notice files, and the packed-artifact smoke test. Generated files under `plugins/codex-reset-kit/mcp/` and `plugins/codex-reset-kit/skills/redeem-codex-reset/` must match their sources.

See [RELEASING.md](RELEASING.md) for the fail-closed registry and protected-environment setup. A GitHub Release must not be used to bootstrap missing npm or environment configuration.
