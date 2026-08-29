import { toMinorUnits } from "../plaid-sync/adapter";

/**
 * Read DTOs for bank/account display.
 *
 * ALLOWLIST. Every field is named explicitly, so a provider credential added to
 * the bank record later cannot reach a client by default.
 */

/**
 * One account as the UI renders it.
 *
 * Derived from actual usage:
 *   id               React key; BankDropdown option value (Plaid account id)
 *   appwriteItemId   bank document id, used for navigation (?id=)
 *   name             BankCard, BankInfo, BankDropdown, BankTabItem, DoughnutChart
 *   officialName     transaction-history detail header
 *   mask             BankCard, transaction-history detail
 *   type / subtype   BankInfo styling
 *   currentBalanceMinor  BankCard, BankInfo, BankDropdown, DoughnutChart, totals
 *   shareableId      the recipient reference a user copies to be paid
 *
 * Dropped because no rendering path reads them:
 *   availableBalance, institutionId, bankId (the Plaid item id)
 *
 * NEVER present, and this is the point of the type:
 *   accessToken        Plaid credential — grants read access to the account
 *   fundingSourceUrl   Dwolla capability — possession is sufficient to move money
 *   userId             raw Appwrite relationship document
 *
 * `shareableId` is intentionally included: it is the identifier a user hands
 * out to receive money. It is base64 of the Plaid account id rather than an
 * opaque token, which is a separate catalogued defect — encoding is not
 * encryption — but it is not a credential.
 */
export type AccountSummaryDTO = {
  id: string;
  appwriteItemId: string;
  name: string;
  officialName: string;
  mask: string;
  type: string;
  subtype: string;
  /**
   * EXACT INTEGER MINOR UNITS, converted at the adapter edge.
   *
   * This was `currentBalance: number` — a float, straight from Plaid's JSON —
   * and it was summed across accounts for the dashboard total, so the error
   * compounded per account. Plaid's number is converted once, by the same
   * function the sync uses, and no float exists past that point.
   */
  currentBalanceMinor: number;
  shareableId: string;
};

export const ACCOUNT_SUMMARY_DTO_FIELDS = [
  "id",
  "appwriteItemId",
  "name",
  "officialName",
  "mask",
  "type",
  "subtype",
  "currentBalanceMinor",
  "shareableId",
] as const;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * A Plaid balance to exact minor units.
 *
 * A missing balance is 0 rather than a throw: an account Plaid reports without a
 * current balance still renders, and refusing to build the DTO would take the
 * whole dashboard down for one incomplete account. A balance that is PRESENT but
 * unconvertible does throw, because silently showing 0 for real money is worse
 * than an error.
 */
const balanceMinor = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  return toMinorUnits(value);
};

/**
 * Build an account summary from a Plaid account plus the owning bank record.
 *
 * Takes the two sources separately rather than a pre-merged object, so the
 * bank record — which holds the credentials — is never spread anywhere.
 */
export function toAccountSummaryDTO(input: {
  plaidAccount: unknown;
  bank: unknown;
}): AccountSummaryDTO {
  const a = (input.plaidAccount ?? {}) as Record<string, unknown>;
  const b = (input.bank ?? {}) as Record<string, unknown>;
  const balances = (a.balances ?? {}) as Record<string, unknown>;

  return {
    id: str(a.account_id),
    appwriteItemId: str(b.$id),
    name: str(a.name),
    officialName: str(a.official_name),
    mask: str(a.mask),
    type: str(a.type),
    subtype: str(a.subtype),
    currentBalanceMinor: balanceMinor(balances.current),
    shareableId: str(b.shareableId),
  };
}
