"use server";

// Only createTransfer remains a server action: it is invoked directly from
// PaymentTransferForm.tsx, a client component.
//
// It is also the single most dangerous endpoint in the application — it accepts
// arbitrary source and destination funding-source URLs from the caller, which
// makes possession of a URL sufficient to move money from it. Securing it means
// removing the browser's ability to name funding sources at all, which is
// transfer-orchestration work for a later milestone. Nothing about its
// behaviour is changed here.
//
// The Dwolla client and every non-client-facing Dwolla operation now live in
// lib/server/dwolla.ts and are no longer publicly callable.

import { dwollaClient } from "../server/dwolla";

export const createTransfer = async ({
  sourceFundingSourceUrl,
  destinationFundingSourceUrl,
  amount,
}: TransferParams) => {
  try {
    const requestBody = {
      _links: {
        source: {
          href: sourceFundingSourceUrl,
        },
        destination: {
          href: destinationFundingSourceUrl,
        },
      },
      amount: {
        currency: "USD",
        value: amount,
      },
    };
    return await dwollaClient
      .post("transfers", requestBody)
      .then((res) => res.headers.get("location"));
  } catch (err) {
    console.error("Transfer fund failed: ", err);
  }
};
