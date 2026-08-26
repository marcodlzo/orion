/**
 * The advisory-lock key that serialises migration work.
 *
 * Its own module because BOTH the backfill and the verifier need it, and the
 * verifier must not import the backfill: the containment suite requires that
 * only `scripts/` can reach a module capable of writing. A shared constant is
 * not a shared capability.
 *
 * Pure — no imports, no I/O — so it stays importable from either side.
 */

/**
 * Arbitrary but fixed.
 *
 * The backfill takes it as the first statement in its transaction, so two
 * migrations cannot interleave. The verifier waits on the same key before
 * taking its snapshot, so it observes the database between migrations rather
 * than through one.
 */
export const MIGRATION_LOCK_KEY = 4_812_007;
