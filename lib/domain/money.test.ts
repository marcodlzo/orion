import { describe, it, expect } from "vitest";

import {
  InvalidMoneyError,
  ZERO_USD,
  addMoney,
  compareMoney,
  isPositive,
  isZero,
  parseUsd,
  toDecimalString,
  tryParseUsd,
  usdFromMinor,
} from "./money";
import { toProviderAmount } from "../server/dwolla";

/**
 * EXACT MONEY.
 *
 * No tolerance, no epsilon, no toBeCloseTo. Financial arithmetic is exact or it
 * is wrong; a test that accepts "close enough" accepts the drift this module
 * exists to prevent.
 */

describe("parseUsd — accepted forms", () => {
  it.each([
    ["0.01", 1],
    ["0.10", 10],
    ["0.99", 99],
    ["1", 100],
    ["1.00", 100],
    ["1.0", 100],
    ["1.5", 150],
    ["10.10", 1010],
    ["12.50", 1250],
    ["1000.99", 100099],
    ["999999.99", 99999999],
    ["0", 0],
  ])("%s -> %d minor units", (input, expected) => {
    expect(parseUsd(input).amountMinor).toBe(expected);
  });

  it("always yields USD", () => {
    expect(parseUsd("1.00").currency).toBe("USD");
  });

  it("produces a safe integer", () => {
    expect(Number.isSafeInteger(parseUsd("999999.99").amountMinor)).toBe(true);
  });
});

describe("parseUsd — rejected forms", () => {
  it.each([
    ["", "empty"],
    ["   ", "whitespace only"],
    [" 1.00", "leading whitespace"],
    ["1.00 ", "trailing whitespace"],
    ["-1", "negative"],
    ["-0.01", "negative cents"],
    ["+1", "explicit sign"],
    ["1.001", "sub-cent precision"],
    ["1.999", "sub-cent precision"],
    ["1.0000", "sub-cent precision"],
    ["NaN", "not a number"],
    ["Infinity", "not an amount"],
    ["-Infinity", "not an amount"],
    ["1e3", "scientific notation"],
    ["1E3", "scientific notation"],
    ["$10", "currency symbol"],
    ["10,000", "thousands separator"],
    ["10.00.00", "two points"],
    [".5", "no leading digit"],
    ["1.", "trailing point"],
    ["abc", "not numeric"],
    ["0x10", "hex"],
    ["1 000", "internal space"],
  ])("rejects %s (%s)", (input) => {
    expect(() => parseUsd(input)).toThrow(InvalidMoneyError);
    expect(tryParseUsd(input)).toBeNull();
  });

  it("WHITESPACE IS REJECTED BY THE PRIMITIVE, deliberately", () => {
    // Trimming a form value is input normalisation and belongs to the adapter
    // that receives it. The domain boundary stays strict so that leniency is
    // visible at the edge rather than baked in here.
    expect(() => parseUsd(" 1.00 ")).toThrow(InvalidMoneyError);
    expect(parseUsd(" 1.00 ".trim()).amountMinor).toBe(100);
  });

  it("rejects an amount beyond exact representation", () => {
    expect(() => parseUsd("999999999999999")).toThrow(InvalidMoneyError);
  });

  it("raises a validation error, never an infrastructure one", () => {
    const error = (() => {
      try {
        parseUsd("abc");
      } catch (e) {
        return e as InvalidMoneyError;
      }
    })();

    expect(error).toBeInstanceOf(InvalidMoneyError);
    expect(error?.code).toBe("INVALID_MONEY");
    // Bad money is the caller's problem, not an outage.
    expect(error?.name).toBe("InvalidMoneyError");
  });
});

describe("no float is used to reach minor units", () => {
  // The usual way sub-cent error enters a codebase: Number("1.15") * 100 is
  // 114.99999999999999, so a naive parser produces 114 cents.
  it.each(["1.15", "2.675", "0.29", "8.20", "1.005"])(
    "%s does not inherit the float multiplication error",
    (input) => {
      const naive = Math.round(Number(input) * 100);
      const parsed = tryParseUsd(input);

      if (parsed) {
        // Where the value IS representable, the exact parse is authoritative.
        const exact = Number(input.split(".")[0]) * 100 +
          Number((input.split(".")[1] ?? "").padEnd(2, "0"));
        expect(parsed.amountMinor).toBe(exact);
      } else {
        // Sub-cent inputs are rejected outright rather than rounded, which is
        // what `naive` would silently do.
        expect(Number.isFinite(naive)).toBe(true);
      }
    }
  );

  it("truncating rather than rejecting would lose money — we reject", () => {
    expect(tryParseUsd("1.005")).toBeNull();
    expect(tryParseUsd("1.999")).toBeNull();
  });
});

