import type { ExchangePolicySnapshot, MarketDataEvent, MarketStatus } from "./market.js";
import type { OrderIntent } from "./orders.js";
import type { ExchangeId, JsonRecord, MarketCode, TimestampInput } from "./types.js";

export type RuleEvaluationStatus = "PASS" | "FAIL" | "WARN";

/**
 * rule 평가 결과다.
 *
 * PASS, FAIL, WARN과 reasonCode를 항상 남겨 주문 차단 또는 경고의 근거를 audit log에 연결한다.
 */
export interface RuleEvaluation {
  status: RuleEvaluationStatus;
  reasonCode: string;
  message: string;
  metadata?: JsonRecord;
}

/**
 * rule이 평가할 때 받는 공통 context다.
 *
 * market 상태, 정책 snapshot, 최신 시세 이벤트, 주문 후보, 계정 상태를 선택적으로 담아 rule 조합을 확장한다.
 */
export interface RuleContext {
  exchangeId: ExchangeId;
  market: MarketCode;
  observedAt: TimestampInput;
  marketStatus?: MarketStatus;
  policySnapshot?: ExchangePolicySnapshot;
  latestEvents?: readonly MarketDataEvent[];
  orderIntent?: OrderIntent;
  accountState?: JsonRecord;
  metadata?: JsonRecord;
}

/**
 * 매수/매도 기준을 구성하는 단일 rule contract다.
 *
 * Rule은 broker나 거래소 client를 직접 호출하지 않고, 전달받은 context만 평가해 PASS, FAIL, WARN을 반환한다.
 */
export interface Rule {
  id: string;
  evaluate(context: RuleContext): RuleEvaluation | Promise<RuleEvaluation>;
}
