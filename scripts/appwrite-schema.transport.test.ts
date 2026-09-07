import { Client } from "node-appwrite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APPWRITE_SCHEMA, synchronizeSchema } from "./appwrite-schema";

type Definition = Record<string, unknown> & { key: string; status: string };
type Table = { columns: Definition[]; indexes: Definition[] };
let tables: Map<string, Table>;
const transport = vi.fn();
const usersId = process.env.APPWRITE_USER_COLLECTION_ID!;
const banksId = process.env.APPWRITE_BANK_COLLECTION_ID!;
const databaseId = process.env.APPWRITE_DATABASE_ID!;

beforeEach(() => {
  transport.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  // Keep the actual SDK's route, parameter and enum handling. Intercept only
  // its HTTP boundary so no schema mutation reaches a provider in these tests.
  vi.spyOn(Client.prototype, "call").mockImplementation(transport);
  tables = new Map(APPWRITE_SCHEMA.map((collection) => [process.env[collection.env]!, {
    columns: collection.attributes.map((attribute) => attribute.kind === "string" ? {
      key: attribute.key, type: "string", status: "available",
      required: attribute.required, size: attribute.size, array: false,
    } : {
      key: attribute.key, type: "relationship", status: "available",
      relatedTable: usersId, relationType: "manyToOne", twoWay: false, onDelete: "restrict",
    }),
    indexes: collection.indexes.map((index) => ({
      key: index.key, type: index.type, status: "available", columns: [...index.attributes],
    })),
  }]));
  transport.mockImplementation(async (method: string, url: URL, _headers: unknown,
    params: Record<string, unknown>) => {
    const match = url.pathname.match(/\/tablesdb\/[^/]+\/tables\/([^/]+)\/(columns|indexes)(?:\/([^/]+))?$/);
    if (!match) throw new Error(`Unexpected schema route: ${url.pathname}`);
    const [, tableId, kind, key] = match;
    const table = tables.get(tableId)!;
    const definitions = kind === "columns" ? table.columns : table.indexes;
    if (method === "get") {
      if (key) return definitions.find((definition) => definition.key === key);
      return { total: definitions.length, [kind]: definitions };
    }
    if (method !== "post") throw new Error("Unexpected schema write");
    const created: Definition = {
      ...params, key: String(params.key), status: "available",
    };
    if (kind === "columns") {
      created.type = key;
      if (key === "relationship") {
        created.relatedTable = params.relatedTableId;
        created.relationType = params.type;
      }
    }
    definitions.push(created);
    return created;
  });
});

describe("native TablesDB schema transport", () => {
  it("normalizes native relatedTable and columns fields and checks without writing", async () => {
    const summary = await synchronizeSchema({ apply: false });
    expect(summary).toEqual({
      createdAttributes: 0, createdIndexes: 0, existingAttributes: 25,
      existingIndexes: 4, missingAttributes: 0, missingIndexes: 0,
    });
    expect(transport).toHaveBeenCalledTimes(6);
    expect(transport.mock.calls.every(([method]) => method === "get")).toBe(true);
  });

  it("rejects a relationship to a different table", async () => {
    tables.get(banksId)!.columns.find((column) => column.key === "userId")!.relatedTable = "wrong-table";
    await expect(synchronizeSchema({ apply: false })).rejects.toThrow("relatedCollection does not point to users");
  });

  it("rejects an index over the wrong native columns", async () => {
    tables.get(banksId)!.indexes[0].columns = ["bankId"];
    await expect(synchronizeSchema({ apply: false })).rejects.toThrow("attributes=bankId");
  });

  it("creates missing definitions through native SDK parameters and validates polled results", async () => {
    const bankTable = tables.get(banksId)!;
    bankTable.columns = bankTable.columns.filter((c) => !["accessToken", "userId"].includes(c.key));
    bankTable.indexes = [];
    const summary = await synchronizeSchema({ apply: true });
    expect(summary).toMatchObject({
      createdAttributes: 2, createdIndexes: 1, existingAttributes: 25, existingIndexes: 4,
    });
    const writes = transport.mock.calls.filter(([method]) => method === "post");
    expect(writes).toHaveLength(3);
    expect(writes.map(([, url, , params]) => ({ path: (url as URL).pathname, params }))).toEqual([
      { path: `/v1/tablesdb/${databaseId}/tables/${banksId}/columns/string`,
        params: { key: "accessToken", size: 512, required: true } },
      { path: `/v1/tablesdb/${databaseId}/tables/${banksId}/columns/relationship`,
        params: { relatedTableId: usersId, type: "manyToOne", twoWay: false,
          key: "userId", onDelete: "restrict" } },
      { path: `/v1/tablesdb/${databaseId}/tables/${banksId}/indexes`,
        params: { key: "accountId_unique", type: "unique", columns: ["accountId"] } },
    ]);
  });
});
