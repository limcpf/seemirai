import type { KillSwitchControlResult, ParsedTelegramInboundCommand } from "../../application/index.js";
import { enforceTelegramMessageLimit } from "../../infrastructure/index.js";
import type { TelegramInboundControlStatusSnapshot } from "./types.js";

type StatusSnapshot = TelegramInboundControlStatusSnapshot;

/**
 * `/status` Telegram 응답을 만든다.
 *
 * HTTP `/status` snapshot의 safe field만 사용하며, 내부 enum은 한국어 거래 영향 문구로 변환하고 안정 식별자는 추적 정보로 내린다.
 */
export function formatTelegramStatusCommandResponse(
  snapshot: StatusSnapshot,
  correlationId: string,
): string {
  return limitTelegramResponse([
    "[운영 상태]",
    `거래 상태: ${labelKillSwitchState(snapshot.tradingState.killSwitchState)}`,
    `신규 주문: ${snapshot.tradingState.newOrdersBlocked ? "중단됨" : "가능"}`,
    `시장 데이터: ${snapshot.marketData.connectionStatus}, 지연 ${formatNullableNumber(snapshot.marketData.lagMs, "ms")}`,
    `DB 상태: ${snapshot.database.ready ? "준비됨" : "점검 필요"}`,
    `PnL 상태: ${snapshot.pnl.statusLabel} - ${snapshot.pnl.message}`,
    `필요 조치: ${firstAction([snapshot.pnl.action, snapshot.paper.action, snapshot.reconcile.actionRequired])}`,
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    `생성 시각: ${snapshot.generatedAt}`,
    `kill switch: ${snapshot.tradingState.killSwitchState}`,
  ]);
}

/**
 * `/positions` Telegram 응답을 만든다.
 *
 * 현재 scope는 paper positions 집계와 PnL 요약만 노출하고, 주문/체결 raw detail이나 broker payload는 포함하지 않는다.
 */
export function formatTelegramPositionsCommandResponse(
  snapshot: StatusSnapshot,
  correlationId: string,
): string {
  return limitTelegramResponse([
    "[포지션]",
    `보유 포지션: ${formatNullableCount(snapshot.paper.openPositionCount, "개")}`,
    `평가자산: ${formatKrw(snapshot.pnl.latestEquityKrw)}`,
    `미실현 손익: ${formatKrw(snapshot.pnl.latestUnrealizedPnlKrw)}`,
    `실현 손익: ${formatKrw(snapshot.pnl.latestRealizedPnlKrw)}`,
    `상태: ${snapshot.paper.statusLabel} - ${snapshot.paper.message}`,
    `필요 조치: ${snapshot.paper.action ?? snapshot.pnl.action ?? "추가 조치 없음"}`,
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    `PnL 캡처: ${snapshot.pnl.latestCapturedAt ?? "기록 없음"}`,
  ]);
}

/**
 * `/pnl` Telegram 응답을 만든다.
 *
 * 금액과 drawdown은 latest PnL snapshot에서 읽은 safe numeric string만 표시하고, 원본 payload_json은 노출하지 않는다.
 */
export function formatTelegramPnlCommandResponse(
  snapshot: StatusSnapshot,
  correlationId: string,
): string {
  return limitTelegramResponse([
    "[손익]",
    `상태: ${snapshot.pnl.statusLabel}`,
    snapshot.pnl.message,
    `평가자산: ${formatKrw(snapshot.pnl.latestEquityKrw)}`,
    `실현 손익: ${formatKrw(snapshot.pnl.latestRealizedPnlKrw)}`,
    `미실현 손익: ${formatKrw(snapshot.pnl.latestUnrealizedPnlKrw)}`,
    `최대 낙폭: ${formatBps(snapshot.pnl.latestDrawdownBps)}`,
    `필요 조치: ${snapshot.pnl.action ?? "추가 조치 없음"}`,
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    `snapshot 수: ${snapshot.pnl.snapshotCount}`,
    `latest source: ${snapshot.pnl.latestSource ?? "없음"}`,
  ]);
}

/**
 * `/why <market|cash>` Telegram 응답을 만든다.
 *
 * decision ledger summary의 사용자-facing message/action만 노출하고, reason code는 hold reason item의 trace에 남겨진 경우에도
 * 첫 화면에는 한국어 label/count로만 표시한다.
 */
