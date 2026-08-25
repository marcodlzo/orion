/**
 * Database failure vocabulary.
 *
 * A datastore failure must stay distinguishable from Unauthorized, NotFound,
 * a validation failure and an invalid-money failure. Collapsing them is how an
 * outage ends up presented as "please log in again", and how a constraint
 * violation ends up looking like a server crash.
 *
 * Nothing here carries SQL text, parameter values or the connection string. A
 * database error message can contain the row that failed a constraint, which
 * for this application means it can contain identifiers we do not want in a log
 * or a client response.
 */

export type DatabaseErrorCode =
  | "DB_UNAVAILABLE"
  | "DB_QUERY_FAILED"
  | "DB_CONSTRAINT_VIOLATION";

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  /** PostgreSQL SQLSTATE, when the driver supplied one. Safe to log. */
  readonly sqlState?: string;
  /** Constraint name, when the failure was a constraint violation. Safe to log. */
  readonly constraint?: string;

  constructor(
    code: DatabaseErrorCode,
    message: string,
    options?: { cause?: unknown; sqlState?: string; constraint?: string }
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
    this.sqlState = options?.sqlState;
    this.constraint = options?.constraint;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The database could not be reached at all. */
export class DatabaseUnavailableError extends DatabaseError {
  constructor(message = "Database is unavailable", options?: { cause?: unknown }) {
    super("DB_UNAVAILABLE", message, options);
  }
}

/** A statement failed for a reason that is not a constraint violation. */
export class QueryFailedError extends DatabaseError {
  constructor(message = "Database query failed", options?: { cause?: unknown; sqlState?: string }) {
    super("DB_QUERY_FAILED", message, options);
  }
}

/**
 * A constraint rejected the write.
 *
 * This is usually a domain fact, not an outage: a duplicate unique key means
 * the caller tried to create something that already exists. Callers translate
 * it; this layer only names it.
 */
export class ConstraintViolationError extends DatabaseError {
  constructor(
    message = "Database constraint violated",
    options?: { cause?: unknown; sqlState?: string; constraint?: string }
  ) {
    super("DB_CONSTRAINT_VIOLATION", message, options);
  }
}

/**
 * A stored record already claims a different immutable identity.
 *
 * NOT a database failure — PostgreSQL accepted the statement. This is the
 * upsert noticing that resolving the conflict its usual way would quietly
 * discard a fact: an auth account already bridged to a different user document,
 * or a linked account already bridged to a different legacy bank document.
 *
 * Those bridges are the audit trail between the two stores. Keeping the old
 * value and reporting success — which is what a plain `ON CONFLICT DO UPDATE`
 * plus `COALESCE(existing, excluded)` does — means a later run can attach data
 * using a mapping the database says belongs to something else. Raising here
 * stops the migration and asks a human, which is the correct response to two
 * sources disagreeing about who someone is.
 */
export class IdentityConflictError extends Error {
  readonly code = "IDENTITY_CONFLICT";
  readonly field: string;
  readonly stored: string;
  readonly incoming: string;

  constructor(input: { field: string; stored: string; incoming: string }) {
    super(
      `${input.field} is already bridged to ${input.stored}; refusing to accept ${input.incoming}`
    );
    this.name = "IdentityConflictError";
    this.field = input.field;
    this.stored = input.stored;
    this.incoming = input.incoming;
    Object.setPrototypeOf(this, IdentityConflictError.prototype);
  }
}

/** SQLSTATE classes that mean "the write violated a rule", not "we broke". */
const CONSTRAINT_SQLSTATES = new Set([
  "23000", // integrity_constraint_violation
  "23001", // restrict_violation
  "23502", // not_null_violation
  "23503", // foreign_key_violation
  "23505", // unique_violation
  "23514", // check_violation
]);

/** SQLSTATE / driver conditions that mean we could not reach the database. */
const UNAVAILABLE_SQLSTATES = new Set([
  "08000", "08003", "08006", "08001", "08004", // connection_exception family
  "57P01", "57P02", "57P03", // admin shutdown / crash shutdown / cannot connect now
  "53300", // too_many_connections
]);

const UNAVAILABLE_SYSCALLS = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EAI_AGAIN",
]);

/**
 * Map a driver error onto the vocabulary above.
 *
 * The original is kept as `cause` for server-side debugging and is never
 * surfaced to a caller.
 */
export function toDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;

  const e = (error ?? {}) as { code?: unknown; constraint?: unknown };
  const code = typeof e.code === "string" ? e.code : undefined;
  const constraint = typeof e.constraint === "string" ? e.constraint : undefined;

  if (code && UNAVAILABLE_SYSCALLS.has(code)) {
    return new DatabaseUnavailableError(undefined, { cause: error });
  }
  if (code && UNAVAILABLE_SQLSTATES.has(code)) {
    return new DatabaseUnavailableError(undefined, { cause: error });
  }
  if (code && CONSTRAINT_SQLSTATES.has(code)) {
    return new ConstraintViolationError(undefined, {
      cause: error,
      sqlState: code,
      constraint,
    });
  }

  return new QueryFailedError(undefined, { cause: error, sqlState: code });
}
