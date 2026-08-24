// Server-only. Holds the Dwolla client, which is constructed with DWOLLA_KEY
// and DWOLLA_SECRET, and deals in funding-source URLs. None of these are called
// from a client component — they are used internally by the signup and
// bank-linking flows — so none is a server action.
//
// createDwollaTransfer lives here rather than behind a "use server" action:
// it accepts funding-source URLs, and a remotely callable function that does
// that is an account-drain primitive.
//
// Still absent, both tracked: idempotency keys, and persistence of the returned
// transfer reference.
import "server-only";

import { Client } from "dwolla-v2";

import { toDecimalString, type Money } from "../domain/money";

const getEnvironment = (): "production" | "sandbox" => {
  const environment = process.env.DWOLLA_ENV as string;

  switch (environment) {
    case "sandbox":
      return "sandbox";
    case "production":
      return "production";
    default:
      throw new Error(
        "Dwolla environment should either be set to `sandbox` or `production`"
      );
  }
};

/** Shared Dwolla client. Exported for the one remaining transfer action. */
export const dwollaClient = new Client({
  environment: getEnvironment(),
  key: process.env.DWOLLA_KEY as string,
  secret: process.env.DWOLLA_SECRET as string,
});

/**
 * Dwolla's wire representation of an amount.
 *
 * The ADAPTER decides this, not application logic. Dwolla wants a decimal
 * string with the currency alongside it; the domain holds exact minor units and
 * knows nothing about that.
 *
 * Uses the domain's exact formatter, so the value is never reconstructed by
 * dividing by 100 in floating point.
 *
 *   125075 -> "1250.75"
 *        1 -> "0.01"
 *      100 -> "1.00"
 */
export function toProviderAmount(money: Money): string {
  return toDecimalString(money);
}

/**
 * Initiate a Dwolla transfer.
 *
 * Accepts funding-source URLs because it is server-only and not remotely
 * callable. This function was previously a `'use server'` action, which meant
 * anyone who could reach the app could name any two funding sources and move
 * money between them. It is now reachable only from the transfer service.
 *
 * Returns the provider reference. Dwolla answers a successful POST with 201 and
 * a Location header naming the created transfer.
 *
 * ACCEPTANCE IS NOT SETTLEMENT. A returned URL means Dwolla accepted the
 * request, not that money moved. ACH settles over days and can still fail or be
 * returned. Nothing here may be treated as a terminal state.
 *
 * No idempotency key is sent. Retrying this creates a second transfer. That is
 * a tracked defect for the idempotency milestone and is NOT solved by moving
 * the call server-side.
 */
export async function createDwollaTransfer(input: {
  sourceFundingSourceUrl: string;
  destinationFundingSourceUrl: string;
  /** Exact minor units. Serialised to Dwolla's format by this adapter. */
  amount: Money;
}): Promise<{ transferUrl: string | null; transferId: string | null }> {
  const requestBody = {
    _links: {
      source: { href: input.sourceFundingSourceUrl },
      destination: { href: input.destinationFundingSourceUrl },
    },
    amount: {
      currency: input.amount.currency,
      value: toProviderAmount(input.amount),
    },
  };

  const response = await dwollaClient.post("transfers", requestBody);
  const transferUrl = response.headers.get("location") ?? null;
  const transferId = transferUrl ? transferUrl.split("/").pop() ?? null : null;

  return { transferUrl, transferId };
}

// Create a Dwolla Funding Source using a Plaid Processor Token
export const createFundingSource = async (
  options: CreateFundingSourceOptions
) => {
  try {
    return await dwollaClient
      .post(`customers/${options.customerId}/funding-sources`, {
        name: options.fundingSourceName,
        plaidToken: options.plaidToken,
      })
      .then((res) => res.headers.get("location"));
  } catch (err) {
    console.error("Creating a Funding Source Failed: ", err);
  }
};

export const createOnDemandAuthorization = async () => {
  try {
    const onDemandAuthorization = await dwollaClient.post(
      "on-demand-authorizations"
    );
    const authLink = onDemandAuthorization.body._links;
    return authLink;
  } catch (err) {
    console.error("Creating an On Demand Authorization Failed: ", err);
  }
};

export const createDwollaCustomer = async (
  newCustomer: NewDwollaCustomerParams
) => {
  try {
    return await dwollaClient
      .post("customers", newCustomer)
      .then((res) => res.headers.get("location"));
  } catch (err) {
    console.error("Creating a Dwolla Customer Failed: ", err);
  }
};

export const addFundingSource = async ({
  dwollaCustomerId,
  processorToken,
  bankName,
}: AddFundingSourceParams) => {
  try {
    // create dwolla auth link
    const dwollaAuthLinks = await createOnDemandAuthorization();

    // add funding source to the dwolla customer & get the funding source url
    const fundingSourceOptions = {
      customerId: dwollaCustomerId,
      fundingSourceName: bankName,
      plaidToken: processorToken,
      _links: dwollaAuthLinks,
    };
    return await createFundingSource(fundingSourceOptions);
  } catch (err) {
    console.error("Transfer fund failed: ", err);
  }
};
