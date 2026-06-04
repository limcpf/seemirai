import type { NumericString, TimestampInput } from "../../domain/index.js";

/**
 * PnL/포지션 회계 계산 상태 코드다.
 *
 * 사용자 표면에는 한국어 label을 먼저 보여주고, 이 code는 추적/감사용으로 보존한다.
 * - CALCULATED: 모든 입력이 충분해 계산이 완료됨
 * - PARTIAL: 일부 scope만 계산 가능하고 나머지는 source나 평가가 결측
 * - UNAVAILABLE: 계산에 필요한 source가 전혀 없음
 * - MANUAL_REVIEW_REQUIRED: reconcile 결과 평균단가가 없거나 MANUAL_REVIEW_REQUIRED snapshot만 존재
 */
export type PnLAccountingStatus =
  | "CALCULATED"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "MANUAL_REVIEW_REQUIRED";

/**
 * PnL 계산의 근거가 된 data source 표현이다.
 *
 * source가 복합이면 "+"로 연결하고, 실제 값은 formatSource 또는 sourcePriority 결과로 정규화한다.
 */
export type PnLSource =
  | "pnl_snapshots"
  | "positions"
  | "live_reconcile_position_snapshots"
  | "fills"
  | "pnl_snapshots+positions"
  | "live_reconcile_position_snapshots+positions"
  | "fills+positions"
  | "unavailable";

/**
 * strategy/market 단위 PnL 회계 scope다.
 *
 * `market`이 null이면 strategy aggregate scope이며, 해당 strategy의 모든 market을 포괄한다.
 * aggregate snapshot이 존재하면 같은 strategy의 per-market fallback을 덮는다.
 */
export interface PnLAccountingScope {
  /** 전략 식별자 */
  strategyId: string;
  /** market별 scope면 market code, strategy aggregate면 null */
  market: string | null;
  /** 계산이 수행된 시점 (ISO timestamp) */
  capturedAt: string;
  /** 계산에 사용된 data source */
  source: PnLSource;
  /** 계산 상태 */
  status: PnLAccountingStatus;
}

// ── 입력 계약 ────────────────────────────────────────────────────────────────

/**
 * 체결 내역 사실 입력이다.
 *
 * order id, 전략, market, side, price, quantity, 수수료, 유동성 구분, 체결 시점을 포함한다.
 * 수수료 통화가 KRW가 아니면 feeTotals에 통화별로 분리 집계된다.
 */
export interface PnLFillFact {
  /** 주문 식별자. 같은 주문이 여러 호가 level로 쪼개져도 filledOrderCount는 한 번만 증가한다. */
  orderId: string;
  /** 체결이 속한 전략 */
  strategyId: string;
  /** 거래 market (예: KRW-BTC) */
  market: string;
  /** 매수/매도 방향 */
  side: "BUY" | "SELL";
  /** 체결 가격 (KRW) */
  price: NumericString;
  /** 체결 수량 */
  quantity: NumericString;
  /** 체결 수수료 금액 */
  fee: NumericString;
  /** 체결 수수료 통화 (예: KRW, BTC) */
  feeCurrency: string;
  /** 유동성 구분: MAKER 또는 TAKER */
  liquidity: "MAKER" | "TAKER";
  /** 체결 시점 */
  filledAt: TimestampInput;
}

/**
 * 현재 포지션 snapshot 입력이다.
 *
 * `positions` table은 시계열이 아닌 현재 상태 snapshot이므로 과거 손익 복원 source로는 약하다.
 * 따라서 output에 fallback source임을 명시한다.
 */
export interface PnLPositionFact {
  /** 전략 식별자 */
  strategyId: string;
  /** market code */
  market: string;
  /** 보유 수량 (Decimal 문자열) */
  quantity: NumericString;
  /** 평균 진입 단가 (KRW). 결측이면 null이며, 계산 불가 원인이 된다. */
  averageEntryPrice: NumericString | null;
  /** 현재까지 실현 손익 (KRW) */
  realizedPnl: NumericString;
  /** 현재까지 미실현 손익 (KRW). 평가가가 없으면 null일 수 있다. */
  unrealizedPnl: NumericString | null;
  /** 포지션 갱신 시점 */
  updatedAt: TimestampInput;
  /** 데이터 근거 source */
  source: string;
}

/**
 * 평가가 입력이다.
 *
 * long position은 보수적으로 즉시 매도 가능한 bid 가격을 사용하는 것이 기본 invariant다.
 */
export interface PnLMarkPriceFact {
  /** market code */
  market: string;
  /** KRW 평가가 (Decimal 문자열) */
  priceKrw: NumericString;
  /** 평가가 관측 시점 */
  observedAt?: TimestampInput;
  /** 평가가 source (예: bid, last, fixture_bid) */
  source: string;
}

