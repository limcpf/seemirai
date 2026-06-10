import type { RuntimeConfig } from "../config.js";
import type { LiveManualApprovalRuntimeConfig } from "./schema.js";

/**
 * M21 수동 승인 runtime startup guard 입력이다.
 *
 * config shape는 이미 `RuntimeConfigSchema`가 확인했으며, caller는 `loadRuntimeTelegramInboundConfig(...).enabled`처럼 token과
 * owner allowlist까지 해결된 M20 inbound readiness를 넘겨야 한다. 이 입력 자체는 broker 호출이나 DB write side effect를
 * 만들지 않는다.
 */
export interface LiveManualApprovalRuntimeGuardInput {
  config: RuntimeConfig;
  telegramInboundReady: boolean;
  reconcileFresh: boolean;
  observedAt: string;
}

/**
 * M21 수동 승인 runtime guard 결과다.
 *
 * `ready=true`일 때만 후속 proposal/approval runtime이 실행될 수 있다. disabled/blocked 결과는 운영자가 조치할 수 있는
 * 한국어 메시지와 stable violation code를 함께 담는다.
 */
export type LiveManualApprovalRuntimeGuardResult =
  | {
      ready: true;
      config: LiveManualApprovalRuntimeConfig;
      message: string;
      action: string;
      observedAt: string;
    }
  | {
      ready: false;
      config: LiveManualApprovalRuntimeConfig;
      violations: readonly string[];
      message: string;
      action: string;
      observedAt: string;
    };

/**
 * M21 수동 승인 runtime guard 실패 오류다.
 *
 * violations는 proposal 생성과 broker 제출 전에 차단해야 하는 원인만 담는다. 이 오류가 발생한 경우 후속 runtime은
 * `UpbitLiveBroker.submitOrder`를 호출하면 안 된다.
 */
export class UnsafeLiveManualApprovalRuntimeConfigError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`안전하지 않은 M21 수동 승인 runtime 설정: ${violations.join(", ")}`);
    this.name = "UnsafeLiveManualApprovalRuntimeConfigError";
    this.violations = violations;
  }
}

/**
 * M21 수동 승인 live pilot이 실행 가능한지 평가한다.
 *
 * 기본 비활성 config, resolved M20 inbound 비활성, stale reconcile은 모두 broker 호출 전 차단 조건이다. 이 함수는 순수 guard이며
 * Telegram polling 시작, DB 조회, Upbit private API 호출 같은 side effect를 만들지 않는다.
 */
export function evaluateLiveManualApprovalRuntimeGuard(
  input: LiveManualApprovalRuntimeGuardInput,
): LiveManualApprovalRuntimeGuardResult {
  const approvalConfig = input.config.live_manual_approval;
  const violations = collectLiveManualApprovalRuntimeViolations(input);

  if (violations.length > 0) {
    return {
      ready: false,
      config: approvalConfig,
      violations,
      message: "M21 수동 승인 live pilot guard가 충족되지 않아 proposal 생성과 승인 주문 제출을 시작하지 않습니다.",
      action: "추적 정보의 guard 위반 항목을 해결한 뒤 다시 시작합니다.",
      observedAt: input.observedAt,
    };
  }

  return {
    ready: true,
    config: approvalConfig,
    message: "M21 수동 승인 live pilot guard가 충족됐습니다. 승인된 proposal만 제출 직전 재검증으로 넘어갈 수 있습니다.",
    action: "실행 전 proposal fingerprint, 예산, market allowlist, risk decision, reconcile freshness를 다시 확인합니다.",
    observedAt: input.observedAt,
  };
}

/**
 * M21 수동 승인 runtime guard를 통과하지 못하면 예외로 중단한다.
 *
 * proposal 생성기나 Telegram approval runtime은 이 함수가 반환한 config만 사용해야 하며, 예외가 발생하면 broker/client factory를
 * 만들지 않는 것이 invariant다.
 */
export function assertLiveManualApprovalRuntimeReady(
  input: LiveManualApprovalRuntimeGuardInput,
): LiveManualApprovalRuntimeConfig {
  const result = evaluateLiveManualApprovalRuntimeGuard(input);
  if (!result.ready) {
    throw new UnsafeLiveManualApprovalRuntimeConfigError(result.violations);
  }

  return result.config;
}

function collectLiveManualApprovalRuntimeViolations(input: LiveManualApprovalRuntimeGuardInput): string[] {
  const approvalConfig = input.config.live_manual_approval;
  const violations: string[] = [];

  if (!approvalConfig.enabled) {
    violations.push("M21 수동 승인 live pilot 설정이 비활성입니다");
    return violations;
  }

  if (!input.telegramInboundReady) {
    // approval command는 token과 owner allowlist까지 해결된 M20 inbound 경계를 재사용해야 하므로 단순 enabled flag만 믿지 않는다.
    violations.push("M21 수동 승인 live pilot에는 M20 Telegram inbound 활성화가 필요합니다");
  }

  if (!input.reconcileFresh) {
    // stale reconcile 상태에서 승인 TTL만 믿고 제출하면 잔고/미체결 불일치를 주문으로 확대할 수 있어 시작 전에 차단한다.
    violations.push("M21 수동 승인 live pilot에는 최신 reconcile 상태가 필요합니다");
  }

  return violations;
}
