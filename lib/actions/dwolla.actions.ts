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
import { requireActor } from "../auth/actor";

/**
 * PROTECTED — authenticated, NOT yet authorized.
 *
 * An anonymous caller can no longer move money. That is the entire extent of
 * the improvement here.
 *
 * STILL VULNERABLE, and this is the most dangerous endpoint in the application:
 * both funding-source URLs still come from the caller. An authenticated user
 * who knows a victim's funding-source URL can name it as the source and their
 * own as the destination. Possession of a URL remains sufficient to move money
 * from it.
 *
 * This cannot be fixed by adding a check here — the fix is to stop accepting
 * funding-source URLs from the browser at all, which is the transfer
 * orchestration phase.
 */
export const createTransfer = async ({
  sourceFundingSourceUrl,
  destinationFundingSourceUrl,
  amount,
}: TransferParams) => {
  try {
    await requireActor();

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
