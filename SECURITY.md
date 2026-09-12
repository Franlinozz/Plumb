# Security policy

Plumb contains code capable of placing leveraged perpetual-futures orders. Treat changes to the
executor, risk governor, signal publication, reconciliation, deployment units and dependency lock
as security-sensitive even when no conventional vulnerability is involved.

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
- Forward research uses `PLUMB_MODE=fake` or public, unauthenticated market endpoints. Live keys
  are not supplied until the forward evidence and canary gates in `POST_COMPETITION.md` pass.
- Nothing in this repo signs a withdrawal. The API key is provisioned trade-only; withdrawal
  permission is never enabled.

## Blast radius

The worst case must be bounded by the funds intentionally placed in the isolated trading
sub-account. The governor adds per-trade, daily-loss, notional, leverage and kill-switch limits, but
it is not insurance against exchange failure, credential compromise, gaps through stops or defects.

## Trust boundaries

- `@plumb/market` and the forward recorder have no credential or order dependency.
- `@plumb/strategy` is pure and cannot reach the executor through workspace dependencies.
- Only `@plumb/executor` may invoke Agent Trade Kit order operations.
- An order requires a published approved signal and exact client-order identity.
- A missing, malformed or ambiguous venue response fails closed and requires reconciliation.
- Discord and general webhook URLs are credentials. Store them in root-readable environment files,
  never source, command arguments or logs.

## Deployment minimums

- Run as a dedicated unprivileged user with a private state directory.
- Use a trade-only, withdrawal-disabled sub-account key and IP allowlisting.
- Keep public ASP/subscriber delivery isolated from exchange credentials.
- Pin production dependencies with `npm ci` and run `npm audit --omit=dev` before deployment.
- Never enable competition-era one-shot timers; their windows and authorisations have expired.
