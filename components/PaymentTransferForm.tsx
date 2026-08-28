"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

import { initiateTransfer } from "@/lib/actions/transfer.actions";

import { BankDropdown } from "./BankDropdown";
import { Button } from "./ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "./ui/form";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const formSchema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().min(4, "Transfer note is too short"),
  // Was `.min(4)`, which validated the STRING LENGTH — it rejected "10" while
  // accepting "abcd". This mirrors the server's accepted money form so the user
  // gets sensible feedback. It is feedback only: the server reparses every
  // amount and is the actual boundary.
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount such as 10 or 10.50")
    // "greater than zero" without arithmetic: any non-zero digit anywhere.
    .refine((v) => /[1-9]/.test(v), "Amount must be greater than zero"),
  senderBank: z.string().min(4, "Please select a valid bank account"),
  shareableId: z.string().min(8, "Please select a valid shareable Id"),
});

const PaymentTransferForm = ({ accounts }: PaymentTransferFormProps) => {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  /**
   * The idempotency key for the CURRENT attempt.
   *
   * Held in a ref rather than minted at call time, because the whole mechanism
   * depends on a retry carrying the SAME key. A key generated inside submit()
   * would be new on every press, which deduplicates nothing.
   *
   * It is cleared only after a submission that we know resolved, so a retry
   * after a network failure reuses it and the server answers from the original
   * attempt instead of moving money again.
   */
  const idempotencyKey = useRef<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      amount: "",
      senderBank: "",
      shareableId: "",
    },
  });

  /**
   * Submits ONE intent. The browser no longer resolves banks, holds a
   * funding-source URL, calls Dwolla, or writes the transaction record.
   *
   * The zod schema above is for user feedback only. The server revalidates
   * every field — a caller can post directly to the action.
   *
   * IDEMPOTENT. The key below identifies one user action across attempts: the
   * server claims it durably before calling the provider, so a retry returns
   * the original result rather than moving money twice.
   *
   * `isLoading` still disables the button, but it is UX — it does nothing about
   * a second tab, a refresh, or a replayed request. The key is the guarantee.
   */
  const submit = async (data: z.infer<typeof formSchema>) => {
    if (isLoading) return;
    setIsLoading(true);

    // Reused across retries of THIS submission; a fresh one is minted only
    // after an attempt resolves.
    idempotencyKey.current ??= crypto.randomUUID();

    try {
      await initiateTransfer({
        idempotencyKey: idempotencyKey.current,
        senderBankId: data.senderBank,
        recipientReference: data.shareableId,
        amount: data.amount,
        note: data.name,
        recipientEmail: data.email,
      });

      // Resolved, so the next submission is a new user action.
      idempotencyKey.current = null;
      form.reset();
      router.push("/");
    } catch (error) {
      // Deliberately KEEPS the key. The attempt may have reached the provider,
      // so the next press must be recognisable as the same action rather than
      // a new transfer.
      console.error("Transfer request failed");
    }

    setIsLoading(false);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="flex flex-col">
        <FormField
          control={form.control}
          name="senderBank"
          render={() => (
            <FormItem className="border-t border-gray-200">
              <div className="payment-transfer_form-item pb-6 pt-5">
                <div className="payment-transfer_form-content">
                  <FormLabel className="text-14 font-medium text-gray-700">
                    Select Source Bank
                  </FormLabel>
                  <FormDescription className="text-12 font-normal text-gray-600">
                    Select the bank account you want to transfer funds from
                  </FormDescription>
                </div>
                <div className="flex w-full flex-col">
                  <FormControl>
                    <BankDropdown
                      accounts={accounts}
                      setValue={form.setValue}
                      otherStyles="!w-full"
                    />
                  </FormControl>
                  <FormMessage className="text-12 text-red-500" />
                </div>
              </div>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="border-t border-gray-200">
              <div className="payment-transfer_form-item pb-6 pt-5">
                <div className="payment-transfer_form-content">
                  <FormLabel className="text-14 font-medium text-gray-700">
                    Transfer Note (Optional)
                  </FormLabel>
                  <FormDescription className="text-12 font-normal text-gray-600">
                    Please provide any additional information or instructions
                    related to the transfer
                  </FormDescription>
                </div>
                <div className="flex w-full flex-col">
                  <FormControl>
                    <Textarea
                      placeholder="Write a short note here"
                      className="input-class"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-12 text-red-500" />
                </div>
              </div>
            </FormItem>
          )}
        />

        <div className="payment-transfer_form-details">
          <h2 className="text-18 font-semibold text-gray-900">
            Bank account details
          </h2>
          <p className="text-16 font-normal text-gray-600">
            Enter the bank account details of the recipient
          </p>
        </div>

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="border-t border-gray-200">
              <div className="payment-transfer_form-item py-5">
                <FormLabel className="text-14 w-full max-w-[280px] font-medium text-gray-700">
                  Recipient&apos;s Email Address
                </FormLabel>
                <div className="flex w-full flex-col">
                  <FormControl>
                    <Input
                      placeholder="ex: johndoe@gmail.com"
                      className="input-class"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-12 text-red-500" />
                </div>
              </div>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="shareableId"
          render={({ field }) => (
            <FormItem className="border-t border-gray-200">
              <div className="payment-transfer_form-item pb-5 pt-6">
                <FormLabel className="text-14 w-full max-w-[280px] font-medium text-gray-700">
                  Receiver&apos;s Plaid Sharable Id
                </FormLabel>
                <div className="flex w-full flex-col">
                  <FormControl>
                    <Input
                      placeholder="Enter the public account number"
                      className="input-class"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-12 text-red-500" />
                </div>
              </div>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="amount"
          render={({ field }) => (
            <FormItem className="border-y border-gray-200">
              <div className="payment-transfer_form-item py-5">
                <FormLabel className="text-14 w-full max-w-[280px] font-medium text-gray-700">
                  Amount
                </FormLabel>
                <div className="flex w-full flex-col">
                  <FormControl>
                    <Input
                      placeholder="ex: 5.00"
                      className="input-class"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="text-12 text-red-500" />
                </div>
              </div>
            </FormItem>
          )}
        />

        <div className="payment-transfer_btn-box">
          <Button type="submit" disabled={isLoading} className="payment-transfer_btn">
            {isLoading ? (
              <>
                <Loader2 size={20} className="animate-spin" /> &nbsp; Sending...
              </>
            ) : (
              "Transfer Funds"
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default PaymentTransferForm;
