import type { JsonRecord } from "../../domain/index.js";

export const LIVE_OPS_BRIEFING_SCHEMA_VERSION = "live_ops_briefing.v1" as const;

/**
 * Live Ops Telegram briefing snapshot의 schema version이다.
 *
 * formatter, LLM briefing draft, audit evidence가 같은 snapshot contract를 참조하도록 고정한다. 이 값은 순수 식별자이며
 * 외부 API 호출, DB write, Telegram dispatch 같은 side effect를 만들지 않는다.
 */
export type LiveOpsBriefingSchemaVersion = typeof LIVE_OPS_BRIEFING_SCHEMA_VERSION;

/**
 * 브리핑 첫 화면에 노출할 운영자 행동 언어다.
 *
 * 내부 enum이나 reason code가 아니라 상태, 원인, 영향, 필요 조치를 먼저 담는다. caller는 이미 deterministic evidence에서
 * 계산한 문구만 전달해야 하며, formatter는 이 값을 주문 판단이나 broker 호출로 연결하지 않는다.
 */
export interface LiveOpsBriefingHeadline {
  statusLabel: string;
  cause: string;
  impact: string;
  action: string;
}

/**
 * daemon과 live order 가능 상태를 설명하는 runtime safe snapshot이다.
 *
 * config 원문이나 secret env를 직접 담지 않고 운영 판단에 필요한 boolean과 한국어 guard 설명만 보존한다. 이 타입은
 * 조립된 상태를 표현할 뿐 runtime guard 재평가나 provider 호출 side effect를 수행하지 않는다.
 */
export interface LiveOpsBriefingRuntimeSnapshot {
  daemonAlive: boolean;
  runModeLabel: string;
  liveEnabled: boolean;
  liveArmed: boolean;
  liveOrderCapable: boolean;
  readinessGuard: string;
}

/**
 * 시장 데이터 freshness와 현재 시황을 요약한 safe snapshot이다.
 *
 * raw ticker/orderbook/provider payload는 금지하고, stale/missing 상태는 0으로 보정하지 않고 status label과 관측 시각으로
 * 표현한다. formatter는 이 값을 읽기 전용 문구로만 사용한다.
 */
export interface LiveOpsBriefingMarketSnapshot {
  freshnessLabel: string;
  summary: string;
  observedAt: string | null;
}

/**
 * 최신 후보, entry/exit decision, HOLD/BLOCK 이유를 묶은 판단 snapshot이다.
 *
 * strategy나 LLM 결과가 직접 주문을 만들지 못하게 하기 위해 이 구조는 사람이 읽을 설명과 조건 목록만 가진다. 내부 reason
 * code는 `trace` 하위에 분리해야 한다.
 */
export interface LiveOpsBriefingDecisionSnapshot {
  latestCandidate: string;
  latestEntryDecision: string;
  latestExitDecision: string;
  buyConditions: readonly string[];
  sellConditions: readonly string[];
  holdReason: string | null;
  blockReason: string | null;
}

/**
 * wallet cash 상태를 나타내는 safe snapshot이다.
 *
 * 금액은 문자열로 보존하고 결측은 null로 둔다. null은 관측 부재를 의미하므로 formatter나 caller가 0 KRW로 보정하면 안 된다.
 */
export interface LiveOpsBriefingCashSnapshot {
  statusLabel: string;
  availableKrw: string | null;
  totalKrw: string | null;
  observedAt: string | null;
}

/**
 * coin balance 상태를 나타내는 safe snapshot이다.
 *
 * raw balance detail 대신 market, currency, 수량 문자열, 상태 문구만 보존한다. 이 값은 Telegram 표시용이며 portfolio
 * reconciliation side effect를 만들지 않는다.
 */
export interface LiveOpsBriefingBalanceSnapshot {
  market: string;
  currency: string;
  total: string | null;
  available: string | null;
  statusLabel: string;
}

/**
 * strategy-owned position 상태를 나타내는 safe snapshot이다.
 *
 * 평균단가와 수량은 문자열로만 저장하고, 원천 주문 detail이나 provider payload는 포함하지 않는다. formatter는 이 값을
 * inspectable summary로만 사용한다.
 */
export interface LiveOpsBriefingPositionSnapshot {
  market: string;
  quantity: string | null;
  averageEntryPriceKrw: string | null;
  statusLabel: string;
}

