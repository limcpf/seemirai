import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type {
  AlertCooldownRecordInput,
  AlertCooldownReservationInput,
  AlertCooldownReservationResult,
  AlertCooldownState,
  AlertCooldownStore,
  AlertNotification,
  DailyReportNotification,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";
import { createRiskGateRuntimeDecisionPlan } from "../../src/application/index.js";
import type { RiskGateDecisionEvidenceAppendInput } from "../../src/application/index.js";
import {
  appendAuditEvent,
  appendOrderStateTransitionEvent,
  PostgresAlertCooldownRepository,
  PostgresAuditLogRepository,
  PostgresRiskGateRuntimeEventStore,
  applyPostgresKillSwitchControl,
  appendRiskEvent,
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  listOrderEventsByOrderId,
  loadLocalDatabaseConfig,
} from "../../src/infrastructure/db/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
  transitionOrderState,
} from "../../src/domain/index.js";
import type {
  InfrastructureRiskSnapshot,
  OrderIntent,
  RiskGateContext,
} from "../../src/domain/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;
const occurredAt = "2026-05-19T01:30:00.000Z";

describeDb("state transition persistence integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await db.deleteFrom("alert_cooldowns").execute();
    await db.deleteFrom("order_events").execute();
    await db.deleteFrom("audit_events").execute();
    await db.deleteFrom("risk_events").execute();
    await db.deleteFrom("jobs").execute();
    await db.deleteFrom("orders").execute();
    await db
      .updateTable("kill_switch_state")
      .set({
        state: "NORMAL",
        reason_code: "test_reset",
        correlation_id: null,
        payload_json: {},
        updated_at: occurredAt,
      })
      .where("scope", "=", "global")
      .execute();
  });

  afterAll(async () => {
    if (database !== undefined) {
      await destroyDatabase(database);
      database = undefined;
      pool = undefined;
      return;
    }

    await pool?.end();
    pool = undefined;
  });

  it("appends order, audit, and risk events for state transition evidence", async () => {
    const db = await getDatabase();
    const order = await insertOrder(db);
    const decision = transitionOrderState({
      fromState: "VALIDATED",
      toState: "RISK_REJECTED",
      occurredAt,
      reasonCode: "risk_limit_daily_loss_exceeded",
      metadata: {
        threshold_snapshot_id: "threshold-1",
      },
    });

    const orderEvent = await appendOrderStateTransitionEvent(db, {
      orderId: order.id,
      correlationId: "candidate-1",
      event: decision.event,
    });
    await appendAuditEvent(db, {
      eventType: "STATE_TRANSITION",
      severity: "WARN",
      occurredAt,
      actor: "risk-gate",
      reasonCode: "risk_limit_daily_loss_exceeded",
      orderId: order.id,
      correlationId: "candidate-1",
      metadata: {
        order_event_id: orderEvent.id,
      },
    });
    await appendRiskEvent(db, {
      riskType: "daily_loss_limit_exceeded",
      severity: "CRITICAL",
      action: "BLOCK_NEW_ORDER",
      orderId: order.id,
      occurredAt,
      payloadJson: {
        order_event_id: orderEvent.id,
      },
    });

    const events = await listOrderEventsByOrderId(db, { orderId: order.id });
    const currentOrder = await db
      .selectFrom("orders")
      .select(["status", "updated_at"])
      .where("id", "=", order.id)
      .executeTakeFirstOrThrow();
    const auditCount = await db
      .selectFrom("audit_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const riskCount = await db
      .selectFrom("risk_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: orderEvent.id,
      order_id: order.id,
      from_status: "VALIDATED",
      to_status: "RISK_REJECTED",
      accepted: true,
      reason_code: "risk_limit_daily_loss_exceeded",
      correlation_id: "candidate-1",
    });
    expect(currentOrder.status).toBe("RISK_REJECTED");
    expect(new Date(currentOrder.updated_at).toISOString()).toBe(occurredAt);
    expect(Number(auditCount.count)).toBe(1);
    expect(Number(riskCount.count)).toBe(1);
  });

  it("keeps the current order snapshot unchanged for rejected transition attempts", async () => {
    const db = await getDatabase();
    const order = await insertOrder(db);
    const decision = transitionOrderState({
      fromState: "VALIDATED",
      toState: "FILLED",
      occurredAt,
      reasonCode: "risk_gate_invalid_target",
    });

    const orderEvent = await appendOrderStateTransitionEvent(db, {
      orderId: order.id,
      correlationId: "candidate-1",
      event: decision.event,
    });
    const currentOrder = await db
      .selectFrom("orders")
      .select(["status", "updated_at"])
      .where("id", "=", order.id)
      .executeTakeFirstOrThrow();

    expect(orderEvent).toMatchObject({
      accepted: false,
      from_status: "VALIDATED",
      to_status: "FILLED",
      reason_code: "risk_gate_invalid_target",
    });
    expect(currentOrder.status).toBe("VALIDATED");
    expect(new Date(currentOrder.updated_at).toISOString()).not.toBe(occurredAt);
  });

  it("rejects accepted stale transitions when the current order status already moved", async () => {
    const db = await getDatabase();
    const order = await insertOrder(db);
    const approvedDecision = transitionOrderState({
      fromState: "VALIDATED",
      toState: "RISK_APPROVED",
      occurredAt,
      reasonCode: "risk_gate_order_approved",
    });
    const staleRejectedDecision = transitionOrderState({
      fromState: "VALIDATED",
      toState: "RISK_REJECTED",
      occurredAt: "2026-05-19T01:31:00.000Z",
      reasonCode: "risk_gate_order_rejected",
    });

    await appendOrderStateTransitionEvent(db, {
      orderId: order.id,
      correlationId: "candidate-1",
      event: approvedDecision.event,
    });

    await expect(
      appendOrderStateTransitionEvent(db, {
        orderId: order.id,
        correlationId: "candidate-1",
        event: staleRejectedDecision.event,
      }),
    ).rejects.toThrow("accepted order state transition target order not found or current status mismatch");

    const events = await listOrderEventsByOrderId(db, { orderId: order.id });
    const currentOrder = await db
      .selectFrom("orders")
      .select(["status", "updated_at"])
      .where("id", "=", order.id)
      .executeTakeFirstOrThrow();

    expect(events).toHaveLength(1);
    expect(currentOrder.status).toBe("RISK_APPROVED");
    expect(new Date(currentOrder.updated_at).toISOString()).toBe(occurredAt);
  });

  it("appends RiskGate decision evidence through the Postgres combined event store", async () => {
    const db = await getDatabase();
    const order = await insertOrder(db);
    const orderIntent = createRuntimeOrderIntent();
    const plan = createRiskGateRuntimeDecisionPlan({
      orderId: order.id,
      orderStatus: "VALIDATED",
      orderIntent,
      currentKillSwitchState: "NORMAL",
      riskGateContext: createRuntimeRiskContext({
        orderIntent,
        infrastructureSignals: [createInfrastructureSignal("DB_WRITE_FAILURE")],
      }),
      actor: "risk-gate",
      correlationId: "candidate-1",
    });
    const store = new PostgresRiskGateRuntimeEventStore(db);

    const appendInput: RiskGateDecisionEvidenceAppendInput = {
      orderStateTransition: {
        orderId: order.id,
        correlationId: "candidate-1",
        event: plan.orderStateTransition.event,
      },
      riskEvents: plan.riskEvents,
      auditEvents: plan.auditEvents,
    };
    if (plan.killSwitchStateTransition !== undefined) {
      appendInput.killSwitchStateTransition = {
        correlationId: "candidate-1",
        event: plan.killSwitchStateTransition.event,
      };
    }

    const receipt = await store.appendDecisionEvidence(appendInput);

    const currentOrder = await db
      .selectFrom("orders")
      .select("status")
      .where("id", "=", order.id)
      .executeTakeFirstOrThrow();
    const riskCount = await db
      .selectFrom("risk_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const auditCount = await db
      .selectFrom("audit_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const killSwitchState = await db
      .selectFrom("kill_switch_state")
      .select(["state", "reason_code"])
      .where("scope", "=", "global")
      .executeTakeFirstOrThrow();

    expect(currentOrder.status).toBe("RISK_REJECTED");
    expect(killSwitchState).toMatchObject({
      state: "HARD_STOP",
      reason_code: "risk_gate_hard_stop",
    });
    expect(receipt.killSwitchEventReceipt).toBeDefined();
    expect(Number(riskCount.count)).toBeGreaterThan(0);
    expect(Number(auditCount.count)).toBe(plan.auditEvents.length);
  });

  it("persists HTTP kill switch control evidence and hard stop cancel job in one transaction", async () => {
    const db = await getDatabase();

    const result = await applyPostgresKillSwitchControl({
      database: db,
      request: {
        targetState: "HARD_STOP",
        reasonCode: "db_write_failure",
        correlationId: "http-kill-switch-1",
        occurredAt,
      },
    });

    const killSwitchState = await db
      .selectFrom("kill_switch_state")
      .select(["state", "reason_code", "correlation_id"])
      .where("scope", "=", "global")
      .executeTakeFirstOrThrow();
    const auditCount = await db
      .selectFrom("audit_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .where("correlation_id", "=", "http-kill-switch-1")
      .executeTakeFirstOrThrow();
    const riskCount = await db
      .selectFrom("risk_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .where("risk_type", "=", "db_write_failure")
      .executeTakeFirstOrThrow();
    const hardStopJob = await db
      .selectFrom("jobs")
      .select(["job_type", "idempotency_key", "payload_json"])
      .where(
        "idempotency_key",
        "=",
        "hard_stop_pending_paper_order_cancel:NORMAL:HARD_STOP:2026-05-19T01:30:00.000Z:http-kill-switch-1",
      )
      .executeTakeFirstOrThrow();

    expect(result.transition.accepted).toBe(true);
    expect(result.hardStopCancelJob).toMatchObject({
      created: true,
      idempotencyKey:
        "hard_stop_pending_paper_order_cancel:NORMAL:HARD_STOP:2026-05-19T01:30:00.000Z:http-kill-switch-1",
    });
    expect(killSwitchState).toEqual({
      state: "HARD_STOP",
      reason_code: "db_write_failure",
      correlation_id: "http-kill-switch-1",
    });
    expect(Number(auditCount.count)).toBe(1);
    expect(Number(riskCount.count)).toBe(1);
    expect(hardStopJob).toMatchObject({
      job_type: "hard_stop_pending_paper_order_cancel",
      idempotency_key:
        "hard_stop_pending_paper_order_cancel:NORMAL:HARD_STOP:2026-05-19T01:30:00.000Z:http-kill-switch-1",
    });
    expect(hardStopJob.payload_json).toMatchObject({
      action_plan: {
        cancel_pending_paper_orders: true,
        auto_liquidate_open_positions: false,
      },
    });
  });

  it("dispatches Telegram alert through configured kill switch control runtime path", async () => {
    const db = await getDatabase();
    const notifier = new RecordingNotifier();

    const result = await applyPostgresKillSwitchControl({
      database: db,
      request: {
        targetState: "HARD_STOP",
        reasonCode: "db_write_failure",
        correlationId: "http-kill-switch-alert",
        occurredAt,
      },
      alertDispatch: {
        environment: "test",
        runMode: "paper_trading",
        notifier,
        durableCooldownStore: new PostgresAlertCooldownRepository(db),
        auditLog: new PostgresAuditLogRepository(db),
        clock: () => new Date(occurredAt),
      },
    });

    const cooldown = await db
      .selectFrom("alert_cooldowns")
      .select(["fingerprint", "last_sent_at", "delivery_reserved_until"])
      .where("reason_code", "=", "db_write_failure")
      .executeTakeFirstOrThrow();
    const notificationAudit = await db
      .selectFrom("audit_events")
      .select(["event_type", "severity", "correlation_id"])
      .where("correlation_id", "=", "http-kill-switch-alert")
      .where("event_type", "=", "NOTIFICATION_DELIVERY")
      .executeTakeFirstOrThrow();

    expect(result.alertDispatch).toMatchObject({
      notification: {
        delivered: true,
      },
    });
    expect(notifier.alerts[0]).toMatchObject({
      severity: "P0",
      title: "Kill switch HARD_STOP",
      fingerprint: "alert:test:paper_trading:P0:kill_switch_control:global:global:db_write_failure",
      metadata: {
        source: "kill_switch_control",
      },
    });
    expect(cooldown).toMatchObject({
      fingerprint: "alert:test:paper_trading:P0:kill_switch_control:global:global:db_write_failure",
      delivery_reserved_until: null,
    });
    expect(cooldown.last_sent_at).toEqual(new Date(occurredAt));
    expect(notificationAudit).toMatchObject({
      event_type: "NOTIFICATION_DELIVERY",
      severity: "INFO",
      correlation_id: "http-kill-switch-alert",
    });
  });

  it("keeps committed kill switch transition successful when post-commit alert dispatch fails", async () => {
    const db = await getDatabase();

    const result = await applyPostgresKillSwitchControl({
      database: db,
      request: {
        targetState: "HARD_STOP",
        reasonCode: "db_write_failure",
        correlationId: "http-kill-switch-alert-failure",
        occurredAt,
      },
      alertDispatch: {
        environment: "test",
        runMode: "paper_trading",
        notifier: new RecordingNotifier(),
        durableCooldownStore: new FailingAlertCooldownStore(),
      },
    });

    const killSwitchState = await db
      .selectFrom("kill_switch_state")
      .select(["state", "reason_code", "correlation_id"])
      .where("scope", "=", "global")
      .executeTakeFirstOrThrow();

    expect(result.transition.accepted).toBe(true);
    expect(result.alertDispatchFailure).toEqual({
      reasonCode: "alert_dispatch_failed",
    });
    expect(killSwitchState).toEqual({
      state: "HARD_STOP",
      reason_code: "db_write_failure",
      correlation_id: "http-kill-switch-alert-failure",
    });
  });

  async function getDatabase(): Promise<Database> {
    if (database !== undefined) {
      return database;
    }

    const config = await loadLocalDatabaseConfig();
    pool = createPostgresPool(config);
    await applyMigrations(pool);
    database = createDatabase(pool);
    return database;
  }
});

class RecordingNotifier implements NotifierPort {
  public readonly alerts: AlertNotification[] = [];

  public async sendAlert(notification: AlertNotification): Promise<NotificationResult> {
    this.alerts.push(notification);
    return {
      delivered: true,
      providerMessageId: "telegram-integration-1",
    };
  }

  public async sendDailyReport(_notification: DailyReportNotification): Promise<NotificationResult> {
    return {
      delivered: true,
      providerMessageId: "telegram-daily-integration-1",
    };
  }
}

class FailingAlertCooldownStore implements AlertCooldownStore {
  public async findByFingerprint(_fingerprint: string): Promise<AlertCooldownState | undefined> {
    return undefined;
  }

  public async reserveDelivery(
    _input: AlertCooldownReservationInput,
  ): Promise<AlertCooldownReservationResult> {
    throw new Error("cooldown unavailable");
  }

  public async releaseDeliveryReservation(
    input: AlertCooldownRecordInput,
  ): Promise<AlertCooldownState> {
    return toEmptyCooldownState(input);
  }

  public async recordSent(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return toEmptyCooldownState(input);
  }

  public async recordSkipped(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return toEmptyCooldownState(input);
  }
}

function toEmptyCooldownState(input: AlertCooldownRecordInput): AlertCooldownState {
  return {
    fingerprint: input.fingerprint,
    severity: input.severity,
    alertType: input.alertType,
    market: input.market,
    strategyId: input.strategyId,
    reasonCode: input.reasonCode,
    lastSentAt: null,
    lastSkippedAt: null,
    deliveryReservedUntil: null,
    payloadJson: input.payloadJson ?? {},
  };
}

async function insertOrder(database: Database): Promise<{ id: string }> {
  return database
    .insertInto("orders")
    .values({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: "trend_following",
      side: "BUY",
      order_type: "LIMIT",
      status: "VALIDATED",
      idempotency_key: "candidate-1",
      requested_price: "10000000",
      requested_quantity: "0.001",
      requested_notional: "10000",
      reason_json: {
        source: "integration-test",
      },
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

function createRuntimeOrderIntent(
  overrides: Partial<Extract<OrderIntent, { orderType: "LIMIT" }>> = {},
): Extract<OrderIntent, { orderType: "LIMIT" }> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity: "0.001",
    requestedNotional: "10000",
    idempotencyKey: "candidate-1",
    reason: "integration-test",
    metadata: {
      expected_loss_bps_of_equity: "10",
    },
    ...overrides,
  };
}

function createRuntimeRiskContext(
  overrides: {
    orderIntent?: OrderIntent;
    infrastructureSignals?: readonly InfrastructureRiskSnapshot[];
  } = {},
): RiskGateContext {
  const thresholdSnapshot = createRiskThresholdSnapshot(defaultRiskLimitThresholds, occurredAt);

  return {
    orderIntent: overrides.orderIntent ?? createRuntimeOrderIntent(),
    account: {
      equityKrw: "1000000",
      dailyRealizedPnlBps: "-10",
      weeklyRealizedPnlBps: "-20",
      maxDrawdownBps: "100",
      capturedAt: occurredAt,
    },
    positions: [],
    strategy: {
      strategyId: "trend_following",
      consecutiveLosses: 0,
      capturedAt: occurredAt,
    },
    infrastructureSignals: overrides.infrastructureSignals ?? [],
    thresholdSnapshot,
    observedAt: occurredAt,
  };
}

function createInfrastructureSignal(
  signal: InfrastructureRiskSnapshot["signal"],
): InfrastructureRiskSnapshot {
  return {
    signal,
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    observedAt: occurredAt,
  };
}
