# Security

Orion is a sandbox-only project under active reconstruction. It connects to
Plaid and Dwolla **sandbox** environments, is not a licensed money transmitter,
and moves no real funds.

This document is deliberately explicit about what is *not* yet secure, because
the repository is a record of fixing those things in sequence rather than a
finished product.

## Credentials in the baseline commit

**The first commit contains credentials. They are not ours, and this is
intentional.**

Commit `ba82011` — *"preserve original Horizon tutorial baseline"* — is a
byte-for-byte copy of the upstream tutorial
[`adrianhajdin/banking`](https://github.com/adrianhajdin/banking) as received.
That upstream repository is public and contains, in `constants/index.ts`:

- four Plaid **sandbox** access tokens
- a Sentry DSN belonging to the tutorial author's organisation
- tutorial account identifiers

These were removed in the following commit, `6325705`. They were also readable
from a served `.js.map` before that commit, because tree-shaking removed them
from the emitted JavaScript while leaving the source map intact — a detail worth
recording, since `hideSourceMaps` only strips the `sourceMappingURL` comment and
does not stop the map being fetched directly.

The baseline is preserved rather than scrubbed because it is the evidence:

```bash
git log -S "access-sandbox-" --oneline
```

shows exactly where they entered and where they left. Rewriting that commit would
delete the proof that the audit happened.

**No credential belonging to this project has ever been committed.** `.env.local`
is gitignored and untracked; `.env.example` contains placeholders only. CI
enforces this on every build by scanning the client bundle — source maps
included — for credential-shaped strings, and by asserting that no `.js.map`
reaches client output at all.

## Known unfixed vulnerabilities

These are documented, scheduled, and deliberately not fixed opportunistically.
They are real, and this application should not be exposed to untrusted users.

| Finding | Severity | Milestone |
|---|---|---|
| Server actions accept client-supplied identifiers with no ownership check (IDOR/BOLA) | Critical | 2 |
| `createTransfer` accepts arbitrary funding-source URLs — an account-drain primitive | Critical | 2 / 6 |
| SSN and date of birth stored in plaintext and serialized into the RSC payload | Critical | 2 |
| Bank-linking trusts a client-supplied user object | High | 2 |
| Transaction records can be forged by an unauthenticated caller | High | 2 |
| No rate limiting on authentication or money movement | Medium | 2 |
| `shareableId` is base64 encoding presented as encryption | Medium | 2 |
| No idempotency — a double-click sends two transfers | High | 6 |
| No ledger; balances read live from the provider | High | 5 |
| Provider acceptance treated as settlement | High | 7 |
| Transaction status derived from a timestamp | Medium | 7 |
| `transactionsSync` called without a cursor; results overwritten each page | High | 10 |

The test suite contains characterisation tests that assert several of these
behaviours as they currently exist, so the milestone which fixes them can prove
the change. Those tests are named `DEFECT` and are expected to fail when their
milestone lands.

## Reporting

This is a personal project and not deployed. If you find something not listed
above, please open an issue. Do not include real credentials in a report.

## Testing scope

Any security testing must use sandbox, local, or provider-test environments
only. Do not exercise findings against live provider systems or third-party
accounts.
