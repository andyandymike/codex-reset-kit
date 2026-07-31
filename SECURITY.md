# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not paste account output, opaque credit IDs, authentication data, local paths, or diagnostic logs into a public issue.

If private reporting is not enabled yet, open a minimal public issue asking the maintainer for a private contact channel without including vulnerability details.

## Security boundaries

Codex Reset Kit must not read or copy Codex authentication files, browser storage, cookies, access tokens, or refresh tokens. It must not call private ChatGPT HTTP endpoints. Authentication stays inside the locally installed Codex App Server.

Treat redemption as irreversible. Reports involving duplicate consumption, selection of the wrong credit, idempotency-key reuse, misleading verification, credential exposure, or bypassed confirmation are high priority.

Automated tests and CI must use only the fake App Server fixture. Never add a repository secret, live ChatGPT account, or live redemption to the default test path.
