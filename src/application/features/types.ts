import type { FinancialDecimalInput } from "../../shared/index.js";
import type { JsonRecord, MarketDataEvent, NumericString, TimestampInput } from "../../domain/index.js";

/**
 * M11에서 strategy와 calibration report가 공유할 feature snapshot key다.
 *
 * key는 report, audit metadata, strategy requiredFeatures에서 안정적으로 재사용되며, 값의 계산식이 바뀌면
 * feature quality 설계 문서를 먼저 갱신해야 한다.
 */
export type M11FeatureKey =
  | "candle_momentum_bps"
  | "realized_volatility_bps"
  | "volume_spike_ratio"
  | "bid_depth_slope_krw_per_bps"
  | "ask_depth_slope_krw_per_bps"
  | "depth_change_rate_ratio"
  | "vwap_deviation_bps"
  | "trade_direction_imbalance_ratio"
  | "market_regime"
  | "session_liquidity_score"
  | "session_liquidity_state"
  | "cost_adjusted_expected_return_bps"
  | "cost_adjusted_margin_bps";

/**
 * 시장 국면 분류 feature의 내부 enum이다.
 *
 * 사용자 문구에 직접 노출하지 않고, strategy 설명과 calibration 비교에서만 안정적인 분류 코드로 사용한다.
 */
export type MarketRegime = "trend_up" | "trend_down" | "range" | "volatile" | "liquidity_stress";

/**
 * 시간대별 유동성 filter의 내부 상태 enum이다.
 *
 * score를 사람이 검토할 수 있는 상태로 접되, 주문 허용 권한은 후속 strategy/risk gate가 별도로 판단한다.
 */
export type SessionLiquidityState = "normal" | "thin" | "stressed";

/**
 * feature snapshot에 들어갈 JSON-safe 값이다.
 *
 * 금융 값은 Decimal string으로, 분류 값은 안정적인 enum string으로 보존해 paper/backtest parity에서 같은 값을 비교한다.
 */
export type FeatureValue = NumericString | MarketRegime | SessionLiquidityState;

/**
 * feature 계산 실패를 주문 후보 fail-closed와 report 설명으로 연결하는 reason code다.
 *
 * 내부 코드는 audit/debug에 보존하고, 사용자 화면이나 리포트에서는 행동 언어로 원인과 영향을 설명해야 한다.
 */
export type FeatureCalculationFailureReasonCode =
  | "FEATURE_INSUFFICIENT_INPUT"
  | "FEATURE_INVALID_DECIMAL"
  | "FEATURE_INVALID_MARKET_VALUE"
  | "FEATURE_MARKET_DATA_STALE";

/**
 * 비용 차감 기대값 feature를 만들 때 필요한 비용 입력이다.
 *
 * 이 입력은 CostModel을 대체하지 않고, strategy 설명과 calibration 비교에 필요한 동일 명칭의 비용 구성요소만
 * 순수 계산기에 전달한다. 값은 string 또는 Decimal만 허용하며 number는 정밀도 손실을 막기 위해 invalid로 처리한다.
 */
export interface FeatureCostInput {
  expectedReturnBps?: FinancialDecimalInput;
  entryFeeBps?: FinancialDecimalInput;
  exitFeeBps?: FinancialDecimalInput;
  spreadCostBpsP75?: FinancialDecimalInput;
  expectedSlippageBpsP95?: FinancialDecimalInput;
  cancelRequotePenaltyBps?: FinancialDecimalInput;
  safetyBufferBps?: FinancialDecimalInput;
}

/**
 * M11 feature calculator가 처리할 순수 입력이다.
 *
 * caller는 이미 수집한 market event window와 기준 시각을 넘기며, calculator는 DB, broker, network, clock read 같은
 * 외부 side effect 없이 이 값만 사용한다. `cost`가 없으면 비용 차감 feature만 fail-closed failure로 남는다.
 */
export interface FeatureCalculationInput {
  observedAt: TimestampInput;
  events: readonly MarketDataEvent[];
  cost?: FeatureCostInput;
  metadata?: JsonRecord;
}

/**
 * feature window와 regime 분류에 쓰는 조정값이다.
 *
 * 모든 duration은 millisecond number이며, 테스트와 runtime이 같은 기본값을 공유하되 후속 calibration PR에서만
 * 운영 기본값 변경을 검토한다.
 */
export interface FeatureCalculationOptions {
  candleBucketMs?: number;
  candleBucketCount?: number;
  volumeBaselineBucketCount?: number;
  tradeImbalanceWindowMs?: number;
  depthChangeLookbackMs?: number;
  orderbookDepthLevels?: number;
  volatileRealizedVolatilityBps?: FinancialDecimalInput;
  volatileVolumeSpikeRatio?: FinancialDecimalInput;
  trendMomentumBps?: FinancialDecimalInput;
  trendImbalanceRatio?: FinancialDecimalInput;
}

/**
 * 단일 feature가 성공적으로 계산된 결과다.
 *
 * `value`는 JSON/report/strategy boundary에서 재사용할 수 있도록 string 또는 안정적인 enum string으로 직렬화된 값이다.
 */
export interface FeatureSuccessResult {
  status: "ok";
  key: M11FeatureKey;
  value: FeatureValue;
  observedAt: string;
  windowStartAt?: string;
  windowEndAt: string;
  metadata?: JsonRecord;
}

/**
 * 단일 feature가 fail-closed로 중단된 결과다.
 *
 * 실패 결과는 0으로 대체하지 않고 reason code와 사람이 읽을 수 있는 message를 함께 보존해 주문 후보 생성과 report가
 * 같은 근거를 사용할 수 있게 한다.
 */
export interface FeatureFailureResult {
  status: "failed";
  key: M11FeatureKey;
  reasonCode: FeatureCalculationFailureReasonCode;
  message: string;
  observedAt: string;
  windowStartAt?: string;
  windowEndAt: string;
  metadata?: JsonRecord;
}

export type FeatureResult = FeatureSuccessResult | FeatureFailureResult;

/**
 * M11 feature snapshot 전체 계산 결과다.
 *
 * 하나 이상의 feature가 실패하면 `status`는 `failed`가 된다. 이 상태는 strategy 후보 생성을 fail-closed로 중지해야 한다는
 * 호출 경계 신호이며, 성공한 일부 feature도 audit과 debugging을 위해 `features`에 남긴다.
 */
export interface FeatureCalculationResult {
  status: "ok" | "failed";
  observedAt: string;
  features: Readonly<Partial<Record<M11FeatureKey, FeatureValue>>>;
  results: readonly FeatureResult[];
  failureReasons: readonly FeatureFailureResult[];
  metadata?: JsonRecord;
}
