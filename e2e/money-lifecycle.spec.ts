import { test, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { Client, Databases, Query } from "node-appwrite";

// Real browser, Appwrite, Plaid Link sandbox, Dwolla sandbox, and PostgreSQL.
// No action, provider, authentication, or ledger mocks.
test.describe.configure({ mode: "serial" });
const email = `orion-e2e-${randomUUID()}@example.com`;
const password = `Orion-${randomUUID()}!`;
const pool = new Pool({ connectionString: process.env.ORION_E2E_DATABASE_URL });
const database = new Databases(new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT!)
  .setKey(process.env.NEXT_APPWRITE_KEY!));
let context: BrowserContext;
let page: Page;
let userDocumentId: string;
let transferRequest: { url: string; body: string; headers: Record<string, string> };
let transferId: string;
let durable: unknown;
const errors: string[] = [];
function probe(mode: string, bankId: string) {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--import", "./scripts/loader/server-only-alias.mjs",
    "e2e/item-probe.ts", mode, bankId], { encoding: "utf8", timeout: 90_000 }));
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.name));
});
test.afterAll(async () => { await context?.close(); await pool.end(); });

async function ownedBanks() {
  const result = await database.listDocuments({ databaseId: process.env.APPWRITE_DATABASE_ID!,
    collectionId: process.env.APPWRITE_BANK_COLLECTION_ID!, queries: [Query.equal("userId", [userDocumentId])] });
  return result.documents;
}

test("new signup reaches the dashboard without a bank", async () => {
  await page.goto("http://localhost:3101/sign-up");
  for (const [label, value] of Object.entries({ "First Name": "Lifecycle", "Last Name": "Tester",
    Address: "99 Test Street", City: "New York", State: "NY", "Postal Code": "10001",
    "Date of Birth": "1990-01-01", SSN: "1234", Email: email, Password: password })) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole("button", { name: "Sign Up", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Link Account/ })).toBeVisible();
  await page.goto("http://localhost:3101/");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  expect(errors).toEqual([]);
  const users = await database.listDocuments({ databaseId: process.env.APPWRITE_DATABASE_ID!,
    collectionId: process.env.APPWRITE_USER_COLLECTION_ID!, queries: [Query.equal("email", [email])] });
  expect(users.documents).toHaveLength(1);
  userDocumentId = users.documents[0].$id;
  expect(await ownedBanks()).toHaveLength(0);
});

