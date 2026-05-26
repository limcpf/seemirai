import type { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../../shared/index.js";
import { m11MarketRegimes, type M11MarketRegime } from "./types.js";

/**
 * 0 이상이어야 하는 strategy threshold 문자열을 Decimal로 정규화한다.
 *
 * 설정 파싱 경계에서만 호출되며, 잘못된 값은 startup/config validation 실패로 노출되도록 예외를 던진다.
 */
export function parseNonNegativeDecimal(value: string, fieldName: string): Decimal {
  const decimal = parseFinancialDecimal(value);

  if (decimal.isNegative()) {
    throw new Error(`${fieldName} must not be negative`);
  }

  return decimal;
}

/**
 * 음수도 허용해야 하는 strategy threshold 문자열을 Decimal로 정규화한다.
 *
 * 설정 파싱 경계에서만 호출되며, 잘못된 값은 startup/config validation 실패로 노출되도록 예외를 던진다. 반환 Decimal은 이후
 * strategy 평가에서 재파싱하지 않는 것이 invariant다.
 */
export function parseDecimal(value: string, fieldName: string): Decimal {
  try {
    return parseFinancialDecimal(value);
  } catch {
    throw new Error(`${fieldName} must be a decimal string`);
  }
}

/**
 * 0..1 범위 ratio threshold를 Decimal로 정규화한다.
 *
 * 체결 방향 imbalance와 session liquidity score처럼 단위가 고정된 비율 설정에만 사용한다. 범위를 벗어나면 잘못된 profile로
 * 보고 외부 side effect 없이 예외를 던진다.
 */
export function parseRatioDecimal(value: string, fieldName: string): Decimal {
  const decimal = parseNonNegativeDecimal(value, fieldName);

  if (decimal.greaterThan(1)) {
    throw new Error(`${fieldName} must be between 0 and 1`);
  }

  return decimal;
}

/**
 * strategy option의 allowed market regime 목록을 불변 복사본으로 정규화한다.
 *
 * 비어 있거나 unknown enum이 섞이면 config 계약 위반으로 실패시킨다. 반환 배열은 평가 중 변경되지 않아야 하며, 사용자 표시
 * 문구로 변환하지 않고 audit metadata에만 보존한다.
 */
export function normalizeAllowedMarketRegimes(values: readonly M11MarketRegime[]): readonly M11MarketRegime[] {
  if (values.length === 0) {
    throw new Error("allowed_market_regimes must include at least one market regime");
  }

  for (const value of values) {
    if (!isM11MarketRegime(value)) {
      throw new Error(`allowed_market_regimes contains an unknown market regime: ${String(value)}`);
    }
  }

  return [...values];
}

/**
 * 외부 feature snapshot에서 온 문자열이 M11 market regime enum인지 좁힌다.
 *
 * 이 함수는 runtime feature 값의 trust boundary에서만 사용하며, unknown 값은 보정하지 않고 상위 guard가 BLOCK으로 기록한다.
 */
export function isM11MarketRegime(value: string): value is M11MarketRegime {
  return (m11MarketRegimes as readonly string[]).includes(value);
}
