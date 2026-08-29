import { describe, expect, it, vi } from "vitest";

import {
  collectChanges,
  foldChanges,
  MAX_PAGES,
  SyncStalledError,
  SyncTooLongError,
  type SyncPage,
  type SyncedTransaction,
} from "./engine";

/**
 * THE LOOP THAT USED TO BE INFINITE.
 *
 * The original sent no cursor, so Plaid returned the same first page forever and
 * `has_more` never became false; and it ASSIGNED rather than accumulated, so
 * every page discarded the one before it. Both defects lived in six lines, which
 * is exactly why the loop is now pure and tested without a provider attached — a
 * sandbox that happens to return one page proves nothing about either.
 */

const txn = (id: string, over: Partial<SyncedTransaction> = {}): SyncedTransaction => ({
  transactionId: id,
  accountId: "acct-1",
  amountMinor: 1_23,
  isoCurrency: "USD",
  postedDate: "2026-08-01",
  name: `txn ${id}`,
  merchantName: null,
  pending: false,
  ...over,
});

const page = (over: Partial<SyncPage> = {}): SyncPage => ({
  added: [],
  modified: [],
  removed: [],
  nextCursor: "cursor-1",
  hasMore: false,
  ...over,
});

/** A fake provider serving fixed pages, recording exactly what it was sent. */
function pagedProvider(pages: SyncPage[]) {
  const cursorsSeen: (string | null)[] = [];
  let index = 0;

  const fetchPage = vi.fn(async (cursor: string | null) => {
    cursorsSeen.push(cursor);
    const next = pages[index];
    if (!next) throw new Error("provider asked for more pages than it has");
    index += 1;
    return next;
  });

  return { fetchPage, cursorsSeen };
}

describe("cursor handling", () => {
  it("sends null on the first sync and the previous cursor thereafter", async () => {
    const { fetchPage, cursorsSeen } = pagedProvider([
      page({ nextCursor: "c1", hasMore: true }),
      page({ nextCursor: "c2", hasMore: true }),
      page({ nextCursor: "c3", hasMore: false }),
    ]);

    const result = await collectChanges(fetchPage, null);

    // THE DEFECT THAT MADE THE LOOP INFINITE: the original sent no cursor at
    // all, so every request returned the same first page.
    expect(cursorsSeen).toEqual([null, "c1", "c2"]);
    expect(result.cursor).toBe("c3");
    expect(result.pagesFetched).toBe(3);
  });

  it("resumes from a stored cursor rather than re-fetching history", async () => {
    const { fetchPage, cursorsSeen } = pagedProvider([
      page({ nextCursor: "c9", hasMore: false }),
    ]);

    await collectChanges(fetchPage, "c8");

    expect(cursorsSeen).toEqual(["c8"]);
  });

  it("returns the LAST cursor, not the first", async () => {
    const { fetchPage } = pagedProvider([
      page({ nextCursor: "c1", hasMore: true }),
      page({ nextCursor: "final", hasMore: false }),
    ]);

    expect((await collectChanges(fetchPage, null)).cursor).toBe("final");
  });
});

describe("accumulation", () => {
  it("keeps EVERY page, not just the last", async () => {
    // `transactions = response.data.added.map(...)` discarded every page but
    // the final one. Three pages of one transaction each must yield three.
    const { fetchPage } = pagedProvider([
      page({ added: [txn("a")], nextCursor: "c1", hasMore: true }),
      page({ added: [txn("b")], nextCursor: "c2", hasMore: true }),
      page({ added: [txn("c")], nextCursor: "c3", hasMore: false }),
    ]);

    const result = await collectChanges(fetchPage, null);

    expect(result.added.map((t) => t.transactionId)).toEqual(["a", "b", "c"]);
  });

  it("accumulates all three change types across pages", async () => {
    // The original mapped `added` only: modified transactions never updated and
    // removed ones stayed forever.
    const { fetchPage } = pagedProvider([
      page({
        added: [txn("a")],
        modified: [txn("m1")],
        removed: ["r1"],
        nextCursor: "c1",
        hasMore: true,
      }),
      page({
        added: [txn("b")],
        modified: [txn("m2")],
        removed: ["r2"],
        nextCursor: "c2",
        hasMore: false,
      }),
    ]);

    const result = await collectChanges(fetchPage, null);

    expect(result.added.map((t) => t.transactionId)).toEqual(["a", "b"]);
    expect(result.modified.map((t) => t.transactionId)).toEqual(["m1", "m2"]);
    expect(result.removed).toEqual(["r1", "r2"]);
  });

  it("handles a page with no changes but more to come", async () => {
    // Plaid does this. Treating an empty page as the end would silently stop a
    // sync partway through.
    const { fetchPage } = pagedProvider([
      page({ nextCursor: "c1", hasMore: true }),
      page({ added: [txn("late")], nextCursor: "c2", hasMore: false }),
    ]);

    const result = await collectChanges(fetchPage, null);

    expect(result.added.map((t) => t.transactionId)).toEqual(["late"]);
  });
});

