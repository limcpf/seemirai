import { ExecutionEngine, createExecutionSafetyConfig } from "../application/execution/index.js";
import type { ExecutionSafetyConfig, HardStopRuntimeActionPlan } from "../application/index.js";
import type { BrokerPort } from "../application/ports/index.js";
import { PaperBroker } from "../infrastructure/paper/index.js";
import type {
  PaperBrokerBalanceInput,
  PaperBrokerFillOptions,
  PaperBrokerOptions,
} from "../infrastructure/paper/index.js";
import { listPhase15AltApprovalEvidenceSnapshots } from "../infrastructure/db/audit-log.js";
import type { Database } from "../infrastructure/db/database.js";
import { DisabledUpbitLiveBroker } from "../infrastructure/upbit/disabled-live-broker.js";
import type {
  BrokerOrder,
  JsonRecord,
  MarketCode,
  OrderLifecycleStatus,
  OrderbookEvent,
  Phase15AltApprovalEvidenceSnapshot,
  TimestampInput,
} from "../domain/index.js";
import { loadRuntimeConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { resolveRegistryActivationConfig } from "./registry-config.js";
import type { RegistryActivationResolution } from "./registry-config.js";
import { resolveRuntimeUniverse } from "./universe.js";
import type { RuntimeUniverseResolution } from "./universe.js";

export const PAPER_NO_KEY_EXECUTION_WORKER_ID = "paper-no-key-execution-worker";

export interface PaperNoKeyExecutionRuntimeOptions {
  initialBalances?: readonly PaperBrokerBalanceInput[];
  orderbookSnapshots?: OrderbookEvent | readonly OrderbookEvent[];
  fillOptions?: PaperBrokerFillOptions;
  brokerOrderIdPrefix?: string;
  phase15ApprovalEvidence?: readonly Phase15AltApprovalEvidenceSnapshot[];
  clock?: () => TimestampInput;
}

/**
 * audit evidence를 DB에서 읽어 execution runtime을 조립할 때 필요한 입력이다.
 *
 * worker entrypoint는 이 async factory를 사용해 수동 승인 config와 durable approval evidence를 같은 universe 해석에
 * 주입한다. DB 조회 외 side effect는 없고, 실제 주문 side effect는 반환된 `ExecutionEngine` 호출 전까지 발생하지 않는다.
 */
export interface PaperNoKeyExecutionRuntimeAuditEvidenceOptions extends PaperNoKeyExecutionRuntimeOptions {
  database: Database;
}

export interface PaperNoKeyExecutionRuntime {
  config: RuntimeConfig;
  registry: RegistryActivationResolution;
  universe: RuntimeUniverseResolution;
  exchangeId: string;
  markets: readonly MarketCode[];
  broker: PaperBroker;
  disabledLiveBroker: DisabledUpbitLiveBroker;
  executionEngine: ExecutionEngine;
  executionSafetyConfig: ExecutionSafetyConfig;
}

export type PendingPaperOrderCancelExecutionStatus = "CANCELED" | "ALREADY_CLOSED" | "FAILED";

export interface PendingPaperOrderCancelExecutionResult {
  action: "CANCEL_PENDING_PAPER_ORDER";
  brokerOrderId: string;
  idempotencyKey: string;
  market: MarketCode;
  plannedStatus: OrderLifecycleStatus;
  status: PendingPaperOrderCancelExecutionStatus;
  brokerOrder?: BrokerOrder;
  errorMessage?: string;
}

export interface HardStopPendingPaperOrderCancelExecutionSummary {
  state: "HARD_STOP";
  cancelPendingPaperOrders: boolean;
  openPositionLiquidationAttempted: false;
  attemptedCancelCount: number;
  canceledCount: number;
  alreadyClosedCount: number;
  failedCount: number;
  results: readonly PendingPaperOrderCancelExecutionResult[];
}

export interface ExecuteHardStopPendingPaperOrderCancelsInput {
  broker: BrokerPort;
  plan: HardStopRuntimeActionPlan;
}

export class UnsafePaperNoKeyExecutionRuntimeError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`Unsafe PAPER_NO_KEY execution runtime: ${violations.join(", ")}`);
    this.name = "UnsafePaperNoKeyExecutionRuntimeError";
    this.violations = violations;
  }
}

