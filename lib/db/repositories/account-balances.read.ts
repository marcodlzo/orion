// Server-only. Actor-scoped, read-only balance projection for account screens.
import "server-only";

import type { Actor } from "../../auth/actor";
import { query, readMoneyMinor } from "../pool";

export type AccountBalanceSummary = {
  ledgerBalanceMinor: number;
  activeHoldsMinor: number;
  creditAllowanceMinor: number;
  availableToTransferMinor: number;
};

const ZERO: AccountBalanceSummary = {
  ledgerBalanceMinor: 0,
  activeHoldsMinor: 0,
  creditAllowanceMinor: 0,
  availableToTransferMinor: 0,
};

/**
 * Derive the authenticated customer's internal balances on every read.
 *
 * Ownership is in the SQL predicate. No customer or ledger account belonging
 * to another actor is loaded and filtered in application memory. The scalar
 * subqueries avoid multiplying entries by holds when both sets contain rows.
 */
export async function getAccountBalanceSummary(
  actor: Actor
): Promise<AccountBalanceSummary> {
  const { rows } = await query<{
    ledger_balance_minor: string;
    active_holds_minor: string;
    credit_allowance_minor: string;
  }>(
    `SELECT
       COALESCE((
         SELECT sum(e.amount_minor)
           FROM ledger_entries e
          WHERE e.account_id = la.id
       ), 0)::text AS ledger_balance_minor,
       COALESCE((
         SELECT sum(h.amount_minor)
           FROM ledger_holds h
          WHERE h.account_id = la.id AND h.state = 'active'
       ), 0)::text AS active_holds_minor,
       COALESCE(la.credit_limit_minor, 0)::text AS credit_allowance_minor
     FROM banking_customers c
     LEFT JOIN ledger_accounts la
       ON la.customer_id = c.id
      AND la.kind = 'customer'
      AND la.currency = 'USD'
     WHERE c.appwrite_auth_id = $1
       AND c.appwrite_user_document_id = $2
     LIMIT 1`,
    [actor.authId, actor.userId]
  );

  if (!rows[0]) return ZERO;

  const ledgerBalanceMinor = readMoneyMinor(rows[0].ledger_balance_minor);
  const activeHoldsMinor = readMoneyMinor(rows[0].active_holds_minor);
  const creditAllowanceMinor = readMoneyMinor(rows[0].credit_allowance_minor);

  return {
    ledgerBalanceMinor,
    activeHoldsMinor,
    creditAllowanceMinor,
    availableToTransferMinor:
      ledgerBalanceMinor - activeHoldsMinor + creditAllowanceMinor,
  };
}
