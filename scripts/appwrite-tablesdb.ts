/**
 * A minimal TablesDB client, exposing the method names the schema script uses.
 *
 * WHY THIS EXISTS. `node-appwrite@12` speaks the legacy DocumentsDB API —
 * `/databases/{id}/collections/...`. Appwrite Cloud has since moved schema
 * management to TablesDB — `/tablesdb/{id}/tables/...` — and the legacy routes
 * now return 401 `general_unauthorized_scope` no matter which scopes the key
 * holds. That is not a permissions problem and no amount of ticking boxes fixes
 * it; the SDK is simply calling routes the server no longer authorises.
 *
 * Verified directly against the live project: every legacy route returned 401
 * while every TablesDB equivalent returned 200 with the same key.
 *
 * The vocabulary changed with the routes — Collections became Tables,
 * Attributes became Columns, Documents became Rows. The method names here keep
 * the OLD spelling on purpose, so the schema script's logic, validation and
 * reporting are untouched by the transport swap. The translation is confined to
 * this file.
 *
 * Operator tooling. Not reachable from any request path.
 */

export type AppwriteError = Error & { code?: number; type?: string };

type Json = Record<string, unknown>;

/**
 * TablesDB reports an index's members as `columns`; the script reads
 * `attributes`. Normalised here rather than at the call sites, so the
 * vocabulary change stays confined to this file — the alternative was an
 * `actual.attributes.join(...)` on an undefined field, which is exactly how it
 * failed the first time.
 */
function normaliseIndex(index: unknown): unknown {
  if (!index || typeof index !== "object") return index;
  const row = index as { columns?: unknown; attributes?: unknown };
  if (row.attributes === undefined && Array.isArray(row.columns)) {
    return { ...row, attributes: row.columns };
  }
  return row;
}

/**
 * TablesDB reports a relationship's target as `relatedTable`; the script reads
 * `relatedCollection`. Same rename, same reason to translate it here: the
 * validator compares the target against the users table, and an undefined field
 * reads as "points at the wrong collection" — which is exactly the alarming and
 * wrong message it produced first time round.
 */
function normaliseColumn(column: unknown): unknown {
  if (!column || typeof column !== "object") return column;
  const row = column as { relatedTable?: unknown; relatedCollection?: unknown };
  if (row.relatedCollection === undefined && row.relatedTable !== undefined) {
    return { ...row, relatedCollection: row.relatedTable };
  }
  return row;
}

export class TablesDbClient {
  constructor(
    private readonly config: {
      endpoint: string;
      projectId: string;
      apiKey: string;
    }
  ) {}

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: Json
  ): Promise<T> {
    const response = await fetch(`${this.config.endpoint}${path}`, {
      method,
      headers: {
        "X-Appwrite-Project": this.config.projectId,
        "X-Appwrite-Key": this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const parsed = (await response.json().catch(() => ({}))) as Json;

    if (!response.ok) {
      // Shaped like the SDK's error so the script's existing 409 handling and
      // its "never print a provider error" rule both keep working. The message
      // carries the status and Appwrite's error TYPE — never the response body,
      // which echoes the request.
      const error = new Error(
        `Appwrite request failed: ${response.status} ${String(parsed.type ?? "unknown")}`
      ) as AppwriteError;
      error.code = response.status;
      error.type = typeof parsed.type === "string" ? parsed.type : undefined;
      throw error;
    }

    return parsed as T;
  }

  private table(databaseId: string, tableId: string): string {
    return `/tablesdb/${databaseId}/tables/${tableId}`;
  }

  /** Columns, returned under the key the script already reads. */
  async listAttributes(
    databaseId: string,
    tableId: string
  ): Promise<{ attributes: unknown[] }> {
    const result = await this.call<{ columns: unknown[] }>(
      "GET",
      `${this.table(databaseId, tableId)}/columns`
    );
    return { attributes: (result.columns ?? []).map(normaliseColumn) };
  }

  async listIndexes(
    databaseId: string,
    tableId: string
  ): Promise<{ indexes: unknown[] }> {
    const result = await this.call<{ indexes: unknown[] }>(
      "GET",
      `${this.table(databaseId, tableId)}/indexes`
    );
    return { indexes: (result.indexes ?? []).map(normaliseIndex) };
  }

  async getAttribute(
    databaseId: string,
    tableId: string,
    key: string
  ): Promise<unknown> {
    return normaliseColumn(
      await this.call("GET", `${this.table(databaseId, tableId)}/columns/${key}`)
    );
  }

  async getIndex(
    databaseId: string,
    tableId: string,
    key: string
  ): Promise<unknown> {
    return normaliseIndex(
      await this.call("GET", `${this.table(databaseId, tableId)}/indexes/${key}`)
    );
  }

  async createStringAttribute(
    databaseId: string,
    tableId: string,
    key: string,
    size: number,
    required: boolean
  ): Promise<unknown> {
    return this.call("POST", `${this.table(databaseId, tableId)}/columns/string`, {
      key,
      size,
      required,
    });
  }

  /**
   * A relationship column.
   *
   * `relatedTableId` is the TablesDB spelling of `relatedCollectionId`. It
   * stores the related row's `$id` — the user DOCUMENT id, which is what bank
   * ownership compares against. Pointing it at the Appwrite Auth account id
   * would match nothing and read as "this user has no banks".
   */
  async createRelationshipAttribute(
    databaseId: string,
    tableId: string,
    relatedTableId: string,
    relationType: string,
    twoWay: boolean,
    key: string,
    onDelete: string
  ): Promise<unknown> {
    return this.call(
      "POST",
      `${this.table(databaseId, tableId)}/columns/relationship`,
      { relatedTableId, type: relationType, twoWay, key, onDelete }
    );
  }

  /** `columns` is the TablesDB spelling of the old `attributes` field. */
  async createIndex(
    databaseId: string,
    tableId: string,
    key: string,
    type: string,
    columns: string[]
  ): Promise<unknown> {
    return this.call("POST", `${this.table(databaseId, tableId)}/indexes`, {
      key,
      type,
      columns,
    });
  }
}
