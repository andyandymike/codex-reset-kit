# Codex Reset Kit

Safely inspect and redeem ChatGPT earned rate-limit resets for Codex from a small cross-platform CLI or an installable Codex Skill.

> [!IMPORTANT]
> Codex Reset Kit is an independent open-source project. It is not affiliated with, endorsed by, or supported by OpenAI.

The project talks only to the documented `codex app-server` JSONL interface. Codex remains responsible for account login, token refresh, and account selection. The kit never reads `auth.json`, browser cookies, or raw tokens.

## Requirements

- Node.js 22 or newer.
- A locally installed `codex` CLI with `codex app-server` support.
- Codex signed into a compatible ChatGPT-backed account.
- Network access for Codex to read the account state.

An OpenAI Platform API key is not a substitute for ChatGPT/Codex account authentication here.

## Install

After the first npm release:

```sh
npm install --global codex-reset-kit
```

From a source checkout:

```sh
npm ci
npm run build
node bin/codex-reset.js help
```

To install the Skill manually, copy `skills/redeem-codex-reset` into your Codex skills directory. The committed Skill script is a standalone bundle; end users still need Node.js 22+ and Codex CLI, but not this repository's development dependencies.

## Usage

Read-only commands never consume a reset:

```sh
codex-reset doctor
codex-reset list
codex-reset list --json
```

Redemption requires exactly one selector:

```sh
codex-reset redeem --credit-id <opaque-id>
codex-reset redeem --earliest
codex-reset redeem --expires-on 2026-08-01 --timezone Asia/Tokyo
codex-reset redeem --next
```

Interactive redemption requires typing `REDEEM`. `--yes` skips that prompt and is intended only for a caller, such as the bundled Skill, that already obtained explicit consent for the current snapshot.

`--next` is intentionally separate from precise selectors. When used, the service chooses a credit and this client cannot prove which expiration date was consumed.

### Safe recovery

Every logical redemption has a UUID idempotency key. If a consume request times out after it may have been sent, the command exits with code `12` and prints that key. Do not start a new attempt; retry the same selector with the same key:

```sh
codex-reset redeem --credit-id <printed-credit-id> \
  --idempotency-key <same-uuid>
```

If the original command used `--earliest` or `--expires-on`, recovery must switch to the exact `creditId` printed in that command's result. If the original command used `--next`, repeat `--next` with the same key. This preserves the original App Server parameters even if the live list has changed.

The client never automatically retries a consume request. It only performs bounded read-only checks after a successful consume outcome.

## Proof levels

- `verified`: one credit disappeared and an eligible rate-limit window showed a credible reset signal.
- `partial`: the service accepted the consume, but concurrent expiration or a missing signal prevents full proof.
- `unverified`: the consume may have succeeded, but a post-consume snapshot could not prove it.
- `failed`: the service explicitly rejected or could not perform the redemption.

`availableCount` is authoritative. Individual `credits` can be `null` or truncated. Exact ID, earliest, and date-based selection fail closed unless the detail snapshot is complete.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Read succeeded, or redemption was verified |
| 2 | Invalid CLI arguments |
| 3 | No compatible ChatGPT-backed Codex account |
| 4 | Detail data cannot prove the requested selection |
| 5 | No reset credit is available |
| 6 | No eligible rate-limit window can be reset |
| 7 | Confirmation missing or cancelled |
| 10 | Consume was explicitly rejected or unsupported |
| 11 | Consume succeeded but verification is incomplete |
| 12 | Consume outcome is unknown; reuse the printed key |
| 20 | Codex App Server startup or protocol failure |

## Development

```sh
npm ci
npm run check
```

The test suite never launches the real `codex` executable. Integration tests spawn `tests/fixtures/fake-app-server.mjs`, and CI has no live-account or live-redemption path.

The runtime dependency budget is intentionally small: `cross-spawn` handles Windows command shims and `zod` validates untrusted protocol responses. TypeScript, Vitest, Biome, and esbuild are development-only.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening a change involving authentication, protocol behavior, or redemption safety.

## Protocol references

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex repository](https://github.com/openai/codex/tree/main/codex-rs/app-server)

The App Server is currently marked experimental by Codex, so compatible Codex versions and protocol validation matter.

## License

MIT
