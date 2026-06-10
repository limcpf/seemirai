import type { RuntimeConfig } from "../config.js";
import type { LiveAutonomousRuntimeConfig } from "./schema.js";

/**
 * M22 제한적 완전 자동매매 startup guard 입력이다.
 *
 * config shape와 보수적 예산 상한은 `RuntimeConfigSchema`가 이미 확인했다. caller는 저장소 밖 redacted evidence id와 각 하위
 * runtime의 readiness provider 결과를 넘겨야 하며, 이 입력 자체는 private client 생성, broker 조립, DB write 같은 side effect를
 * 만들지 않는다.
 */
export interface LiveAutonomousRuntimeGuardInput {
  config: RuntimeConfig;
  observedAt: string;
  m21WeekGateEvidenceId?: string;
  operatorArmEvidenceId?: string;
  budgetEvidenceId?: string;
  keyScopeEvidenceId?: string;
  telegramInboundReady: boolean;
  reconcileFresh: boolean;
  pnlStatusReady: boolean;
  decisionLedgerReady: boolean;
  exitEngineReady: boolean;
}

/**
 * M22 제한적 완전 자동매매 startup guard 결과다.
 *
 * `ready=true`일 때만 후속 autonomous runtime이 private client 또는 live broker factory 조립을 고려할 수 있다. `ready=false`는
 * 운영자가 조치할 수 있는 한국어 메시지와 stable violation code를 함께 담으며, 이 결과는 외부 side effect 없이 계산된다.
 */
export type LiveAutonomousRuntimeGuardResult =
  | {
      ready: true;
      config: LiveAutonomousRuntimeConfig;
      message: string;
      action: string;
      observedAt: string;
    }
  | {
      ready: false;
      config: LiveAutonomousRuntimeConfig;
      violations: readonly string[];
      message: string;
      action: string;
      observedAt: string;
    };

/**
 * M22 제한적 완전 자동매매 startup guard 실패 오류다.
 *
 * violations는 private client와 live broker 조립 전에 차단해야 하는 원인만 담는다. 이 오류가 발생한 경우 caller는
 * `UpbitLiveBroker`나 `BrokerPort.submitOrder` 경계를 만들면 안 된다.
 */
export class UnsafeLiveAutonomousRuntimeConfigError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`안전하지 않은 M22 제한적 완전 자동매매 runtime 설정: ${violations.join(", ")}`);
    this.name = "UnsafeLiveAutonomousRuntimeConfigError";
    this.violations = violations;
  }
}

/**
 * M22 제한적 완전 자동매매 runtime을 시작할 수 있는지 평가한다.
 *
 * 기본 비활성 config, 필수 evidence 누락, M20/M16/M17/M18/M19 readiness 누락은 모두 private client와 live broker 조립 전 차단
 * 조건이다. 이 함수는 순수 guard이며 Telegram polling, DB 조회, Upbit private API 호출 같은 side effect를 만들지 않는다.
 */
export function evaluateLiveAutonomousRuntimeGuard(
  input: LiveAutonomousRuntimeGuardInput,
): LiveAutonomousRuntimeGuardResult {
  const liveAutonomousConfig = input.config.live_autonomous;
  const violations = collectLiveAutonomousRuntimeViolations(input);

  if (violations.length > 0) {
    return {
      ready: false,
      config: liveAutonomousConfig,
      violations,
      message:
        "M22 제한적 완전 자동매매 guard가 충족되지 않아 private client, live broker, autonomous loop를 시작하지 않습니다.",
      action: "추적 정보의 guard 위반 항목과 필요한 evidence/readiness를 해결한 뒤 다시 시작합니다.",
      observedAt: input.observedAt,
    };
  }

  return {
    ready: true,
    config: liveAutonomousConfig,
    message: "M22 제한적 완전 자동매매 guard가 충족됐습니다. 주문 후보는 제출 직전 safety gate를 다시 통과해야 합니다.",
    action: "실행 전 risk gate, kill switch, reconcile freshness, budget, market allowlist, order type, price deviation을 다시 확인합니다.",
    observedAt: input.observedAt,
  };
}

