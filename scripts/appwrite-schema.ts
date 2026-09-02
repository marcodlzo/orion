/**
 * Provision the legacy Appwrite collections used by Orion.
 *
 * Check only (the default):
 *   npm run appwrite:schema
 *
 * Create missing attributes and indexes:
 *   npm run appwrite:schema:apply
 *
 * This is operator tooling. It uses the server API key directly, never imports
 * into a request path, and never prints configuration values or provider
 * errors. Existing definitions are validated before they are accepted: an
 * undersized credential field or a relationship aimed at the wrong collection
 * stops the run instead of becoming a delayed runtime failure.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// TablesDB, not node-appwrite's Databases. The installed SDK speaks the legacy
// DocumentsDB API, whose routes now return 401 on this Appwrite Cloud whatever
// scopes the key holds — verified route by route against the live project.
// See scripts/appwrite-tablesdb.ts.
import { TablesDbClient } from "./appwrite-tablesdb";

const IndexType = { Unique: "unique", Key: "key" } as const;
const RelationshipType = { ManyToOne: "manyToOne" } as const;
const RelationMutate = { Restrict: "restrict" } as const;

type StringAttributeSpec = {
  kind: "string";
  key: string;
  required: boolean;
  size: number;
};

type RelationshipAttributeSpec = {
  kind: "relationship";
  key: string;
  relatedCollection: "users";
  relationType: "manyToOne";
  twoWay: false;
  onDelete: "restrict";
};

export type AttributeSpec = StringAttributeSpec | RelationshipAttributeSpec;

type IndexSpec = {
  key: string;
  type: "key" | "unique";
  attributes: readonly string[];
};

type CollectionSpec = {
  name: "users" | "banks" | "transactions";
  env: "APPWRITE_USER_COLLECTION_ID" | "APPWRITE_BANK_COLLECTION_ID" | "APPWRITE_TRANSACTION_COLLECTION_ID";
  attributes: readonly AttributeSpec[];
  indexes: readonly IndexSpec[];
};

const string = (key: string, size: number): StringAttributeSpec => ({
  kind: "string",
  key,
  size,
  required: true,
});

/**
 * An attribute the application READS but never WRITES.
 *
 * Marking one required breaks every write to the collection: Appwrite rejects a
 * createDocument that omits a required attribute, and the caller finds out at
 * the worst possible moment. `channel` and `category` are read by the
 * transactions table and supplied by nothing — a tutorial leftover — so they
 * must be optional or no transfer can be recorded at all.
 */
const optionalString = (key: string, size: number): StringAttributeSpec => ({
  kind: "string",
  key,
  size,
  required: false,
});

/**
 * THE RUNTIME CONTRACT, not the upstream tutorial schema.
 *
 * SSN and dateOfBirth are intentionally absent: Dwolla receives them during
 * signup, then Orion discards them. accessToken and fundingSourceUrl store the
 * AES-GCM envelope produced by banks.repository.ts, so both need 512 chars.
 */
export const APPWRITE_SCHEMA: readonly CollectionSpec[] = [
  {
    name: "users",
    env: "APPWRITE_USER_COLLECTION_ID",
    attributes: [
      string("firstName", 64),
      string("lastName", 64),
      string("address1", 100),
      string("city", 64),
      string("state", 2),
      string("postalCode", 6),
      string("email", 254),
      string("userId", 36),
      string("dwollaCustomerId", 64),
      string("dwollaCustomerUrl", 255),
    ],
    indexes: [
      { key: "userId_unique", type: IndexType.Unique, attributes: ["userId"] },
    ],
  },
  {
    name: "banks",
    env: "APPWRITE_BANK_COLLECTION_ID",
    attributes: [
      string("bankId", 128),
      string("accountId", 128),
      string("accessToken", 512),
      string("fundingSourceUrl", 512),
      string("shareableId", 256),
      {
        kind: "relationship",
        key: "userId",
        relatedCollection: "users",
        relationType: RelationshipType.ManyToOne,
        twoWay: false,
        onDelete: RelationMutate.Restrict,
      },
    ],
    // Appwrite relationships can be filtered directly. A second string userId
    // would destroy the ownership model by making two fields disagree.
    indexes: [
      {
        key: "accountId_unique",
        type: IndexType.Unique,
        attributes: ["accountId"],
      },
    ],
  },
  {
    name: "transactions",
    env: "APPWRITE_TRANSACTION_COLLECTION_ID",
    attributes: [
      string("name", 200),
      string("amount", 32),
      optionalString("channel", 32),
      optionalString("category", 64),
      string("senderId", 36),
      string("senderBankId", 36),
      string("receiverId", 36),
      string("receiverBankId", 36),
      string("email", 254),
    ],
    indexes: [
      {
        key: "senderBankId_key",
        type: IndexType.Key,
        attributes: ["senderBankId"],
      },
      {
        key: "receiverBankId_key",
        type: IndexType.Key,
        attributes: ["receiverBankId"],
      },
    ],
  },
] as const;

