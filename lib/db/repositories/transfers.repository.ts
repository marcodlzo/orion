// Server-only. PostgreSQL write boundary for transfers.
//
// THE FIRST REPOSITORY HERE THAT A REQUEST PATH CALLS. Everything else in
// lib/db is operator tooling. The import-boundary test names this file
// explicitly as the one permitted crossing; adding a second one is a milestone
// decision, not a refactor.
import "server-only";

import type { PoolClient } from "pg";

import { query } from "../pool";
import { IdentityConflictError, toDatabaseError } from "../errors";

/** The full lifecycle. Only the first three transitions are drivable today. */
export type TransferState =
  | "requested"
  | "submitted"
  | "settled"
  | "failed"
  | "returned";

export type TransferRow = {
  id: string;
  customer_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  state: TransferState;
  amount_minor: string;
  currency: string;
  provider: string;
  provider_transfer_id: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
};

export type TransferClaim = {
  customerId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  amountMinor: number;
  currency: string;
};

/**
 * What a claim attempt found.
 *
 * `replayed` is the case that makes retry safe and is deliberately not folded
 * into `claimed`: the caller must know whether it owns this attempt or is
 * looking at someone else's completed work.
 */
export type ClaimOutcome =
  /** This call owns the attempt. Nothing has been sent to the provider yet. */
  | { kind: "claimed"; row: TransferRow }
  /** A previous attempt already resolved. Return its result; send nothing. */
  | { kind: "replayed"; row: TransferRow }
  /** A previous attempt claimed the key and never resolved. Re-drive it. */
  | { kind: "in-flight"; row: TransferRow };

async function run<T extends Record<string, unknown>>(
  client: PoolClient | undefined,
  text: string,
  params: readonly unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  if (!client) return query<T>(text, params);
  try {
    const result = await client.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    throw toDatabaseError(error);
  }
}

/**
 * Claim an idempotency key, or discover it is already claimed.
 *
 * MUST BE COMMITTED BEFORE THE PROVIDER IS CALLED. That ordering is the whole
 * mechanism: a durable claim means a process that dies mid-flight leaves
 * evidence, and the next attempt can re-send with the same key rather than
 * guessing whether money moved.
 *
 * WHAT ACTUALLY SERIALISES TWO SIMULTANEOUS CLAIMS: the unique index. An
 * INSERT that conflicts with an uncommitted row blocks until that transaction
 * resolves, so the loser cannot proceed on a half-formed view. This is proven
 * by a deterministic test that holds an uncommitted claim open.
 *
 * `FOR UPDATE` is deliberately NOT credited with that. It only holds a lock for
 * the life of the caller's transaction, and the service calls this without one,
 * where it is released at statement end. It is kept because callers that DO
 * supply a transaction — the tests, and any future multi-step claim — need the
 * row stable for its duration; it is not what makes the ordinary path safe.
 *
 * Two retries that both observe an existing `requested` row will both re-drive
 * the provider. That is safe, but not because of anything here: they carry the
 * same Idempotency-Key, and Dwolla returns the original transfer.
 *
 * A key reused with a DIFFERENT payload raises IdentityConflictError. Silently
 * replaying the original would return a result for a transfer the caller did
 * not ask for; silently accepting the new payload would let one key move two
 * different amounts.
 */
export async function claimTransfer(
  input: TransferClaim,
  client?: PoolClient
): Promise<ClaimOutcome> {
  const inserted = await run<TransferRow>(
    client,
    `INSERT INTO transfers (
       customer_id, idempotency_key, request_fingerprint,
       state, amount_minor, currency
     )
     VALUES ($1, $2, $3, 'requested', $4, $5)
     ON CONFLICT (customer_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      input.customerId,
      input.idempotencyKey,
      input.requestFingerprint,
      String(input.amountMinor),
      input.currency,
    ]
  );

  if (inserted.rows[0]) return { kind: "claimed", row: inserted.rows[0] };

  // The key was already claimed. Lock the row before deciding anything about
  // it: without FOR UPDATE two concurrent retries could both read `requested`
  // and both re-drive the provider call.
  const existing = await run<TransferRow>(
    client,
    `SELECT * FROM transfers
      WHERE customer_id = $1 AND idempotency_key = $2
      FOR UPDATE`,
    [input.customerId, input.idempotencyKey]
  );

  const row = existing.rows[0];
  if (!row) {
    // The conflicting row vanished between the INSERT and the SELECT. Nothing
    // sensible can be concluded, and inventing an outcome here would be a
    // guess about money.
    throw new Error(
      `idempotency key ${input.idempotencyKey} conflicted but could not be read`
    );
  }

  if (row.request_fingerprint !== input.requestFingerprint) {
    throw new IdentityConflictError({
      field: `transfers.idempotency_key=${input.idempotencyKey}`,
      stored: row.request_fingerprint,
      incoming: input.requestFingerprint,
    });
  }

  return row.state === "requested"
    ? { kind: "in-flight", row }
    : { kind: "replayed", row };
}

/**
 * Record that the provider accepted the transfer.
 *
 * ACCEPTANCE IS NOT SETTLEMENT. `submitted` means Dwolla returned a reference;
 * ACH settles over days, and the terminal states need webhooks. Nothing here
 * may write `settled`.
 *
 * Only a `requested` row advances. A row already `submitted` stays as it is and
 * is returned unchanged, so a re-drive that races the original cannot overwrite
 * a provider reference with a second one.
 */
export async function markSubmitted(
  input: { transferId: string; providerTransferId: string },
  client?: PoolClient
): Promise<TransferRow> {
  const { rows } = await run<TransferRow>(
    client,
    `UPDATE transfers
        SET state = 'submitted',
            provider_transfer_id =
              COALESCE(provider_transfer_id, $2)
      WHERE id = $1 AND state IN ('requested', 'submitted')
      RETURNING *`,
    [input.transferId, input.providerTransferId]
  );

  const row = rows[0];
  if (!row) {
    // Either the row is gone or it is in a state this transition cannot leave.
    // Both mean the caller's model of the transfer is wrong.
    throw new Error(`transfer ${input.transferId} cannot move to submitted`);
  }
  return row;
}

/**
 * Record a terminal failure.
 *
 * `failure_code` is a fixed vocabulary, never a driver or provider message:
 * those quote the request, and a Dwolla request carries funding-source URLs.
 */
export async function markFailed(
  input: { transferId: string; failureCode: string },
  client?: PoolClient
): Promise<TransferRow> {
  const { rows } = await run<TransferRow>(
    client,
    `UPDATE transfers
        SET state = 'failed', failure_code = $2
      WHERE id = $1 AND state = 'requested'
      RETURNING *`,
    [input.transferId, input.failureCode]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`transfer ${input.transferId} cannot move to failed`);
  }
  return row;
}

/** Look one up by provider reference, for reconciliation. */
export async function findTransferByProviderId(
  providerTransferId: string,
  client?: PoolClient
): Promise<TransferRow | null> {
  const { rows } = await run<TransferRow>(
    client,
    "SELECT * FROM transfers WHERE provider_transfer_id = $1",
    [providerTransferId]
  );
  return rows[0] ?? null;
}

/** Every transfer for one customer, newest first. Actor-scoped by the caller. */
export async function listTransfersForCustomer(
  customerId: string,
  client?: PoolClient
): Promise<TransferRow[]> {
  const { rows } = await run<TransferRow>(
    client,
    "SELECT * FROM transfers WHERE customer_id = $1 ORDER BY created_at DESC, id",
    [customerId]
  );
  return rows;
}