export class UnsafeHardStopCancelPlanError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`Unsafe hard stop cancel plan: ${violations.join(", ")}`);
    this.name = "UnsafeHardStopCancelPlanError";
    this.violations = violations;
  }
}

/**
 * 기본 paper profile을 주문 실행 runtime으로 조립한다.
 *
 * 이 조립기는 `ExecutionEngine -> PaperBroker`만 활성화한다. Upbit live broker는 같은 `BrokerPort` 모양의 disabled
 * stub으로만 노출해 future extension point는 유지하되, MVP `PAPER_NO_KEY` 실행 중 실거래 주문 API가 생성되거나
 * 호출되는 경로를 닫는다.
 */
export function createPaperNoKeyExecutionRuntime(
  input: unknown,
  options: PaperNoKeyExecutionRuntimeOptions = {},
): PaperNoKeyExecutionRuntime {
  const config = assertPaperNoKeyExecutionRuntimeConfig(loadRuntimeConfig(input));
  const registry = resolveRegistryActivationConfig(config.registry);
  const universeOptions: {
    observedAt: TimestampInput;
    evidence?: readonly Phase15AltApprovalEvidenceSnapshot[];
  } = {
    observedAt: options.clock?.() ?? new Date().toISOString(),
  };

  if (options.phase15ApprovalEvidence !== undefined) {
    universeOptions.evidence = options.phase15ApprovalEvidence;
  }

  const universe = resolveRuntimeUniverse(config.universe, universeOptions);
  const exchangeId = registry.exchange.id;
  const paperBrokerOptions: PaperBrokerOptions = {
    exchangeId,
    initialBalances: options.initialBalances ?? [],
    brokerOrderIdPrefix: options.brokerOrderIdPrefix ?? "paper-runtime-order",
  };

  assignIfDefined(paperBrokerOptions, "orderbookSnapshots", options.orderbookSnapshots);
  assignIfDefined(paperBrokerOptions, "fillOptions", options.fillOptions);
  assignIfDefined(paperBrokerOptions, "clock", options.clock);

  const broker = new PaperBroker(paperBrokerOptions);
  const executionSafetyConfig = createPaperNoKeyExecutionSafetyConfig(config);
  const executionEngine = new ExecutionEngine(
    { broker },
    {
      safetyConfig: executionSafetyConfig,
    },
  );
  const disabledLiveBroker = new DisabledUpbitLiveBroker({
    reason: "PAPER_NO_KEY execution runtime uses PaperBroker for all BrokerPort side effects",
  });

  return {
    config,
    registry,
    universe,
    exchangeId,
    markets: universe.allowedMarkets,
    broker,
    disabledLiveBroker,
    executionEngine,
    executionSafetyConfig,
  };
}

/**
 * audit_events에 저장된 phase 1.5 evidence를 주입해 `PAPER_NO_KEY` execution runtime을 조립한다.
 *
 * config에 남은 수동 승인 market만으로 paper execution universe를 열지 않고, 같은 DB에 저장된 APPROVE/REVOKE/EXPIRE
 * evidence를 먼저 재해석해 비용/RiskGate 경계의 market 목록을 고정한다.
 */
export async function createPaperNoKeyExecutionRuntimeWithAuditEvidence(
  input: unknown,
  options: PaperNoKeyExecutionRuntimeAuditEvidenceOptions,
): Promise<PaperNoKeyExecutionRuntime> {
  const phase15ApprovalEvidence =
    options.phase15ApprovalEvidence ?? await listPhase15AltApprovalEvidenceSnapshots(options.database);

  return createPaperNoKeyExecutionRuntime(input, {
    ...options,
    phase15ApprovalEvidence,
  });
}

/**
 * `PAPER_NO_KEY` execution runtime 전용 안전 조건을 검증한다.
 *
 * `assertSafeRuntimeConfig`가 공통 안전 toggle을 먼저 닫고, 이 guard는 주문 실행 조립 경계에서 Upbit API key와 live
 * broker 설정이 섞이지 않았는지 다시 확인한다.
 */
export function assertPaperNoKeyExecutionRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const violations: string[] = [];

  if (config.exchange !== "UPBIT" || config.market !== "KRW_SPOT" || config.mode !== "PAPER_TRADING") {
    violations.push("execution runtime must use UPBIT KRW_SPOT PAPER_TRADING");
  }

  if (config.registry.exchangeId !== "upbit_krw_spot") {
    violations.push("execution runtime must use upbit_krw_spot registry exchange");
  }

  if (!config.paper_no_key) {
    violations.push("execution runtime requires paper_no_key=true");
  }

  if (config.secrets.upbit_access_key !== undefined || config.secrets.upbit_secret_key !== undefined) {
    violations.push("PAPER_NO_KEY execution runtime must not receive Upbit API keys");
  }

  if (config.live_trading_enabled || config.market_order_enabled || config.entry_market_order_enabled) {
    violations.push("execution runtime must keep live trading and market order toggles disabled");
  }

  if (violations.length > 0) {
    throw new UnsafePaperNoKeyExecutionRuntimeError(violations);
  }

  return config;
}

/**
 * runtime config의 실행 toggle을 ExecutionEngine guard 입력으로 변환한다.
 */
export function createPaperNoKeyExecutionSafetyConfig(config: RuntimeConfig): ExecutionSafetyConfig {
  return createExecutionSafetyConfig({
    liveTradingEnabled: config.live_trading_enabled,
    marketOrderEnabled: config.market_order_enabled,
    entryMarketOrderEnabled: config.entry_market_order_enabled,
    paperNoKey: config.paper_no_key,
  });
}

/**
 * hard stop action plan에 포함된 pending paper order 취소를 실제 `BrokerPort.cancelOrder`로 실행한다.
 *
 * RiskGate는 M5에서 취소 계획까지만 만들고, 이 함수가 M6 runtime side effect 경계다. open position 자동 청산은
 * action plan에 있더라도 실행하지 않고 unsafe plan으로 거부해, 장애 상황에서 신규 주문 차단과 미체결 취소만 수행한다.
 */
export async function executeHardStopPendingPaperOrderCancels(
  input: ExecuteHardStopPendingPaperOrderCancelsInput,
): Promise<HardStopPendingPaperOrderCancelExecutionSummary> {
  assertHardStopCancelPlanIsSafe(input.plan);

  const results: PendingPaperOrderCancelExecutionResult[] = [];
  for (const action of input.plan.pendingPaperOrderCancelActions) {
    try {
      // 외부 broker side effect는 계획에 명시된 pending paper order 취소로만 제한한다.
      const brokerOrder = await input.broker.cancelOrder(action.brokerOrderId);
      const status = classifyCancelResultStatus(brokerOrder.status);
      const result: PendingPaperOrderCancelExecutionResult = {
        action: "CANCEL_PENDING_PAPER_ORDER",
        brokerOrderId: action.brokerOrderId,
        idempotencyKey: action.idempotencyKey,
        market: action.market,
        plannedStatus: action.status,
        status,
        brokerOrder,
      };
      if (status === "FAILED") {
        result.errorMessage = `Broker order remains open after hard stop cancel: ${brokerOrder.status}`;
      }
      results.push(result);
    } catch (error) {
      results.push({
        action: "CANCEL_PENDING_PAPER_ORDER",
        brokerOrderId: action.brokerOrderId,
        idempotencyKey: action.idempotencyKey,
        market: action.market,
        plannedStatus: action.status,
        status: "FAILED",
        errorMessage: readErrorMessage(error),
      });
    }
  }

  return createHardStopCancelExecutionSummary(input.plan, results);
}

/**
 * broker에서 현재 open paper order 목록을 읽어 hard stop 계획 입력으로 사용할 수 있게 한다.
 */
export async function listPendingPaperOrdersForHardStop(
  broker: BrokerPort,
): Promise<readonly BrokerOrder[]> {
  const orders = await broker.listOpenOrders();
  return orders.filter((order) => pendingPaperOrderStatusesRequiringCancel.includes(order.status));
}

