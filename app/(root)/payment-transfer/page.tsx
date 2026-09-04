import HeaderBox from '@/components/HeaderBox'
import PaymentTransferForm from '@/components/PaymentTransferForm'
import { getAccounts } from '@/lib/server/banks';
import { getLoggedInUser } from '@/lib/actions/user.actions';
import NoLinkedAccounts from '@/components/NoLinkedAccounts';
import React from 'react'

const Transfer = async () => {
  const loggedIn = await getLoggedInUser();
  const accounts = await getAccounts()

  const accountsData = accounts?.data ?? [];

  return (
    <section className="payment-transfer">
      <HeaderBox 
        title="Payment Transfer"
        subtext="Please provide any specific details or notes related to the payment transfer"
      />

      <section className="size-full pt-5">
        {/*
          EMPTY IS NOT THE SAME AS MISSING. The old guard was `if (!accounts)
          return`, which renders nothing at all for a failed read AND passes an
          empty list straight through to a form that indexed accounts[0].
        */}
        {accountsData.length === 0 ? (
          <NoLinkedAccounts action="send a payment" />
        ) : (
          <PaymentTransferForm accounts={accountsData} />
        )}
      </section>
    </section>
  )
}

export default Transfer