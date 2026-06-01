const orderStatusLabels: Record<string, string> = {
  CREATED: "주문 생성",
  VALIDATED: "주문 검증 완료",
  RISK_APPROVED: "리스크 승인",
  RISK_REJECTED: "리스크 거부",
  SUBMITTED: "제출됨",
  ACCEPTED: "접수됨",
  PARTIALLY_FILLED: "부분 체결",
  FILLED: "체결 완료",
  CANCEL_REQUESTED: "취소 요청",
  CANCELED: "취소 완료",
  REJECTED: "거부됨",
  EXPIRED: "만료됨",
  FAILED: "실패",
  MANUAL_REVIEW_REQUIRED: "수동 점검 필요",
};

const discardReasonLabels: Record<string, string> = {
  cost_decision_rejected: "비용 조건 미충족",
  cost_margin_insufficient: "비용 차감 후 기대 수익 부족",
  feature_missing_spread_bps: "스프레드 지표 없음",
  order_intent_rejected: "주문 의도 변환 거부",
  requested_price_invalid: "요청 가격 오류",
  rule_engine_not_passed: "주문 규칙 미통과",
  spread_negative: "비정상 스프레드",
  spread_too_wide: "스프레드 기준 초과",
  strategy_decision_blocked: "전략 판단 차단",
};

const riskActionLabels: Record<string, string> = {
  ALLOW: "허용",
  AUDIT_ONLY: "감사 기록",
  BLOCK_ORDER: "주문 차단",
  HARD_STOP: "거래 불가능 전환",
  MANUAL_REVIEW_REQUIRED: "수동 점검 필요",
  NEW_ORDERS_BLOCKED: "신규 주문 중단",
  PAUSE_STRATEGY: "전략 중지",
  PLAN_CANCEL_PENDING_PAPER_ORDER: "대기 주문 취소 예약",
};

const riskTypeLabels: Record<string, string> = {
  cost: "비용 리스크",
  drawdown: "최대 낙폭",
  kill_switch_control: "거래 상태 제어",
  loss_limit: "손실 한도",
  market_data_freshness: "시세 최신성",
  notification: "알림 장애",
  order_idempotency: "주문 중복 방지",
  public_websocket_lag: "실시간 시세 지연",
  quote_freshness: "호가 최신성",
  spread: "스프레드",
  stale_market_data: "오래된 시세 데이터",
};

const phase15AltApprovalActionLabels: Record<string, string> = {
  APPROVE: "수동 승인",
  REJECT: "승인 거부",
  REVOKE: "승인 철회",
  EXPIRE: "승인 만료",
};

const pilotEvidenceStatusLabels: Record<string, string> = {
  FAILED: "검증 실패",
  MANUAL_REVIEW_REQUIRED: "수동 점검 필요",
  PASSED: "검증 통과",
  SKIPPED: "실행 생략",
};

const pilotProfileLabels: Record<string, string> = {
  PILOT_ORDER_SMOKE: "소액 주문 smoke",
  PILOT_POLICY_SYNC: "정책 조회",
  PILOT_READ_ONLY: "읽기 전용",
};

/**
 * 주문 상태 code를 Telegram 리포트용 한국어 문구로 바꾼다.
 *
 * 상태 code는 DB와 state machine의 안정적인 식별자이므로 보존하되, 사용자에게는 거래 영향이 먼저 읽히도록 라벨을 앞에 둔다.
 * 새 상태가 들어와도 formatter가 실패하지 않게 code를 괄호 안 추적 정보로 남기는 fallback을 유지한다.
 */
export function labelOrderStatus(code: string): string {
  return labelCode(code, orderStatusLabels, "미분류 주문 상태");
}

/**
 * 주문 후보 폐기 reason code를 운영자가 읽을 수 있는 원인 문구로 바꾼다.
 *
 * audit payload의 원본 reason code는 집계 key로 유지하고, 본문에서는 한국어 설명을 먼저 보여준다. 알 수 없는 신규 code는
 * 리포트를 중단하지 않고 "미분류 원인"으로 표시해 데이터 유실보다 전달 가능성을 우선한다.
 */
export function labelDiscardReason(code: string): string {
  return labelCode(code, discardReasonLabels, "미분류 폐기 원인");
}

/**
 * 리스크 action code를 사용자가 이해하는 차단/조치 문구로 바꾼다.
 *
 * action은 risk_events의 감사 key이므로 그대로 삭제하지 않는다. 리포트 본문은 한국어 조치명을 먼저 보여주고, 원본 code는
 * 괄호에 남겨 운영자가 DB evidence와 연결할 수 있게 한다.
 */
export function labelRiskAction(code: string): string {
  return labelCode(code, riskActionLabels, "미분류 조치");
}

/**
 * 리스크 종류 code를 운영 원인 축 문구로 바꾼다.
 *
 * 새 risk_type이 추가되어도 리포트 생성은 계속되어야 한다. fallback은 code를 포함하므로 운영자가 누락된 매핑을 발견하고
 * 후속 PR에서 사용자 문구를 보강할 수 있다.
 */
export function labelRiskType(code: string): string {
  return labelCode(code, riskTypeLabels, "미분류 리스크");
}

/**
 * phase 1.5 알트 수동 편입 action code를 운영자가 읽을 수 있는 상태 문구로 바꾼다.
 *
 * audit event의 action code는 재현 key로 유지하고, daily report 본문은 승인/거부/철회/만료라는 행동 언어를 먼저 보여준다.
 */
export function labelPhase15AltApprovalAction(code: string): string {
  return labelCode(code, phase15AltApprovalActionLabels, "미분류 알트 편입 상태");
}

/**
 * pilot private API evidence 상태 code를 daily report용 한국어 문구로 바꾼다.
 *
 * status code는 audit row와 연결하기 위한 안정 식별자이므로 괄호에 보존하고, 본문에는 검증 통과/실패/수동 점검 같은 운영
 * 행동 언어를 먼저 보여준다. 알 수 없는 code도 리포트 생성을 막지 않는다.
 */
export function labelPilotEvidenceStatus(code: string): string {
  return labelCode(code, pilotEvidenceStatusLabels, "미분류 pilot evidence 상태");
}

/**
 * pilot profile code를 daily report용 한국어 문구로 바꾼다.
 *
 * profile은 private API side effect 범위를 구분하는 key이므로 원본 code를 유지하되, 운영자는 읽기 전용/정책 조회/주문
 * smoke 단계가 먼저 보이도록 label을 사용한다.
 */
export function labelPilotProfile(code: string): string {
  return labelCode(code, pilotProfileLabels, "미분류 pilot profile");
}

function labelCode(code: string, labels: Record<string, string>, fallbackPrefix?: string): string {
  const label = labels[code] ?? fallbackPrefix;
  if (label === undefined) {
    return code;
  }

  return `${label} (${code})`;
}
