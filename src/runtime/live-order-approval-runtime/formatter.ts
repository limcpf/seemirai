import { enforceTelegramMessageLimit } from "../../infrastructure/index.js";
import type { LiveOrderApprovalCommandRuntimeResult } from "./types.js";

/**
 * M21 approval command 결과를 Telegram 사용자 응답으로 변환한다.
 *
 * 첫 화면은 한국어 상태/원인/영향/필요 조치를 우선하고, proposal id와 reason code는 추적 정보로 분리한다.
 */
export function formatLiveOrderApprovalCommandResponse(
  result: LiveOrderApprovalCommandRuntimeResult,
  correlationId: string,
): string {
  return enforceTelegramMessageLimit([
    titleForStatus(result.status),
    statusLine(result),
    causeLine(result),
    impactLine(result),
    actionLine(result),
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    `proposal: ${result.proposalId}`,
    `reason: ${result.reasonCode}`,
    result.brokerOrder === undefined ? undefined : `broker order: ${result.brokerOrder.brokerOrderId}`,
  ].filter((line): line is string => line !== undefined).join("\n"));
}

function titleForStatus(status: LiveOrderApprovalCommandRuntimeResult["status"]): string {
  switch (status) {
    case "APPROVAL_SUBMITTED":
      return "[수동 승인 주문 제출]";
    case "REJECTION_RECORDED":
      return "[수동 승인 거부 기록]";
    case "APPROVAL_SUBMISSION_BLOCKED":
    case "APPROVAL_SUBMISSION_FAILED":
    case "APPROVAL_RECORD_FAILED":
    case "REJECTION_RECORD_FAILED":
      return "[수동 승인 처리 보류]";
    case "PROPOSAL_EXPIRED":
      return "[수동 승인 만료]";
    case "PROPOSAL_NOT_FOUND":
    case "PROPOSAL_NOT_APPROVABLE":
    case "RUNTIME_DISABLED":
      return "[수동 승인 미실행]";
  }
}

function statusLine(result: LiveOrderApprovalCommandRuntimeResult): string {
  switch (result.status) {
    case "APPROVAL_SUBMITTED":
      return "상태: 운영자 승인을 기록했고 live 주문 제출까지 완료했습니다.";
    case "REJECTION_RECORDED":
      return "상태: 운영자 거부를 기록했고 주문은 제출하지 않았습니다.";
    case "PROPOSAL_EXPIRED":
      return "상태: proposal 승인 가능 시간이 지나 만료로 기록했습니다.";
    case "PROPOSAL_NOT_FOUND":
      return "상태: 해당 proposal을 찾지 못해 주문을 제출하지 않았습니다.";
    case "PROPOSAL_NOT_APPROVABLE":
      return "상태: 이미 닫힌 proposal이라 승인 또는 거부를 실행하지 않았습니다.";
    case "RUNTIME_DISABLED":
      return "상태: M21 수동 승인 runtime이 비활성이라 요청을 실행하지 않았습니다.";
    case "APPROVAL_SUBMISSION_BLOCKED":
      return "상태: 제출 직전 재검증이 실패해 live 주문을 제출하지 않았습니다.";
    case "APPROVAL_SUBMISSION_FAILED":
      if (result.reasonCode === "m21_broker_submission_uncertain") {
        return "상태: broker 제출 결과가 불확실해 성공 주문으로 처리하지 않았습니다.";
      }
      if (result.brokerSubmitted) {
        return "상태: live 주문 제출 후 기록 검증이 실패해 성공 처리하지 않았습니다.";
      }
      return "상태: live 주문 제출이 실패해 성공 주문으로 처리하지 않았습니다.";
    case "APPROVAL_RECORD_FAILED":
    case "REJECTION_RECORD_FAILED":
      return "상태: proposal 상태 기록이 충돌해 요청을 완료하지 않았습니다.";
  }
}

function causeLine(result: LiveOrderApprovalCommandRuntimeResult): string {
  switch (result.status) {
    case "APPROVAL_SUBMISSION_BLOCKED":
      return `원인: ${formatViolations(result.trace?.violations)}`;
    case "APPROVAL_RECORD_FAILED":
    case "REJECTION_RECORD_FAILED":
      return "원인: 현재 proposal 상태 또는 fingerprint가 명령 처리 중 변경됐습니다.";
    case "APPROVAL_SUBMISSION_FAILED":
      if (result.reasonCode === "m21_broker_submission_uncertain") {
        return "원인: broker 호출 중 오류가 발생했고 거래소 도달 여부를 확인하지 못했습니다.";
      }
      if (result.reasonCode === "m21_broker_submission_audit_append_failed") {
        return "원인: broker 제출 후 최종 audit 기록을 완료하지 못했습니다.";
      }
      if (
        result.reasonCode === "m21_broker_submission_evidence_failed" ||
        result.reasonCode === "m21_broker_submission_evidence_exception"
      ) {
        return "원인: broker 제출 후 제출 evidence 기록을 완료하지 못했습니다.";
      }
      return "원인: broker 제출 또는 제출 실패 evidence 기록 중 오류가 발생했습니다.";
    default:
      return `원인: ${result.reasonCode}`;
  }
}

