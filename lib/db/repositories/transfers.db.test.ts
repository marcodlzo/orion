import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, getPool, query, withTransaction } from "../pool";
import { ConstraintViolationError, IdentityConflictError } from "../errors";
import { requireTestDatabase } from "../test-database";
import { upsertBankingCustomer } from "./banking-customers.repository";
import {
  claimTransfer,
  findTransferByProviderId,
  listTransfersForCustomer,
  markFailed,
  markSubmitted,
} from "./transfers.repository";

/**
 * TRANSFER IDEMPOTENCY, AGAINST A REAL SERVER.
 *
 * Idempotency is asserted BY REPLAY — issuing the same request again and
 * checking there is one financial effect — never by observing that a key row
 * exists. A key table can be perfectly populated while the provider was called
 * twice.
 */

beforeAll(() => {
  requireTestDatabase();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await query("TRUNCATE transfers, linked_accounts, banking_customers CASCADE");
});

async function seedCustomer(n = 1): Promise<string> {
  const { row } = await upsertBankingCustomer({
    appwriteAuthId: `auth-${n}`,
    appwriteUserDocumentId: `user-doc-${n}`,
  });
  return row.id;
}

const claim = (customerId: string, over: Partial<Parameters<typeof claimTransfer>[0]> = {}) => ({
  customerId,
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  requestFingerprint: "fp-abc",
  amountMinor: 10_00,
  currency: "USD",
  ...over,
});

describe("claiming an idempotency key", () => {
  it("claims a fresh key in the requested state", async () => {
    const customerId = await seedCustomer();

    const outcome = await claimTransfer(claim(customerId));

    expect(outcome.kind).toBe("claimed");
    expect(outcome.row.state).toBe("requested");
    // The provider has not been called at this point. That is the whole reason
    // the claim is committed first.
    expect(outcome.row.provider_transfer_id).toBeNull();
  });

  it("stores the amount as exact integer minor units", async () => {
    const customerId = await seedCustomer();

    const { row } = await claimTransfer(claim(customerId, { amountMinor: 123_45 }));

    // BIGINT arrives as a string from the driver, deliberately.
    expect(row.amount_minor).toBe("12345");
    expect(Number(row.amount_minor)).toBe(123_45);
  });

  it("REPLAY: a second claim of a resolved key returns the original", async () => {
    const customerId = await seedCustomer();
    const first = await claimTransfer(claim(customerId));
    await markSubmitted({
      transferId: first.row.id,
      providerTransferId: "dwolla-transfer-1",
    });

    const second = await claimTransfer(claim(customerId));

    expect(second.kind).toBe("replayed");
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.provider_transfer_id).toBe("dwolla-transfer-1");
  });

  it("REPLAY creates exactly one transfer row, not two", async () => {
    const customerId = await seedCustomer();
    const first = await claimTransfer(claim(customerId));
    await markSubmitted({
      transferId: first.row.id,
      providerTransferId: "dwolla-transfer-1",
    });

    await claimTransfer(claim(customerId));
    await claimTransfer(claim(customerId));

    // The assertion that matters: one financial effect, not "a key row exists".
    expect(await listTransfersForCustomer(customerId)).toHaveLength(1);
  });

  it("reports an unresolved previous attempt as in-flight", async () => {
    const customerId = await seedCustomer();
    const first = await claimTransfer(claim(customerId));

    // The first attempt died between claiming and hearing from the provider.
    const second = await claimTransfer(claim(customerId));

    expect(second.kind).toBe("in-flight");
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.state).toBe("requested");
  });

  it("CONFLICT: same key, different payload is rejected", async () => {
    const customerId = await seedCustomer();
    await claimTransfer(claim(customerId));

    // Never silently replayed (would answer for a transfer nobody asked for)
    // and never silently accepted (would let one key move two amounts).
    await expect(
      claimTransfer(claim(customerId, { requestFingerprint: "fp-DIFFERENT" }))
    ).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it("a conflicting claim creates no second row", async () => {
    const customerId = await seedCustomer();
    await claimTransfer(claim(customerId));

    await claimTransfer(
      claim(customerId, { requestFingerprint: "fp-DIFFERENT", amountMinor: 999_00 })
    ).catch(() => undefined);

    const rows = await listTransfersForCustomer(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_minor).toBe("1000");
  });

  it("scopes keys per customer, so one actor cannot collide with another", async () => {
    const a = await seedCustomer(1);
    const b = await seedCustomer(2);

    const first = await claimTransfer(claim(a));
    const second = await claimTransfer(claim(b));

    // Same key string, different customers: two independent transfers.
    expect(second.kind).toBe("claimed");
    expect(second.row.id).not.toBe(first.row.id);
  });
});

