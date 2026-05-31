import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

/**
 * phase 1.5 알트 수동 편입 상태 변경의 안정 action code다.
 *
 * 운영자가 수동 승인, 철회, 만료를 판단한 시점을 audit/reporting 계층이 같은 언어로 기록하게 하는 contract다.
 * 이 타입은 외부 side effect를 만들지 않으며, 후속 repository나 notifier는 이 값을 사용자 문구로 별도 변환해야 한다.
 */
export type Phase15AltApprovalAction = "APPROVE" | "REVOKE" | "EXPIRE";

/**
 * phase 1.5 알트 후보가 통과해야 하는 유동성/상장/시장경보 기준이다.
 *
 * 런타임 config와 evaluator가 공유하는 입력 contract이며, 모든 숫자는 DB와 audit에서 재현 가능한 Decimal string으로
 * 유지한다. 이 값 자체는 주문 허용이 아니라 수동 승인 후보 판정을 위한 threshold snapshot이다.
 */
export interface Phase15AltEligibilityThresholds {
  minListingAgeDays: number;
  minThirtyDayAverageTradeValueKrw: NumericString;
  maxSevenDaySpreadP95Bps: NumericString;
  maxExpectedSlippageBps: NumericString;
  minDepthKrw: NumericString;
}

/**
 * 수동 승인 설정에 남기는 알트 market 단위 contract다.
 *
 * config는 operator가 승인한 market과 승인 근거 식별자만 보존한다. 실제 조건별 수치 snapshot은 evidence로 남겨
 * 승인 당시 기준을 나중에 재현할 수 있어야 하며, 만료 시각이 있으면 후속 runtime이 신규 진입을 차단해야 한다.
 */
export interface Phase15ManualAltApprovalConfig {
  market: MarketCode;
  approvedAt: TimestampInput;
  approvedBy?: string;
  evidenceId?: string;
  expiresAt?: TimestampInput;
}

/**
 * phase 1.5 알트 수동 편입 설정 contract다.
 *
 * 후보 목록과 승인 목록은 runtime config에서 읽히지만 자동 신규 상장 편입을 의미하지 않는다. 승인 목록은 최대 3개라는
 * invariant를 유지해야 하며, paper runtime의 기본값은 빈 승인 목록이라 기존 BTC/ETH universe를 흔들지 않는다.
 */
export interface Phase15AltUniverseConfig {
  enabled: boolean;
  candidateMarkets: readonly MarketCode[];
  manualApprovals: readonly Phase15ManualAltApprovalConfig[];
  maxManualApprovals: number;
  thresholds: Phase15AltEligibilityThresholds;
}

/**
 * 수동 승인/철회/만료 시점의 조건별 판정 snapshot이다.
 *
 * evaluator는 이 구조를 audit evidence로 넘기고, repository/reporting은 그대로 보존한다. `passed=false`인 항목이 있으면
 * 해당 market은 universe 편입 후보가 아니며, 이 구조 자체는 DB write나 외부 API 호출을 수행하지 않는 순수 데이터다.
 */
export interface Phase15AltApprovalEvidenceSnapshot {
  exchangeId: ExchangeId;
  market: MarketCode;
  action: Phase15AltApprovalAction;
  observedAt: TimestampInput;
  thresholds: Phase15AltEligibilityThresholds;
  conditions: readonly Phase15AltApprovalEvidenceCondition[];
  approvedBy?: string;
  evidenceId?: string;
  source?: string;
  metadata?: JsonRecord;
}

/**
 * phase 1.5 후보 조건 하나의 판정 결과다.
 *
 * reasonCode는 audit/debug용 안정 식별자이며, 사용자에게 직접 보여줄 때는 한국어 상태/원인/필요 조치 문구로 변환해야 한다.
 */
export interface Phase15AltApprovalEvidenceCondition {
  key:
    | "listing_age"
    | "market_warning"
    | "market_caution"
    | "thirty_day_average_trade_value"
    | "seven_day_spread_p95"
    | "expected_slippage"
    | "depth";
  passed: boolean;
  reasonCode: string;
  actualValue?: NumericString | boolean | number;
  thresholdValue?: NumericString | boolean | number;
  metadata?: JsonRecord;
}
