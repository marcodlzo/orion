/**
 * Standing limits, in exact minor units.
 *
 * These are POLICY, not arithmetic, and they are here rather than in a config
 * file so that changing one is a code review rather than an environment
 * variable somebody sets differently in production.
 */

/**
 * How far below zero a customer's AVAILABLE balance may go.
 *
 * WHAT THIS ACTUALLY CONSTRAINS TODAY: how much one customer may have committed
 * and unsettled at one time. It is not a bank-balance check, and describing it
 * as one would be a lie — this system does not know what is in anyone's bank
 * account. Nothing credits a customer's ledger account yet, so their ledger
 * balance is zero or negative, and every in-flight transfer draws against this
 * allowance.
 *
 * THE VALUE IS A PLACEHOLDER; THE MECHANISM IS NOT. The enforcement — checked
 * under a row lock, in the same transaction as the claim, before the provider is
 * called — is what this milestone delivers and what the tests prove. The number
 * needs a product decision and real balance data (Plaid balances, Milestone 10),
 * at which point this same check becomes a genuine solvency check without
 * changing shape.
 *
 * Kept in step with `migrations/1700000004000_holds-and-available-balance.sql`,
 * which seeds existing rows with it; a test asserts the two agree.
 */
export const CUSTOMER_CREDIT_LIMIT_MINOR = 500000;

/**
 * The house account's limit.
 *
 * Zero, and constrained to zero by the schema. No hold is ever placed against
 * the settlement account, so this is never consulted — which is exactly why it
 * is pinned: an attempt to draw on it fails loudly rather than quietly
 * succeeding against an allowance nobody granted.
 */
export const SETTLEMENT_CREDIT_LIMIT_MINOR = 0;