function assertHardStopCancelPlanIsSafe(plan: HardStopRuntimeActionPlan): void {
  const violations: string[] = [];
  const candidate = plan as unknown;

  if (!isJsonRecord(candidate)) {
    throw new UnsafeHardStopCancelPlanError(["hard stop cancel execution requires plan object"]);
  }

  if (candidate.state !== "HARD_STOP") {
    violations.push("hard stop cancel execution requires state=HARD_STOP");
  }

  // 저장소/재생 경계에서는 타입 정보가 지워지므로, 필드를 읽기 전에 actionPlan 모양을 먼저 검증한다.
  const actionPlan = candidate.actionPlan;
  if (!isJsonRecord(actionPlan)) {
    violations.push("hard stop cancel execution requires actionPlan object");
  } else {
    if (actionPlan.cancelPendingPaperOrders !== true) {
      violations.push("hard stop cancel execution requires cancelPendingPaperOrders=true");
    }

    if (actionPlan.autoLiquidateOpenPositions !== false) {
      violations.push("hard stop cancel execution must not auto-liquidate open positions");
    }
  }

  // cancelOrder 호출 전 replay된 각 action이 실제 pending paper order 취소 계획인지 확인한다.
  const cancelActions = candidate.pendingPaperOrderCancelActions;
  if (!Array.isArray(cancelActions)) {
    violations.push("hard stop cancel execution requires pendingPaperOrderCancelActions array");
  } else {
    for (const [index, action] of cancelActions.entries()) {
      collectPendingPaperOrderCancelActionViolations(violations, index, action);
    }
  }

  if (violations.length > 0) {
    throw new UnsafeHardStopCancelPlanError(violations);
  }
}

function collectPendingPaperOrderCancelActionViolations(
  violations: string[],
  index: number,
  action: unknown,
): void {
  if (!isJsonRecord(action)) {
    violations.push(`hard stop cancel action[${index}] requires action object`);
    return;
  }

  if (action.action !== "PLAN_CANCEL_PENDING_PAPER_ORDER") {
    violations.push(`hard stop cancel action[${index}] requires PLAN_CANCEL_PENDING_PAPER_ORDER action`);
  }

  if (!isNonEmptyString(action.brokerOrderId)) {
    violations.push(`hard stop cancel action[${index}] requires brokerOrderId string`);
  }

  if (!isNonEmptyString(action.idempotencyKey)) {
    violations.push(`hard stop cancel action[${index}] requires idempotencyKey string`);
  }

  if (!isNonEmptyString(action.market)) {
    violations.push(`hard stop cancel action[${index}] requires market string`);
  }

  if (typeof action.status !== "string") {
    violations.push(`hard stop cancel action[${index}] requires status string`);
  } else if (!isPendingPaperOrderStatusRequiringCancel(action.status)) {
    violations.push(`hard stop cancel action[${index}] requires pending order status`);
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPendingPaperOrderStatusRequiringCancel(value: string): value is OrderLifecycleStatus {
  return pendingPaperOrderStatusesRequiringCancel.includes(value as OrderLifecycleStatus);
}

function classifyCancelResultStatus(status: OrderLifecycleStatus): PendingPaperOrderCancelExecutionStatus {
  if (status === "CANCELED") {
    return "CANCELED";
  }

  if (pendingPaperOrderStatusesRequiringCancel.includes(status)) {
    return "FAILED";
  }

  return "ALREADY_CLOSED";
}

function createHardStopCancelExecutionSummary(
  plan: HardStopRuntimeActionPlan,
  results: readonly PendingPaperOrderCancelExecutionResult[],
): HardStopPendingPaperOrderCancelExecutionSummary {
  return {
    state: "HARD_STOP",
    cancelPendingPaperOrders: plan.actionPlan.cancelPendingPaperOrders,
    openPositionLiquidationAttempted: false,
    attemptedCancelCount: results.length,
    canceledCount: results.filter((result) => result.status === "CANCELED").length,
    alreadyClosedCount: results.filter((result) => result.status === "ALREADY_CLOSED").length,
    failedCount: results.filter((result) => result.status === "FAILED").length,
    results,
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assignIfDefined<Target extends JsonRecord | PaperBrokerOptions, Key extends keyof Target>(
  target: Target,
  key: Key,
  value: Target[Key] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

const pendingPaperOrderStatusesRequiringCancel: readonly OrderLifecycleStatus[] = [
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
];
