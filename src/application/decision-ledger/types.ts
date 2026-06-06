import type { DecisionCategory, DecisionFrameCategory, EvidenceKind, SummaryStatus } from "./category.js";

/**
 * M18 decision ledger의 공개 계약 — 모든 타입은 append-only evidence와 read-only why summary의
 * shape를 고정한다. 이 모듈은 persistence, producer, LLM, HTTP route를 포함하지 않으며
 * 순수 type contract와 category 상수만 제공한다.
 *
 * ## 경계
 *
 * - `application` layer는 `infrastructure`를 import하지 않는다.
 * - `interfaces/http-control`은 summary provider contract만 알고 DB row나 raw payload를 직접 해석하지 않는다.
 * - `runtime` 조립부는 DB repository/provider를 주입할 수 있지만 `/status` route handler 안에서 write side effect를 수행하지 않는다.
 *
 * ## 보안 invariant
 *
 * - `payload`와 `trace`에는 raw provider payload, raw order detail, secret 후보, Authorization/JWT/API key를 넣지 않는다.
 */

/**
 * DecisionLedgerFrame의 공통 본문이다.
 *
 * source run id와 correlation id 존재 여부에 따라 trace 요구사항이 달라지므로 외부 계약은
 * union/intersection type으로 노출한다. 공통 본문은 한 번의 feature → strategy → gate → broker
 * 흐름에서 보존해야 하는 판단 시각, 대상, 범주, dedupe key를 고정하며 persistence나 외부
 * side effect를 포함하지 않는다.
 */
interface DecisionLedgerFrameBase {
  /** M18 contract version. 예: `"m18.decision_ledger.v1"`. */
  readonly ledgerVersion: string;

  /** `PaperDecisionInputFrame.id`. runner 입력 frame 식별자. */
  readonly sourceFrameId: string;

  /** 거래소 식별자. 예: `"UPBIT"`. */
  readonly exchange: string;

  /** market별 판단이면 `"KRW-BTC"` 같은 code. cash/global 판단이면 `null`. */
  readonly market: string | null;

  /** strategy별 판단이면 strategy id. cash/global 판단이면 `null`. */
  readonly strategyId: string | null;

  /** LLM 설명 실패가 아닌 실제 판단 결과 범주. */
  readonly category: DecisionFrameCategory;

  /** frame 기록/조회 상태. */
  readonly summaryStatus: SummaryStatus;

  /** 시장/feature frame 관측 시각. */
  readonly observedAt: Date;

  /** 판단이 확정된 시각. */
  readonly decisionAt: Date;

  /**
   * hold/discard/cost/risk/execution reason count.
   *
   * key는 reason code, value는 해당 reason이 발생한 횟수다.
   * 주문 후보 0건 frame은 `CASH_HOLD`와 구체적 차단 사유 개수를 여기에 보존한다.
   */
  readonly reasonCounts: Readonly<Record<string, number>>;

  /** 내부 id, fingerprint, source table, source id, correlation id 같은 추적 정보만 담는다. */
  readonly trace: Readonly<Record<string, unknown>>;

  /**
   * 같은 frame/source/correlation 재실행 중복 append를 차단하는 deterministic key.
   *
   * repository는 이 키의 unique constraint로 중복 insert를 막는다.
   */
  readonly dedupeKey: string;
}

interface DecisionLedgerFrameWithSourceRun {
  /** runner 또는 runtime 실행 단위 식별자. */
  readonly sourceRunId: string;
}

interface DecisionLedgerFrameWithoutSourceRun {
  /** runner 또는 runtime 실행 단위 식별자를 알 수 없는 경우 `null`로 보존한다. */
  readonly sourceRunId: null;

  readonly trace: Readonly<Record<string, unknown>> & {
    readonly sourceRunUnavailableReason: string;
  };
}

interface DecisionLedgerFrameWithCorrelation {
  /** 주문, risk, execution evidence와 연결할 수 있는 stable id. */
  readonly correlationId: string;
}

interface DecisionLedgerFrameWithoutCorrelation {
  /** stable correlation id가 아직 없거나 조회 불가능한 경우 `null`로 보존한다. */
  readonly correlationId: null;

  readonly trace: Readonly<Record<string, unknown>> & {
    readonly correlationUnavailableReason: string;
  };
}

type DecisionLedgerSourceRunContract =
  | DecisionLedgerFrameWithSourceRun
  | DecisionLedgerFrameWithoutSourceRun;

