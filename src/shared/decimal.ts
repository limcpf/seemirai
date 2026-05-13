import { Decimal } from "decimal.js";

export type FinancialDecimalInput = string | Decimal;

export class InvalidFinancialDecimalInputError extends Error {
  public constructor(inputType: string) {
    super(`Financial decimal input must be a string or Decimal, received ${inputType}`);
    this.name = "InvalidFinancialDecimalInputError";
  }
}

export class NonFiniteFinancialDecimalError extends Error {
  public constructor() {
    super("Financial decimal input must be finite");
    this.name = "NonFiniteFinancialDecimalError";
  }
}

export function parseFinancialDecimal(input: unknown): Decimal {
  let value: Decimal;

  if (input instanceof Decimal) {
    value = input;
  } else if (typeof input === "number") {
    throw new InvalidFinancialDecimalInputError("number");
  } else if (typeof input !== "string") {
    throw new InvalidFinancialDecimalInputError(typeof input);
  } else {
    value = new Decimal(input);
  }

  if (!value.isFinite()) {
    throw new NonFiniteFinancialDecimalError();
  }

  return value;
}

export function toStorageDecimalString(input: FinancialDecimalInput): string {
  return parseFinancialDecimal(input).toFixed();
}
