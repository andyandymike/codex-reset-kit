# Codex Reset Kit

Inspect earned Codex rate-limit reset credits, bind one exact credit to a short-lived local intent, and redeem it only after a fresh terminal confirmation. The project provides a cross-platform CLI and a read-only/preparation Codex Skill.

> [!IMPORTANT]
> Codex Reset Kit is an independent experimental project. It is not affiliated with, endorsed by, or supported by OpenAI. The npm package has not been published yet.

The kit uses only the documented `codex app-server` JSONL interface. Codex remains responsible for login, token refresh, and account selection. The kit never reads Codex authentication files, browser storage, cookies, or raw tokens.

## Safety model

Redemption is split into an explicit state machine:

```text
inspect -> prepare a durable exact intent -> local TTY confirmation
        -> re-read and reject drift -> send once -> read-only reconciliation
```

- `list`, `doctor`, and `prepare` never consume a reset.
- `earliest` and calendar-date selectors are resolved to one exact credit ID before confirmation.
- The account fingerprint, target, expiration, reset type, authoritative count, rate-limit windows, snapshot digest, and idempotency key are bound in a private journal.
- Confirmation expires at the earlier of five minutes or the target credit's expiry. Any account, plan, target, count, or rate-limit change aborts the attempt.
- There is no `--yes`, caller-supplied idempotency key, or service-selected `--next` path.
- A request that may have been sent is never called rejected. Recovery uses only the same journaled key and exact parameters.
- `verified` requires the exact target to disappear, the authoritative count to decrease by one, and a strong non-natural rate-limit reset signal.
- Cross-process account ownership uses an append-only compare-and-swap journal. Both a crashed send and a normally returned unknown outcome retain ownership, blocking different attempts until that exact attempt is resolved.

The Codex Skill may inspect and prepare an intent, but it must never execute `commit`, `redeem`, or `recover`. A real redemption must be confirmed by the user in a local interactive terminal. A future host-approved destructive tool would be required for safe agent-executed redemption.

## Requirements

- Node.js 22 or newer.
- A locally installed Codex CLI with compatible `codex app-server` support.
- Codex signed into a ChatGPT account whose stable identity is available to App Server.
- Network access for Codex to read and update account state.

OpenAI Platform API keys, API-key accounts, workspace plans (Team, Business, Enterprise, and Education), unknown future plans, and other provider types are not accepted for redemption. Only currently known personal ChatGPT plans are allowed. Workspace use remains unsupported until the App Server client identity and compliance path are formally confirmed.

## Build from source

```sh
npm ci --ignore-scripts
npm run check
node bin/codex-reset.js help
```

After a reviewed npm release is available, this section will be updated with the published install command. Do not substitute similarly named registry packages.

Until then, run checkout examples by replacing `codex-reset` with `node bin/codex-reset.js`; no global install or `npm link` is required.

To install the Skill manually, copy `skills/redeem-codex-reset` into your Codex skills directory. End users need Node.js 22+ and Codex CLI, but not this repository's development dependencies.

## Inspect without consuming

```sh
codex-reset doctor
codex-reset list
codex-reset list --json
```

`availableCount` is authoritative. Detail rows can be absent, capped, duplicated, inconsistent, or contain future protocol values. Precise preparation fails closed unless all available supported rows can be proven.

## Redeem locally

The one-command path prepares a journal, displays the bound account and snapshot, then asks for an attempt-specific phrase:

```sh
codex-reset redeem --credit-id <opaque-id>
codex-reset redeem --earliest
codex-reset redeem --expires-on 2026-08-01 --timezone Asia/Tokyo
```

The two-step path is useful when a read-only agent prepares the intent and the user finishes locally:

```sh
codex-reset prepare --expires-on 2026-08-01 --timezone Asia/Tokyo --json
codex-reset commit --attempt <printed-attempt-id>
```

`commit` shows the exact confirmation deadline, then re-reads the account and full safety snapshot after confirmation. Drift makes the intent permanently stale; prepare a new one instead of overriding the check.

## Unknown outcomes and recovery

Every logical attempt has one idempotency key generated and fsynced before any consume request. It stays inside the local journal and is not printed into normal output.

If a request may have reached the service, exit code `12` prints only the attempt ID:

```sh
codex-reset recover --attempt <same-attempt-id>
```

