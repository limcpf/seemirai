import type {
  PnLAccountingOutput,
  PnLAccountingScope,
  PnLAccountingStatus,
  PnLMissingReason,
} from "./types.js";

/**
 * PnL 회계 상태 코드를 사용자-facing 한국어 label로 변환한다.
 *
 * 이 함수는 status/report 포맷터가 첫 화면에 한국어를 먼저 보여주고
 * 내부 code를 추적 정보로 분리하기 위한 공통 매핑이다.
 */
export function formatPnLAccountingStatus(status: PnLAccountingStatus): string {
  switch (status) {
    case "CALCULATED":
      return "계산 완료";
    case "PARTIAL":
      return "일부 계산 가능";
    case "UNAVAILABLE":
      return "계산 불가";
    case "MANUAL_REVIEW_REQUIRED":
      return "수동 검토 필요";
  }
}

/**
 * 계산 불가 원인을 한국어 사용자 문구로 변환한다.
 *
 * 숫자 0과 계산 불가를 구분하기 위해, 값이 없을 때는 이 메시지를 먼저 보여준다.
 * 내부 reason code는 추적 정보에 남긴다.
 */
export function formatMissingReason(reason: PnLMissingReason): string {
  return reason.message;
}

/**
 * 계산 불가 원인 code를 사용자-facing 한국어 문구로 변환한다.
 *
 * 새 reason code가 추가되면 이 매핑에 항목을 추가해야 한다.
 */
export function labelMissingReasonCode(code: string): string {
  switch (code) {
    case "NO_MARK_PRICE":
      return "평가가 없음";
    case "AVERAGE_ENTRY_MISSING":
      return "평균단가 근거 없음";
    case "POSITION_QUANTITY_MISSING":
      return "보유 수량 근거 없음";
    case "MANUAL_REVIEW_REQUIRED":
      return "수동 검토 필요";
    case "NO_POSITION_SOURCE":
      return "포지션 정보 없음";
    case "NO_CASH_SOURCE":
      return "현금 정보 없음";
    case "NO_FILL_SOURCE":
      return "체결 내역 없음";
    case "RECOVERABLE_ONLY":
      return "복구 가능 상태만 사용 가능";
    case "SNAPSHOT_COVERAGE_PARTIAL":
      return "일부 snapshot coverage만 확인됨";
    case "POSITION_REALIZED_PNL_UNADJUSTED":
      return "positions 실현손익은 수수료 반영 근거 없음";
    default:
      return `계산 불가 (${code})`;
  }
}

/**
 * PnL accounting output에서 사용자-facing 한 줄 요약을 만든다.
 *
 * 상태와 주요 숫자를 한국어로 보여주며, 계산 불가인 값은 "계산 불가"로 표시한다.
 * 내부 code와 trace는 노출하지 않는다.
 */
export function formatPnLSummary(output: PnLAccountingOutput): string {
  const status = formatPnLAccountingStatus(output.status);
  const totalPnl = output.totalPnlKrw !== null ? `${output.totalPnlKrw} KRW` : "계산 불가";
  const equity = output.equityKrw !== null ? `${output.equityKrw} KRW` : "계산 불가";
  const cash = output.cashKrw !== null ? `${output.cashKrw} KRW` : "계산 불가";

  let summary = `상태: ${status}\n`;
  summary += `총 평가자산: ${equity}\n`;
  summary += `현금: ${cash}\n`;
  summary += `총 손익: ${totalPnl}\n`;

  if (output.realizedPnlKrw !== null) {
    summary += `실현 손익: ${output.realizedPnlKrw} KRW\n`;
  } else {
    summary += "실현 손익: 계산 불가\n";
  }

  if (output.unrealizedPnlKrw !== null) {
    summary += `미실현 손익: ${output.unrealizedPnlKrw} KRW\n`;
  } else {
    summary += "미실현 손익: 계산 불가\n";
  }

  if (output.positionMarketValueKrw !== null) {
    summary += `보유 평가액: ${output.positionMarketValueKrw} KRW\n`;
  } else {
    summary += "보유 평가액: 계산 불가\n";
  }

  if (output.missingReasons.length > 0) {
    summary += "\n계산 불가 원인:\n";
    for (const reason of output.missingReasons) {
      summary += `  - ${reason.message} (${reason.scope})\n`;
    }
  }

  if (output.feeTotals.length > 0) {
    summary += "\n수수료:\n";
    for (const fee of output.feeTotals) {
      summary += `  ${fee.currency}: ${fee.amount}\n`;
    }
  }

  return summary;
}

/**
 * 하나의 scope를 사용자-facing 한글로 포맷한다.
 */
export function formatScope(scope: PnLAccountingScope): string {
  const market = scope.market ?? "전체";
  return `${scope.strategyId}/${market}`;
}