/**
 * M22 제한적 완전 자동매매 startup guard를 통과하지 못하면 예외로 중단한다.
 *
 * autonomous runtime factory는 이 함수가 반환한 config만 사용해야 하며, 예외가 발생하면 credential 해석과 broker/client factory
 * 조립을 시도하지 않는 것이 invariant다.
 */
export function assertLiveAutonomousRuntimeReady(
  input: LiveAutonomousRuntimeGuardInput,
): LiveAutonomousRuntimeConfig {
  const result = evaluateLiveAutonomousRuntimeGuard(input);
  if (!result.ready) {
    throw new UnsafeLiveAutonomousRuntimeConfigError(result.violations);
  }

  return result.config;
}

function collectLiveAutonomousRuntimeViolations(input: LiveAutonomousRuntimeGuardInput): string[] {
  const liveAutonomousConfig = input.config.live_autonomous;
  const violations: string[] = [];

  if (!liveAutonomousConfig.enabled) {
    violations.push("M22 제한적 완전 자동매매 설정이 비활성입니다");
    return violations;
  }

  collectEvidenceViolations(input, violations);
  collectReadinessViolations(input, violations);

  return violations;
}

function collectEvidenceViolations(input: LiveAutonomousRuntimeGuardInput, violations: string[]): void {
  if (!hasEvidenceId(input.m21WeekGateEvidenceId)) {
    // M21 운영 안정성 gate가 없으면 승인 없는 자동 주문을 열 수 없으므로 client 조립 전 차단한다.
    violations.push("M22에는 M21 1주 gate evidence가 필요합니다");
  }

  if (!hasEvidenceId(input.operatorArmEvidenceId)) {
    // 운영자가 명시적으로 arm 하지 않은 자동 loop는 설정 실수만으로 live side effect를 만들 수 있어 차단한다.
    violations.push("M22에는 operator arm evidence가 필요합니다");
  }

  if (!hasEvidenceId(input.budgetEvidenceId)) {
    // 소액 예산 증거가 없으면 config 숫자를 운영 승인으로 간주할 수 없어 차단한다.
    violations.push("M22에는 budget evidence가 필요합니다");
  }

  if (!hasEvidenceId(input.keyScopeEvidenceId)) {
    // 주문 권한 key scope가 확인되지 않으면 출금/입출금 권한 오설정을 배제할 수 없어 차단한다.
    violations.push("M22에는 key scope evidence가 필요합니다");
  }
}

function collectReadinessViolations(input: LiveAutonomousRuntimeGuardInput, violations: string[]): void {
  if (!input.telegramInboundReady) {
    // M22 상태 조회와 emergency control은 M20 inbound readiness를 전제로 하므로 startup에서 먼저 확인한다.
    violations.push("M22에는 M20 Telegram inbound readiness가 필요합니다");
  }

  if (!input.reconcileFresh) {
    // stale reconcile 상태에서 자동 주문을 열면 로컬/거래소 불일치를 주문으로 확대할 수 있어 차단한다.
    violations.push("M22에는 최신 reconcile 상태가 필요합니다");
  }

  if (!input.pnlStatusReady) {
    // PnL 상태를 읽지 못하면 손실 한도와 budget 판단을 설명할 수 없어 자동 loop를 열지 않는다.
    violations.push("M22에는 PnL status readiness가 필요합니다");
  }

  if (!input.decisionLedgerReady) {
    // 판단 이유 ledger가 없으면 자동 주문의 사후 설명과 감사 chain이 끊기므로 시작 전에 차단한다.
    violations.push("M22에는 decision ledger readiness가 필요합니다");
  }

  if (!input.exitEngineReady) {
    // 자동 entry만 열리고 exit engine이 준비되지 않으면 포지션 축소 경계가 비대칭이 되어 차단한다.
    violations.push("M22에는 M19 exit engine readiness가 필요합니다");
  }
}

function hasEvidenceId(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