/**
 * PnL과 equity 관측값을 나타내는 safe snapshot이다.
 *
 * 계산 불가와 0원을 구분하기 위해 결측은 null로 유지한다. 이 구조는 계산 결과를 담을 뿐 PnL closeout runner나 DB write를
 * 직접 수행하지 않는다.
 */
export interface LiveOpsBriefingPnlSnapshot {
  statusLabel: string;
  realizedKrw: string | null;
  unrealizedKrw: string | null;
  equityKrw: string | null;
  observedAt: string | null;
}

/**
 * wallet, coin, position, PnL, 예산 사용량을 묶은 portfolio snapshot이다.
 *
 * caller는 각 하위 source를 secret-safe projection으로 낮춘 뒤 전달해야 한다. formatter는 open exposure와 budget used가
 * 없으면 관측 없음으로 표시하고 0으로 대체하지 않는다.
 */
export interface LiveOpsBriefingPortfolioSnapshot {
  cash: LiveOpsBriefingCashSnapshot;
  balances: readonly LiveOpsBriefingBalanceSnapshot[];
  positions: readonly LiveOpsBriefingPositionSnapshot[];
  pnl: LiveOpsBriefingPnlSnapshot;
  openExposureKrw: string | null;
  budgetUsedKrw: string | null;
}

/**
 * reconcile, open order, risk block, alert retry 상태를 묶은 운영 snapshot이다.
 *
 * Telegram provider 실패나 reconcile 문제는 trading state rollback이 아니라 사람이 확인할 브리핑 문구로만 노출한다. 이 타입은
 * 외부 dispatch나 DB transaction side effect를 수행하지 않는다.
 */
export interface LiveOpsBriefingOperationsSnapshot {
  openOrders: string;
  reconcile: string;
  risk: string;
  alertRetry: string;
}

/**
 * 내부 evidence와 source 식별자를 브리핑 말미에 분리하기 위한 추적 snapshot이다.
 *
 * 첫 화면에서는 사용자 행동 언어를 우선하고, 내부 id/reason/source는 이 영역에만 둔다. raw provider payload, raw order
 * detail, credential, Telegram token은 이 필드에도 넣을 수 없다.
 */
export interface LiveOpsBriefingTraceSnapshot {
  evidenceIds: readonly string[];
  reasonCodes: readonly string[];
  sourceIds: readonly string[];
  metadata?: JsonRecord | undefined;
}

/**
 * Telegram `/brief`와 scheduled briefing이 공유하는 read-only Live Ops briefing snapshot이다.
 *
 * 서로 다른 source의 상태를 이미 secret-safe projection으로 낮춘 뒤 하나로 묶는다. 이 contract는 LLM이나 Telegram provider가
 * 주문 후보, 주문 수량, 목표가, broker 호출을 만들 수 없게 읽기 전용 evidence만 포함한다.
 */
export interface LiveOpsBriefingSnapshot {
  schemaVersion: LiveOpsBriefingSchemaVersion;
  observedAt: string;
  headline: LiveOpsBriefingHeadline;
  runtime: LiveOpsBriefingRuntimeSnapshot;
  market: LiveOpsBriefingMarketSnapshot;
  decisions: LiveOpsBriefingDecisionSnapshot;
  portfolio: LiveOpsBriefingPortfolioSnapshot;
  operations: LiveOpsBriefingOperationsSnapshot;
  trace: LiveOpsBriefingTraceSnapshot;
}

/**
 * deterministic briefing formatter 옵션이다.
 *
 * Telegram 기본 제한은 4096자이며 테스트나 다른 transport에서 더 작은 한도를 줄 수 있다. formatter는 초과분을 잘라내지만
 * Telegram provider 전송은 수행하지 않는다.
 */
export interface FormatLiveOpsBriefingOptions {
  maxCharacters?: number | undefined;
}

/**
 * briefing snapshot 안전성 점검 결과다.
 *
 * path는 문제가 관찰된 JSON 경로이고 reason은 raw provider/secret/order detail 후보를 나타낸다. preview는 redaction된 짧은
 * 문맥만 제공해 검증 로그가 secret을 재노출하지 않게 한다.
 */
export interface LiveOpsBriefingSafetyIssue {
  path: string;
  reason: string;
  redactedPreview: string;
}
