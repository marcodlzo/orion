import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { accountGet, listDocuments, accountsGet, readTransactions } = vi.hoisted(() => ({
  accountGet: vi.fn(),
  listDocuments: vi.fn(),
  accountsGet: vi.fn(),
  readTransactions: vi.fn(),
}));

const sessions = new AsyncLocalStorage<string | undefined>();
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => {
    const value = sessions.getStore();
    return value ? { value } : undefined;
  } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../appwrite", () => ({
  createSessionClient: async () => ({ account: { get: accountGet } }),
  createAdminClient: async () => ({ database: { listDocuments } }),
}));
vi.mock("../plaid", () => ({ plaidClient: { accountsGet } }));
vi.mock("./dwolla", () => ({ addFundingSource: vi.fn(), createDwollaCustomer: vi.fn() }));
vi.mock("../db/repositories/plaid-transactions.read", () => ({
  listTransactionsForOwnedAccounts: readTransactions,
}));

import { getLoggedInUser } from "../actions/user.actions";
import { requireActor } from "../auth/actor";
import { UnauthorizedError } from "../auth/errors";
import { getAccount, getAccounts } from "./banks";
import { ACCOUNT_SUMMARY_DTO_FIELDS } from "../dto/bank.dto";

// The real renderer and cache shipped with the pinned Next version, not a mock
// cache or a simulated dispatcher. Only external I/O is replaced.
const require = createRequire(import.meta.url);
const { renderToReadableStream } = require(
  "next/dist/server/future/route-modules/app-page/vendored/rsc/react-server-dom-webpack-server-edge"
) as {
  renderToReadableStream(model: unknown, manifest: object, options: {
    onError(error: unknown): void;
  }): ReadableStream<Uint8Array>;
};

async function render<T>(session: string | undefined, read: () => Promise<T>): Promise<T> {
  return sessions.run(session, async () => {
    const result: { value?: T; error?: unknown; failed?: boolean } = {};
    const model = createElement(async function Read() {
      result.value = await read();
      return null;
    });
    const stream = renderToReadableStream(model, {}, {
      onError(error) { result.error = error; result.failed = true; },
    });
    await new Response(stream).text();
    if (result.failed) throw result.error;
    return result.value as T;
  });
}

const user = (owner: string) => ({
  $id: `user-${owner}`, userId: `auth-${owner}`, dwollaCustomerId: `dwolla-${owner}`,
  firstName: owner, lastName: "Test", email: `${owner}@example.com`,
  ssn: "private-ssn", dateOfBirth: "1990-01-01",
});
const bank = (owner: string, suffix: string, item = suffix) => ({
  $id: `bank-${owner}-${suffix}`, userId: { $id: `user-${owner}` },
  accountId: `account-${owner}-${suffix}`, bankId: `item-${owner}-${item}`,
  accessToken: `test-token-${owner}-${item}`, fundingSourceUrl: "private-funding-source",
  shareableId: `share-${owner}-${suffix}`,
});
const banks = [bank("alice", "checking", "one"), bank("alice", "savings", "one"),
  bank("alice", "other", "two"), bank("bob", "checking", "one")];
const USERS = process.env.APPWRITE_USER_COLLECTION_ID;
const BANKS = process.env.APPWRITE_BANK_COLLECTION_ID;
const TRANSACTIONS = process.env.APPWRITE_TRANSACTION_COLLECTION_ID;
type Query = { attribute: string; values: string[] };
const queryValue = (queries: string[], attribute: string) =>
  queries.map((q) => JSON.parse(q) as Query).find((q) => q.attribute === attribute)?.values[0];
const callsTo = (collection: string | undefined) =>
  listDocuments.mock.calls.filter(([, id]) => id === collection);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  accountGet.mockImplementation(async () => ({ $id: `auth-${sessions.getStore()}` }));
  listDocuments.mockImplementation(async (_db: string, collection: string, queries: string[]) => {
    if (collection === USERS) {
      const owner = queryValue(queries, "userId")?.replace("auth-", "");
      return { documents: owner ? [user(owner)] : [], total: owner ? 1 : 0 };
    }
    if (collection === BANKS) {
      // Apply the actual predicates sent to Appwrite. Removing the ownership
      // predicate must expose Bob's record and fail the IDOR test below.
      const documents = banks.filter((b) =>
        queries.map((q) => JSON.parse(q) as Query).every((q) =>
          q.attribute === "userId" ? b.userId.$id === q.values[0] :
            q.attribute === "$id" ? b.$id === q.values[0] : false
        )
      );
      return { documents, total: documents.length };
    }
    if (collection === TRANSACTIONS) return { documents: [], total: 0 };
    throw new Error("Unexpected collection");
  });
  accountsGet.mockImplementation(async ({ access_token }: { access_token: string }) => ({
    data: { accounts: banks.filter((b) => b.accessToken === access_token).map((b) => ({
      account_id: b.accountId, name: b.accountId, mask: "1234", type: "depository",
      balances: { current: b.$id.includes("savings") ? 20 : 10 },
    })) },
  }));
  readTransactions.mockResolvedValue([]);
});