export function formatTelegramWhyCommandResponse(
  snapshot: StatusSnapshot,
  command: ParsedTelegramInboundCommand,
  correlationId: string,
): string {
  const target = command.argument;
  if (snapshot.why === null) {
    return limitTelegramResponse([
      "[판단 이유]",
      "상태: 조회 준비 안 됨",
      "판단 이유 provider가 runtime에 연결되지 않아 최근 판단 이유를 확인하지 못했습니다.",
      "필요 조치: decision ledger status provider를 연결한 뒤 다시 조회하세요.",
      "",
      "추적 정보",
      `요청 ID: ${correlationId}`,
    ]);
  }

  if (target?.kind === "cash") {
    const cash = snapshot.why.cash;
    const item = cash.item;
    return limitTelegramResponse([
      "[판단 이유: 현금]",
      `상태: ${cash.statusLabel}`,
      item?.message ?? cash.message,
      optionalLine("영향", item?.impact ?? cash.impact),
      `필요 조치: ${item?.action ?? cash.action ?? "추가 조치 없음"}`,
      ...formatCashHoldReasons(item?.holdReasons ?? []),
      "",
      "추적 정보",
      `요청 ID: ${correlationId}`,
      `생성 시각: ${snapshot.why.generatedAt}`,
      `조회 상태: ${snapshot.why.readStatus}`,
    ]);
  }

  const market = target?.kind === "market" ? target.market : null;
  const item = market === null ? undefined : snapshot.why.markets.items.find((candidate) => candidate.market === market);
  if (item === undefined) {
    return limitTelegramResponse([
      `[판단 이유: ${market ?? "시장"}]`,
      `상태: ${snapshot.why.markets.statusLabel}`,
      market === null
        ? "조회할 market이 지정되지 않았습니다."
        : `${market}의 최근 판단 이유가 아직 기록되지 않았습니다.`,
      `필요 조치: ${snapshot.why.markets.action ?? "러너 실행 후 다시 조회하세요."}`,
      "",
      "추적 정보",
      `요청 ID: ${correlationId}`,
      `조회 상태: ${snapshot.why.markets.readStatus}`,
    ]);
  }

  return limitTelegramResponse([
    `[판단 이유: ${item.market}]`,
    `상태: ${item.statusLabel}`,
    item.message,
    optionalLine("영향", item.impact),
    `필요 조치: ${item.action ?? "추가 조치 없음"}`,
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    `최신 판단: ${item.latestDecisionAt ?? "기록 없음"}`,
    `생성 시각: ${snapshot.why.generatedAt}`,
  ]);
}

/**
 * `/orders` Telegram 응답을 만든다.
 *
 * paper pending/open order 집계와 live reconcile open order count만 표시하며, raw order detail과 live broker 호출 결과는 포함하지 않는다.
 */
export function formatTelegramOrdersCommandResponse(
  snapshot: StatusSnapshot,
  correlationId: string,
): string {
  return limitTelegramResponse([
    "[주문]",
    `paper 대기 주문: ${formatNullableCount(snapshot.paper.pendingPaperOrderCount, "건")}`,
    `paper 보유 포지션: ${formatNullableCount(snapshot.paper.openPositionCount, "개")}`,
    `실계좌 미체결 주문: ${formatNullableCount(snapshot.reconcile.openOrderCount, "건")}`,
    `reconcile 상태: ${snapshot.reconcile.message}`,
    `필요 조치: ${snapshot.reconcile.actionRequired}`,
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    `reconcile 결과: ${snapshot.reconcile.result}`,
    `마지막 reconcile: ${snapshot.reconcile.lastReconcileAt ?? "기록 없음"}`,
  ]);
}

/**
 * `/risk` Telegram 응답을 만든다.
 *
 * kill switch, market data lag, PnL drawdown, reconcile mismatch를 한 화면에 요약해 운영자가 신규 주문 차단 원인을 판단하게 한다.
 */
export function formatTelegramRiskCommandResponse(
  snapshot: StatusSnapshot,
  correlationId: string,
): string {
  return limitTelegramResponse([
    "[리스크]",
    `거래 제한: ${labelKillSwitchState(snapshot.tradingState.killSwitchState)}`,
    `신규 주문 차단: ${snapshot.tradingState.newOrdersBlocked ? "예" : "아니오"}`,
    `수동 점검: ${snapshot.tradingState.requiresManualReview ? "필요" : "불필요"}`,
    `시장 데이터 지연: ${formatNullableNumber(snapshot.marketData.lagMs, "ms")}`,
    `최대 낙폭: ${formatBps(snapshot.pnl.latestDrawdownBps)}`,
    `reconcile: ${snapshot.reconcile.message}`,
    `필요 조치: ${firstAction([snapshot.reconcile.actionRequired, snapshot.pnl.action, snapshot.paper.action])}`,
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    `blocked reason: ${snapshot.tradingState.blockedReason ?? "없음"}`,
    `reconcile mismatch: ${formatNullableCount(snapshot.reconcile.mismatchCount, "건")}`,
  ]);
}

