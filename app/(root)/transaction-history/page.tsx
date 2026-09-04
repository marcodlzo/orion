import HeaderBox from '@/components/HeaderBox'
import { Pagination } from '@/components/Pagination';
import TransactionsTable from '@/components/TransactionsTable';
import { getAccount, getAccounts } from '@/lib/server/banks';
import { getLoggedInUser } from '@/lib/actions/user.actions';
import { formatMinorUnits } from '@/lib/domain/money';
import NoLinkedAccounts from '@/components/NoLinkedAccounts';
import React from 'react'

const TransactionHistory = async ({ searchParams: { id, page }}:SearchParamProps) => {
  const currentPage = Number(page as string) || 1;
  const loggedIn = await getLoggedInUser();
  const accounts = await getAccounts()

  const accountsData = accounts?.data ?? [];
  const appwriteItemId = (id as string) || accountsData[0]?.appwriteItemId;

  // Nothing to look up, and nothing to render. Asking getAccount for an
  // undefined id produced "Bank not found" on every page load.
  if (accountsData.length === 0 || !appwriteItemId) {
    return (
      <div className="transactions">
        <div className="transactions-header">
          <HeaderBox
            title="Transaction History"
            subtext="See your bank details and transactions."
          />
        </div>
        <div className="space-y-6">
          <NoLinkedAccounts action="see your transaction history" />
        </div>
      </div>
    );
  }

  const account = await getAccount({ appwriteItemId })

  // getAccount swallows its errors and returns undefined. Until that changes,
  // every read below has to survive it rather than throw on `.length`.
  const transactions = account?.transactions ?? [];

  const rowsPerPage = 10;
  const totalPages = Math.ceil(transactions.length / rowsPerPage);

  const indexOfLastTransaction = currentPage * rowsPerPage;
  const indexOfFirstTransaction = indexOfLastTransaction - rowsPerPage;

  const currentTransactions = transactions.slice(
    indexOfFirstTransaction, indexOfLastTransaction
  )
  return (
    <div className="transactions">
      <div className="transactions-header">
        <HeaderBox 
          title="Transaction History"
          subtext="See your bank details and transactions."
        />
      </div>

      <div className="space-y-6">
        <div className="transactions-account">
          <div className="flex flex-col gap-2">
            <h2 className="text-18 font-bold text-white">{account?.data.name}</h2>
            <p className="text-14 text-blue-25">
              {account?.data.officialName}
            </p>
            <p className="text-14 font-semibold tracking-[1.1px] text-white">
              ●●●● ●●●● ●●●● {account?.data.mask}
            </p>
          </div>
          
          <div className='transactions-account-balance'>
            <p className="text-14">Current balance</p>
            <p className="text-24 text-center font-bold">{formatMinorUnits(account?.data.currentBalanceMinor ?? 0)}</p>
          </div>
        </div>

        <section className="flex w-full flex-col gap-6">
          <TransactionsTable 
            transactions={currentTransactions}
          />
            {totalPages > 1 && (
              <div className="my-4 w-full">
                <Pagination totalPages={totalPages} page={currentPage} />
              </div>
            )}
        </section>
      </div>
    </div>
  )
}

export default TransactionHistory