import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  InvalidFinancialDecimalInputError,
  NonFiniteFinancialDecimalError,
  parseFinancialDecimal,
  toStorageDecimalString,
} from "../../src/shared/decimal.js";

describe("financial decimal boundary", () => {
  it("parses string values as Decimal instances", () => {
    const value = parseFinancialDecimal("5000.00000001");

    expect(value).toBeInstanceOf(Decimal);
    expect(value.toFixed()).toBe("5000.00000001");
  });

  it("keeps Decimal inputs without converting through number", () => {
    const input = new Decimal("0.0500");

    expect(parseFinancialDecimal(input)).toBe(input);
    expect(toStorageDecimalString(input)).toBe("0.05");
  });

  it("rejects JavaScript number input at the finance boundary", () => {
    expect(() => parseFinancialDecimal(0.1)).toThrow(InvalidFinancialDecimalInputError);
  });

  it.each(["NaN", "Infinity", "-Infinity"])("rejects non-finite string input: %s", (input) => {
    expect(() => parseFinancialDecimal(input)).toThrow(NonFiniteFinancialDecimalError);
  });

  it("rejects non-finite Decimal instances", () => {
    expect(() => parseFinancialDecimal(new Decimal("NaN"))).toThrow(NonFiniteFinancialDecimalError);
  });
});
