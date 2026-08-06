# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not paste account output, opaque credit IDs, authentication data, local paths, or diagnostic logs into a public issue.

If private reporting is not enabled yet, open a minimal public issue asking the maintainer for a private contact channel without including vulnerability details.

## Security boundaries

Codex Reset Kit must not read or copy Codex authentication files, browser storage, cookies, access tokens, or refresh tokens. It must not call private ChatGPT HTTP endpoints. Authentication stays inside the locally installed Codex App Server.

Redemption is limited to known personal ChatGPT plans. Workspace/enterprise and unknown future plans fail closed because this independent client has no registered enterprise compliance identity.

Treat redemption as irreversible. Reports involving duplicate consumption, selection of the wrong credit, idempotency-key reuse, misleading verification, credential exposure, or bypassed confirmation are high priority.

The local attempt journal contains an opaque credit ID and idempotency key. It must be created before sending, restricted to the local user, bound to an account fingerprint and canonical parameters, and never pasted into public reports. The deterministic account fingerprint is pseudonymous, not anonymous; treat it as private account-linked data. Account ownership uses immutable compare-and-swap revisions so a crashed send or normally returned unknown outcome cannot be bypassed by a different attempt. An uncertain journal is recovery authority; do not delete or edit it while investigating an unknown outcome.

Custom state storage must use a dedicated private subdirectory. The tool must reject a filesystem root, the home directory itself, symlinks, or an overly broad POSIX directory; it must never chmod a broad user-selected directory on the user's behalf. New Windows installs default to `%LOCALAPPDATA%\codex-reset-kit`, while an existing legacy `~/.codex-reset-kit` remains authoritative; finding both locations must fail closed rather than overlook an uncertain attempt. A custom Windows path must remain under the current user's home or `%LOCALAPPDATA%`. The project does not claim to audit arbitrary inherited Windows ACLs, so those per-user OS directories remain part of the trust boundary.

The bundled Skill may request real redemption only through the plugin's `redeem_prepared_reset` and `recover_reset_redemption` MCP tools. Both tools must advertise `readOnlyHint: false`, `destructiveHint: true`, and `openWorldHint: false`; the plugin pins both to `approval_mode = "prompt"`. Keep `approvals_reviewer = "user"` on hosts that use this plugin.

Host approval alone is not the server-side confirmation. Immediately before a possible send, the MCP server must issue a form elicitation that displays the journaled account fingerprint, exact credit ID, and expiry and accepts only the attempt-specific phrase. Missing elicitation capability, decline, cancellation, timeout, changed binding, or a cancelled tool call must stop before sending. The initial chat request is never substituted for this confirmation.

The Skill must never run the CLI `commit`, `redeem`, or `recover` commands, execute the MCP bundle through a shell, allocate a pseudo-terminal, or synthesize an elicitation response. Local CLI redemption remains TTY-only. Treat any unattended, implicit, or alternate agent-executable consume path as a security regression.

The local stdio MCP server is authorized as the current OS user and opens no listening port. This project does not claim to defend against malicious code already running as that same user: such code could bypass this project and speak to Codex App Server directly. The boundary here is preventing accidental, stale, ambiguous, or unapproved action through Codex Reset Kit itself.

An old uncertain attempt must continue blocking new logical sends. After the replay deadline, only a separate local `CLOSE UNKNOWN` phrase may mark it `closed-unknown`; this action sends nothing, makes no outcome claim, and must clearly warn that it gives up future replay authority.

Automated tests and CI must use only the fake App Server fixture. MCP tests must prove that no fake consume occurs before the bound elicitation response and that the exact target is sent at most once. Never add a repository secret, live ChatGPT account, or live redemption to the default test path.

Post-send proof must revalidate the same account before and after reading rate limits. Release workflows must build and test without OIDC permissions, publish only the reviewed tarball from the protected `npm` environment, pin Actions by full commit SHA, and include all bundled dependency notices.
