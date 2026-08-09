# SECURITY.md

> Stub. Expanded when the ASP is publicly reachable (Phase 9–10).

## Reporting

Security issues: open a private security advisory on
[github.com/Franlinozz/Plumb](https://github.com/Franlinozz/Plumb/security/advisories) rather than a
public issue.

## Key handling

- **No secrets in the repo, ever.** `.env` is gitignored; `.env.example` carries names and shapes
  only, never values.
- Exchange credentials are a **sub-account API key only — never the main account**. The sub-account
  holds exactly the competition capital and nothing else.
- Secrets reach the running process through the environment (`EnvironmentFile` under systemd), never
  through a committed file, a CLI argument, or a log line.
- Live keys **do not exist before Phase 9**. Everything up to that point runs in `PLUMB_MODE=fake`
  or against public, unauthenticated market endpoints.
- Nothing in this repo signs a withdrawal. The API key is provisioned trade-only; withdrawal
  permission is never enabled.

## Blast radius

The worst case Plumb can reach on its own is losing the 400 USDT in the sub-account, and the risk
governor exists to make even that require a chain of failures: per-trade risk is 4 USDT, the daily
loss limit is 20 USDT, and the kill switch halts permanently at 335 USDT equity.
