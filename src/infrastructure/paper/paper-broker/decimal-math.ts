import type { NumericString } from "../../../domain/index.js";
import { parseFinancialDecimal } from "../../../shared/index.js";

/**
 * 통화 코드를 paper broker 내부 key로 정규화한다.
 *
 * 잔고 map은 대소문자와 공백 차이 때문에 중복 row가 생기면 주문 한도 검증이 틀어지므로 모든 통화를 같은 key로 맞춘다.
 */
export function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * numeric 문자열을 Decimal 기준 canonical 문자열로 정규화한다.
 *
 * idempotency fingerprint와 balance snapshot이 입력 scale 차이에 흔들리지 않게 한다.
 */
export function normalizeDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).toFixed();
}

export function parseFinancialDecimalString(value: NumericString): ReturnType<typeof parseFinancialDecimal> {
  return parseFinancialDecimal(value);
}

export function addDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).add(parseFinancialDecimal(right)).toFixed();
}

export function subtractDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).sub(parseFinancialDecimal(right)).toFixed();
}

export function multiplyDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).mul(parseFinancialDecimal(right)).toFixed();
}

export function negateDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).negated().toFixed();
}

export function absDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).abs().toFixed();
}

export function isPositiveDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).greaterThan(0);
}

export function isNegativeDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).lessThan(0);
}

export function isZeroDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).equals(0);
}