describe("concurrency", () => {
  it("two simultaneous claims of one key produce ONE transfer", async () => {
    const customerId = await seedCustomer();

    // Genuinely parallel, each in its own transaction so the row lock is real.
    const [first, second] = await Promise.all([
      withTransaction((client) => claimTransfer(claim(customerId), client)),
      withTransaction((client) => claimTransfer(claim(customerId), client)),
    ]);

    expect(await listTransfersForCustomer(customerId)).toHaveLength(1);
    expect(first.row.id).toBe(second.row.id);

    // Exactly one call owns the attempt; the other sees it already claimed.
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["claimed", "in-flight"]);
  });

  it("survives five simultaneous claims", async () => {
    const customerId = await seedCustomer();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTransaction((client) => claimTransfer(claim(customerId), client))
      )
    );

    expect(await listTransfersForCustomer(customerId)).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "claimed")).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.row.id)).size).toBe(1);
  });
});

describe("state transitions", () => {
  it("requested → submitted records the provider reference", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));

    const submitted = await markSubmitted({
      transferId: row.id,
      providerTransferId: "dwolla-transfer-1",
    });

    expect(submitted.state).toBe("submitted");
    expect(submitted.provider_transfer_id).toBe("dwolla-transfer-1");
  });

  it("never overwrites a provider reference already recorded", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));
    await markSubmitted({ transferId: row.id, providerTransferId: "dwolla-1" });

    // A re-drive that races the original must not replace the reference — the
    // two stores would then disagree about which provider transfer this is.
    const again = await markSubmitted({
      transferId: row.id,
      providerTransferId: "dwolla-2",
    });

    expect(again.provider_transfer_id).toBe("dwolla-1");
  });

  it("requested → failed records a code", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));

    const failed = await markFailed({
      transferId: row.id,
      failureCode: "PROVIDER_REJECTED",
    });

    expect(failed.state).toBe("failed");
    expect(failed.failure_code).toBe("PROVIDER_REJECTED");
  });

  it("REJECTS submitted → failed", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));
    await markSubmitted({ transferId: row.id, providerTransferId: "dwolla-1" });

    // Money was already handed to the provider. Marking it failed locally would
    // be a statement this system is not entitled to make.
    await expect(
      markFailed({ transferId: row.id, failureCode: "TOO_LATE" })
    ).rejects.toThrow();
  });

  it("REJECTS failed → submitted", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));
    await markFailed({ transferId: row.id, failureCode: "PROVIDER_REJECTED" });

    await expect(
      markSubmitted({ transferId: row.id, providerTransferId: "dwolla-1" })
    ).rejects.toThrow();
  });

  it("nothing here can write settled", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));
    await markSubmitted({ transferId: row.id, providerTransferId: "dwolla-1" });

    // Acceptance is not settlement. ACH settles over days and the terminal
    // states need webhooks, which is a later milestone.
    const rows = await listTransfersForCustomer(customerId);
    expect(rows.every((r) => r.state !== "settled")).toBe(true);
  });
});

