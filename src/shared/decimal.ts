import { Decimal } from "decimal.js";

export type FinancialDecimalInput = string | Decimal;

export class InvalidFinancialDecimalInputError extends Error {
  public constructor(inputType: string) {
    super(`Financial decimal input must be a string or Decimal, received ${inputType}`);
    this.name = "InvalidFinancialDecimalInputError";
  }
}

export function parseFinancialDecimal(input: unknown): Decimal {
  if (input instanceof Decimal) {
    return input;
  }

  if (typeof input === "number") {
    throw new InvalidFinancialDecimalInputError("number");
  }

  if (typeof input !== "string") {
    throw new InvalidFinancialDecimalInputError(typeof input);
  }

  return new Decimal(input);
}

export function toStorageDecimalString(input: FinancialDecimalInput): string {
  return parseFinancialDecimal(input).toFixed();
}
