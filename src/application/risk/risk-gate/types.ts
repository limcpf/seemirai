import type { Decimal } from "decimal.js";
import type { MarketCode, RiskGateEvaluation } from "../../../domain/index.js";

/**
 * RiskGate threshold 문자열을 Decimal/number 비교에 바로 쓸 수 있게 파싱한 내부 snapshot이다.
 *
 * evaluator entry가 한 번만 만들고 각 policy에 읽기 전용으로 전달하며, DB나 외부 설정을 다시 조회하지 않는 invariant를 가진다.
 */
export interface ParsedThresholds {
  dailyLossLimitBps: Decimal;
  weeklyLossLimitBps: Decimal;
  maxDrawdownBps: Decimal;
  maxOrderNotionalBpsOfEquity: Decimal;
  maxExpectedLossBpsOfEquity: Decimal;
  btcEthMaxPositionBpsOfEquity: Decimal;
  altMaxPositionBpsOfEquity: Decimal;
  totalAltMaxPositionBpsOfEquity: Decimal;
  maxConsecutiveStrategyLosses: number;
}

/**
 * decimal 입력 읽기 결과와 fail-closed evaluation을 함께 운반하는 내부 타입이다.
 *
 * value가 없고 evaluation이 있으면 호출자는 계산을 계속하지 말고 해당 evaluation을 결과에 포함해야 하며, 외부 side effect는 없다.
 */
export interface DecimalRead {
  value: Decimal | undefined;
  evaluation?: RiskGateEvaluation;
}

/**
 * 시장 단위 포지션 노출을 bps 단위 Decimal로 정규화한 평가 입력이다.
 *
 * 여러 전략 포지션은 market 기준으로 합산된 뒤 이 형태로 전달되어 단일/전체 노출 한도 평가의 기준이 된다.
 */
export interface MarketExposure {
  market: MarketCode;
  bpsOfEquity: Decimal;
}
