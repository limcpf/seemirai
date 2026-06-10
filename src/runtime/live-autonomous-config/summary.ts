import type { JsonRecord } from "../../domain/index.js";
import type { LiveAutonomousRuntimeGuardInput } from "./guard.js";
import { evaluateLiveAutonomousRuntimeGuard } from "./guard.js";

/**
 * M22 제한적 완전 자동매매 safe summary다.
 *
 * operator arm, budget, key scope, M21 week gate evidence id는 원문을 노출하지 않고 boolean으로 낮춘다. 이 summary는 `/status`,
 * Telegram, report에 전달 가능한 값만 포함해야 하며 raw credential, raw provider payload, Authorization/JWT를 포함하지 않는다.
 */
export interface LiveAutonomousRuntimeSafeSummary {
  enabled: boolean;
  ready: boolean;
  allowedMarkets: readonly string[];
  maxOrderKrw: string;
  dailyAutonomousNotionalLimitKrw: string;
  maxOpenPositionNotionalKrw: string;
  m21WeekGateEvidenceConfigured: boolean;
  operatorArmEvidenceConfigured: boolean;
  budgetEvidenceConfigured: boolean;
  keyScopeEvidenceConfigured: boolean;
  telegramInboundReady: boolean;
  reconcileFresh: boolean;
  pnlStatusReady: boolean;
  decisionLedgerReady: boolean;
  exitEngineReady: boolean;
  statusLabel: string;
  message: string;
  action: string | null;
  trace: JsonRecord;
}

/**
 * M22 제한적 완전 자동매매 guard 입력을 secret-safe summary로 변환한다.
 *
 * evidence id는 존재 여부만 boolean으로 노출하고, 내부 reason code와 violation 목록은 `trace`에 분리한다. 이 함수는 순수 변환이며
 * readiness provider 조회, DB write, Upbit private API 호출 같은 side effect를 만들지 않는다.
 */
export function createLiveAutonomousRuntimeSafeSummary(
  input: LiveAutonomousRuntimeGuardInput,
): LiveAutonomousRuntimeSafeSummary {
  const result = evaluateLiveAutonomousRuntimeGuard(input);
  const config = input.config.live_autonomous;
  const enabled = config.enabled;
  const ready = result.ready;
  const reason = toReason(enabled, ready);

  return {
    enabled,
    ready,
    allowedMarkets: [...config.allowed_markets],
    maxOrderKrw: config.max_order_krw,
    dailyAutonomousNotionalLimitKrw: config.daily_autonomous_notional_limit_krw,
    maxOpenPositionNotionalKrw: config.max_open_position_notional_krw,
    m21WeekGateEvidenceConfigured: hasEvidenceId(input.m21WeekGateEvidenceId),
    operatorArmEvidenceConfigured: hasEvidenceId(input.operatorArmEvidenceId),
    budgetEvidenceConfigured: hasEvidenceId(input.budgetEvidenceId),
    keyScopeEvidenceConfigured: hasEvidenceId(input.keyScopeEvidenceId),
    telegramInboundReady: input.telegramInboundReady,
    reconcileFresh: input.reconcileFresh,
    pnlStatusReady: input.pnlStatusReady,
    decisionLedgerReady: input.decisionLedgerReady,
    exitEngineReady: input.exitEngineReady,
    statusLabel: toStatusLabel(reason),
    message: result.message,
    action: result.action,
    trace: {
      source: "live_autonomous_runtime_guard",
      reason,
      observedAt: input.observedAt,
      violations: result.ready ? [] : [...result.violations],
    },
  };
}

function toReason(enabled: boolean, ready: boolean): string {
  if (!enabled) {
    return "live_autonomous_disabled";
  }

  return ready ? "live_autonomous_guard_ready" : "live_autonomous_guard_blocked";
}

function toStatusLabel(reason: string): string {
  if (reason === "live_autonomous_disabled") {
    return "M22 비활성";
  }

  if (reason === "live_autonomous_guard_ready") {
    return "M22 자동매매 준비";
  }

  return "M22 guard 차단";
}

function hasEvidenceId(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
