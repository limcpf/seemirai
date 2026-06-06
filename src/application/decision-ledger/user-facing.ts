import type { DecisionCategory, DecisionFrameCategory } from "./category.js";

/**
 * decision category를 사용자-facing 한국어 상태 label로 매핑한다.
 *
 * 이 함수는 순수 변환 함수이며 DB나 외부 provider를 호출하지 않는다.
 * 사용자에게 바로 노출되는 label이며, 안정적인 내부 category code는 trace로 분리한다.
 *
 * @param category 판단 범주
 * @returns 한국어 상태 label
 */
export function toCategoryLabel(category: DecisionCategory): string {
  switch (category) {
    case "BUY":
      return "매수 판단";
    case "SELL":
      return "매도 판단";
    case "HOLD":
      return "보유";
    case "CASH_HOLD":
      return "현금 보유";
    case "DISCARD":
      return "주문 폐기";
    case "COST_REJECTED":
      return "비용 차단";
    case "RISK_REJECTED":
      return "리스크 차단";
    case "EXECUTION_REJECTED":
      return "실행 거부";
    case "EXECUTED":
      return "실행 완료";
    case "EXPLANATION_FAILED":
      return "설명 생성 실패";
  }
}

/**
 * evidence kind를 사용자-facing 한국어 label로 매핑한다.
 */
export function toEvidenceKindLabel(kind: string): string {
  switch (kind) {
    case "STRATEGY_DECISION":
      return "전략 판단";
    case "ORDER_INTENT":
      return "주문 후보";
    case "DISCARD_REASON":
      return "폐기 사유";
    case "COST_BREAKDOWN":
      return "비용 평가";
    case "RISK_DECISION":
      return "리스크 평가";
    case "EXECUTION_RESULT":
      return "실행 결과";
    case "PNL_STATUS_CONTEXT":
      return "PnL 상태";
    case "EXPLANATION_SUMMARY":
      return "설명 요약";
    case "EXPLANATION_FAILURE":
      return "설명 실패";
    default:
      return kind;
  }
}

/**
 * 판단 category에 따라 사용자-facing 한국어 상태/원인/영향/조치 문구를 만든다.
 *
 * 이 함수는 순수 변환 함수이며 DB나 외부 provider를 호출하지 않는다.
 *
 * @param frameCategory frame 판단 범주
 * @param market market code (없으면 null)
 * @returns 한국어 문구 묶음
 */
export function toWhyStatusMessages(
  frameCategory: DecisionFrameCategory | null,
  market?: string | null,
): {
  statusLabel: string;
  message: string;
  impact: string | null;
  action: string | null;
} {
  const marketLabel = market ?? "전체";

  if (frameCategory === null) {
    return {
      statusLabel: "기록 없음",
      message: `${marketLabel}에 대한 최근 판단 기록이 없습니다.`,
      impact: null,
      action: "러너 실행 후 다시 조회하세요.",
    };
  }

  switch (frameCategory) {
    case "BUY":
      return {
        statusLabel: "매수 판단",
        message: `${marketLabel}에서 매수 신호가 생성되었습니다.`,
        impact: "비용과 리스크 게이트를 통과하면 신규 매수 주문이 제출됩니다.",
        action: null,
      };
    case "SELL":
      return {
        statusLabel: "매도 판단",
        message: `${marketLabel}에서 매도 신호가 생성되었습니다.`,
        impact: "기존 포지션이 있다면 청산 주문이 제출됩니다.",
        action: null,
      };
    case "HOLD":
      return {
        statusLabel: "보유",
        message: `${marketLabel}에서 현재 진입 또는 청산하지 않기로 판단했습니다.`,
        impact: "시장 조건이 전략 진입 기준을 만족하지 않습니다.",
        action: "시장 상황 변화를 모니터링하며 대기하세요.",
      };
    case "CASH_HOLD":
      return {
        statusLabel: "현금 보유",
        message: `모든 전략이 ${marketLabel}에서 현금 보유를 선택했습니다.`,
        impact: "기대 수익이 비용을 하회하거나 전략 신호가 생성되지 않았습니다.",
        action: "시장 조건이 개선될 때까지 대기하세요.",
      };
    case "DISCARD":
      return {
        statusLabel: "주문 폐기",
        message: `${marketLabel}에서 생성된 주문 후보가 변환 단계에서 폐기되었습니다.`,
        impact: "주문이 실제로 제출되지 않았습니다.",
        action: "전략 신호와 conversion rule을 확인하세요.",
      };
    case "COST_REJECTED":
      return {
        statusLabel: "비용 차단",
        message: `${marketLabel}에서 비용이 기대 수익을 초과하여 주문이 차단되었습니다.`,
        impact: "스프레드, 수수료, 슬리피지를 고려한 순기대수익이 마진을 확보하지 못했습니다.",
        action: "시장 변동성과 스프레드 조건을 확인하세요.",
      };
    case "RISK_REJECTED":
      return {
        statusLabel: "리스크 차단",
        message: `${marketLabel}에서 리스크 한도를 초과하여 주문이 차단되었습니다.`,
        impact: "계정 손실 한도, 종목 노출 한도, 또는 연속 손실 제한에 걸렸습니다.",
        action: "포지션과 리스크 한도 상태를 확인하세요.",
      };
    case "EXECUTION_REJECTED":
      return {
        statusLabel: "실행 거부",
        message: `${marketLabel}에서 주문 실행이 거부되었습니다.`,
        impact: "주문이 broker에 제출되지 않았습니다.",
        action: "실행 엔진 상태와 broker 연결을 확인하세요.",
      };
    case "EXECUTED":
      return {
        statusLabel: "실행 완료",
        message: `${marketLabel}에서 주문이 broker에 제출되어 실행되었습니다.`,
        impact: "주문이 접수되었으며 체결 결과는 execution evidence에서 확인할 수 있습니다.",
        action: null,
      };
  }
}

/**
 * reason code를 사용자-facing 한국어 사유 label로 매핑한다.
 *
 * 이 함수는 알려진 reason code만 label로 변환하고, 모르는 code는 그대로 반환한다.
 * 순수 변환 함수이며 외부 side effect가 없다.
 *
 * @param reasonCode 내부 reason code
 * @returns 한국어 label
 */
export function toHoldReasonLabel(reasonCode: string): string {
  const known: Record<string, string> = {
    fixture_waiting_for_signal: "신호 대기 중",
    insufficient_expected_return: "기대 수익 부족",
    wide_spread: "스프레드 확대",
    low_depth: "호가 깊이 부족",
    high_volatility: "높은 변동성",
    stale_market_data: "시장 데이터 지연",
    strategy_hold: "전략 보유 판단",
    all_strategies_hold: "모든 전략 보유",
    cost_margin_insufficient: "비용 마진 부족",
    exposure_limit_exceeded: "노출 한도 초과",
    expected_loss_limit_exceeded: "예상 손실 한도 초과",
    paper_broker_rejected: "paper broker 거부",
    fixture_strategy_blocked: "전략 차단",
  };

  return known[reasonCode] ?? reasonCode;
}
