import type {
  JsonRecord,
  MarketCode,
  OrderLifecycleStatus,
  TimestampInput,
} from "../../domain/index.js";
import type { ExitPaperRuntimeInput, ExitPaperRuntimeResult } from "../exit-engine/index.js";

/**
 * M22 live autonomous exit 표면의 운영 health code다.
 *
 * HTTP status code와 분리된 업무 상태이며, `warning`과 `unavailable`은 신규 entry를 보수적으로 멈추거나 수동 점검으로
 * 수렴해야 하는 신호다. 이 타입은 표현 contract일 뿐 DB 조회, broker 호출, notification side effect를 만들지 않는다.
 */
export type LiveAutonomousExitOperationalStatus = "ok" | "warning" | "unavailable";

/**
 * M22 live autonomous exit summary의 안정 상태 code다.
 *
 * 사용자-facing 화면은 한국어 `statusLabel/message/action`을 먼저 보여주고, 이 code는 trace/debug와 테스트 재현에 사용한다.
 */
export type LiveAutonomousExitStatusCode =
  | "DISABLED"
  | "BLOCKED"
  | "READY"
  | "NO_EXIT_INTENT"
  | "EXIT_SUBMITTED"
  | "REQUOTE_INTENT_CREATED"
  | "RECONCILE_REQUIRED"
  | "MANUAL_REVIEW_REQUIRED";

/**
 * M22 exit summary가 reconcile worker에서 읽는 최소 snapshot이다.
 *
 * application layer가 runtime 구현을 역참조하지 않도록 `/status.reconcile`의 safe 값만 복사한다. mismatch detail, raw order,
 * credential, provider payload는 이 경계에 들어오면 안 된다.
 */
export interface LiveAutonomousExitReconcileSnapshot {
  result: "SKIPPED" | "SUCCESS" | "MISMATCH_DETECTED" | "FAILED" | "UNAVAILABLE";
  mismatchCount: number | null;
  openOrderCount: number | null;
  balanceStatus: "OK" | "STALE" | "UNAVAILABLE";
  websocketStatus: "CONNECTED" | "DISCONNECTED" | "RECONNECTING" | "DEGRADED";
  lastReconcileAt: string | null;
}

/**
 * M22 live autonomous exit summary 생성 입력이다.
 *
 * caller는 startup guard 결과, 최신 reconcile safe summary, 선택적인 직전 exit runtime 결과를 넘긴다. 이 함수군은 이미 발생한
 * exit 결과를 운영자 문구로 낮추기만 하며 broker submit/cancel/requote나 DB write side effect를 수행하지 않는다.
 */
export interface CreateLiveAutonomousExitStatusSummaryInput {
  enabled: boolean;
  runtimeReady: boolean;
  exitEngineReady: boolean;
  observedAt: TimestampInput;
  reconcile: LiveAutonomousExitReconcileSnapshot;
  lastExitResult?: ExitPaperRuntimeResult | null;
}

/**
 * M22 live autonomous exit runner에 전달할 M19 exit runtime 입력이다.
 *
 * 실제 `ports`는 runtime factory가 주입한 runner 내부에 고정되어야 하므로, autonomous orchestration 경계는 판단/sizing/scope 같은
 * 업무 입력만 넘긴다. 이 타입은 실행 요청 contract이며 자체 side effect를 만들지 않는다.
 */
export type LiveAutonomousExitRunnerInput = Omit<ExitPaperRuntimeInput, "ports">;

/**
 * M22 live autonomous exit orchestration port다.
 *
 * 구현체는 M19 exit runtime 또는 후속 live-safe adapter일 수 있다. 이 port가 호출되는 순간 broker submit/cancel side effect가
 * 발생할 수 있으므로 caller는 reconcile, guard, exit readiness를 먼저 통과시켜야 한다.
 */
export interface LiveAutonomousExitRuntimePorts {
  runExit(input: LiveAutonomousExitRunnerInput): Promise<ExitPaperRuntimeResult>;
}

/**
 * M22 live autonomous exit runtime 실행 요청이다.
 *
 * startup guard와 reconcile summary가 안전하지 않으면 runner를 호출하지 않고 summary만 반환한다. `exitInput`은 runner 호출이
 * 허용된 경우에만 사용되며, 이 타입 자체는 저장소나 broker side effect를 만들지 않는다.
 */
export interface LiveAutonomousExitRuntimeRequest extends Omit<CreateLiveAutonomousExitStatusSummaryInput, "lastExitResult"> {
  exitInput: LiveAutonomousExitRunnerInput;
}

/**
 * M22 live autonomous exit runtime의 실행 상태다.
 *
 * `SKIPPED`는 guard/reconcile 때문에 runner를 호출하지 않았다는 뜻이고, `EXECUTED`는 주입된 M19 exit runner가 실제로 호출된
 * 상태다. 사용자-facing 상태는 `summary`에 한국어로 보존한다.
 */
export type LiveAutonomousExitRuntimeStatus = "SKIPPED" | "EXECUTED";

/**
 * M22 live autonomous exit runtime 실행 결과다.
 *
 * runner 호출 여부와 safe summary를 함께 반환해 HTTP/Telegram/report가 동일한 판단을 재사용하게 한다. `exitResult`는 runner가
 * 실행된 경우에만 포함하며, raw broker detail은 summary가 아니라 내부 호출자만 다뤄야 한다.
 */
export interface LiveAutonomousExitRuntimeResult {
  status: LiveAutonomousExitRuntimeStatus;
  summary: LiveAutonomousExitStatusSummary;
  exitResult?: ExitPaperRuntimeResult;
}

/**
 * Telegram, HTTP status, daily report가 공유하는 M22 live autonomous exit safe summary다.
 *
 * 내부 주문 식별자와 reason code는 `trace`에 분리하고, 첫 화면에는 상태·원인·영향·필요 조치를 한국어로 제공한다. raw broker
 * order detail, provider response, credential은 포함하지 않는 것이 invariant다.
 */
export interface LiveAutonomousExitStatusSummary {
  enabled: boolean;
  runtimeReady: boolean;
  exitEngineReady: boolean;
  status: LiveAutonomousExitOperationalStatus;
  statusCode: LiveAutonomousExitStatusCode;
  statusLabel: string;
  message: string;
  impact: string | null;
  action: string | null;
  market: MarketCode | null;
  strategyId: string | null;
  latestBrokerOrderStatus: OrderLifecycleStatus | null;
  filledQuantity: string | null;
  remainingQuantity: string | null;
  reconcile: LiveAutonomousExitReconcileSnapshot;
  trace: JsonRecord;
}