describe("exact arithmetic", () => {
  it("10 cents + 20 cents is exactly 30 cents", () => {
    const total = addMoney(parseUsd("0.10"), parseUsd("0.20"));

    expect(total.amountMinor).toBe(30);
    expect(toDecimalString(total)).toBe("0.30");
    // The reason this module exists. No tolerance is permitted.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("sums a long run of cents without drift", () => {
    let total = ZERO_USD;
    for (let i = 0; i < 1000; i += 1) {
      total = addMoney(total, parseUsd("0.01"));
    }

    expect(total.amountMinor).toBe(1000);
    expect(toDecimalString(total)).toBe("10.00");
  });

  it("rejects a sum beyond exact representation", () => {
    const huge = usdFromMinor(Number.MAX_SAFE_INTEGER);
    expect(() => addMoney(huge, usdFromMinor(1))).toThrow(InvalidMoneyError);
  });

  it("compares by minor units", () => {
    expect(compareMoney(parseUsd("1.00"), parseUsd("0.99"))).toBeGreaterThan(0);
    expect(compareMoney(parseUsd("0.99"), parseUsd("1.00"))).toBeLessThan(0);
    expect(compareMoney(parseUsd("1.00"), parseUsd("1.00"))).toBe(0);
  });

  it("knows positive from zero", () => {
    expect(isPositive(parseUsd("0.01"))).toBe(true);
    expect(isPositive(ZERO_USD)).toBe(false);
    expect(isZero(parseUsd("0"))).toBe(true);
  });
});

describe("toDecimalString / toProviderAmount", () => {
  it.each([
    [125075, "1250.75"],
    [1, "0.01"],
    [10, "0.10"],
    [100, "1.00"],
    [0, "0.00"],
    [99999999, "999999.99"],
  ])("%d minor units serialises to %s", (minor, expected) => {
    expect(toDecimalString(usdFromMinor(minor))).toBe(expected);
    // The provider adapter owns the wire format and uses the exact formatter.
    expect(toProviderAmount(usdFromMinor(minor))).toBe(expected);
  });

  it("always emits two decimal places", () => {
    expect(toDecimalString(parseUsd("1"))).toBe("1.00");
    expect(toDecimalString(parseUsd("1.5"))).toBe("1.50");
  });

  it("does not reconstruct the value by dividing in floating point", () => {
    // 8.20 is a classic: 820 / 100 is 8.2, and toFixed(2) on some values
    // rounds the wrong way. Exact string construction avoids the question.
    expect(toDecimalString(usdFromMinor(820))).toBe("8.20");
    expect(toDecimalString(usdFromMinor(2675))).toBe("26.75");
    expect(toDecimalString(usdFromMinor(114))).toBe("1.14");
  });
});

describe("round trip preserves the exact value", () => {
  it.each([
    "0.01",
    "0.10",
    "1.00",
    "10.50",
    "12.50",
    "1000.99",
    "999999.99",
  ])("%s survives parse -> provider string", (input) => {
    const money = parseUsd(input);
    const wire = toProviderAmount(money);

    expect(parseUsd(wire).amountMinor).toBe(money.amountMinor);
  });

  it("normalises equivalent literals to the same canonical form", () => {
    expect(toProviderAmount(parseUsd("1"))).toBe("1.00");
    expect(toProviderAmount(parseUsd("1.0"))).toBe("1.00");
    expect(toProviderAmount(parseUsd("1.00"))).toBe("1.00");
  });
});

describe("usdFromMinor", () => {
  it("rejects a non-integer", () => {
    expect(() => usdFromMinor(1.5)).toThrow(InvalidMoneyError);
  });

  it("rejects an unsafe integer", () => {
    expect(() => usdFromMinor(Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidMoneyError);
  });

  it("accepts a negative value — sign is meaningful for entries", () => {
    // The primitive permits negatives; transfer validation is what rejects
    // them. Keeping those concerns separate matters once a ledger exists.
    expect(usdFromMinor(-500).amountMinor).toBe(-500);
    expect(toDecimalString(usdFromMinor(-500))).toBe("-5.00");
  });
});