function impactLine(result: LiveOrderApprovalCommandRuntimeResult): string {
  return result.brokerSubmitted
    ? "영향: 중복 제출 방지를 위해 같은 proposal 재승인은 차단됩니다."
    : "영향: live broker 주문 side effect는 발생하지 않았습니다.";
}

function actionLine(result: LiveOrderApprovalCommandRuntimeResult): string {
  switch (result.status) {
    case "APPROVAL_SUBMITTED":
      return "필요 조치: broker 주문 상태와 reconcile 결과를 확인하세요.";
    case "REJECTION_RECORDED":
      return "필요 조치: 새 주문 후보가 필요하면 strategy/risk 판단을 다시 생성하세요.";
    case "APPROVAL_SUBMISSION_BLOCKED":
      return "필요 조치: 표시된 차단 원인을 해소한 뒤 새 proposal을 생성하세요.";
    case "PROPOSAL_EXPIRED":
    case "PROPOSAL_NOT_APPROVABLE":
    case "PROPOSAL_NOT_FOUND":
      return "필요 조치: 최신 proposal 알림을 확인한 뒤 다시 승인하거나 거부하세요.";
    case "RUNTIME_DISABLED":
      return "필요 조치: M21 runtime guard와 설정을 확인한 뒤 다시 시도하세요.";
    case "APPROVAL_RECORD_FAILED":
    case "REJECTION_RECORD_FAILED":
    case "APPROVAL_SUBMISSION_FAILED":
      return "필요 조치: audit/proposal store와 broker 상태를 확인하고 수동 점검 evidence를 남기세요.";
  }
}

function formatViolations(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "제출 직전 guard가 충족되지 않았습니다.";
  }

  return value.map((item) => violationMessage(String(item))).join(", ");
}

function violationMessage(reasonCode: string): string {
  switch (reasonCode) {
    case "m21_runtime_disabled":
      return "M21 수동 승인 runtime이 비활성입니다.";
    case "m21_proposal_not_approved":
      return "proposal 승인 상태가 제출 가능 상태가 아닙니다.";
    case "m21_market_not_allowed":
      return "현재 허용된 market이 아닙니다.";
    case "m21_order_type_not_supported":
      return "현재 pilot은 지정가 주문만 허용합니다.";
    case "m21_order_notional_mismatch":
      return "proposal 금액과 실제 제출 가격·수량으로 계산한 금액이 일치하지 않습니다.";
    case "m21_order_notional_exceeds_limit":
      return "주문 금액이 단일 주문 한도를 초과했습니다.";
    case "m21_daily_budget_exceeded":
      return "일일 승인 예산 한도를 초과합니다.";
    case "m21_risk_not_approved":
      return "risk gate가 현재 주문 제출을 승인하지 않았습니다.";
    case "m21_risk_decision_mismatch":
      return "proposal의 risk decision과 최신 재검증 결과가 일치하지 않습니다.";
    case "m21_kill_switch_blocks_new_orders":
      return "kill switch가 신규 주문을 차단 중입니다.";
    case "m21_reconcile_not_fresh":
      return "실계좌 reconcile 상태가 최신이 아닙니다.";
    case "m21_invalid_idempotency_key":
      return "거래소 제출용 idempotency key가 허용 범위를 벗어났습니다.";
    case "m21_price_reference_invalid":
      return "가격 편차를 계산할 기준 가격이 유효하지 않습니다.";
    case "m21_price_deviation_exceeded":
      return "proposal 가격과 최신 기준 가격의 편차가 허용 범위를 초과했습니다.";
    case "m21_daily_budget_reservation_failed":
      return "일일 승인 예산 선점이 현재 proposal 상태와 일치하지 않습니다.";
    case "m21_daily_budget_reservation_unavailable":
      return "일일 승인 예산 선점 저장소를 사용할 수 없습니다.";
    case "m21_broker_submission_uncertain":
      return "broker 호출 결과가 불확실해 수동 reconcile 확인이 필요합니다.";
    case "m21_submission_recheck_unavailable":
      return "제출 직전 재검증 snapshot을 읽지 못했습니다.";
    case "m21_approval_audit_append_failed":
      return "승인 evidence 감사 기록을 완료하지 못했습니다.";
    case "m21_recheck_audit_append_failed":
      return "재검증 통과 evidence 감사 기록을 완료하지 못했습니다.";
    default:
      return "제출 직전 guard가 충족되지 않았습니다.";
  }
}
