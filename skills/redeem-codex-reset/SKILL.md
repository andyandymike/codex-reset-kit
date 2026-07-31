---
name: redeem-codex-reset
description: Safely inspect and redeem ChatGPT earned rate-limit resets for Codex through the bundled CLI and official Codex App Server. Use when a user asks to list Codex reset credits, find the earliest or date-specific reset, diagnose reset availability, or explicitly consume a Codex reset credit. Require a fresh read and explicit post-read confirmation before any redemption.
---

# Redeem Codex Reset

Use the bundled `scripts/codex-reset.mjs` executable. Resolve it relative to this `SKILL.md` file and invoke it with Node.js 22 or newer. Do not reproduce the App Server protocol by hand.

## Inspect

Run this for any query, inventory, expiration, or diagnostic request:

```text
node <skill-dir>/scripts/codex-reset.mjs list --json
```

Use `doctor --json` only to diagnose Codex CLI, authentication, or protocol compatibility. Treat both commands as read-only.

Report `availableCount` as authoritative. Distinguish these detail states:

- `available`: precise selection is possible.
- `partial`: some rows are missing; do not claim the earliest or date-specific credit.
- `unavailable`: only the count is known; do not identify a specific credit.
- `empty`: no detailed available credits were returned.

Never infer credit order from array position, grant time, or the service's default selection.

## Redeem

Perform these steps in order:

1. Run `list --json` immediately before redemption.
2. Resolve the requested target from the fresh snapshot.
3. Show the target ID, full expiration timestamp, time zone, current credit count, and any warning.
4. Ask the user to explicitly confirm this irreversible redemption against the shown snapshot.
5. Only after that confirmation, run exactly one matching command with `--yes --json`:

```text
node <skill-dir>/scripts/codex-reset.mjs redeem --credit-id <opaque-id> --yes --json
node <skill-dir>/scripts/codex-reset.mjs redeem --earliest --yes --json
node <skill-dir>/scripts/codex-reset.mjs redeem --expires-on <YYYY-MM-DD> --timezone <iana> --yes --json
node <skill-dir>/scripts/codex-reset.mjs redeem --next --yes --json
```

Use `--next` only when the user explicitly accepts service-side selection and understands that the specific expiration cannot be proven. If a precise request has `partial` or `unavailable` details, stop and explain the limitation; do not silently downgrade it to `--next`.

Treat only exit code `0` with `verification.status: "verified"` as fully verified. Exit code `11` means the consume outcome succeeded but verification is incomplete. Exit code `12` means the outcome is unknown: display the returned idempotency key and retry only if the user requests recovery, using the exact same key:

```text
node <skill-dir>/scripts/codex-reset.mjs redeem --credit-id <printed-credit-id> --idempotency-key <same-uuid> --yes --json
```

If the original request used `--next`, repeat `--next` with the same key. If it used `--earliest` or `--expires-on`, recover with the exact `creditId` printed by the original result. Never generate a new key for an unknown prior attempt, retry consume automatically, or try a different credit.

## Boundaries

- Never run `redeem` for a read-only or ambiguous request.
- Never inspect or copy `auth.json`, browser cookies, access tokens, or refresh tokens.
- Never call private ChatGPT HTTP endpoints or automate the UI.
- Never claim which credit was consumed when the service selected it.
- Require a locally installed `codex` CLI signed into a compatible ChatGPT-backed account.
