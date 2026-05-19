import { describe, expect, it } from "vitest";
import type { PaperFillSimulationResult } from "../../src/application/index.js";
import type {
  BrokerOrder,
  LimitOrderIntent,
  OrderSubmission,
} from "../../src/domain/index.js";
import {
  createPaperExecutionStateTransitionEvents,
  toExecutionOrderRowInput,
  toFillRowInputs,
  toPaperOrderRowInput,
} from "../../src/infrastructure/index.js";
import type { PersistPaperExecutionInput } from "../../src/infrastructure/index.js";

const submittedAt = "2026-05-19T02:00:00.000Z";
const updatedAt = "2026-05-19T02:00:02.000Z";
const orderbookReceivedAt = "2026-05-19T02:00:01.000Z";

describe("execution persistence mappers", () => {
  it("maps approved order submissions to canonical orders rows", () => {
    const row = toExecutionOrderRowInput(createPersistInput());

    expect(row).toMatchObject({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: "trend_following",
      side: "BUY",
      order_type: "LIMIT",
      status: "RISK_APPROVED",
      idempotency_key: "execution-candidate-1",
      requested_price: "10000000",
      requested_quantity: "0.002",
      requested_notional: "20000",
      created_at: submittedAt,
      updated_at: submittedAt,
      reason_json: {
        reason: "unit-test-order",
        broker_order_id: "paper-order-1",
        broker_status: "PARTIALLY_FILLED",
        expected_loss_bps_of_equity: "12",
      },
    });
  });

  it("stores post-only as a paper flag without violating the DB time_in_force check", () => {
    const row = toPaperOrderRowInput("00000000-0000-4000-8000-000000000001", createPersistInput());

    expect(row).toMatchObject({
      order_id: "00000000-0000-4000-8000-000000000001",
      post_only: true,
      time_in_force: null,
      simulated_latency_ms: 250,
      submitted_at: submittedAt,
      accepted_at: updatedAt,
      completed_at: null,
      fill_model_json: {
        source: "paper_broker",
        broker_order_id: "paper-order-1",
        broker_status: "PARTIALLY_FILLED",
        simulated_latency_ms: 250,
      },
    });
  });

  it("maps paper simulation fills to fill rows using quote currency fees", () => {
    const rows = toFillRowInputs("00000000-0000-4000-8000-000000000001", createPersistInput());

    expect(rows).toEqual([
      {
        order_id: "00000000-0000-4000-8000-000000000001",
        exchange: "upbit_krw_spot",
        market: "KRW-BTC",
        side: "BUY",
        price: "9990000",
        quantity: "0.001",
        fee: "4.995",
        fee_currency: "KRW",
        liquidity: "TAKER",
        filled_at: orderbookReceivedAt,
      },
    ]);
  });

  it("expands broker final status into legal order state transition events", () => {
    const events = createPaperExecutionStateTransitionEvents(createPersistInput());

    expect(events.map((event) => `${event.fromState}->${event.toState}`)).toEqual([
      "RISK_APPROVED->SUBMITTED",
      "SUBMITTED->ACCEPTED",
      "ACCEPTED->PARTIALLY_FILLED",
    ]);
    expect(events.every((event) => event.accepted)).toBe(true);
    expect(events.map((event) => event.reasonCode)).toEqual([
      "paper_execution_risk_approved_to_submitted",
      "paper_execution_submitted_to_accepted",
      "paper_execution_accepted_to_partially_filled",
    ]);
  });

  it("preserves partial-fill evidence before a filled-and-canceled order closes", () => {
    const events = createPaperExecutionStateTransitionEvents(createFilledAndCanceledPersistInput());

    expect(events.map((event) => `${event.fromState}->${event.toState}`)).toEqual([
      "RISK_APPROVED->SUBMITTED",
      "SUBMITTED->ACCEPTED",
      "ACCEPTED->PARTIALLY_FILLED",
      "PARTIALLY_FILLED->CANCEL_REQUESTED",
      "CANCEL_REQUESTED->CANCELED",
    ]);
    expect(events.every((event) => event.accepted)).toBe(true);
  });
});

function createPersistInput(): PersistPaperExecutionInput {
  const intent: LimitOrderIntent = {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity: "0.002",
    requestedNotional: "20000",
    idempotencyKey: "execution-candidate-1",
    reason: "unit-test-order",
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      signal_id: "signal-1",
    },
  };
  const submission: OrderSubmission = {
    intent,
    costSnapshot: {
      trade_allowed: true,
      source: "cost-model",
    },
    riskApproval: {
      status: "APPROVED",
      source: "risk-gate",
    },
    expectedLossBpsOfEquity: "12",
    submittedAt,
  };
  const simulation: PaperFillSimulationResult = {
    status: "PARTIALLY_FILLED",
    orderStatus: "PARTIALLY_FILLED",
    reasonCode: "limit_crossed_partial",
    requestedQuantity: "0.002",
    filledQuantity: "0.001",
    openQuantity: "0.001",
    canceledQuantity: "0",
    averageFillPrice: "9990000",
    totalFillNotional: "9990",
    totalFee: "4.995",
    fills: [
      {
        price: "9990000",
        quantity: "0.001",
        notional: "9990",
        fee: "4.995",
        liquidity: "TAKER",
      },
    ],
    orderbookReceivedAt,
  };
  const brokerOrder: BrokerOrder = {
    brokerOrderId: "paper-order-1",
    idempotencyKey: "execution-candidate-1",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    status: "PARTIALLY_FILLED",
    requestedQuantity: "0.002",
    remainingQuantity: "0.001",
    requestedPrice: "10000000",
    acceptedAt: updatedAt,
    updatedAt,
    metadata: {
      paper_fill_simulation: simulation,
      balance_mutation_applied: true,
    },
  };

  return {
    submission,
    brokerOrder,
    correlationId: "candidate-1",
    simulatedLatencyMs: 250,
  };
}

function createFilledAndCanceledPersistInput(): PersistPaperExecutionInput {
  const input = createPersistInput();
  const simulation = input.brokerOrder.metadata?.paper_fill_simulation as PaperFillSimulationResult;
  const canceledSimulation: PaperFillSimulationResult = {
    ...simulation,
    status: "IOC_CANCELED",
    orderStatus: "CANCELED",
    openQuantity: "0",
    canceledQuantity: "0.001",
  };

  return {
    ...input,
    brokerOrder: {
      ...input.brokerOrder,
      status: "CANCELED",
      remainingQuantity: "0",
      metadata: {
        ...(input.brokerOrder.metadata ?? {}),
        paper_fill_simulation: canceledSimulation,
      },
    },
  };
}
