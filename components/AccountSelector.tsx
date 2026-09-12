import Link from "next/link";

/**
 * Choose which linked account a page is showing.
 *
 * WHY THIS EXISTS. Transaction History read an account id from the URL and
 * otherwise fell back to the first account, but rendered nothing to change it.
 * A customer with two banks could only ever see one of them, and the only way
 * to reach the other was to know its id and type it into the address bar.
 *
 * LINKS, NOT TABS. The dashboard uses client-side tabs, which is right there
 * because it swaps already-loaded panels. Here the account id is a SERVER
 * concern: the page reads it from searchParams and fetches that account's
 * history. A link keeps the URL the single source of truth, so the view is
 * shareable, bookmarkable, and survives a reload — and it needs no client
 * JavaScript at all.
 *
 * The page number is deliberately dropped when switching. Page 3 of one
 * account's history has no meaning for another's.
 */
export const AccountSelector = ({
  accounts,
  selectedItemId,
  basePath,
}: {
  accounts: { id: string; appwriteItemId: string; name: string; mask: string }[];
  selectedItemId: string;
  basePath: string;
}) => {
  // One account is not a choice. Rendering a single inert control implies there
  // is somewhere else to go.
  if (accounts.length < 2) return null;

  return (
    <nav aria-label="Select an account" className="flex flex-wrap gap-2">
      {accounts.map((account) => {
        const isSelected = account.appwriteItemId === selectedItemId;

        return (
          <Link
            key={account.id}
            href={`${basePath}?id=${encodeURIComponent(account.appwriteItemId)}`}
            // Announced to assistive technology rather than conveyed by colour
            // alone, which is the whole reason `aria-current` exists.
            aria-current={isSelected ? "page" : undefined}
            className={[
              "text-14 rounded-lg border px-4 py-2 font-medium transition-colors",
              isSelected
                ? "border-bankGradient bg-bank-gradient text-white"
                : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
            ].join(" ")}
          >
            {account.name}
            {account.mask ? (
              <span className={isSelected ? "text-white/80" : "text-gray-500"}>
                {" "}
                ••{account.mask}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
};

export default AccountSelector;
