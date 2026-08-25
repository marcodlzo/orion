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
const PLAID_TIMEOUT_MS = Number(process.env.PLAID_TIMEOUT_MS ?? 15_000);

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