// Server-only. Holds PLAID_CLIENT_ID and PLAID_SECRET; must never be reachable
// from a client component.
import "server-only";

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

/**
 * Hard deadline on every Plaid call, in milliseconds.
 *
 * Without one, axios waits indefinitely. `fetchAccountMetadata` catches a
 * REJECTED call, but a promise that never settles is not a rejection — it
 * stalls the whole backfill before the transaction opens, with no error, no
 * output and no way to tell a hung migration from a slow one.
 *
 * Overridable so an operator on a slow link can raise it; deliberately not
 * unbounded.
 */
const MAX_TIMEOUT_MS = 60_000;

function resolveTimeout(raw: string | undefined): number {
  if (raw === undefined) return 15_000;

  const parsed = Number(raw);
  // Every one of these silently disabled or corrupted the deadline: axios
  // treats 0 as "no timeout", NaN and negatives are meaningless, and a value
  // above the cap is indistinguishable from a hang in practice. Fail at
  // configuration load, where an operator can still see it.
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    throw new Error(
      `PLAID_TIMEOUT_MS must be a positive integer of at most ${MAX_TIMEOUT_MS} ms; received "${raw}"`
    );
  }
  return parsed;
}

const PLAID_TIMEOUT_MS = resolveTimeout(process.env.PLAID_TIMEOUT_MS);

const configuration = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    timeout: PLAID_TIMEOUT_MS,
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    }
  }
})

export const plaidClient = new PlaidApi(configuration);

/** Exposed so a test can assert the deadline exists rather than assume it. */
export const plaidRequestTimeoutMs = PLAID_TIMEOUT_MS;