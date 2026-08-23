/**
 * Typed failures for the authentication boundary.
 *
 * The distinction that matters: an infrastructure failure must never be
 * reported as "unauthorized". Collapsing them hides outages behind a login
 * screen and, worse, trains callers to treat every failure as an auth problem.
 *
 * Deliberately minimal. This is not an application-wide error envelope; it is
 * the smallest vocabulary the actor boundary needs. Extend it when a later
 * milestone has a concrete need, not in anticipation of one.
 */

export type AuthErrorCode =
  | "UNAUTHORIZED"
  | "ACTOR_NOT_PROVISIONED"
  | "INFRASTRUCTURE";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
    // Required when targeting ES5 so `instanceof` works across the subclass chain.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * No usable session. The caller is anonymous, the cookie is absent, or the
 * session has expired or been revoked.
 */
export class UnauthorizedError extends AuthError {
  constructor(message = "Not authenticated", options?: { cause?: unknown }) {
    super("UNAUTHORIZED", message, options);
  }
}

/**
 * The session is valid but no internal user record backs it.
 *
 * This is reachable in practice: signUp creates the Appwrite auth account, then
 * the Dwolla customer, then the user document, with no transaction around them.
 * A failure between steps leaves exactly this state. Never fabricate an actor
 * to paper over it.
 */
export class ActorNotProvisionedError extends AuthError {
  constructor(message = "Authenticated account has no internal user record", options?: { cause?: unknown }) {
    super("ACTOR_NOT_PROVISIONED", message, options);
  }
}

/**
 * The datastore or auth provider failed while resolving identity. The caller
 * may well be authenticated; we could not determine it. Never downgrade this to
 * UnauthorizedError.
 */
export class InfrastructureError extends AuthError {
  constructor(message = "Could not resolve identity", options?: { cause?: unknown }) {
    super("INFRASTRUCTURE", message, options);
  }
}

/** True when the caller is definitively not authenticated. */
export const isUnauthenticated = (error: unknown): boolean =>
  error instanceof UnauthorizedError || error instanceof ActorNotProvisionedError;