/**
 * 현금 잔고 입력이다.
 *
 * KRW available, locked, total을 포함한다.
 */
export interface PnLCashFact {
  /** 사용 가능 KRW */
  availableKrw: NumericString;
  /** 주문에 묶인 KRW */
  lockedKrw: NumericString;
  /** 총 KRW */
  totalKrw: NumericString;
  /** 잔고 조회 source */
  source: string;
  /** 잔고 조회 시점 */
  observedAt: TimestampInput;
}

/**
 * 체결 품질/비용 입력이다.
 *
 * 관측 source가 없으면 해당 metric은 `null`로 남기며, 계산 불가 원인을 output에 포함한다.
 * 절대 0으로 보정하지 않는다.
 */
export interface PnLCostQualityFact {
  /** 전략 식별자 */
  strategyId: string;
  /** market code */
  market: string;
  /** spread cost bps. 관측 불가면 null */
  spreadCostBps?: NumericString;
  /** slippage bps. 관측 불가면 null */
  slippageBps?: NumericString;
  /** cancel/requote penalty bps. 관측 불가면 null */
  cancelRequotePenaltyBps?: NumericString;
  /** 비용 관측 source */
  source: string;
}

/**
 * 기존 PnL 시계열 snapshot 입력이다.
 *
 * `pnl_snapshots` table row를 application 경계로 정규화한 형태다.
 * market이 null이면 strategy aggregate snapshot이다.
 */
export interface PnLSnapshotFact {
  /** 전략 식별자 */
  strategyId: string;
  /** market code 또는 strategy aggregate면 null */
  market: string | null;
  /** snapshot 생성 시점 (ISO timestamp) */
  capturedAt: TimestampInput;
  /** 총 평가자산 (KRW) */
  equity: NumericString;
  /** 실현 손익 (KRW) */
  realizedPnl: NumericString;
  /** 미실현 손익 (KRW) */
  unrealizedPnl: NumericString;
  /** 최대 낙폭 (bps) */
  drawdownBps: NumericString;
  /** snapshot payload의 보조 metadata. 비용 분해, 결측 원인 등 M17 contract를 담을 수 있다. */
  payloadJson?: Record<string, unknown>;
}

/**
 * M16 live reconcile position snapshot 입력이다.
 *
 * RECOVERABLE 상태이고 평균단가 근거가 있을 때만 계산 source 후보가 된다.
 * MANUAL_REVIEW_REQUIRED나 평균단가 결측은 계산 불가 원인으로만 처리한다.
 */
export interface PnLReconcileFact {
  /** 전략 식별자 */
  strategyId: string;
  /** market code */
  market: string;
  /** reconcile 복구 상태: RECOVERABLE, MANUAL_REVIEW_REQUIRED, MISMATCH 등 */
  recoveryStatus: string;
  /** 평균 진입 단가 (KRW). MANUAL_REVIEW_REQUIRED나 근거 없음이면 null */
  averageEntryPrice: NumericString | null;
  /** reconcile 시점 */
  reconciledAt: TimestampInput;
  /** 평균단가 산출 근거 source */
  averageEntrySource?: string;
  /** 수동 검토 필요 증거 ID */
  manualReviewEvidenceId?: string;
}

// ── 계산 불가 원인 ──────────────────────────────────────────────────────────

/**
 * 계산 불가 항목의 이유 상세다.
 *
 * 사용자 표면에는 한국어 message를 먼저 보여주고, 추적 정보는 reasonCode, scope, source를
 * trace 영역에 분리해 보존한다.
 */
export interface PnLMissingReason {
  /** 사용자-facing 한국어 문구 */
  message: string;
  /** stable reason code (추적/감사용) */
  reasonCode: string;
  /** 영향을 받은 scope */
  scope: string;
  /** 결측의 근거 source */
  source: string;
}

// ── 출력 계약 ────────────────────────────────────────────────────────────────

/**
 * strategy/market scope별 포지션 세부 내역이다.
 *
 * quantity가 0이면 실제 보유가 없음을 의미한다.
 * averageEntryPrice가 null이면 평균단가 근거가 없어 계산 불가다.
 */
export interface PnLPositionDetail {
  /** 전략 식별자 */
  strategyId: string;
  /** market code */
  market: string;
  /** 보유 수량 (Decimal 문자열) */
  quantity: NumericString;
  /** 평균 진입 단가 (KRW). 근거 없으면 null */
  averageEntryPrice: NumericString | null;
  /** position market value (KRW). 평가가가 없으면 null */
  marketValueKrw: NumericString | null;
  /** 미실현 손익 (KRW). 평가가 또는 평균단가가 없으면 null */
  unrealizedPnlKrw: NumericString | null;
  /** equity 대비 노출 비중 (bps). marketValueKrw 또는 equity가 없으면 null */
  exposureBps: NumericString | null;
}

