# Cutover preflight — 2026-09-09

The cutover has not been applied. The [accounting ADR](adr/0002-cutover-accounting-model.md)
is proposed, pending the settlement and funding choices.

`npm run db:cutover:preflight` now performs a read-only history comparison. It
checks the sender and recipient identity bridges, bank ownership, exact amount,
currency, and the existing transfer-intent fingerprint. It refuses repeated
identical payments and multiple legacy documents competing for one transfer.
Candidate matches are evidence for review, not authorization to migrate.

## Observed data

- Two Appwrite transaction documents; one transfer in the application PostgreSQL database.
- One unique matching candidate for the existing transfer.
- One legacy record rejected with `MISSING_IDENTITY`.
- A separate read confirmed the rejected record belongs to a synthetic
  `orion-e2e-…@example.com` user, whose sender and recipient bridges are absent
  from the application database. The E2E suite uses a separate PostgreSQL test
  database but the configured Appwrite project, so its provider-side fixtures
  remain visible to an application-wide Appwrite scan.

The preflight exits 1 for this unresolved source record. It neither skips the
record nor creates a financial transfer to make counts agree. Before a full
history migration, separate the E2E dataset from application data or provide an
explicit reviewed migration scope. A name prefix alone must not authorize
deleting or silently excluding records.

## Validation

Typecheck and lint passed. All 708 application tests passed, including eight new
history-matching tests and the unchanged architecture assertions. No database
migration, ledger posting, provider mutation, credential rewrite, or runtime
read-path cutover was performed in this preflight work.
