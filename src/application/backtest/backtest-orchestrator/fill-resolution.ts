import { parseMarketEventTimestampNanos } from "../../../domain/index.js";
import type { OrderbookEvent, TimestampInput } from "../../../domain/index.js";
import { simulatePaperFill } from "../../execution/index.js";
import type { PaperFillSimulatorOptions } from "../../execution/index.js";
import type { PendingBacktestFill } from "./types.js";

/**
 * pending fill 목록을 최신 replay orderbook 기준으로 해소한다.
 *
 * force=false이면 latency 기준 snapshot이 아직 없을 때 대기하고, replay 종료 시 force=true로 마지막 no-fill까지 확정한다.
 */
export function resolvePendingFills(pendingFills: PendingBacktestFill[], force: boolean): void {
  for (let index = pendingFills.length - 1; index >= 0; index -= 1) {
    if (resolvePendingFill(pendingFills[index]!, force)) {
      pendingFills.splice(index, 1);
    }
  }
}

/**
 * 단일 pending fill을 PaperFillSimulator로 해소한다.
 *
 * fill result는 원래 candidate result 객체에 append되며, 아직 latency snapshot이 없으면 false를 반환해 다음 orderbook을 기다린다.
 */
export function resolvePendingFill(pendingFill: PendingBacktestFill, force: boolean): boolean {
  const simulationInput = createPaperFillSimulationInput(pendingFill);
  const fillResult = simulatePaperFill({
    intent: pendingFill.intent,
    orderbooks: simulationInput.orderbooks,
    options: simulationInput.options,
  });

  if (!force && fillResult.reasonCode === "latency_snapshot_missing") {
    // latency 기준 snapshot이 아직 replay되지 않았으면 임의 no-fill로 확정하지 않고 다음 호가를 기다린다.
    return false;
  }

  pendingFill.result.fillResult = fillResult;
  return true;
}

function createPaperFillSimulationInput(pendingFill: PendingBacktestFill): {
  orderbooks: OrderbookEvent | readonly OrderbookEvent[];
  options: PaperFillSimulatorOptions;
} {
  const sortedOrderbooks = sortOrderbooksByReceivedAt(pendingFill.orderbooks);
  if (!usesImmediateExecutionSnapshot(pendingFill.options)) {
    return {
      orderbooks: sortedOrderbooks,
      options: pendingFill.options,
    };
  }

  const selectedOrderbook = selectImmediateExecutionOrderbook(sortedOrderbooks, pendingFill.options.submittedAt);
  return {
    orderbooks: selectedOrderbook ?? [],
    options: omitSubmittedAt(pendingFill.options),
  };
}

function usesImmediateExecutionSnapshot(options: PaperFillSimulatorOptions): options is PaperFillSimulatorOptions & {
  submittedAt: TimestampInput;
} {
  return options.submittedAt !== undefined && Math.max(options.latencyMs ?? 0, 0) === 0;
}

function omitSubmittedAt(options: PaperFillSimulatorOptions): PaperFillSimulatorOptions {
  const { submittedAt: _submittedAt, ...remainingOptions } = options;
  return remainingOptions;
}

function selectImmediateExecutionOrderbook(
  orderbooks: readonly OrderbookEvent[],
  submittedAt: TimestampInput,
): OrderbookEvent | undefined {
  const submittedAtNanos = readTimestampNanos(submittedAt);
  let latestPreSubmitSnapshot: OrderbookEvent | undefined;
  let earliestPostSubmitSnapshot: OrderbookEvent | undefined;

  for (const orderbook of orderbooks) {
    const receivedAtNanos = readTimestampNanos(orderbook.receivedAt);
    if (receivedAtNanos <= submittedAtNanos) {
      // latency가 없으면 runtime PaperBroker처럼 제출 직전에 관측한 최신 snapshot을 즉시 체결 근거로 사용한다.
      latestPreSubmitSnapshot = orderbook;
      continue;
    }

    earliestPostSubmitSnapshot ??= orderbook;
  }

  return latestPreSubmitSnapshot ?? earliestPostSubmitSnapshot;
}

function sortOrderbooksByReceivedAt(orderbooks: readonly OrderbookEvent[]): readonly OrderbookEvent[] {
  return [...orderbooks].sort(compareOrderbooksByReceivedAt);
}

function compareOrderbooksByReceivedAt(left: OrderbookEvent, right: OrderbookEvent): number {
  // receivedAt 동률은 runtime PaperBroker처럼 기존 관측 순서를 보존한다.
  return compareBigInt(readTimestampNanos(left.receivedAt), readTimestampNanos(right.receivedAt));
}

function readTimestampNanos(timestamp: TimestampInput): bigint {
  return parseMarketEventTimestampNanos(timestamp);
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}
