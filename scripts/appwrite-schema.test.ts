import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APPWRITE_SCHEMA,
  attributeMismatches,
  indexMismatches,
} from "./appwrite-schema";

describe("Appwrite schema contract", () => {
  it("contains the exact 25 runtime attributes with no duplicate keys", () => {
    expect(
      APPWRITE_SCHEMA.map((collection) => [
        collection.name,
        collection.attributes.map(({ key }) => key),
      ])
    ).toEqual([
      [
        "users",
        [
          "firstName",
          "lastName",
          "address1",
          "city",
          "state",
          "postalCode",
          "email",
          "userId",
          "dwollaCustomerId",
          "dwollaCustomerUrl",
        ],
      ],
      [
        "banks",
        [
          "bankId",
          "accountId",
          "accessToken",
          "fundingSourceUrl",
          "shareableId",
          "userId",
        ],
      ],
      [
        "transactions",
        [
          "name",
          "amount",
          "channel",
          "category",
          "senderId",
          "senderBankId",
          "receiverId",
          "receiverBankId",
          "email",
        ],
      ],
    ]);

    const attributes = APPWRITE_SCHEMA.flatMap(({ attributes }) => attributes);
    expect(attributes).toHaveLength(25);
  });

  it("reserves 512 characters for both encrypted provider fields", () => {
    const banks = APPWRITE_SCHEMA.find(({ name }) => name === "banks")!;
    const byKey = new Map(banks.attributes.map((attribute) => [attribute.key, attribute]));

    expect(byKey.get("accessToken")).toMatchObject({ kind: "string", size: 512 });
    expect(byKey.get("fundingSourceUrl")).toMatchObject({ kind: "string", size: 512 });
  });

  it("models banks.userId as a one-way many-to-one link to user documents", () => {
    const banks = APPWRITE_SCHEMA.find(({ name }) => name === "banks")!;
    expect(banks.attributes.find(({ key }) => key === "userId")).toEqual({
      kind: "relationship",
      key: "userId",
      relatedCollection: "users",
      relationType: "manyToOne",
      twoWay: false,
      onDelete: "restrict",
    });
  });

  it("rejects an existing credential attribute that is too small", () => {
    expect(
      attributeMismatches(
        { kind: "string", key: "accessToken", required: true, size: 512 },
        {
          key: "accessToken",
          type: "string",
          status: "available",
          required: true,
          size: 255,
        },
        "users-id"
      )
    ).toContain("size=255 (needs >=512)");
  });

  it("rejects a relationship aimed at the Auth id or wrong collection", () => {
    expect(
      attributeMismatches(
        {
          kind: "relationship",
          key: "userId",
          relatedCollection: "users",
          relationType: "manyToOne",
          twoWay: false,
          onDelete: "restrict",
        },
        {
          key: "userId",
          type: "relationship",
          status: "available",
          relatedCollection: "auth-users",
          relationType: "oneToOne",
          twoWay: false,
          onDelete: "restrict",
        },
        "orion-users"
      )
    ).toEqual([
      "relatedCollection does not point to users",
      "relationType=oneToOne",
    ]);
  });

  it("pins the indexes used by every non-system Appwrite query", () => {
    expect(
      APPWRITE_SCHEMA.flatMap((collection) =>
        collection.indexes.map((index) => [
          collection.name,
          index.key,
          index.type,
          index.attributes,
        ])
      )
    ).toEqual([
      ["users", "userId_unique", "unique", ["userId"]],
      ["banks", "accountId_unique", "unique", ["accountId"]],
      ["transactions", "senderBankId_key", "key", ["senderBankId"]],
      ["transactions", "receiverBankId_key", "key", ["receiverBankId"]],
    ]);

    expect(
      indexMismatches(
        { key: "senderBankId_key", type: "key", attributes: ["senderBankId"] },
        {
          key: "senderBankId_key",
          type: "key",
          status: "available",
          attributes: ["receiverBankId"],
        }
      )
    ).toEqual(["attributes=receiverBankId"]);
  });
});

/**
 * THE TEST THE SUITE ABOVE WAS MISSING.
 *
 * Every assertion before this one compares the schema against ITSELF — the
 * constant contains what the constant says it contains. All six stayed green
 * while `channel` and `category` were marked required, which Appwrite enforces
 * on write: every transfer would have failed at `createTransactionRecord`,
 * AFTER Dwolla had already moved the money, surfacing as
 * TransferSubmittedButNotRecordedError on every single transfer.
 *
 * This one reads the APPLICATION and compares. A required attribute nothing
 * writes is a collection nothing can write to.
 */
describe("required attributes match what the application writes", () => {
  const ROOT = fileURLToPath(new URL("../", import.meta.url));
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  /** Top-level keys of the object literal passed to `call(`. */
  const writtenKeys = (source: string, call: string): string[] => {
    const start = source.indexOf(call);
    if (start === -1) throw new Error(`${call} not found`);

    // Walk from the call to its matching close paren, tracking depth so nested
    // objects and calls do not end the scan early.
    let depth = 0;
    let end = start;
    for (let i = source.indexOf("(", start); i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    const args = source.slice(start, end);
    // Depth-1 keys only: `name: x` nested inside another object is not a column.
    const keys: string[] = [];
    let braceDepth = 0;
    for (const line of args.split("\n")) {
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      // `key: value`, shorthand `key,` and a trailing shorthand `key` with no
      // comma. Missing the shorthand form made this report accessToken and
      // fundingSourceUrl as unwritten when the code writes both.
      const match = /^\s*(\w+)\s*(?::|,\s*$|$)/.exec(line);
      if (match && braceDepth === 1) keys.push(match[1]);
      braceDepth += opens - closes;
    }
    return keys;
  };

  const requiredOf = (name: string) =>
    APPWRITE_SCHEMA.find((c) => c.name === name)!
      .attributes.filter((a) => a.kind === "string" && a.required)
      .map((a) => a.key)
      .sort();

  it("writes every required transactions attribute", () => {
    const written = writtenKeys(
      read("lib/services/transfers.service.ts"),
      "createTransactionRecord("
    );

    expect(written.length).toBeGreaterThan(0);
    expect(requiredOf("transactions").filter((k) => !written.includes(k))).toEqual([]);
  });

  it("writes every required banks attribute", () => {
    const written = writtenKeys(
      read("lib/actions/user.actions.ts"),
      "createBankForActor("
    );

    expect(written.length).toBeGreaterThan(0);
    expect(requiredOf("banks").filter((k) => !written.includes(k))).toEqual([]);
  });

  it("keeps channel and category optional, because nothing supplies them", () => {
    // Named explicitly so re-marking them required is a deliberate act that
    // fails here, rather than a plausible-looking edit.
    const transactions = APPWRITE_SCHEMA.find((c) => c.name === "transactions")!;
    for (const key of ["channel", "category"]) {
      expect(
        transactions.attributes.find((a) => a.key === key),
        `${key} is read by the table but written by nothing`
      ).toMatchObject({ required: false });
    }
  });
});
