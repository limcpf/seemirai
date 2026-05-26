import { parseMarketEventTimestampNanos } from "../../../domain/index.js";
import type { ExchangeId, MarketCode, OrderbookEvent, TimestampInput } from "../../../domain/index.js";
import type { PaperBrokerFillOptions } from "./types.js";

/**
 * 생성자나 테스트에서 주입한 단일/배열 orderbook 입력을 배열 window로 정규화한다.
 *
 * undefined는 빈 window로 처리해 fill simulator가 데이터 부재를 기존 방식대로 no-fill 결과로 판단하게 둔다.
 */
export function normalizeOrderbookSnapshots(
  snapshots: OrderbookEvent | readonly OrderbookEvent[] | undefined,
): readonly OrderbookEvent[] {
  if (snapshots === undefined) {
    return [];
  }

  if (isOrderbookSnapshotArray(snapshots)) {
    return snapshots;
  }

  return [snapshots];
}

/**
 * latency 옵션이 post-submit snapshot을 기다려야 하는지 판단한다.
 *
 * latency가 0이면 즉시 체결 snapshot 하나만 넘기고, 양수이면 fill simulator가 제출 이후 window를 선택하게 한다.
 */
export function shouldWaitForPostSubmitSnapshot(options: PaperBrokerFillOptions): boolean {
  return (options.latencyMs ?? 0) > 0;
}

/**
 * latency 없는 주문에 사용할 즉시 체결 호가를 선택한다.
 *
 * 제출 이전 최신 snapshot을 우선하고, 없으면 가장 이른 제출 이후 snapshot을 사용해 deterministic replay가 빈 호가로만
 * 떨어지지 않게 한다.
 */
export function selectImmediateExecutionOrderbook(
  orderbooks: readonly OrderbookEvent[],
  submittedAt: TimestampInput,
): OrderbookEvent | undefined {
  const submittedAtNanos = readTimestampNanos(submittedAt);
  let latestPreSubmitSnapshot: OrderbookEvent | undefined;
  let earliestPostSubmitSnapshot: OrderbookEvent | undefined;

  for (const orderbook of orderbooks) {
    const receivedAtNanos = readTimestampNanos(orderbook.receivedAt);
    if (receivedAtNanos <= submittedAtNanos) {
      // latency가 없는 paper submit은 주문 직전에 관측한 최신 snapshot을 즉시 체결 근거로 사용할 수 있어야 한다.
      latestPreSubmitSnapshot = orderbook;
      continue;
    }

    earliestPostSubmitSnapshot ??= orderbook;
  }

  return latestPreSubmitSnapshot ?? earliestPostSubmitSnapshot;
}

/**
 * PaperBroker가 market별 orderbook window를 저장할 때 사용하는 key다.
 *
 * exchange와 market을 함께 묶어 다른 exchange의 동명 market snapshot이 섞이지 않게 한다.
 */
export function createOrderbookKey(exchangeId: ExchangeId, market: MarketCode): string {
  return `${exchangeId}:${market}`;
}

function isOrderbookSnapshotArray(
  snapshots: OrderbookEvent | readonly OrderbookEvent[],
): snapshots is readonly OrderbookEvent[] {
  return Array.isArray(snapshots);
}

function readTimestampNanos(value: TimestampInput): bigint {
  return parseMarketEventTimestampNanos(value);
}

export function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export { readTimestampNanos };
