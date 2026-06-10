import { createHash } from "node:crypto";
import { parseFinancialDecimal } from "../../shared/index.js";
import type { JsonRecord, NumericString } from "../index.js";
import type { LiveOrderProposalContract } from "./types.js";

/**
 * M21 proposal fingerprint에 들어가는 canonical evidence다.
 *
 * 승인 재사용 방지는 이 projection을 기준으로 하며, operator-facing 문구나 raw provider payload처럼 표시/전송에 따라 바뀌는
 * 값은 포함하지 않는다. 이 type은 broker 호출 side effect 없이 stale approval 비교 입력만 표현한다.
 */
export interface LiveOrderProposalFingerprintEvidence {
  proposal_id: string;
  exchange_id: string;
  market: string;
  side: string;
  order_type: "LIMIT";
  requested_price: NumericString;
  requested_volume: NumericString;
  expected_notional_krw: NumericString;
  configured_max_order_krw: NumericString;
  daily_approved_notional_limit_krw: NumericString;
  daily_approved_notional_used_krw: NumericString;
  decision_ledger_id: string;
  risk_decision_id: string;
  idempotency_key: string;
  expires_at: string;
  cost_snapshot: JsonRecord;
}

/**
 * proposal을 stale approval 검증용 canonical evidence로 낮춘다.
 *
 * 금융 숫자는 Decimal 문자열로 정규화하고, cost snapshot은 key 정렬 JSON으로 고정한다. 이 함수는 순수 변환 경계이며
 * DB write, Telegram reply, broker 호출 같은 외부 side effect를 만들지 않는다.
 */
export function createLiveOrderProposalFingerprintEvidence(
  proposal: LiveOrderProposalContract,
): LiveOrderProposalFingerprintEvidence {
  return {
    proposal_id: proposal.proposalId,
    exchange_id: proposal.exchangeId,
    market: proposal.market,
    side: proposal.side,
    order_type: proposal.orderType,
    requested_price: normalizeFinancialDecimalString(proposal.requestedPrice),
    requested_volume: normalizeFinancialDecimalString(proposal.requestedVolume),
    expected_notional_krw: normalizeFinancialDecimalString(proposal.expectedNotionalKrw),
    configured_max_order_krw: normalizeFinancialDecimalString(proposal.budget.configuredMaxOrderKrw),
    daily_approved_notional_limit_krw: normalizeFinancialDecimalString(
      proposal.budget.dailyApprovedNotionalLimitKrw,
    ),
    daily_approved_notional_used_krw: normalizeFinancialDecimalString(
      proposal.budget.dailyApprovedNotionalUsedKrw,
    ),
    decision_ledger_id: proposal.decisionLedgerId,
    risk_decision_id: proposal.riskDecisionId,
    idempotency_key: proposal.idempotencyKey,
    expires_at: toTimestampString(proposal.expiresAt),
    cost_snapshot: toStableJsonRecord(proposal.costSnapshot),
  };
}

/**
 * M21 proposal fingerprint를 SHA-256 hex 문자열로 만든다.
 *
 * 이 fingerprint는 보안 secret을 감추는 용도가 아니라, 같은 proposal id가 다른 가격/수량/예산/risk evidence로 재승인되는
 * stale approval 경로를 차단하는 멱등성 근거다. 외부 side effect는 없다.
 */
export function createLiveOrderProposalFingerprint(proposal: LiveOrderProposalContract): string {
  const evidence = createLiveOrderProposalFingerprintEvidence(proposal);
  return createHash("sha256").update(stableStringify(evidence)).digest("hex");
}

function normalizeFinancialDecimalString(value: NumericString): NumericString {
  try {
    return parseFinancialDecimal(value).toFixed();
  } catch {
    return value;
  }
}

function toTimestampString(timestamp: LiveOrderProposalContract["expiresAt"]): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

  // proposal은 저장/복원 경계를 지날 수 있으므로 같은 instant의 다른 ISO 표기가 stale approval로 오판되지 않게 정규화한다.
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
}

function stableStringify(input: unknown): string {
  return JSON.stringify(toStableJsonValue(input));
}

function toStableJsonRecord(record: JsonRecord): JsonRecord {
  return toStableJsonValue(record) as JsonRecord;
}

function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toStableJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const stableRecord: JsonRecord = {};
    for (const [key, child] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      stableRecord[key] = toStableJsonValue(child);
    }
    return stableRecord;
  }

  return value;
}
