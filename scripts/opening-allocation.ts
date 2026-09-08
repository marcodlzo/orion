/**
 * Seed opening ledger balances from a reviewed Plaid snapshot.
 *
 *   npm run funding:opening          DRY RUN — posts nothing
 *   npm run funding:opening:commit   actually post
 *
 * READ THIS BEFORE RUNNING IT. This is the only thing in the system that
 * creates money. Everything else moves money that already exists.
 *
 * WHAT IT IS NOT. It is not a deposit. A Plaid balance says what the EXTERNAL
 * bank holds for that customer; it is not money Orion received. The posting is
 * therefore booked as an OPENING ALLOCATION against an equity account, carries
 * the snapshot it came from, and is distinguishable from real funding forever by
 * its transaction kind.
 *
 * Describing the result as "the customer deposited" would be false, and the
 * whole point of the shape is that nobody has to take that on trust: the ledger
 * says which it was.
 *
 * ONCE PER SOURCE. The reference is the snapshot digest, and a unique index
 * refuses a second posting for it. Re-running is safe and reports what already
 * exists; it does not top anybody up.
 *
 * See docs/adr/0002-cutover-accounting-model.md.
 */
import { createHash } from "node:crypto";

import { closePool, withTransaction } from "../lib/db/pool";
import { findCustomerByUserDocumentId } from "../lib/db/repositories/banking-customers.repository";
import { balanceOf, ensureCustomerAccount } from "../lib/db/repositories/ledger.repository";
import { allocateOpening } from "../lib/funding/opening-allocation";
import {
  readAllLegacyBanks,
  readAllLegacyUsers,
} from "../lib/migration/appwrite-source";
import { plaidClient } from "../lib/plaid";
import { toMinorUnits } from "../lib/plaid-sync/adapter";

/** The relationship reads back as the user document id. */
function ownerDocumentId(bank: Record<string, unknown>): string {
  const raw = bank.userId;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "$id" in raw) {
    return String((raw as { $id: unknown }).$id);
  }
  return "";
}

async function main(): Promise<number> {
  const commit = process.argv.includes("--commit");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }

  const users = await readAllLegacyUsers();
  const banks = await readAllLegacyBanks();

  // One Plaid call per Item, not per bank record: several bank records can back
  // the same Item, and asking twice would double-count the same balance.
  const tokenByItem = new Map<string, string>();
  for (const bank of banks.documents) {
    const itemId = String(bank.bankId ?? "");
    const token = String(bank.accessToken ?? "");
    if (itemId && token && !tokenByItem.has(itemId)) tokenByItem.set(itemId, token);
  }

  /** account_id -> available balance in exact minor units. */
  const balanceByAccount = new Map<string, number>();
  for (const token of Array.from(tokenByItem.values())) {
    try {
      const response = await plaidClient.accountsGet({ access_token: token });
      for (const account of response.data.accounts) {
        if (account.type !== "depository") continue;
        // `available` is what can actually be drawn on; `current` includes
        // pending credits the bank has not released.
        const dollars = account.balances.available ?? account.balances.current;
        if (dollars === null || dollars === undefined) continue;
        // Through the decimal representation, never `dollars * 100`.
        balanceByAccount.set(account.account_id, toMinorUnits(dollars));
      }
    } catch {
      // Code only. A Plaid error echoes the request, and the request carries
      // the access token.
      console.error("  a Plaid item could not be read; its accounts are skipped");
    }
  }

  type Proposal = {
    label: string;
    customerId: string;
    amountMinor: number;
    sourceReference: string;
    existingBalanceMinor: number;
  };
  const proposals: Proposal[] = [];
  const skipped: string[] = [];

  for (const user of users.documents) {
    const record = user as unknown as Record<string, unknown>;
    const label = `${String(record.firstName ?? "?")} <${String(record.email ?? "")}>`;

    const customer = await findCustomerByUserDocumentId(user.$id);
    if (!customer) {
      skipped.push(`${label} — not enrolled`);
      continue;
    }

    const owned = banks.documents.filter(
      (b) => ownerDocumentId(b as unknown as Record<string, unknown>) === user.$id
    );
    let amountMinor = 0;
    for (const bank of owned) {
      amountMinor += balanceByAccount.get(String(bank.accountId ?? "")) ?? 0;
    }

    if (amountMinor <= 0) {
      skipped.push(`${label} — no positive balance to allocate`);
      continue;
    }

    // The digest is over what was actually read, so a different snapshot is a
    // different source and an identical one cannot post twice.
    const digest = createHash("sha256")
      .update(`${customer.id}|${amountMinor}|${owned.map((b) => b.accountId).sort().join(",")}`)
      .digest("hex")
      .slice(0, 16);

    const account = await ensureCustomerAccount(customer.id);

    proposals.push({
      label,
      customerId: customer.id,
      amountMinor,
      sourceReference: `opening:${digest}`,
      existingBalanceMinor: await balanceOf(account.id),
    });
  }

  const money = (minor: number) =>
    `${minor < 0 ? "-" : ""}$${Math.abs(Math.trunc(minor / 100))}.${String(Math.abs(minor % 100)).padStart(2, "0")}`;

  console.log(
    [
      "────────────────────────────────────────────────────────────────",
      `Opening allocation   ${commit ? "[COMMITTED]" : "[DRY RUN — nothing is posted]"}`,
      "────────────────────────────────────────────────────────────────",
      "",
      "THIS IS NOT A DEPOSIT. It books seeded opening funds against an equity",
      "account, from a Plaid snapshot of what the EXTERNAL bank holds.",
      "",
    ].join("\n")
  );

  let posted = 0;
  let already = 0;

  for (const proposal of proposals) {
    if (!commit) {
      console.log(
        `  WOULD ALLOCATE  ${money(proposal.amountMinor).padStart(12)}  to ${proposal.label}` +
          `  (ledger now ${money(proposal.existingBalanceMinor)})`
      );
      continue;
    }

    const outcome = await withTransaction((client) =>
      allocateOpening(
        {
          customerId: proposal.customerId,
          amountMinor: proposal.amountMinor,
          sourceReference: proposal.sourceReference,
        },
        client
      )
    );

    if (outcome.kind === "posted") {
      posted += 1;
      console.log(`  ALLOCATED       ${money(proposal.amountMinor).padStart(12)}  to ${proposal.label}`);
    } else {
      already += 1;
      console.log(`  ALREADY DONE    ${money(proposal.amountMinor).padStart(12)}  to ${proposal.label}`);
    }
  }

  for (const line of skipped) console.log(`  skipped         ${line}`);

  console.log(
    [
      "",
      commit
        ? `posted ${posted}, already allocated ${already}, skipped ${skipped.length}`
        : `${proposals.length} allocation(s) proposed, ${skipped.length} skipped`,
      commit ? "" : "To apply:\n  npm run funding:opening:commit",
      "────────────────────────────────────────────────────────────────",
    ]
      .filter(Boolean)
      .join("\n")
  );

  await closePool();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `Allocation failed: ${error instanceof Error ? error.name : "unknown error"}`
    );
    process.exitCode = 1;
  });