type ExistingAttribute = {
  key: string;
  type: string;
  status: string;
  error?: string;
  required?: boolean;
  array?: boolean;
  size?: number;
  relatedCollection?: string;
  relationType?: string;
  twoWay?: boolean;
  onDelete?: string;
};

type ExistingIndex = {
  key: string;
  type: string;
  status: string;
  error?: string;
  attributes: string[];
};

type ResolvedCollection = CollectionSpec & { id: string };

type SchemaConfig = {
  endpoint: string;
  projectId: string;
  apiKey: string;
  databaseId: string;
  collections: ResolvedCollection[];
};

type Summary = {
  createdAttributes: number;
  createdIndexes: number;
  existingAttributes: number;
  existingIndexes: number;
  missingAttributes: number;
  missingIndexes: number;
};

const TERMINAL_FAILURES = new Set(["failed", "stuck"]);
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("your-")) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function resolveSchemaConfig(): SchemaConfig {
  const ids = new Map<string, string>();
  for (const collection of APPWRITE_SCHEMA) {
    ids.set(collection.name, requiredEnvironment(collection.env));
  }

  return {
    endpoint: requiredEnvironment("NEXT_PUBLIC_APPWRITE_ENDPOINT"),
    projectId: requiredEnvironment("NEXT_PUBLIC_APPWRITE_PROJECT"),
    apiKey: requiredEnvironment("NEXT_APPWRITE_KEY"),
    databaseId: requiredEnvironment("APPWRITE_DATABASE_ID"),
    collections: APPWRITE_SCHEMA.map((collection) => ({
      ...collection,
      id: ids.get(collection.name)!,
    })),
  };
}

export function attributeMismatches(
  expected: AttributeSpec,
  actual: ExistingAttribute,
  userCollectionId: string
): string[] {
  const mismatches: string[] = [];

  if (expected.kind === "string") {
    if (actual.type !== "string") mismatches.push(`type=${actual.type}`);
    if (actual.required !== expected.required) {
      mismatches.push(`required=${String(actual.required)}`);
    }
    if (actual.array === true) mismatches.push("array=true");
    if (typeof actual.size !== "number" || actual.size < expected.size) {
      mismatches.push(`size=${String(actual.size)} (needs >=${expected.size})`);
    }
    return mismatches;
  }

  if (actual.type !== "relationship") mismatches.push(`type=${actual.type}`);
  if (actual.relatedCollection !== userCollectionId) {
    mismatches.push("relatedCollection does not point to users");
  }
  if (actual.relationType !== expected.relationType) {
    mismatches.push(`relationType=${String(actual.relationType)}`);
  }
  if (actual.twoWay !== expected.twoWay) {
    mismatches.push(`twoWay=${String(actual.twoWay)}`);
  }
  if (actual.onDelete !== expected.onDelete) {
    mismatches.push(`onDelete=${String(actual.onDelete)}`);
  }
  return mismatches;
}

export function indexMismatches(expected: IndexSpec, actual: ExistingIndex): string[] {
  const mismatches: string[] = [];
  if (actual.type !== expected.type) mismatches.push(`type=${actual.type}`);
  if (actual.attributes.join("\u0000") !== expected.attributes.join("\u0000")) {
    mismatches.push(`attributes=${actual.attributes.join(",")}`);
  }
  return mismatches;
}

function assertAvailable(status: string, label: string, error?: string): void {
  if (TERMINAL_FAILURES.has(status)) {
    const suffix = error ? " (Appwrite reported a provisioning error)" : "";
    throw new Error(`${label} is ${status}${suffix}`);
  }
}

