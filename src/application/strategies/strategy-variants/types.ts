import type { Decimal } from "decimal.js";

interface EntryGuardOptions {
  maxSpreadBps: string;
  minDepthKrw: string;
  minCostAdjustedMarginBps: string;
}

/**
 * M11 feature snapshot이 strategy 경계에 전달하는 시장 국면 코드다.
 *
 * 사용자 표시 문구가 아니라 내부 feature enum이므로, strategy는 이 값으로 후보 허용 여부만 판단하고 외부 side effect를 만들지
 * 않는다. 알 수 없는 값은 feature 생성 경계가 깨진 것으로 보고 주문 후보를 fail-closed한다.
 */
export type M11MarketRegime = "trend_up" | "trend_down" | "range" | "volatile" | "liquidity_stress";

/**
 * strategy 입력 검증에서 허용하는 M11 시장 국면의 단일 source of truth다.
 */
export const m11MarketRegimes = ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"] as const;

/**
 * 추세 추종 전략의 보수적 진입 threshold다.
 *
 * 기존 M4 실행 보조 feature와 M11 feature snapshot을 함께 요구한다. M11 threshold 기본값은 #68 운영 관측 전에는
 * 공격적으로 후보를 줄이지 않도록 0 또는 전체 regime 허용으로 시작하고, 후보 생성 전 fail-closed 검증 경계만 연다.
 */
export interface TrendFollowingStrategyOptions extends EntryGuardOptions {
  breakoutLookbackBuckets: number;
  minTradeStrength: string;
  minOrderbookImbalance: string;
  minVolatilityExpansionBps: string;
  minCandleMomentumBps: string;
  minRealizedVolatilityBps: string;
  maxRealizedVolatilityBps: string;
  minVolumeSpikeRatio: string;
  minTradeDirectionImbalance: string;
  allowedMarketRegimes: readonly M11MarketRegime[];
}

/**
 * 평균 회귀 전략의 보수적 진입 threshold다.
 *
 * rolling VWAP 이탈, 유동성 점수, regime, 비용 차감 margin을 M11 입력으로 요구한다. 기준값이 0인 기본 profile은
 * 기존 운영 threshold보다 공격적으로 바꾸지 않고, feature 누락과 invalid 값만 주문 후보 생성을 차단한다.
 */
export interface MeanReversionStrategyOptions extends EntryGuardOptions {
  entryDeviationBps: string;
  exitDeviationBps: string;
  stopLossBps: string;
  minRealizedVolatilityBps: string;
  maxRealizedVolatilityBps: string;
  minAbsVwapDeviationBps: string;
  minSessionLiquidityScore: string;
  allowedMarketRegimes: readonly M11MarketRegime[];
}

/**
 * 변동성 돌파 전략의 보수적 진입 threshold다.
 *
 * realized volatility, volume spike, candle momentum, regime, 비용 차감 margin을 같은 snapshot에서 읽는다. CostModel은
 * 여전히 최종 비용 권한을 갖고, 이 옵션은 strategy 설명과 calibration 비교를 위한 사전 입력 검증에 한정된다.
 */
export interface VolatilityBreakoutStrategyOptions extends EntryGuardOptions {
  breakoutLookbackBuckets: number;
  minVolatilityExpansionBps: string;
  minCandleMomentumBps: string;
  minRealizedVolatilityBps: string;
  maxRealizedVolatilityBps: string;
  minVolumeSpikeRatio: string;
  allowedMarketRegimes: readonly M11MarketRegime[];
}

/**
 * 호가 불균형 모멘텀 전략의 보수적 진입 threshold다.
 *
 * depth slope, depth 변화율, 체결 방향 imbalance, 비용 차감 margin을 요구한다. 호가 metric이 비어 있으면 0 보정 없이
 * BLOCK으로 닫아 backtest/paper calibration에서 누락 원인을 분리할 수 있게 한다.
 */
export interface OrderbookImbalanceMomentumStrategyOptions extends EntryGuardOptions {
  minTradeStrength: string;
  minOrderbookImbalance: string;
  minDepthSlopeKrwPerBps: string;
  minDepthChangeRateRatio: string;
  minTradeDirectionImbalance: string;
}

/**
 * 유동성 회귀 전략의 보수적 진입 threshold다.
 *
 * depth 변화율, session liquidity score, VWAP 이탈, 비용 차감 margin을 후보 생성 전 검증한다. 기본값은 운영 threshold
 * 확정 전 안전하게 pass-through에 가깝게 두고, Sub PR 5에서 관측 데이터 기반 조정을 검토한다.
 */
export interface LiquidityReversionStrategyOptions extends EntryGuardOptions {
  entryDeviationBps: string;
  stopLossBps: string;
  minDepthChangeRateRatio: string;
  minAbsVwapDeviationBps: string;
  minSessionLiquidityScore: string;
}

/**
 * M4 MVP에서 활성화할 5개 strategy variant의 parameter 묶음이다.
 */
export interface M4StrategyVariantOptions {
  trendFollowing: TrendFollowingStrategyOptions;
  meanReversion: MeanReversionStrategyOptions;
  volatilityBreakout: VolatilityBreakoutStrategyOptions;
  orderbookImbalanceMomentum: OrderbookImbalanceMomentumStrategyOptions;
  liquidityReversion: LiquidityReversionStrategyOptions;
}

/**
 * strategy feature Decimal 읽기 결과를 표현하는 내부 판별 union이다.
 *
 * `ok`만 계산에 사용할 수 있고, `missing`/`invalid`는 상위 guard가 BLOCK decision으로 바꿔 audit reason을 보존한다.
 */
export type DecimalRead =
  | {
      status: "ok";
      value: Decimal;
    }
  | {
      status: "missing";
    }
  | {
      status: "invalid";
    };
