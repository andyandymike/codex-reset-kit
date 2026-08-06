# Codex Reset Kit

Use an earned Codex rate-limit reset credit from your phone while your computer runs the action safely.

When you are at your computer, Codex already gives you a reset control. The gap appears when you are away and using ChatGPT/Codex Remote on mobile: you can continue the task, but you need a deliberate way to inspect, select, approve, and verify one reset credit on the connected host. Codex Reset Kit fills that gap.

> [!IMPORTANT]
> Codex Reset Kit is an independent experimental project. It is not affiliated with, endorsed by, or supported by OpenAI. The npm package has not been published yet. Remote and plugin availability can vary by Codex rollout.

## How the remote flow works

```text
phone request
  -> connected host inspects credits
  -> bind one exact account + credit + expiry in a private journal
  -> Codex asks approval for the destructive MCP tool
  -> user types an attempt-specific phrase in the Remote confirmation form
  -> host re-reads the full snapshot and rejects drift
  -> send once with one durable idempotency key
  -> reconcile and report verified / partial / unknown evidence
```

The first chat message starts the workflow; it is not the final confirmation. `check_remote_reset_setup`, `list_reset_credits`, `get_redemption_attempt`, and preparation do not consume a credit. Only the destructive `redeem_prepared_reset` or same-attempt recovery tool can send, and both advertise `destructiveHint: true`.

The plugin also requires a second, server-issued form confirmation bound to the exact account fingerprint, credit ID, expiry, confirmation deadline, and attempt ID. A cancellation, timeout, missing form capability, changed binding, account switch, plan change, credit change, count change, or rate-limit-window drift stops before the first send.

## Requirements

End users need:

- Node.js 22 or newer on the connected computer.
- A current Codex CLI and ChatGPT desktop app on that computer.
- Codex signed into a compatible personal ChatGPT account.
- The ChatGPT mobile app with Remote available and paired to the host.
- The host awake, online, and running ChatGPT desktop.

You do not need TypeScript, npm development dependencies, or a checkout after the plugin is installed. OpenAI Platform API keys, API-key accounts, workspace plans, and unknown future plan types are rejected for redemption.

Nothing is installed on the phone: Remote uses the connected host's plugin, MCP server, permissions, and Codex sign-in. If that host/client does not advertise MCP form elicitation, destructive reset tools refuse before any consume request.

## Install the GitHub plugin

This repository is also a Codex plugin marketplace:

```sh
codex plugin marketplace add andyandymike/codex-reset-kit
```

Then restart ChatGPT desktop, open **Plugins**, choose the `codex-reset-kit` marketplace, and install **Codex Reset Kit**. In Codex CLI, open `/plugins` and install it from the configured marketplace. Begin a new task after installation so the bundled Skill and MCP tools are loaded.

Before relying on it away from the computer, run this once in that new desktop task:

```text
Use $redeem-codex-reset to check whether this computer is ready for a phone Remote reset.
```

The read-only preflight checks App Server startup, the signed-in account and plan, reset-credit detail support, local journal readiness, the negotiated MCP protocol, and the bound form-confirmation capability. It does not create a missing journal directory, prepare an attempt, or consume a credit.

Keep approval review human-controlled for this irreversible workflow:

```toml
approvals_reviewer = "user"
```

The plugin itself pins `redeem_prepared_reset` and `recover_reset_redemption` to `approval_mode = "prompt"`. Its MCP server runs locally over stdio and starts the documented `codex app-server`; it does not open a listening port.

For a source checkout, build and validate first:

```sh
npm ci --ignore-scripts
npm run check
npm run package:smoke
```

## Use it from your phone

1. Open **Remote** in the ChatGPT mobile app and select the paired computer.
2. Start or continue a Codex task on that host.
3. Invoke the Skill and identify the credit you want, for example:

   ```text
   Use $redeem-codex-reset to use the Codex reset credit expiring on 2030-08-01 in Asia/Tokyo.
   ```

4. Review the returned account fingerprint, credit-ID preview and full SHA-256 identity, expiry, and confirmation deadline.
5. Approve the destructive tool call on your phone, then type the attempt-specific phrase in the bound confirmation form.
6. Wait for the verified, partial, or unknown result. If it is unknown, recover only the same attempt; never prepare a new one.

A calendar date always requires an explicit IANA time zone. If several credits match that date or share the earliest timestamp, the workflow stops and asks you to choose an exact ID.

## Safety model

- Selectors resolve to one exact credit ID before final approval.
- The account fingerprint, target, expiration, reset type, authoritative count, rate-limit windows, snapshot digest, and idempotency key are bound in a private append-only journal.
- Confirmation expires at the earlier of five minutes or the target credit's expiry.
- There is no `--yes`, caller-supplied idempotency key, service-selected target, shell confirmation, or pseudo-terminal shortcut in the Skill.
- The public library surface stays read-only/pure. Agent-executed redemption exists only as the host-approved MCP tool.
- A request that may have been sent is never called rejected. Recovery reuses only the same journaled key and exact parameters.
- `verified` requires the exact target to disappear, the authoritative count to decrease by one, and a strong non-natural rate-limit reset signal.
- A crashed or unknown send retains the account lock, preventing a different attempt from silently duplicating it.