Recovery first performs account-bound, read-only reconciliation. Only if completion cannot be proved does it show the account and exact target again, ask for another local TTY confirmation, and replay the exact account-bound ID/key pair. It never creates a new logical attempt. Read-only proof remains available after 24 hours, but an uncertain attempt at least 24 hours old cannot be replayed.

An old unknown attempt keeps the account blocked so a fresh key cannot silently duplicate it. After the replay deadline, `recover` may instead offer a separate `CLOSE UNKNOWN …` confirmation. Closing sends nothing and does not claim whether the old operation completed; it permanently gives up replay authority and deliberately permits future attempts. This decision returns exit `13` and is recorded as `closed-unknown`.

Attempt and account-lock journals are stored under `~/.codex-reset-kit` by default with restrictive file and directory modes where the platform supports them. A custom `CODEX_RESET_KIT_STATE_DIR` must be a dedicated subdirectory; filesystem roots, the home directory itself, symlinks, and POSIX directories accessible to other users are rejected rather than having their permissions changed. Journals contain the opaque target ID and idempotency key but no account email or authentication token. Revisions are append-only. Do not publish, edit, or casually delete an uncertain attempt journal.

## Result semantics

- `verified`: the exact target disappeared, count decreased by one, and a strong eligible window signal was observed without a natural rollover.
- `partial`: the service completed the journaled operation, but concurrency, expiry, missing details, or incomplete signals prevent full proof.
- `unverified`: the post-request state provides no sufficient proof yet.
- `failed`: a definitive non-consuming service outcome or a pre-send failure occurred.
- `closed-unknown`: after the replay deadline, the user explicitly ended recovery authority without sending or deciding the old outcome.

Exit `11` means the service completed the journaled operation but verification is incomplete. It is terminal: never create another attempt. Exit `12` means the outcome is unknown and only the printed same-attempt recovery path is allowed. Exit `13` means the user deliberately closed an old unprovable journal without deciding its outcome or sending a request. Exit `14` means completion is known or proven but the local journal could not record its terminal state; run only the printed same-attempt recovery command.

| Code | Meaning |
| ---: | --- |
| 0 | Read/preparation succeeded, or exact redemption evidence was verified |
| 2 | Invalid CLI arguments |
| 3 | Missing, unsupported, or unidentifiable ChatGPT account |
| 4 | Detail data cannot prove an exact supported target |
| 5 | Service reports no reset credit |
| 6 | Service reports no eligible window to reset |
| 7 | Local confirmation missing or cancelled |
| 8 | Prepared state changed, expired, or is concurrently locked |
| 9 | Attempt journal missing, corrupted, or in the wrong state |
| 10 | Reserved for a contractually definitive consume rejection |
| 11 | Operation completed; verification evidence is incomplete |
| 12 | Outcome unknown; use only the same journaled attempt |
| 13 | Old unknown journal deliberately closed without replay or an outcome claim |
| 14 | Completion known/proven, but local terminal journal write failed; recover the same attempt |
| 20 | App Server startup, transport, or application failure |

## Development and verification

```sh
npm ci --ignore-scripts
npm run audit
npm run check
npm run package:smoke
```

The test process sets a hard guard that accepts only the marked Node process with the exact `fake-app-server.mjs` fixture shape; a marker alone cannot authorize another executable. The fake server and unit suite validate handshake ordering, credit ID, UUID format, same-key parameter binding, append-only cross-process locking and replay, account/plan changes, account-bound reconciliation, expiry boundaries, mutation-before-timeout/RPC-error, and future outcomes. CI has no live-account or live-redemption path.

Runtime dependencies are exact-pinned. The standalone Skill includes the project `LICENSE` and notices for all bundled direct and transitive packages in `THIRD_PARTY_NOTICES`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before changing authentication, protocol, journal, confirmation, or redemption behavior.

Maintainers must complete the protected environment and npm Trusted Publishing prerequisites in [RELEASING.md](RELEASING.md) before creating a GitHub Release.

## Protocol references

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex repository](https://github.com/openai/codex/tree/main/codex-rs/app-server)

The App Server is experimental. Unknown fields may be tolerated for reads, but unknown account types, credit statuses/types, initialize shapes, and consume outcomes fail closed for redemption.

## License

Codex Reset Kit is MIT licensed. Bundled dependency notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