async function waitUntilAvailable<T extends { status: string; error?: string }>(
  read: () => Promise<T>,
  label: string
): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resource = await read();
    assertAvailable(resource.status, label, resource.error);
    if (resource.status === "available") return resource;
    await new Promise((finish) => setTimeout(finish, POLL_INTERVAL_MS));
  }
  throw new Error(`${label} did not become available within ${POLL_TIMEOUT_MS / 1000}s`);
}

function asAppwriteError(error: unknown): { code?: number; type?: string } {
  if (!error || typeof error !== "object") return {};
  const candidate = error as { code?: unknown; type?: unknown };
  return {
    code: typeof candidate.code === "number" ? candidate.code : undefined,
    type: typeof candidate.type === "string" ? candidate.type : undefined,
  };
}

function safeError(error: unknown): string {
  const appwrite = asAppwriteError(error);
  if (appwrite.code || appwrite.type) {
    return [appwrite.code, appwrite.type].filter(Boolean).join(" ");
  }
  return error instanceof Error ? error.message : "Unknown error";
}

async function createAttribute(
  databases: TablesDbClient,
  config: SchemaConfig,
  collection: ResolvedCollection,
  attribute: AttributeSpec
): Promise<void> {
  if (attribute.kind === "string") {
    await databases.createStringAttribute(
      config.databaseId,
      collection.id,
      attribute.key,
      attribute.size,
      attribute.required
    );
    return;
  }

  const userCollectionId = config.collections.find(({ name }) => name === "users")!.id;
  await databases.createRelationshipAttribute(
    config.databaseId,
    collection.id,
    userCollectionId,
    RelationshipType.ManyToOne,
    false,
    attribute.key,
    RelationMutate.Restrict
  );
}

async function ensureAttribute(
  databases: TablesDbClient,
  config: SchemaConfig,
  collection: ResolvedCollection,
  attribute: AttributeSpec,
  existing: Map<string, ExistingAttribute>,
  apply: boolean,
  summary: Summary
): Promise<void> {
  const label = `${collection.name}.${attribute.key}`;
  const userCollectionId = config.collections.find(({ name }) => name === "users")!.id;
  let actual = existing.get(attribute.key);

  if (!actual) {
    summary.missingAttributes += 1;
    if (!apply) {
      console.log(`  MISSING attribute ${label}`);
      return;
    }

    console.log(`  CREATE  attribute ${label}`);
    try {
      await createAttribute(databases, config, collection, attribute);
    } catch (error) {
      // Another operator may have created it after the initial read. Only a
      // conflict is safe to re-read; every other provider error stays fatal.
      if (asAppwriteError(error).code !== 409) throw error;
    }
    actual = await waitUntilAvailable(
      () =>
        databases.getAttribute(
          config.databaseId,
          collection.id,
          attribute.key
        ) as Promise<ExistingAttribute>,
      `Attribute ${label}`
    );
    summary.createdAttributes += 1;
  } else if (actual.status !== "available") {
    actual = await waitUntilAvailable(
      () =>
        databases.getAttribute(
          config.databaseId,
          collection.id,
          attribute.key
        ) as Promise<ExistingAttribute>,
      `Attribute ${label}`
    );
  }

  assertAvailable(actual.status, `Attribute ${label}`, actual.error);
  const mismatches = attributeMismatches(attribute, actual, userCollectionId);
  if (mismatches.length > 0) {
    throw new Error(`Attribute ${label} is incompatible: ${mismatches.join("; ")}`);
  }
  summary.existingAttributes += 1;
  if (!apply) console.log(`  OK      attribute ${label}`);
}

