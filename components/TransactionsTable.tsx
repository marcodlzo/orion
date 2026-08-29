import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { transactionCategoryStyles, transactionStatusStyles } from "@/constants"
import { cn, formatDateTime, removeSpecialCharacters } from "@/lib/utils"
import { formatMinorUnits } from "@/lib/domain/money"
import type { TransactionStatus } from "@/lib/dto/transaction.dto"

const CategoryBadge = ({ category }: CategoryBadgeProps) => {
  const {
    borderColor,
    backgroundColor,
    textColor,
    chipBackgroundColor,
   } = transactionCategoryStyles[category as keyof typeof transactionCategoryStyles] || transactionCategoryStyles.default
   
  return (
    <div className={cn('category-badge', borderColor, chipBackgroundColor)}>
      <div className={cn('size-2 rounded-full', backgroundColor)} />
      <p className={cn('text-[12px] font-medium', textColor)}>{category}</p>
    </div>
  )
} 

/**
 * The transaction's REAL status.
 *
 * This used to be `getTransactionStatus(new Date(t.date))`, which returned
 * "Processing" under two days old and "Success" after — so a failed transfer
 * displayed as Success once it was old enough. The status now arrives on the
 * DTO from actual state and this component only chooses a colour for it.
 */
const StatusBadge = ({ status }: { status: TransactionStatus }) => {
  const style = transactionStatusStyles[status];

  return (
    <div className={cn('category-badge', style.borderColor, style.chipBackgroundColor)}>
      <div className={cn('size-2 rounded-full', style.backgroundColor)} />
      <p className={cn('text-[12px] font-medium', style.textColor)}>{style.label}</p>
    </div>
  )
}

const TransactionsTable = ({ transactions }: TransactionTableProps) => {
  return (
    <Table>
      <TableHeader className="bg-[#f9fafb]">
        <TableRow>
          <TableHead className="px-2">Transaction</TableHead>
          <TableHead className="px-2">Amount</TableHead>
          <TableHead className="px-2">Status</TableHead>
          <TableHead className="px-2">Date</TableHead>
          <TableHead className="px-2 max-md:hidden">Channel</TableHead>
          <TableHead className="px-2 max-md:hidden">Category</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((t) => {
          // Formatted from EXACT MINOR UNITS. The sign is carried by
          // `direction`, decided where the provider's convention is known,
          // rather than inferred from the first character of a formatted string
          // — which is what `amount[0] === '-'` was doing.
          const amount = formatMinorUnits(t.amountMinor, { signDisplay: "never" })
          const isDebit = t.direction === 'debit';

          return (
            <TableRow key={t.id} className={`${isDebit ? 'bg-[#FFFBFA]' : 'bg-[#F6FEF9]'} !over:bg-none !border-b-DEFAULT`}>
              <TableCell className="max-w-[250px] pl-2 pr-10">
                <div className="flex items-center gap-3">
                  <h1 className="text-14 truncate font-semibold text-[#344054]">
                    {removeSpecialCharacters(t.name)}
                  </h1>
                </div>
              </TableCell>

              <TableCell className={`pl-2 pr-10 font-semibold ${
                isDebit ? 'text-[#f04438]' : 'text-[#039855]'
              }`}>
                {isDebit ? `-${amount}` : `+${amount}`}
              </TableCell>

              <TableCell className="pl-2 pr-10">
                <StatusBadge status={t.status} />
              </TableCell>

              <TableCell className="min-w-32 pl-2 pr-10">
                {formatDateTime(new Date(t.date)).dateTime}
              </TableCell>

              <TableCell className="pl-2 pr-10 capitalize min-w-24">
               {t.paymentChannel}
              </TableCell>

              <TableCell className="pl-2 pr-10 max-md:hidden">
               <CategoryBadge category={t.category} /> 
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export default TransactionsTable