The local stdio server is authorized as the current OS user and delegates ChatGPT authentication to Codex App Server. Codex Reset Kit never reads Codex authentication files, browser storage, cookies, raw access tokens, or refresh tokens, and it never calls private ChatGPT HTTP endpoints directly. The displayed account fingerprint is a deterministic pseudonymous hash used for binding and comparison; it is not anonymization and should not be published.

## Unknown outcomes and recovery

Every logical attempt gets one UUID idempotency key that is fsynced before any consume request and never appears in normal output.

If the result is unknown, use `$redeem-codex-reset` to inspect and recover that same attempt. Recovery first performs account-bound read-only reconciliation. Only if completion cannot be proved can it ask for a new destructive approval and replay the exact account/credit/key tuple.

After 24 hours, replay is disabled. The user may instead type a distinct `CLOSE UNKNOWN …` phrase. Closing sends nothing and does not decide whether the old request completed; it permanently gives up replay authority and deliberately permits future attempts.

New Windows installs keep journals under `%LOCALAPPDATA%\codex-reset-kit`; macOS and Linux use `~/.codex-reset-kit`. An existing Windows `~/.codex-reset-kit` remains authoritative so an uncertain recovery lock is never silently abandoned; if both default locations exist, the tool fails closed until the journals are reconciled. Journals contain an opaque credit ID and idempotency key, but no account email or authentication token. A custom `CODEX_RESET_KIT_STATE_DIR` must be a dedicated private subdirectory; filesystem roots, the home directory itself, symlinks, and overly broad POSIX directories are rejected. Windows custom paths must also stay under the current user's home or `%LOCALAPPDATA%` directory. Existing Windows ACL inheritance remains part of the local OS trust boundary.

## Local CLI

The original local CLI remains available for people sitting at the computer:

```sh
node bin/codex-reset.js doctor
node bin/codex-reset.js list
node bin/codex-reset.js redeem --credit-id <opaque-id>
```

Local `commit`, `redeem`, and `recover` still require a real interactive TTY and an attempt-specific phrase. The Skill never runs these commands; this prevents shell execution from becoming a second unattended remote path.

## Result semantics

- `verified`: exact target disappearance, count delta, and a strong eligible-window reset signal agree.
- `partial`: the service completed the journaled operation, but concurrency, expiry, missing details, or incomplete signals prevent full proof.
- `unverified`: the request may have reached the service, but current evidence cannot prove completion.
- `failed`: a definitive non-consuming outcome or a pre-send failure occurred.
- `closed-unknown`: the user explicitly ended recovery authority without sending or deciding the old outcome.

| Code | Meaning |
| ---: | --- |
| 0 | Read/preparation succeeded, or exact redemption evidence was verified |
| 2 | Invalid arguments or approval binding |
| 3 | Missing, unsupported, or unidentifiable ChatGPT account |
| 4 | Detail data cannot prove an exact supported target |
| 5 | Service reports no reset credit |
| 6 | Service reports no eligible window to reset |
| 7 | Required confirmation missing, declined, cancelled, or expired |
| 8 | Prepared state changed or is concurrently locked |
| 9 | Attempt journal missing, corrupted, or in the wrong state |
| 10 | Reserved for a contractually definitive consume rejection |
| 11 | Operation completed; verification evidence is incomplete |
| 12 | Outcome unknown; recover only the same journaled attempt |
| 13 | Old unknown journal deliberately closed without an outcome claim |
| 14 | Completion known/proven, but the terminal journal write failed |
| 20 | App Server startup, transport, or application failure |

## Development and proof boundary

```sh
npm ci --ignore-scripts
npm run audit
npm run check
npm run package:smoke
```

Automated tests hard-block any App Server executable that is not the explicitly marked `fake-app-server.mjs` fixture. The MCP integration test completes the full initialize → prepare → elicitation → exact consume → verify sequence against that fake process and proves that no send occurs before the confirmation response. CI contains no real account, secret, or live redemption path.

This means the repository proves protocol and local safety behavior with fakes. It does not claim that CI or this development session redeemed a real credit. The packed-plugin smoke test verifies that the installed MCP server exposes the read-only setup check, and the integration suite exercises that check against the fake App Server; neither is a live redemption.

Runtime dependencies are exact-pinned. The committed standalone Skill and MCP bundles include the project license and third-party notices.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [RELEASING.md](RELEASING.md) before changing authentication, MCP annotations, confirmation, protocol, journal, or redemption behavior.

## Protocol references

- [Codex Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)

The Codex App Server and plugin surfaces can evolve. Unknown protocol fields may be tolerated for reads, but unknown account types, credit statuses/types, initialize shapes, and consume outcomes fail closed for redemption.

## License

Codex Reset Kit is MIT licensed. Bundled dependency notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
