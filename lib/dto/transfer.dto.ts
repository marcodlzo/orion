/**
 * Result of a money movement, as the browser sees it.
 *
 * ALLOWLIST. Deliberately tiny — the client needs to know the request was
 * accepted and which record represents it. Nothing else.
 *
 * NEVER present:
 *   fundingSourceUrl, accessToken, processorToken, the Dwolla transfer URL,
 *   dwollaCustomerId, either party's bank record, any raw Appwrite document
 */
export type TransferResultDTO = {
  transactionId: string;
  /**
   * "submitted" means the provider accepted the request.
   *
   * It deliberately does not say "completed" or "settled". ACH settles over
   * days and can still fail or be returned, and this application has no
   * webhook or state machine to learn the outcome. Claiming a terminal state
   * here would be the same defect as deriving status from a timestamp.
   */
  status: "submitted";
};

export const TRANSFER_RESULT_DTO_FIELDS = ["transactionId", "status"] as const;