/**
 * control 명령의 2단계 확인 요청 메시지를 만든다.
 *
 * 첫 번째 control 명령은 상태를 바꾸지 않았음을 명확히 보여주고, 같은 명령을 한 번 더 보내야 실행된다는 확인 절차를 안내한다.
 */
export function formatTelegramControlConfirmationRequiredResponse(input: {
  command: ParsedTelegramInboundCommand;
  expiresAt: string;
  correlationId: string;
}): string {
  return limitTelegramResponse([
    "[제어 명령 확인 필요]",
    `${labelControlCommand(input.command.name)} 요청은 아직 실행하지 않았습니다.`,
    "영향: 현재 거래 상태는 변경되지 않았습니다.",
    `필요 조치: ${input.expiresAt} 전까지 같은 명령을 한 번 더 보내면 실행합니다.`,
    "",
    "추적 정보",
    `요청 ID: ${input.correlationId}`,
    `명령: /${input.command.name}`,
  ]);
}

/**
 * accepted/rejected kill switch provider 결과를 Telegram 응답으로 변환한다.
 *
 * provider가 거부한 전이는 운영 명령 충돌이므로 실패 stack 대신 상태 전이 거부 이유와 현재 영향만 보여준다.
 */
export function formatTelegramControlCommandResponse(input: {
  command: ParsedTelegramInboundCommand;
  result: KillSwitchControlResult;
  correlationId: string;
}): string {
  const transition = input.result.transition;
  const targetLabel = labelKillSwitchState(transition.toState);
  const statusLine = transition.accepted
    ? `상태: 거래 상태를 ${targetLabel} 상태로 변경했습니다.`
    : `상태: 거래 상태 변경이 거부되었습니다.`;

  return limitTelegramResponse([
    `[제어 명령 결과: /${input.command.name}]`,
    statusLine,
    `현재 영향: ${describeActionPlan(input.result)}`,
    `필요 조치: ${transition.accepted ? recommendControlFollowUp(transition.toState) : transition.message}`,
    "",
    "추적 정보",
    `요청 ID: ${input.correlationId}`,
    `from: ${transition.fromState}`,
    `to: ${transition.toState}`,
    `reason: ${transition.reasonCode}`,
    optionalLine("감사 이벤트", input.result.auditEventId),
    optionalLine("리스크 이벤트", input.result.riskEventId),
    optionalLine("후속 job", input.result.hardStopCancelJob?.idempotencyKey),
  ]);
}

/**
 * command 실행 실패 응답을 만든다.
 *
 * exception message는 secret이나 provider detail을 포함할 수 있으므로 사용자에게는 정규화된 실패 안내만 보여준다.
 */
export function formatTelegramCommandExecutionFailureResponse(input: {
  commandName: string;
  correlationId: string;
}): string {
  return limitTelegramResponse([
    "[명령 처리 실패]",
    `상태: /${input.commandName} 요청을 처리하지 못했습니다.`,
    "영향: 거래 상태 변경이나 주문 side effect는 완료된 것으로 간주하지 않습니다.",
    "필요 조치: audit log와 runtime 상태를 확인한 뒤 다시 시도하세요.",
    "",
    "추적 정보",
    `요청 ID: ${input.correlationId}`,
    "reason: telegram_inbound_command_execution_failed",
  ]);
}

/**
 * command dedupe 저장 실패 응답을 만든다.
 *
 * dedupe 저장소를 신뢰할 수 없으면 같은 Telegram update 재전달이 control provider를 중복 호출할 수 있으므로, 실행 전에
 * fail-closed로 멈추고 운영자에게 DB/jobs 상태 확인을 안내한다.
 */
export function formatTelegramDedupeFailureResponse(correlationId: string): string {
  return limitTelegramResponse([
    "[명령 처리 보류]",
    "상태: 중복 실행 보호 상태를 기록하지 못해 Telegram 명령을 실행하지 않았습니다.",
    "영향: 조회와 제어 요청 모두 처리되지 않았습니다.",
    "필요 조치: DB 연결, jobs table idempotency key 충돌, migration 적용 상태를 확인한 뒤 다시 시도하세요.",
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    "reason: telegram_inbound_dedupe_failed",
  ]);
}

