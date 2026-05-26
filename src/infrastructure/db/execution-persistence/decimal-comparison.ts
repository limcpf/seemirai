import type { NumericString } from "../../../domain/index.js";
import { parseFinancialDecimal } from "../../../shared/index.js";

/**
 * nullable DB numeric 문자열을 지정 scale에서 비교한다.
 *
 * PostgreSQL numeric이 저장 과정에서 scale을 정규화해도 같은 경제적 값이면 idempotent 재시도로 인정하기 위해 사용한다.
 */
export function nullableDecimalStringEquals(
  left: NumericString | null,
  right: NumericString | null,
  scale: number,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return decimalStringEqualsAtScale(left, right, scale);
}

/**
 * 두 numeric 문자열이 같은 경제적 값인지 비교한다.
 *
 * 문자열 모양이 아니라 Decimal 값으로 비교해 broker metadata와 intent의 표현 scale 차이가 검증 실패로 번지지 않게 한다.
 */
export function decimalStringEquals(left: NumericString, right: NumericString): boolean {
  return parseFinancialDecimal(left).equals(parseFinancialDecimal(right));
}

/**
 * 두 numeric 문자열을 지정 scale로 정규화해 비교한다.
 *
 * DB column scale이 intent보다 짧은 경우에도 같은 값이면 idempotent 재시도 invariant를 유지한다.
 */
export function decimalStringEqualsAtScale(left: NumericString, right: NumericString, scale: number): boolean {
  return parseFinancialDecimal(left).toDecimalPlaces(scale).equals(parseFinancialDecimal(right).toDecimalPlaces(scale));
}

/**
 * numeric 문자열이 양수인지 확인한다.
 *
 * fill/cancel evidence 검증에서 0 수량을 체결 또는 취소 근거로 승격하지 않기 위한 fail-closed predicate다.
 */
export function isPositiveDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).greaterThan(0);
}