async function ensureIndex(
  databases: TablesDbClient,
  config: SchemaConfig,
  collection: ResolvedCollection,
  index: IndexSpec,
  existing: Map<string, ExistingIndex>,
  apply: boolean,
  summary: Summary
): Promise<void> {
  const label = `${collection.name}.${index.key}`;
  let actual = existing.get(index.key);

  if (!actual) {
    summary.missingIndexes += 1;
    if (!apply) {
      console.log(`  MISSING index     ${label}`);
      return;
    }

    console.log(`  CREATE  index     ${label}`);
    try {
      await databases.createIndex(
        config.databaseId,
        collection.id,
        index.key,
        index.type,
        [...index.attributes]
      );
    } catch (error) {
      if (asAppwriteError(error).code !== 409) throw error;
    }
    actual = await waitUntilAvailable(
      () =>
        databases.getIndex(
          config.databaseId,
          collection.id,
          index.key
        ) as Promise<ExistingIndex>,
      `Index ${label}`
    );
    summary.createdIndexes += 1;
  } else if (actual.status !== "available") {
    actual = await waitUntilAvailable(
      () =>
        databases.getIndex(
          config.databaseId,
          collection.id,
          index.key
        ) as Promise<ExistingIndex>,
      `Index ${label}`
    );
  }

  assertAvailable(actual.status, `Index ${label}`, actual.error);
  const mismatches = indexMismatches(index, actual);
  if (mismatches.length > 0) {
    throw new Error(`Index ${label} is incompatible: ${mismatches.join("; ")}`);
  }
  summary.existingIndexes += 1;
  if (!apply) console.log(`  OK      index     ${label}`);
}

export async function synchronizeSchema(options: { apply: boolean }): Promise<Summary> {
  const config = resolveSchemaConfig();
  const databases = new TablesDbClient({
    endpoint: config.endpoint,
    projectId: config.projectId,
    apiKey: config.apiKey,
  });
  const summary: Summary = {
    createdAttributes: 0,
    createdIndexes: 0,
    existingAttributes: 0,
    existingIndexes: 0,
    missingAttributes: 0,
    missingIndexes: 0,
  };

  for (const collection of config.collections) {
    console.log(`\n${collection.name}`);
    const [attributeList, indexList] = await Promise.all([
      databases.listAttributes(config.databaseId, collection.id),
      databases.listIndexes(config.databaseId, collection.id),
    ]);
    const attributes = new Map(
      (attributeList.attributes as unknown as ExistingAttribute[]).map((attribute) => [
        attribute.key,
        attribute,
      ])
    );
    const indexes = new Map(
      (indexList.indexes as unknown as ExistingIndex[]).map((index) => [
        index.key,
        index,
      ])
    );

    for (const attribute of collection.attributes) {
      await ensureAttribute(
        databases,
        config,
        collection,
        attribute,
        attributes,
        options.apply,
        summary
      );
    }
    for (const index of collection.indexes) {
      await ensureIndex(
        databases,
        config,
        collection,
        index,
        indexes,
        options.apply,
        summary
      );
    }
  }

  return summary;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown[0]}`);
    console.error("Use no flag to check, or --apply to create missing schema.");
    return 1;
  }

  const apply = args.includes("--apply");
  console.log(`APPWRITE SCHEMA — ${apply ? "APPLY" : "CHECK ONLY"}`);

  try {
    const summary = await synchronizeSchema({ apply });
    console.log("\nSummary");
    console.log(`  compatible attributes ${summary.existingAttributes}`);
    console.log(`  compatible indexes    ${summary.existingIndexes}`);
    if (apply) {
      console.log(`  created attributes    ${summary.createdAttributes}`);
      console.log(`  created indexes       ${summary.createdIndexes}`);
      console.log("\nSchema is compatible with Orion.");
      return 0;
    }

    console.log(`  missing attributes    ${summary.missingAttributes}`);
    console.log(`  missing indexes       ${summary.missingIndexes}`);
    if (summary.missingAttributes + summary.missingIndexes > 0) {
      console.log("\nRun npm run appwrite:schema:apply to create the missing resources.");
      return 2;
    }
    console.log("\nSchema is compatible with Orion.");
    return 0;
  } catch (error) {
    const appwrite = asAppwriteError(error);
    if (appwrite.code === 401 && appwrite.type === "general_unauthorized_scope") {
      console.error("\nAppwrite rejected schema access: 401 general_unauthorized_scope");
      console.error(
        "Temporarily add tables/columns/indexes read+write scopes (or the legacy collections/attributes/indexes equivalents) to NEXT_APPWRITE_KEY."
      );
      return 1;
    }
    console.error(`\nSchema provisioning failed: ${safeError(error)}`);
    return 1;
  }
}

const entryUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryUrl === import.meta.url) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