type DecisionLedgerCorrelationContract =
  | DecisionLedgerFrameWithCorrelation
  | DecisionLedgerFrameWithoutCorrelation;

/**
 * 한 frame의 decision ledger 기록 — runner가 한 번의 feature → strategy → gate → broker 흐름을
 * 평가한 뒤 append-only로 남기는 최상위 단위다.
 *
 * frame은 `dedupeKey`로 중복 append를 차단하며, 여러 evidence item을 하위에 가질 수 있다.
 * 주문 후보 0건 frame도 HOLD/CASH_HOLD/DISCARD 이유를 reasonCounts로 보존한다.
 */
export type DecisionLedgerFrame = DecisionLedgerFrameBase &
  DecisionLedgerSourceRunContract &
  DecisionLedgerCorrelationContract;

/**
 * frame 아래 append-only로 저장되는 단일 근거 evidence item이다.
 *
 * 하나의 frame은 여러 evidence item을 가질 수 있다 (예: STRATEGY_DECISION → ORDER_INTENT →
 * COST_BREAKDOWN → RISK_DECISION → EXECUTION_RESULT).
 *
 * ## 보안
 *
 * `payload`와 `trace`에는 raw provider payload, raw order detail, secret 후보,
 * Authorization/JWT/API key를 넣지 않는다.
 */
export interface DecisionEvidenceItem {
  /** 근거 종류. */
  readonly evidenceKind: EvidenceKind;

  /** 연관된 판단 범주. */
  readonly category: DecisionCategory;

  /** 내부 reason code. 사용자-facing 문구는 `userMessage`로 분리한다. */
  readonly reasonCode: string | null;

  /** 사용자-facing 한국어 상태 메시지. */
  readonly userMessage: string;

  /** 한국어 영향 설명. 없으면 `null`. */
  readonly impact: string | null;

  /** 한국어 필요 조치. 없으면 `null`. */
  readonly action: string | null;

  /** 근거가 발생한 시각. */
  readonly occurredAt: Date;

  /** 근거 출처 시스템/모듈명. 예: `"strategy.mean-reversion"`, `"cost-model"`, `"risk-gate"`. */
  readonly source: string;

  /** 근거 출처 내부 식별자. 예: strategy id, cost evaluation id, risk context id. */
  readonly sourceId: string | null;

  /**
   * 근거 상세 payload. raw provider payload, raw order detail, secret, token을 포함하지 않는다.
   *
   * evidence kind별로 허용되는 payload shape는 evidence kind contract에서 정의한다.
   */
  readonly payload: Readonly<Record<string, unknown>>;

  /**
   * evidence 중복 append를 차단하는 deterministic fingerprint.
   *
   * repository는 이 키의 unique constraint로 중복 insert를 막는다.
   */
  readonly evidenceFingerprint: string;

  /** 내부 id, 상위 frame id, correlation id 같은 추적 정보만 담는다. */
  readonly trace: Readonly<Record<string, unknown>>;
}

/**
 * `/status` 하위 read-only `why` summary의 최상위 응답 shape다.
 *
 * 이 summary는 read-only며, 별도 write/control endpoint를 만들지 않는다.
 * 사용자-facing 응답은 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여주고
 * 내부 식별자는 `trace`에 분리한다.
 */
export interface WhySummary {
  /** market별 최근 판단 이유 section. */
  readonly markets: WhyMarketSummarySection;

  /** strategy별 최근 판단 이유 section. */
  readonly strategies: WhyStrategySummarySection;

  /** 현금 보유 이유 section. 주문 후보 0건이면 `item=null`이 아니라 hold reason counts를 포함한다. */
  readonly cash: WhyCashSummarySection;

  /** summary 생성 시각. */
  readonly generatedAt: Date;

  /** summary 조회 상태. */
  readonly readStatus: "OK" | "NOT_FOUND" | "UNAVAILABLE";

  /** 내부 식별자, query source, correlation id만 포함. */
  readonly trace: Readonly<Record<string, unknown>>;
}

/**
 * why summary의 section별 조회 상태다.
 *
 * 각 section은 독립적으로 DB/read provider 실패를 `UNAVAILABLE`로 낮출 수 있어야 하므로,
 * 최상위 summary status만으로 개별 조회 실패를 표현하지 않는다.
 */
export type WhyReadStatus = "OK" | "NOT_FOUND" | "UNAVAILABLE";

/**
 * why summary의 추적 정보 영역이다.
 *
 * 사용자-facing 필드에는 한국어 상태/원인/영향/조치만 두고, 내부 category와 reason code는
 * 이 trace 또는 후속 detail 영역에 분리한다.
 */
