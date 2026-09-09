import AnimatedCounter from './AnimatedCounter';
import DoughnutChart from './DoughnutChart';
import { formatMinorUnits } from '@/lib/domain/money';

const TotalBalanceBox = ({
  accounts = [], totalBanks, totalCurrentBalanceMinor, ledgerSummary
}: TotalBalanceBoxProps) => {
  return (
    <section className="total-balance">
      <div className="total-balance-chart">
        <DoughnutChart accounts={accounts} />
      </div>

      <div className="flex flex-col gap-6">
        <h2 className="header-2">
          Bank Accounts: {totalBanks}
        </h2>
        <div className="flex flex-col gap-2">
          <p className="total-balance-label">
            Provider balance
          </p>

          <div className="total-balance-amount flex-center gap-2">
            <AnimatedCounter amountMinor={totalCurrentBalanceMinor} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-gray-500">Orion ledger balance</dt>
              <dd className="font-semibold text-gray-900">
                {formatMinorUnits(ledgerSummary.ledgerBalanceMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Active holds</dt>
              <dd className="font-semibold text-gray-900">
                {formatMinorUnits(ledgerSummary.activeHoldsMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Credit allowance</dt>
              <dd className="font-semibold text-gray-900">
                {formatMinorUnits(ledgerSummary.creditAllowanceMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Available to transfer</dt>
              <dd className="font-semibold text-gray-900">
                {formatMinorUnits(ledgerSummary.availableToTransferMinor)}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  )
}

export default TotalBalanceBox