test("empty transaction and payment pages render without crashing", async () => {
  for (const route of ["/transaction-history", "/payment-transfer", "/my-banks"]) {
    await page.goto(`http://localhost:3101${route}`);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByText(/Application error/)).toHaveCount(0);
  }
  await page.goto("http://localhost:3101/payment-transfer");
  await expect(page.getByText(/connect|link/i).first()).toBeVisible();
  expect(await ownedBanks()).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("sign in and link every sandbox depository account through Plaid Link", async () => {
  await context.clearCookies();
  await page.goto("http://localhost:3101/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  // NOT an exact name. The sidebar button's accessible name is composed from
  // the icon's alt text AND the label, so it reads "connect bank Connect bank"
  // and an exact match finds nothing. Waiting on it silently burned the whole
  // 180s timeout.
  //
  // Playwright waits for the button to be ENABLED, which is what makes this
  // deterministic: every variant is now disabled until Plaid reports ready, so
  // the click cannot land while `open()` would be a no-op.
  await page.getByRole("button", { name: /connect bank/i }).first().click();
  const link = page.frameLocator('iframe[id^="plaid-link-iframe"]');
  // Plaid's consent screen offers two buttons matching /continue/i: a submit
  // that stays DISABLED until a phone number is entered, and an explicit
  // "continue without phone number". Targeting by test id rather than by name
  // avoids both the ambiguity and the disabled one.
  await link.getByTestId("button-combined-consent-continue-without-phone").click();
  // The default list shows popular real institutions; the sandbox test bank has
  // to be searched for. First Platypus Bank is the non-OAuth sandbox
  // institution, which is why it is used here — the real banks in this list all
  // route through an OAuth handoff that cannot be driven headlessly.
  await link.getByRole("searchbox").fill("Platypus");
  // Search results are `option` elements, not buttons. Anchored at the start so
  // "First Platypus Balance Bank" and the other sandbox variants do not match.
  await link.getByRole("option").filter({ hasText: /^First Platypus Bank/ }).first().click();
  // Plaid then offers three flavours of the same sandbox institution. The exact
  // name is the plain one; the other two are OAuth handoffs that leave the
  // iframe for a provider-hosted page and cannot be driven here.
  await link.getByRole("button", { name: "First Platypus Bank", exact: true }).click();
  await link.getByLabel(/username/i).fill("user_good");
  await link.getByLabel(/password/i).fill("pass_good");
  await link.getByRole("button", { name: /submit/i }).click();
  await link.getByRole("button", { name: /continue/i }).click();
  // OPTIONAL, and it must be. Link sometimes finishes on the previous click and
  // tears its iframe down, so a second unconditional click fails on a detached
  // element rather than on anything real. The assertion that the flow worked is
  // the poll below, which watches for the linked banks — not the button count.
  await link
    .getByRole("button", { name: /continue/i })
    .click({ timeout: 15_000 })
    .catch(() => undefined);
  await expect.poll(async () => (await ownedBanks()).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
  const banks = await ownedBanks();
  const provider = probe("accounts", banks[0].$id) as {
    accounts: Array<{ id: string; subtype: string | null }>;
  };

  // NOT every depository account — every FUNDABLE one.
  //
  // First Platypus Bank reports three depository accounts: checking, savings,
  // and cash management. Dwolla accepts only checking and savings as ACH
  // funding sources, so the third is refused by the provider and reported as a
  // partial failure rather than linked. Linking a bank you cannot transfer from
  // would be worse than skipping it.
  //
  // What this still proves is the defect it was written for: the tutorial kept
  // `accounts[0]` and silently discarded the rest, so more than one linked bank
  // is the assertion that matters.
  const fundable = provider.accounts.filter(
    a => a.subtype === "checking" || a.subtype === "savings"
  );
  expect(fundable.length).toBeGreaterThan(1);
  expect(banks.map(b => b.accountId).sort()).toEqual(fundable.map(a => a.id).sort());
  const mirrors = await pool.query(`SELECT external_account_id,display_name FROM linked_accounts a
    JOIN banking_customers c ON c.id=a.customer_id WHERE c.appwrite_user_document_id=$1`, [userDocumentId]);
  expect(mirrors.rows.map(r => r.external_account_id).sort()).toEqual(banks.map(b => b.accountId).sort());
  await page.goto("http://localhost:3101/my-banks");
  for (const row of mirrors.rows) await expect(page.getByText(row.display_name, { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("operator sync persists transactions and resumes from the stored cursor", async () => {
  const banks = await ownedBanks();
  const itemId = banks[0].bankId;
  await expect.poll(async () => {
    const outcome = probe("sync", banks[0].$id);
    expect(outcome.status).toBe("synced");
    return (await pool.query("SELECT count(*)::int AS n FROM plaid_transactions WHERE item_id=$1", [itemId])).rows[0].n;
  }, { timeout: 120_000, intervals: [3000, 5000] }).toBeGreaterThan(0);
  const before = await pool.query("SELECT plaid_transaction_id,amount_minor FROM plaid_transactions WHERE item_id=$1 ORDER BY plaid_transaction_id", [itemId]);
  const outcome = probe("sync", banks[0].$id);
  expect(outcome).toMatchObject({ status: "synced", resumed: true });
  const item = await pool.query("SELECT status,cursor,last_error_code FROM plaid_items WHERE item_id=$1", [itemId]);
  expect(item.rows[0].status).toBe("healthy");
  expect(item.rows[0].cursor).toBeTruthy();
  expect(item.rows[0].last_error_code).toBeNull();
  const after = await pool.query("SELECT plaid_transaction_id,amount_minor FROM plaid_transactions WHERE item_id=$1 ORDER BY plaid_transaction_id", [itemId]);
  expect(after.rows).toEqual(before.rows);
  for (const row of after.rows) expect(String(row.amount_minor)).toMatch(/^-?\d+$/);
  await page.goto("http://localhost:3101/transaction-history");
  await expect(page.locator("tbody tr").first()).toBeVisible();
});

async function financialSnapshot() {
  const transfers = await pool.query(`SELECT t.id,t.state,t.amount_minor,t.provider_transfer_id FROM transfers t
    JOIN banking_customers c ON c.id=t.customer_id WHERE c.appwrite_user_document_id=$1 ORDER BY t.id`, [userDocumentId]);
  const holds = await pool.query("SELECT id,state,amount_minor FROM ledger_holds WHERE transfer_id=$1 ORDER BY id", [transferId]);
  const entries = await pool.query(`SELECT e.id,e.amount_minor FROM ledger_entries e JOIN ledger_transactions t
    ON t.id=e.transaction_id WHERE t.transfer_id=$1 ORDER BY e.id`, [transferId]);
  return { transfers: transfers.rows, holds: holds.rows, entries: entries.rows };
}

test("transfer form creates exactly one durable transfer, hold, and provider reference", async () => {
  const banks = await ownedBanks();
  await page.goto("http://localhost:3101/payment-transfer");
  await page.getByRole("combobox").click();
  await page.getByRole("option").first().click();
  await page.getByPlaceholder("Write a short note here").fill("Lifecycle sandbox test");
  await page.getByPlaceholder("ex: johndoe@gmail.com").fill(email);
  await page.getByPlaceholder("Enter the public account number").fill(banks[1].shareableId);
  await page.getByPlaceholder("ex: 5.00").fill("0.01");
  const isTransfer = (request: Request) => request.method() === "POST" &&
    Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes("idempotencyKey"));
  const requestPromise = page.waitForRequest(isTransfer);
  await page.getByRole("button", { name: "Transfer Funds", exact: true }).click();
  const request = await requestPromise;
  transferRequest = { url: request.url(), body: request.postData()!, headers: {
    "next-action": request.headers()["next-action"], "content-type": request.headers()["content-type"],
  } };
  await expect.poll(async () => (await pool.query(`SELECT t.id FROM transfers t JOIN banking_customers c
    ON c.id=t.customer_id WHERE c.appwrite_user_document_id=$1 AND t.state='submitted'`, [userDocumentId])).rowCount).toBe(1);
  const result = await pool.query(`SELECT t.id FROM transfers t JOIN banking_customers c
    ON c.id=t.customer_id WHERE c.appwrite_user_document_id=$1`, [userDocumentId]);
  transferId = result.rows[0].id;
  durable = await financialSnapshot();
  const snapshot = await financialSnapshot();
  expect(snapshot.transfers).toHaveLength(1);
  expect(snapshot.transfers[0]).toMatchObject({ state: "submitted", amount_minor: "1" });
  expect(snapshot.transfers[0].provider_transfer_id).toBeTruthy();
  expect(snapshot.holds).toHaveLength(1);
  expect(snapshot.holds[0]).toMatchObject({ state: "active", amount_minor: "1" });
  expect(snapshot.entries).toHaveLength(0); // Provider acceptance is not settlement.
});

test("replaying the exact browser request has one financial effect", async () => {
  const status = await page.evaluate(async input => {
    const response = await fetch(input.url, { method: "POST", headers: input.headers, body: input.body });
    await response.text();
    return response.status;
  }, transferRequest);
  expect(status).toBe(200);
  expect(await financialSnapshot()).toEqual(durable);
});