describe("termination", () => {
  it("stops after one page when there is no more", async () => {
    const { fetchPage } = pagedProvider([page({ hasMore: false })]);

    await collectChanges(fetchPage, null);

    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("ABORTS when the provider promises more but does not advance the cursor", async () => {
    // The exact shape of the original infinite loop. Looping again here would
    // re-fetch the same page forever while the accumulators grow without bound
    // — so this must raise, not spin.
    const { fetchPage } = pagedProvider([
      page({ added: [txn("a")], nextCursor: "stuck", hasMore: true }),
      page({ added: [txn("a")], nextCursor: "stuck", hasMore: true }),
    ]);

    await expect(collectChanges(fetchPage, null)).rejects.toBeInstanceOf(
      SyncStalledError
    );
    // It stopped on the SECOND page — the first is where the cursor changes
    // from null, which is legitimate.
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("aborts immediately when the first page repeats the cursor it was given", async () => {
    const { fetchPage } = pagedProvider([
      page({ nextCursor: "c8", hasMore: true }),
    ]);

    await expect(collectChanges(fetchPage, "c8")).rejects.toBeInstanceOf(
      SyncStalledError
    );
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("refuses a run longer than the page ceiling", async () => {
    // The backstop for a provider that advances the cursor every page while
    // never setting has_more: false. Without it, the only thing between this
    // loop and an unbounded run against a paid API is the provider behaving.
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return page({ nextCursor: `c${n}`, hasMore: true });
    });

    await expect(collectChanges(fetchPage, null, { maxPages: 4 })).rejects.toBeInstanceOf(
      SyncTooLongError
    );
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it("applies the default ceiling when no limit is passed", () => {
    // Asserting the constant is a positive integer proves nothing about whether
    // it is used. This drives a provider that would page forever and checks the
    // walk stops on its own — the ceiling is only a backstop if it is wired in.
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return page({ nextCursor: `c${n}`, hasMore: true });
    });

    return expect(collectChanges(fetchPage, null))
      .rejects.toBeInstanceOf(SyncTooLongError)
      .then(() => {
        expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
      });
  });

  it("refuses to return an empty cursor", async () => {
    // Storing "" would ask for "changes since the beginning of nothing" on the
    // next run.
    const { fetchPage } = pagedProvider([page({ nextCursor: "", hasMore: false })]);

    await expect(collectChanges(fetchPage, null)).rejects.toBeInstanceOf(
      SyncStalledError
    );
  });
});

describe("the engine applies nothing", () => {
  it("returns changes and writes through no port but fetchPage", async () => {
    // Keeping the walk unable to write is what makes "cursor and data are
    // written together" impossible to get wrong here: there is no other write
    // for it to be separated from.
    const { fetchPage } = pagedProvider([
      page({ added: [txn("a")], nextCursor: "c1", hasMore: false }),
    ]);

    const result = await collectChanges(fetchPage, null);

    expect(Object.keys(result).sort()).toEqual([
      "added",
      "cursor",
      "modified",
      "pagesFetched",
      "removed",
    ]);
  });
});

describe("folding a page set into its net effect", () => {
  it("lets a later modification win over the add", async () => {
    const folded = foldChanges({
      added: [txn("a", { amountMinor: 1_00 })],
      modified: [txn("a", { amountMinor: 9_99 })],
      removed: [],
      cursor: "c",
      pagesFetched: 1,
    });

    expect(folded.upserts).toHaveLength(1);
    expect(folded.upserts[0].amountMinor).toBe(9_99);
  });

  it("lets a removal win over an add in the same run", async () => {
    // Plaid can add a transaction on one page and retract it on another.
    // Applying the raw lists in order would leave the row present or absent
    // depending on how the applier happened to sequence them.
    const folded = foldChanges({
      added: [txn("a"), txn("b")],
      modified: [txn("a", { amountMinor: 5_00 })],
      removed: ["a"],
      cursor: "c",
      pagesFetched: 2,
    });

    expect(folded.upserts.map((t) => t.transactionId)).toEqual(["b"]);
    expect(folded.removals).toEqual(["a"]);
  });

  it("deduplicates a transaction modified twice", async () => {
    const folded = foldChanges({
      added: [],
      modified: [txn("a", { name: "first" }), txn("a", { name: "second" })],
      removed: [],
      cursor: "c",
      pagesFetched: 1,
    });

    expect(folded.upserts).toHaveLength(1);
    expect(folded.upserts[0].name).toBe("second");
  });

  it("deduplicates a repeated removal", async () => {
    const folded = foldChanges({
      added: [],
      modified: [],
      removed: ["r", "r"],
      cursor: "c",
      pagesFetched: 1,
    });

    expect(folded.removals).toEqual(["r"]);
  });
});
