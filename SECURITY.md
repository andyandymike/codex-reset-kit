# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not paste account output, opaque credit IDs, authentication data, local paths, or diagnostic logs into a public issue.

If private reporting is not enabled yet, open a minimal public issue asking the maintainer for a private contact channel without including vulnerability details.

## Security boundaries

Codex Reset Kit must not read or copy Codex authentication files, browser storage, cookies, access tokens, or refresh tokens. It must not call private ChatGPT HTTP endpoints. Authentication stays inside the locally installed Codex App Server.

Redemption is limited to known personal ChatGPT plans. Workspace/enterprise and unknown future plans fail closed because this independent client has no registered enterprise compliance identity.

Treat redemption as irreversible. Reports involving duplicate consumption, selection of the wrong credit, idempotency-key reuse, misleading verification, credential exposure, or bypassed confirmation are high priority.

The local attempt journal contains an opaque credit ID and idempotency key. It must be created before sending, restricted to the local user, bound to an account fingerprint and canonical parameters, and never pasted into public reports. Account ownership uses immutable compare-and-swap revisions so a crashed send or normally returned unknown outcome cannot be bypassed by a different attempt. An uncertain journal is recovery authority; do not delete or edit it while investigating an unknown outcome.

Custom state storage must use a dedicated private subdirectory. The tool must reject a filesystem root, the home directory itself, symlinks, or an overly broad POSIX directory; it must never chmod a broad user-selected directory on the user's behalf.

The bundled Skill is intentionally non-destructive: it may inspect and prepare, but must never execute `commit`, `redeem`, or `recover`. Real redemption requires a local interactive terminal. Treat any path that restores unattended or implicit consumption as a security regression.

An old uncertain attempt must continue blocking new logical sends. After the replay deadline, only a separate local `CLOSE UNKNOWN` phrase may mark it `closed-unknown`; this action sends nothing, makes no outcome claim, and must clearly warn that it gives up future replay authority.

Automated tests and CI must use only the fake App Server fixture. Never add a repository secret, live ChatGPT account, or live redemption to the default test path.

Post-send proof must revalidate the same account before and after reading rate limits. Release workflows must build and test without OIDC permissions, publish only the reviewed tarball from the protected `npm` environment, pin Actions by full commit SHA, and include all bundled dependency notices.
