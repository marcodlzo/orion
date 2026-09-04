import Link from "next/link";

/**
 * What a page shows before any bank is linked.
 *
 * WHY THIS EXISTS. Every page that reads accounts assumed at least one — the
 * transfer form crashed on `accounts[0].id` and the history page crashed on
 * `account.transactions.map`. A brand-new user, which is every user for their
 * first minute, met a blank screen and a stack trace.
 *
 * `if (!accounts) return` guarded the wrong thing: the list is not null when
 * there are no banks, it is EMPTY, and an empty array passes that check.
 */
export const NoLinkedAccounts = ({
  action,
}: {
  /** What the page needs an account for, in the user's words. */
  action: string;
}) => (
  <div className="flex flex-col items-start gap-3 rounded-lg border border-gray-200 bg-white p-6">
    <h2 className="text-18 font-semibold text-gray-900">
      No bank account linked yet
    </h2>
    <p className="text-14 max-w-prose text-gray-600">
      Link a bank account to {action}.
    </p>
    <Link
      href="/"
      className="text-14 font-semibold text-bankGradient underline-offset-4 hover:underline"
    >
      Go to your dashboard to connect a bank
    </Link>
  </div>
);

export default NoLinkedAccounts;
