/**
 * Data-access failures.
 *
 * Deliberately separate from a "not owned" concept: callers must not be able to
 * tell the difference between a record that does not exist and one that exists
 * but belongs to somebody else. Both surface as NotFoundError, so this action
 * layer cannot be used as an existence oracle for another user's records.
 *
 * Infrastructure failures reuse InfrastructureError from lib/auth/errors.ts.
 * That type is generic despite living under auth/; consolidating the two error
 * vocabularies into one lib/errors.ts is worth doing, but it would touch the
 * authentication phase's files and is not this phase's job.
 */

export type RepositoryErrorCode = "NOT_FOUND";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The record does not exist, OR it exists and the actor does not own it.
 *
 * Collapsing those two cases is intentional. Returning "forbidden" for a record
 * the caller does not own confirms that the id is real, which turns the
 * endpoint into an enumeration oracle.
 */
export class NotFoundError extends RepositoryError {
  constructor(message = "Not found", options?: { cause?: unknown }) {
    super("NOT_FOUND", message, options);
  }
}
