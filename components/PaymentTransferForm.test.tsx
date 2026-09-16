import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actions/transfer.actions", () => ({
  initiateTransfer: vi.fn(),
}));
vi.mock("./BankDropdown", () => ({ BankDropdown: vi.fn() }));
vi.mock("./ui/button", () => ({ Button: vi.fn() }));
vi.mock("./ui/form", () => ({
  Form: vi.fn(),
  FormControl: vi.fn(),
  FormDescription: vi.fn(),
  FormField: vi.fn(),
  FormItem: vi.fn(),
  FormLabel: vi.fn(),
  FormMessage: vi.fn(),
}));
vi.mock("./ui/input", () => ({ Input: vi.fn() }));
vi.mock("./ui/textarea", () => ({ Textarea: vi.fn() }));

import { paymentTransferFormSchema } from "./PaymentTransferForm";

const validForm = {
  email: "recipient@example.invalid",
  name: "Rent",
  amount: "25.00",
  senderBank: "bank-source",
  shareToken: "0123456789abcdef0123456789abcdef",
};

describe("PaymentTransferForm recipient reference", () => {
  it("accepts the exact lowercase 32-hex share-token shape", () => {
    expect(paymentTransferFormSchema.safeParse(validForm).success).toBe(true);
  });

  it.each([
    ["short", "01234567"],
    ["non-hex", "g123456789abcdef0123456789abcdef"],
    ["uppercase", "0123456789ABCDEF0123456789ABCDEF"],
    ["appended", "0123456789abcdef0123456789abcdef00"],
  ])("rejects a %s recipient reference", (_label, shareToken) => {
    expect(
      paymentTransferFormSchema.safeParse({ ...validForm, shareToken }).success
    ).toBe(false);
  });
});