/**
 * audit 저장 실패 응답을 만든다.
 *
 * M20 control surface는 audit evidence 없이 command를 실행하면 안 되므로, audit 실패는 조회/제어 모두 fail-closed로 안내한다.
 */
export function formatTelegramAuditFailureResponse(correlationId: string): string {
  return limitTelegramResponse([
    "[명령 처리 보류]",
    "상태: 감사 기록을 저장하지 못해 Telegram 명령을 실행하지 않았습니다.",
    "영향: 조회와 제어 요청 모두 처리되지 않았습니다.",
    "필요 조치: DB 연결과 audit_events table 상태를 확인한 뒤 다시 시도하세요.",
    "",
    "추적 정보",
    `요청 ID: ${correlationId}`,
    "reason: telegram_inbound_audit_append_failed",
  ]);
}

function limitTelegramResponse(lines: ReadonlyArray<string | undefined>): string {
  return enforceTelegramMessageLimit(lines.filter((line): line is string => line !== undefined).join("\n"));
}

function labelKillSwitchState(state: string): string {
  switch (state) {
    case "NORMAL":
      return "정상 거래 가능";
    case "NEW_ORDERS_BLOCKED":
      return "신규 주문 중단";
    case "STRATEGY_PAUSED":
      return "전략 평가 중지";
    case "HARD_STOP":
      return "거래 불가능";
    case "MANUAL_REVIEW_REQUIRED":
      return "수동 점검 필요";
    default:
      return "상태 확인 필요";
  }
}

function labelControlCommand(commandName: ParsedTelegramInboundCommand["name"]): string {
  switch (commandName) {
    case "pause":
      return "신규 주문 중단";
    case "resume":
      return "거래 상태 복구";
    case "kill":
      return "긴급 거래 중지";
    default:
      return `/${commandName}`;
  }
}

function describeActionPlan(result: KillSwitchControlResult): string {
  const actions: string[] = [];
  if (result.actionPlan.newOrdersBlocked) {
    actions.push("신규 주문 차단");
  }
  if (result.actionPlan.strategyEvaluationBlocked) {
    actions.push("전략 평가 중지");
  }
  if (result.actionPlan.cancelPendingPaperOrders) {
    actions.push("pending paper 주문 취소 job 예약");
  }
  if (result.actionPlan.requiresManualReview) {
    actions.push("수동 점검 필요");
  }

  return actions.length === 0 ? "신규 제한 없음" : actions.join(", ");
}

function recommendControlFollowUp(state: string): string {
  switch (state) {
    case "NORMAL":
      return "reconcile과 PnL 상태가 정상인지 확인한 뒤 자동 운영을 재개하세요.";
    case "NEW_ORDERS_BLOCKED":
      return "신규 주문은 중단됐습니다. 원인을 확인한 뒤 필요하면 /resume을 확인 절차로 실행하세요.";
    case "HARD_STOP":
      return "pending 주문 취소 evidence와 수동 점검을 완료한 뒤 복구 절차를 진행하세요.";
    case "MANUAL_REVIEW_REQUIRED":
      return "수동 점검 항목을 해소한 뒤 상태 복구를 검토하세요.";
    default:
      return "상태 전이 결과와 audit evidence를 확인하세요.";
  }
}

function firstAction(actions: ReadonlyArray<string | null>): string {
  return actions.find((action) => action !== null && action.trim().length > 0) ?? "추가 조치 없음";
}

function optionalLine(label: string, value: string | undefined | null): string | undefined {
  return value === undefined || value === null || value.length === 0 ? undefined : `${label}: ${value}`;
}

function formatCashHoldReasons(
  reasons: ReadonlyArray<{ label: string; count: number }>,
): string[] {
  if (reasons.length === 0) {
    return [];
  }

  return ["보유 사유:", ...reasons.slice(0, 5).map((reason) => `- ${reason.label}: ${reason.count}회`)];
}

function formatNullableCount(value: number | null, unit: string): string {
  return value === null ? "확인 불가" : `${value}${unit}`;
}

function formatNullableNumber(value: number | null, unit: string): string {
  return value === null ? "확인 불가" : `${value}${unit}`;
}

function formatKrw(value: string | null): string {
  return value === null ? "기록 없음" : `${value} KRW`;
}

function formatBps(value: string | null): string {
  return value === null ? "기록 없음" : `${value} bps`;
}
