# Releasing

Publishing is intentionally disabled until both GitHub and npm are provisioned explicitly. Do not add a long-lived npm token to this repository.

## One-time setup

1. Establish ownership of `codex-reset-kit` on npm and confirm that the package repository URL is exactly `https://github.com/andyandymike/codex-reset-kit`.
2. Configure npm Trusted Publishing for GitHub user `andyandymike`, repository `codex-reset-kit`, workflow `release.yml`, environment `npm`, and the `npm publish` action.
3. Create a GitHub environment named `npm`. Add required reviewers and a deployment policy appropriate for version tags from protected `main` history.
4. Add the environment variable `NPM_RELEASE_GUARD=protected-v1` to that environment. The publish job fails closed when this marker is absent; it is not a secret and is not an authentication credential.
5. Enable private vulnerability reporting and strengthen the `main` ruleset to require pull requests and the full CI matrix before merge. Protect release tags from deletion or update.

The release verification job has no OIDC permission. Only the separate `publish` job receives `id-token: write`, after the protected environment gate, and it publishes the exact previously verified artifact.

## Release procedure

1. Run `npm ci --ignore-scripts`, `npm run audit`, `npm run check`, and `npm run package:smoke` locally.
2. Update `package.json`, `package-lock.json`, the embedded CLI version, release notes, and generated Skill bundle in one reviewed commit.
3. Merge through the protected `main` branch and wait for every required CI check.
4. Create a `v<package-version>` tag on that exact `main` commit and publish a non-prerelease GitHub Release.
5. Review the protected `npm` deployment, approve it deliberately, then verify the npm provenance and packed contents after publication.

Never publish directly from an unreviewed working tree, reuse a released version, or bypass the artifact checksum/version checks.