describe("schema guarantees", () => {
  it("refuses a submitted row with no provider reference", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));

    // The CHECK is the last line of defence against an unreconcilable row.
    await expect(
      query("UPDATE transfers SET state = 'submitted' WHERE id = $1", [row.id])
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("refuses a zero or negative amount", async () => {
    const customerId = await seedCustomer();

    await expect(
      claimTransfer(claim(customerId, { amountMinor: 0 }))
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("refuses a currency the schema does not accept", async () => {
    const customerId = await seedCustomer();

    await expect(
      claimTransfer(claim(customerId, { currency: "GBP" }))
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("refuses an unknown state", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));

    await expect(
      query("UPDATE transfers SET state = 'teleported' WHERE id = $1", [row.id])
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("refuses two rows sharing one provider transfer id", async () => {
    const customerId = await seedCustomer();
    const a = await claimTransfer(claim(customerId));
    const b = await claimTransfer(
      claim(customerId, {
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        requestFingerprint: "fp-other",
      })
    );

    await markSubmitted({ transferId: a.row.id, providerTransferId: "dwolla-1" });

    await expect(
      markSubmitted({ transferId: b.row.id, providerTransferId: "dwolla-1" })
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("refuses to delete a customer that has transfers", async () => {
    const customerId = await seedCustomer();
    await claimTransfer(claim(customerId));

    // ON DELETE RESTRICT. Financial history must not vanish with a profile.
    await expect(
      query("DELETE FROM banking_customers WHERE id = $1", [customerId])
    ).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it("finds a transfer by its provider reference", async () => {
    const customerId = await seedCustomer();
    const { row } = await claimTransfer(claim(customerId));
    await markSubmitted({ transferId: row.id, providerTransferId: "dwolla-9" });

    expect((await findTransferByProviderId("dwolla-9"))?.id).toBe(row.id);
    expect(await findTransferByProviderId("absent")).toBeNull();
  });

  it("carries no provider credential column", async () => {
    const { rows } = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'transfers'`
    );
    const columns = rows.map((r) => r.column_name);

    for (const forbidden of [
      "funding_source_url",
      "source_funding_source_url",
      "destination_funding_source_url",
      "access_token",
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });
});

/**
 * WHAT ACTUALLY SERIALISES TWO CLAIMS, PROVEN DETERMINISTICALLY.
 *
 * The unique index, not the row lock. An INSERT conflicting with an uncommitted
 * row blocks until that transaction resolves, so a second claim cannot proceed
 * on a half-formed view of the first.
 *
 * Worth stating because the first version of this repository credited
 * `FOR UPDATE` with the serialisation. Removing `FOR UPDATE` left every test
 * green — including these — which is what exposed the claim as wrong: the lock
 * lives only as long as the caller's transaction, and the service calls
 * `claimTransfer` without one.
 *
 * A racing `Promise.all` cannot establish any of this; the timing that matters
 * may simply not occur. These hold the first transaction open deliberately.
 */
describe("claim serialisation", () => {
  it("BLOCKS a second claim until the first transaction commits", async () => {
    const customerId = await seedCustomer();
    const holder = await getPool().connect();

    try {
      await holder.query("BEGIN");
      const first = await claimTransfer(claim(customerId), holder);
      expect(first.kind).toBe("claimed");

      // Uncommitted. A second claim must not be able to conclude anything yet.
      let settled = false;
      const second = withTransaction((client) =>
        claimTransfer(claim(customerId), client)
      ).then((outcome) => {
        settled = true;
        return outcome;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        settled,
        "second claim resolved while the first was still uncommitted"
      ).toBe(false);

      await holder.query("COMMIT");
      holder.release();

      const outcome = await second;

      // It sees the committed claim rather than erroring or claiming its own.
      expect(outcome.kind).toBe("in-flight");
      expect(outcome.row.id).toBe(first.row.id);
      expect(await listTransfersForCustomer(customerId)).toHaveLength(1);
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      throw error;
    }
  });

  it("a blocked claim sees a resolved outcome, not a stale one", async () => {
    const customerId = await seedCustomer();
    const holder = await getPool().connect();

    try {
      await holder.query("BEGIN");
      const first = await claimTransfer(claim(customerId), holder);
      // The holder resolves the attempt before committing.
      await markSubmitted(
        { transferId: first.row.id, providerTransferId: "dwolla-blocked-1" },
        holder
      );

      const second = withTransaction((client) =>
        claimTransfer(claim(customerId), client)
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      await holder.query("COMMIT");
      holder.release();

      // Replayed, not in-flight: the waiter must observe the state as of the
      // commit it waited for, not as of when it started waiting.
      const outcome = await second;
      expect(outcome.kind).toBe("replayed");
      expect(outcome.row.provider_transfer_id).toBe("dwolla-blocked-1");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      throw error;
    }
  });
});
