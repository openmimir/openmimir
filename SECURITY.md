# Security policy

Mimir controls coding agents that run commands and edit files on your machine. We take reports
seriously.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/openmimir/openmimir/security/advisories/new) with a
description, steps to reproduce, and the version (`mimir version`). We aim to reply within 72 hours.

## Security model

- The server binds to `127.0.0.1` by default.
- Requests are only trusted without pairing when they come from a loopback address **and** use a
  loopback `Host` header. This blocks DNS-rebinding attacks from web pages.
- Every `/api/*` call needs an `x-mimir-token` header. The token is only handed out to trusted or
  paired clients, and responses carry no CORS headers, so other websites cannot read it.
- The WebSocket requires the token as well.
- Other devices pair through `mimir pair`, which sets an `HttpOnly`, `SameSite=Strict` cookie.
- Approvals are tiered (`confirm` vs `screen`). Voice can never approve `screen`-tier actions
  such as pushes, deploys or deletes.
- API keys stay on the server. The browser only gets an SDP answer for its voice session, never a key.
- `~/.openmimir/config.json` is written with mode `600`.

## Supported versions

Only the latest release receives security fixes while the project is in `0.x`.