/**
 * 통화별 수수료 합계다.
 *
 * 서로 다른 통화를 섞지 않고 currency를 key로 분리해 정확한 비용 의미를 유지한다.
 */
export interface PnLFeeTotal {
  /** 수수료 통화 */
  currency: string;
  /** 수수료 합계 (Decimal 문자열) */
  amount: NumericString;
}

/**
 * 체결 품질/비용 집계 metric이다.
 *
 * 관측 source가 없으면 available=false로 남기고, 절대 0으로 보정하지 않는다.
 */
export interface PnLExecutionQualityMetric {
  /** 평균값 (bps). 관측 불가면 null */
  value: NumericString | null;
  /** 실제 관측값 기준 계산 여부 */
  available: boolean;
  /** 관측 건수 */
  sampleCount: number;
  /** metric source */
  source: string;
}

/**
 * PnL/포지션 회계 계산기 출력의 핵심 손익 요약이다.
 *
 * 모든 금액은 KRW Decimal 문자열이며, 계산 불가인 필드는 null이다.
 * trace에는 run id, correlation id, source table, source timestamp만 허용하고
 * secret, raw provider payload는 저장하지 않는다.
 */
export interface PnLAccountingOutput {
  /** 계산 scope 목록 */
  scopes: readonly PnLAccountingScope[];
  /** 전체 계산 상태 */
  status: PnLAccountingStatus;
  /** 실현 손익 (KRW) */
  realizedPnlKrw: string | null;
  /** 미실현 손익 (KRW) */
  unrealizedPnlKrw: string | null;
  /** 총 손익 (KRW) = realized + unrealized */
  totalPnlKrw: string | null;
  /** 현금 (KRW). 잔고 source가 없으면 실제 0과 구분하기 위해 null이다. */
  cashKrw: string | null;
  /** 보유 포지션 평가액 합계 (KRW) */
  positionMarketValueKrw: string | null;
  /** 총 평가자산 (KRW) = cash + position market value */
  equityKrw: string | null;
  /** 포지션 세부 내역 (strategy/market별) */
  positions: readonly PnLPositionDetail[];
  /** 통화별 수수료 합계 */
  feeTotals: readonly PnLFeeTotal[];
  /** spread cost 집계 */
  spreadCost: PnLExecutionQualityMetric;
  /** slippage 집계 */
  slippage: PnLExecutionQualityMetric;
  /** cancel/requote penalty 집계 */
  cancelRequote: PnLExecutionQualityMetric;
  /** 계산 불가 원인 목록 */
  missingReasons: readonly PnLMissingReason[];
  /** 추적 정보: run id, correlation id, source table, source timestamp */
  trace: {
    /** 계산 실행 식별자 */
    runId?: string;
    /** 상관 관계 식별자 */
    correlationId?: string;
    /** 주요 source table 목록 */
    sourceTables?: readonly string[];
    /** 마지막 source timestamp */
    lastSourceTimestamp?: string;
  };
}

/**
 * PnL 회계 계산기의 전체 입력이다.
 *
 * application layer는 이 구조로 데이터를 받아 순수 계산을 수행한다.
 * DB 접근, HTTP 호출, side effect는 없으며, 동일 입력에 대해 항상 같은 결과를 반환해야 한다.
 */
export interface PnLAccountingInput {
  /** 계산 기준 시각. 없으면 source timestamp에서 deterministic하게 도출한다. */
  capturedAt?: TimestampInput;
  /** 계산 대상 scope 정보 (strategy/market별 식별) */
  targetScopes?: readonly PnLAccountingScope[];
  /** 체결 내역 */
  fills: readonly PnLFillFact[];
  /** 현재 포지션 snapshot */
  positions: readonly PnLPositionFact[];
  /** 평가가 */
  markPrices: readonly PnLMarkPriceFact[];
  /** 현금 잔고 */
  cash: PnLCashFact | null;
  /** 체결 품질/비용 */
  costQuality: readonly PnLCostQualityFact[];
  /** 기존 PnL snapshot (source priority 우선) */
  pnlSnapshots: readonly PnLSnapshotFact[];
  /** M16 live reconcile position snapshot */
  reconcileFacts: readonly PnLReconcileFact[];
  /** 추적 정보 주입 (호출자가 run id, correlation id 등을 넣음) */
  trace?: PnLAccountingOutput["trace"];
}
