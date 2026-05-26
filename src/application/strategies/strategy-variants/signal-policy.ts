import type { Decimal } from "decimal.js";
import type { OrderSide } from "../../../domain/index.js";

/**
 * 부호 있는 signal과 threshold를 매수/매도 방향으로 변환한다.
 *
 * threshold가 0이면 양/음 부호만으로 판단하고, threshold가 있으면 양방향 대칭 기준을 통과한 경우에만 side를 반환한다.
 */
export function sideFromSignedSignal(signal: Decimal, threshold: Decimal): OrderSide | undefined {
  if (threshold.isZero()) {
    if (signal.greaterThan(0)) {
      return "BUY";
    }

    if (signal.lessThan(0)) {
      return "SELL";
    }

    return undefined;
  }

  if (signal.greaterThanOrEqualTo(threshold)) {
    return "BUY";
  }

  if (signal.lessThanOrEqualTo(threshold.negated())) {
    return "SELL";
  }

  return undefined;
}

/**
 * 양수 방향 신호가 최소 threshold를 통과했는지 판정한다.
 *
 * threshold 0은 완전 pass-through가 아니라 양수 신호만 허용하는 기준이며, 외부 상태를 변경하지 않는 순수 비교다.
 */
export function passesPositiveSignalThreshold(signal: Decimal, threshold: Decimal): boolean {
  return threshold.isZero() ? signal.greaterThan(0) : signal.greaterThanOrEqualTo(threshold);
}

/**
 * 평균 회귀 신호 부호를 반대 방향 주문 side로 변환한다.
 *
 * 음수 이탈은 BUY, 양수 이탈은 SELL로 해석하고 threshold를 넘지 못하면 후보를 만들지 않도록 undefined를 반환한다.
 */
export function sideFromReversionSignal(signal: Decimal, threshold: Decimal): OrderSide | undefined {
  if (isNegativeReversionSignal(signal, threshold)) {
    return "BUY";
  }

  if (isPositiveReversionSignal(signal, threshold)) {
    return "SELL";
  }

  return undefined;
}

/**
 * 평균보다 충분히 낮은 음수 이탈인지 판정한다.
 *
 * threshold 0인 profile에서는 단순 음수 여부만 보고, 양수/0 신호는 BUY 회귀 후보로 만들지 않는다.
 */
export function isNegativeReversionSignal(signal: Decimal, threshold: Decimal): boolean {
  return threshold.isZero() ? signal.lessThan(0) : signal.lessThanOrEqualTo(threshold.negated());
}

/**
 * 평균보다 충분히 높은 양수 이탈인지 판정한다.
 *
 * threshold 0인 profile에서는 단순 양수 여부만 보고, 음수/0 신호는 SELL 회귀 후보로 만들지 않는다.
 */
export function isPositiveReversionSignal(signal: Decimal, threshold: Decimal): boolean {
  return threshold.isZero() ? signal.greaterThan(0) : signal.greaterThanOrEqualTo(threshold);
}

/**
 * 문자열 방향 feature를 주문 side로 정규화한다.
 *
 * 알려진 상승/하락 별칭만 허용하고 unknown 값은 보정하지 않아 strategy가 HOLD reason으로 기록할 수 있게 한다.
 */
export function sideFromDirectionFeature(direction: string | undefined): OrderSide | undefined {
  const normalized = direction?.trim().toUpperCase();

  if (normalized === "UP" || normalized === "BUY" || normalized === "LONG") {
    return "BUY";
  }

  if (normalized === "DOWN" || normalized === "SELL" || normalized === "SHORT") {
    return "SELL";
  }

  return undefined;
}
