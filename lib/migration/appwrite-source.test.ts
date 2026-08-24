import { beforeEach, describe, expect, it, vi } from "vitest";

const { listDocuments } = vi.hoisted(() => ({ listDocuments: vi.fn() }));

vi.mock("../appwrite", () => ({
  createAdminClient: async () => ({ database: { listDocuments } }),
}));

import { InfrastructureError } from "../auth/errors";
import { PAGE_SIZE, readAllLegacyUsers } from "./appwrite-source";

const docs = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    $id: `user-${String(from + i).padStart(5, "0")}`,
    userId: `auth-${from + i}`,
  }));

/** A server that pages correctly through `all`. */
const pagingServer = (all: { $id: string }[]) =>
  vi.fn(async (_db: string, _coll: string, queries: unknown[]) => {
    const cursor = findCursor(queries);
    const start = cursor ? all.findIndex((d) => d.$id === cursor) + 1 : 0;
    const slice = all.slice(start, start + PAGE_SIZE);
    return { documents: slice, total: all.length };
  });

/**
 * node-appwrite serialises a Query to JSON like
 * {"method":"cursorAfter","values":["user-00100"]}, so the value is parsed out
 * rather than pattern-matched — a regex here silently returned the wrong
 * substring and made the fake server replay page one forever.
 */
function findCursor(queries: unknown[]): string | undefined {
  for (const q of queries) {
    try {
      const parsed = JSON.parse(String(q)) as { method?: string; values?: unknown[] };
      if (parsed.method === "cursorAfter" && typeof parsed.values?.[0] === "string") {
        return parsed.values[0];
      }
    } catch {
      /* not a JSON query */
    }
  }
  return undefined;
}

beforeEach(() => {
  listDocuments.mockReset();
});

describe("readAll — pagination completeness", () => {
  it("asks for an explicit page size instead of the server default", async () => {
    // Appwrite's default is 25. Relying on it means the page size can change
    // under the migration without a code change.
    listDocuments.mockResolvedValue({ documents: [], total: 0 });

    await readAllLegacyUsers();

    const queries = listDocuments.mock.calls[0][2] as unknown[];
    expect(queries.some((q) => String(q).includes(String(PAGE_SIZE)))).toBe(true);
  });

  it("reads a single short page", async () => {
    const all = docs(1, 3);
    listDocuments.mockImplementation(pagingServer(all));

    const scan = await readAllLegacyUsers();

    expect(scan.scanned).toBe(3);
    expect(scan.reportedTotal).toBe(3);
    expect(scan.pages).toBe(1);
    expect(scan.complete).toBe(true);
  });

  it("walks multiple pages and returns every document exactly once", async () => {
    const all = docs(1, PAGE_SIZE * 2 + 7);
    listDocuments.mockImplementation(pagingServer(all));

    const scan = await readAllLegacyUsers();

    expect(scan.pages).toBe(3);
    expect(scan.scanned).toBe(all.length);
    expect(scan.complete).toBe(true);
    expect(new Set(scan.documents.map((d) => d.$id)).size).toBe(all.length);
    expect(scan.documents.map((d) => d.$id)).toEqual(all.map((d) => d.$id));
  });

  it("stops after an exactly-full final page without an extra request", async () => {
    // The boundary case: a collection that is an exact multiple of PAGE_SIZE.
    const all = docs(1, PAGE_SIZE * 2);
    listDocuments.mockImplementation(pagingServer(all));

    const scan = await readAllLegacyUsers();

    expect(scan.scanned).toBe(all.length);
    expect(scan.complete).toBe(true);
    // Two full pages, then one that comes back empty to prove the end.
    expect(scan.pages).toBe(3);
  });

  it("passes a cursor after the first page, never an offset", async () => {
    const all = docs(1, PAGE_SIZE + 1);
    listDocuments.mockImplementation(pagingServer(all));

    await readAllLegacyUsers();

    const secondCall = String(listDocuments.mock.calls[1][2]);
    expect(secondCall).toContain("cursorAfter");
    expect(secondCall).not.toContain("offset");
  });
});

describe("readAll — pagination non-progress", () => {
  it("throws when the cursor does not advance", async () => {
    // A stalled cursor used to break the loop and return a short read. The
    // caller then saw a small, well-formed dataset with no way to know it was
    // truncated.
    listDocuments.mockResolvedValue({ documents: docs(1, PAGE_SIZE), total: 999 });

    await expect(readAllLegacyUsers()).rejects.toBeInstanceOf(InfrastructureError);
  });

  it("throws when a document is returned twice", async () => {
    let call = 0;
    listDocuments.mockImplementation(async () => {
      call += 1;
      // Second page repeats the first page's last document.
      return call === 1
        ? { documents: docs(1, PAGE_SIZE), total: PAGE_SIZE * 2 }
        : { documents: docs(PAGE_SIZE, PAGE_SIZE), total: PAGE_SIZE * 2 };
    });

    await expect(readAllLegacyUsers()).rejects.toBeInstanceOf(InfrastructureError);
  });

  it("throws on a short read rather than returning partial data", async () => {
    // The server says 500 exist but hands back one short page.
    listDocuments.mockResolvedValue({ documents: docs(1, 10), total: 500 });

    const error = await readAllLegacyUsers().then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(error).toBeInstanceOf(InfrastructureError);
    expect(error!.message).toContain("10");
    expect(error!.message).toContain("500");
  });

  it("does not silently deduplicate a repeated page", async () => {
    listDocuments.mockResolvedValue({ documents: docs(1, PAGE_SIZE), total: PAGE_SIZE });

    // total == PAGE_SIZE, so the walk requests a second page; the server
    // repeats the first. Deduplicating would report a clean, complete read.
    await expect(readAllLegacyUsers()).rejects.toBeInstanceOf(InfrastructureError);
  });
});

describe("readAll — evidence", () => {
  it("reports the server's total alongside what it actually scanned", async () => {
    const all = docs(1, PAGE_SIZE + 5);
    listDocuments.mockImplementation(pagingServer(all));

    const scan = await readAllLegacyUsers();

    // Without both numbers, "migrated N customers" is equally true of a
    // complete read and of one that stopped after page one.
    expect(scan).toMatchObject({
      scanned: PAGE_SIZE + 5,
      reportedTotal: PAGE_SIZE + 5,
      pages: 2,
      complete: true,
    });
  });

  it("marks an over-read incomplete instead of throwing", async () => {
    // A document deleted mid-walk shrinks the total. Not data loss, but the
    // source moved underneath the migration and that must be visible.
    let call = 0;
    listDocuments.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { documents: docs(1, PAGE_SIZE), total: PAGE_SIZE + 10 }
        : { documents: docs(PAGE_SIZE + 1, 3), total: PAGE_SIZE - 1 };
    });

    const scan = await readAllLegacyUsers();

    expect(scan.scanned).toBe(PAGE_SIZE + 3);
    expect(scan.complete).toBe(false);
  });

  it("handles an empty collection as complete", async () => {
    listDocuments.mockResolvedValue({ documents: [], total: 0 });

    const scan = await readAllLegacyUsers();

    expect(scan).toMatchObject({ scanned: 0, reportedTotal: 0, complete: true });
  });
});

describe("readAll — error containment", () => {
  it("does not leak the provider error into the message", async () => {
    listDocuments.mockRejectedValue(
      new Error("appwrite said: key=SENTINEL_APPWRITE_KEY_9f3a")
    );

    const error = await readAllLegacyUsers().then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(error!.message).not.toContain("SENTINEL_APPWRITE_KEY_9f3a");
  });
});
