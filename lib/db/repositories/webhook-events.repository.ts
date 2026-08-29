// Server-only. PostgreSQL boundary for provider webhook events.
import "server-only";

import type { PoolClient } from "pg";

import { query } from "../pool";
import { toDatabaseError } from "../errors";

export type WebhookEventRow = {
  id: string;
  provider: string;
  provider_event_id: string;
  topic: string;
  payload_digest: string;
  received_at: Date;
  processed_at: Date | null;
  outcome: string | null;
};

/**
 * What claiming an event found.
 *
 * `duplicate` is separated from `retry` deliberately. A redelivery of something
 * already applied must change nothing; a redelivery of something that arrived
 * and then failed mid-apply SHOULD be retried. Collapsing them would either
 * double-apply or strand the failure forever.
 */
export type EventClaim =
  | { kind: "claimed"; row: WebhookEventRow }
  | { kind: "duplicate"; row: WebhookEventRow }
  | { kind: "retry"; row: WebhookEventRow };

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
 * Record that an event arrived, or discover it already had.
 *
 * THE UNIQUE INDEX IS THE DEDUPLICATION, not this function's control flow.
 * Dwolla retries delivery, and a retry is indistinguishable from a first
 * delivery at the HTTP layer — so "apply once" cannot be a property of the
 * handler. Two concurrent deliveries of one event race here, and the index
 * decides.
 */
export async function claimWebhookEvent(
  input: {
    providerEventId: string;
    topic: string;
    payloadDigest: string;
  },
  client?: PoolClient
): Promise<EventClaim> {
  const inserted = await run<WebhookEventRow>(
    client,
    `INSERT INTO provider_webhook_events
       (provider, provider_event_id, topic, payload_digest)
     VALUES ('dwolla', $1, $2, $3)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING *`,
    [input.providerEventId, input.topic, input.payloadDigest]
  );

  if (inserted.rows[0]) return { kind: "claimed", row: inserted.rows[0] };

  const existing = await run<WebhookEventRow>(
    client,
    `SELECT * FROM provider_webhook_events
      WHERE provider = 'dwolla' AND provider_event_id = $1`,
    [input.providerEventId]
  );

  const row = existing.rows[0];
  if (!row) {
    throw new Error(
      `webhook event ${input.providerEventId} conflicted but could not be read`
    );
  }

  // Applied already: do nothing. Arrived but never applied: let it retry.
  return row.processed_at ? { kind: "duplicate", row } : { kind: "retry", row };
}

/** Mark an event applied. `outcome` is fixed vocabulary, never a provider message. */
export async function markEventProcessed(
  input: { eventId: string; outcome: string },
  client?: PoolClient
): Promise<WebhookEventRow> {
  const { rows } = await run<WebhookEventRow>(
    client,
    `UPDATE provider_webhook_events
        SET processed_at = now(), outcome = $2
      WHERE id = $1
      RETURNING *`,
    [input.eventId, input.outcome]
  );
  if (!rows[0]) throw new Error(`webhook event ${input.eventId} not found`);
  return rows[0];
}

export async function findWebhookEvent(
  providerEventId: string,
  client?: PoolClient
): Promise<WebhookEventRow | null> {
  const { rows } = await run<WebhookEventRow>(
    client,
    `SELECT * FROM provider_webhook_events
      WHERE provider = 'dwolla' AND provider_event_id = $1`,
    [providerEventId]
  );
  return rows[0] ?? null;
}