export type WhySummaryTrace = Readonly<Record<string, unknown>> & {
  readonly category?: DecisionCategory | null;
  readonly reasonCode?: string | null;
};

/**
 * market별 최근 판단 이유 목록과 조회 상태를 묶는 read-only section이다.
 */
export interface WhyMarketSummarySection {
  /** 이 section의 조회 상태. */
  readonly readStatus: WhyReadStatus;

  /** market별 최근 판단 이유 목록. */
  readonly items: readonly WhyMarketSummary[];

  /** query source와 실패 사유 같은 내부 추적 정보만 포함. */
  readonly trace: WhySummaryTrace;
}

/**
 * strategy별 최근 판단 이유 목록과 조회 상태를 묶는 read-only section이다.
 */
export interface WhyStrategySummarySection {
  /** 이 section의 조회 상태. */
  readonly readStatus: WhyReadStatus;

  /** strategy별 최근 판단 이유 목록. */
  readonly items: readonly WhyStrategySummary[];

  /** query source와 실패 사유 같은 내부 추적 정보만 포함. */
  readonly trace: WhySummaryTrace;
}

/**
 * 현금 보유 이유와 조회 상태를 묶는 read-only section이다.
 */
export interface WhyCashSummarySection {
  /** 이 section의 조회 상태. */
  readonly readStatus: WhyReadStatus;

  /** cash summary. 조회 전/기록 없음이면 `null`, 주문 후보 0건이면 reason count를 가진 item. */
  readonly item: WhyCashSummary | null;

  /** query source와 실패 사유 같은 내부 추적 정보만 포함. */
  readonly trace: WhySummaryTrace;
}

/**
 * market별 최근 판단 이유 summary item.
 *
 * 사용자-facing 정보(statusLabel, message, impact, action)를 먼저 배치하고
 * 내부 식별자는 `trace`로 분리한다.
 */
export interface WhyMarketSummary {
  /** market code. 예: `"KRW-BTC"`, `"KRW-ETH"`. */
  readonly market: string;

  /** 한국어 상태 label. */
  readonly statusLabel: string;

  /** 한국어 원인 설명. */
  readonly message: string;

  /** 한국어 영향. 없으면 `null`. */
  readonly impact: string | null;

  /** 한국어 필요 조치. 없으면 `null`. */
  readonly action: string | null;

  /** 최신 판단 시각. 기록이 없으면 `null`. */
  readonly latestDecisionAt: Date | null;

  /** 내부 식별자, query source, correlation id만 포함. */
  readonly trace: WhySummaryTrace;
}

/**
 * strategy별 최근 판단 이유 summary item.
 */
export interface WhyStrategySummary {
  /** strategy 식별자. */
  readonly strategyId: string;

  /** 한국어 상태 label. */
  readonly statusLabel: string;

  /** 한국어 원인 설명. */
  readonly message: string;

  /** 한국어 영향. 없으면 `null`. */
  readonly impact: string | null;

  /** 한국어 필요 조치. 없으면 `null`. */
  readonly action: string | null;

  /** 최신 판단 시각. 기록이 없으면 `null`. */
  readonly latestDecisionAt: Date | null;

  /** 내부 식별자, query source, correlation id만 포함. */
  readonly trace: WhySummaryTrace;
}

/**
 * 현금 보유 이유 summary.
 *
 * 주문 후보 0건 frame이면 `holdReasonCounts`에 구체적인 차단 사유별 개수를 보존한다.
 * 이 객체는 `null`이 될 수 있으며, `null`은 cash hold data가 아직 수집되지 않았음을 의미한다.
 */
export interface WhyCashSummary {
  /** 한국어 상태 label. */
  readonly statusLabel: string;

  /** 한국어 원인 설명. */
  readonly message: string;

  /** 한국어 영향. 없으면 `null`. */
  readonly impact: string | null;

  /** 한국어 필요 조치. 없으면 `null`. */
  readonly action: string | null;

  /** 최신 판단 시각. 기록이 없으면 `null`. */
  readonly latestDecisionAt: Date | null;

  /**
   * 현금 보유 사유별 발생 횟수.
   * key는 reason code, value는 해당 사유 발생 횟수.
   */
  readonly holdReasonCounts: Readonly<Record<string, number>>;

  /** 내부 식별자, query source, correlation id만 포함. */
  readonly trace: WhySummaryTrace;
}