async function navigation() {
  const [layoutUser, pageUser, accounts] = await Promise.all([
    getLoggedInUser(), getLoggedInUser(), getAccounts(),
  ]);
  const account = await getAccount({ appwriteItemId: "bank-alice-savings" });
  return { layoutUser, pageUser, accounts, account };
}

describe("render-path round trips and isolation", () => {
  it("shares identity, profile, ownership proofs and Item balances for a complete navigation", async () => {
    const result = await render("alice", navigation);
    expect(accountGet).toHaveBeenCalledTimes(1);
    expect(callsTo(USERS)).toHaveLength(1);
    expect(callsTo(BANKS)).toHaveLength(2); // owned list + selected bank proof
    expect(callsTo(TRANSACTIONS)).toHaveLength(2); // sent + received
    expect(accountsGet).toHaveBeenCalledTimes(2); // two Items, three accounts
    expect(readTransactions).toHaveBeenCalledTimes(1);
    expect(readTransactions).toHaveBeenCalledWith(["account-alice-savings"]);
    expect(result.layoutUser).toEqual(result.pageUser);
    expect(result.accounts.data).toHaveLength(3);
    expect(result.accounts.totalCurrentBalanceMinor).toBe(4000);
    expect(result.account.data.currentBalanceMinor).toBe(2000);
    expect(result.account.data).toEqual(result.accounts.data[1]);
    expect(Object.keys(result.account.data).sort()).toEqual([...ACCOUNT_SUMMARY_DTO_FIELDS].sort());
    expect(JSON.stringify(result)).not.toMatch(/private-|test-token-|dwolla-/);
  });

  it("deduplicates simultaneous account-list reads", async () => {
    await render("alice", () => Promise.all([getAccounts(), getAccounts()]));
    expect(callsTo(BANKS)).toHaveLength(1);
    expect(accountsGet).toHaveBeenCalledTimes(2);
  });

  it("resolves identity and balances anew on a later request", async () => {
    await render("alice", navigation);
    accountsGet.mockResolvedValue({ data: { accounts: [{
      account_id: "account-alice-savings", balances: { current: 30 },
    }] } });
    const later = await render("alice", navigation);
    expect(accountGet).toHaveBeenCalledTimes(2);
    expect(callsTo(USERS)).toHaveLength(2);
    expect(accountsGet).toHaveBeenCalledTimes(4);
    expect(later.account.data.currentBalanceMinor).toBe(3000);
  });

  it("isolates concurrent Alice and Bob renders, including reads after awaits", async () => {
    const read = async () => {
      const first = await requireActor();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const [again, profile, accounts] = await Promise.all([
        requireActor(), getLoggedInUser(), getAccounts(),
      ]);
      expect(first).toBe(again);
      return { actor: first, profile, accounts };
    };
    const [alice, bob] = await Promise.all([render("alice", read), render("bob", read)]);
    expect(accountGet).toHaveBeenCalledTimes(2);
    expect(callsTo(USERS)).toHaveLength(2);
    expect(alice.actor.authId).toBe("auth-alice");
    expect(bob.actor.authId).toBe("auth-bob");
    expect(bob.profile?.id).toBe("user-bob");
    expect(bob.accounts.data.map((a: { id: string }) => a.id)).toEqual(["account-bob-checking"]);
    expect(JSON.stringify(alice)).not.toContain("bob");
    expect(JSON.stringify(bob)).not.toContain("alice");
  });

  it("does not reuse a previous authenticated render after logout", async () => {
    await render("alice", () => requireActor());
    await expect(render(undefined, () => requireActor())).rejects.toBeInstanceOf(UnauthorizedError);
    expect(accountGet).toHaveBeenCalledTimes(1);
  });

  it("refuses another owner's URL id before provider or history reads", async () => {
    const account = await render("alice", () => getAccount({ appwriteItemId: "bank-bob-checking" }));
    expect(account).toBeUndefined();
    expect(accountsGet).not.toHaveBeenCalled();
    expect(readTransactions).not.toHaveBeenCalled();
    expect(callsTo(TRANSACTIONS)).toHaveLength(0);
    expect(queryValue(callsTo(BANKS)[0][2], "userId")).toBe("user-alice");
  });

  it("still checks a foreign URL id after the actor's own account list has loaded", async () => {
    const account = await render("alice", async () => {
      await getAccounts();
      accountsGet.mockClear();
      return getAccount({ appwriteItemId: "bank-bob-checking" });
    });
    expect(account).toBeUndefined();
    expect(accountsGet).not.toHaveBeenCalled();
    expect(readTransactions).not.toHaveBeenCalled();
    expect(callsTo(TRANSACTIONS)).toHaveLength(0);
    expect(callsTo(BANKS)).toHaveLength(2);
  });

  it("starts both history sources while Plaid is still pending, after ownership", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    accountsGet.mockImplementation(async () => {
      await blocked;
      return { data: { accounts: [{ account_id: "account-alice-checking" }] } };
    });
    const pending = render("alice", () => getAccount({ appwriteItemId: "bank-alice-checking" }));
    try {
      await vi.waitFor(() => {
        expect(readTransactions).toHaveBeenCalledTimes(1);
        expect(callsTo(TRANSACTIONS)).toHaveLength(2);
      });
      expect(callsTo(BANKS)).toHaveLength(1);
    } finally {
      release();
      await pending;
    }
  });
});
