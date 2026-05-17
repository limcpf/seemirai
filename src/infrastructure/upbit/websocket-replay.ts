import { z } from "zod";
import type {
  ExchangeId,
  MarketCode,
  MarketDataConnectionStatus,
  MarketDataEvent,
  MarketDataStatusEvent,
  OrderbookEvent,
  TimestampInput,
  TradeEvent,
} from "../../domain/index.js";
import {
  createUpbitMarketDataStatusEvent,
  toConnectedStatusEvent,
  toOrderbookEvent,
  toStaleMarketDataStatusEvent,
  toTradeEvent,
  toWebSocketErrorStatusEvent,
} from "./websocket-mapper.js";
import {
  UpbitWebSocketErrorResponseSchema,
  UpbitWebSocketMarketDataPayloadSchema,
  UpbitWebSocketOrderbookSchema,
  UpbitWebSocketStatusSchema,
  UpbitWebSocketTradeSchema,
} from "./schemas.js";

const ReplayStatusSchema = z
  .object({
    kind: z.literal("status"),
    status: z.enum(["CONNECTED", "STALE", "RECONNECTING", "DISCONNECTED"]),
    observed_at: z.union([z.string().min(1), z.date()]),
    market: z.string().min(1).optional(),
    reason_code: z.string().min(1).optional(),
    websocket_lag_ms: z.number().int().nonnegative().optional(),
    reconnect_count: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** Upbit WebSocket fixture replay의 단일 입력이다. */
export type UpbitWebSocketReplayInput =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | readonly unknown[]
  | Record<string, unknown>
  | {
      payload: unknown;
      receivedAt?: TimestampInput;
    };

/** Upbit WebSocket replay 옵션이다. */
export interface ReplayUpbitWebSocketOptions {
  exchangeId?: ExchangeId;
  receivedAt: TimestampInput;
  staleThresholdMs?: number;
}

/**
 * WebSocket transport message를 JSON payload 배열로 디코딩한다.
 *
 * Upbit `sequential_id`는 JS safe integer보다 클 수 있으므로 raw text에서는 해당 필드를 문자열로 보호한
 * 뒤 JSON.parse를 수행한다. 이렇게 해야 체결 id가 후속 저장소 idempotency 기준으로 안정적으로 넘어간다.
 */
export function decodeUpbitWebSocketMessage(message: string | ArrayBuffer | ArrayBufferView): readonly unknown[] {
  const text = messageToString(message);
  const payload: unknown = JSON.parse(protectLargeSequentialIds(text));

  return Array.isArray(payload) ? payload : [payload];
}

/**
 * Upbit WebSocket fixture payload를 deterministic market data event sequence로 재생한다.
 *
 * replay harness는 실제 network loop 없이 schema, mapper, stale/reconnect 상태 처리를 같은 순서로 검증한다.
 * PR3 persistence는 이 sequence를 저장 입력으로 받아 trade/orderbook row와 metric/snapshot을 만들 수 있다.
 */
export async function* replayUpbitWebSocketMessages(
  inputs: Iterable<unknown>,
  options: ReplayUpbitWebSocketOptions,
): AsyncIterable<TradeEvent | OrderbookEvent | MarketDataStatusEvent> {
  for (const input of inputs) {
    const { payloads, receivedAt } = normalizeReplayInput(input, options.receivedAt);

    for (const payload of payloads) {
      const event = toMarketDataEvent(payload, {
        receivedAt,
        ...(options.exchangeId === undefined ? {} : { exchangeId: options.exchangeId }),
      });

      yield event;

      if (event.type !== "STATUS" && options.staleThresholdMs !== undefined) {
        const staleStatus = toStaleMarketDataStatusEvent(event, {
          observedAt: receivedAt,
          staleThresholdMs: options.staleThresholdMs,
        });

        if (staleStatus !== undefined) {
          yield staleStatus;
        }
      }
    }
  }
}

/**
 * Upbit WebSocket payload 하나를 domain market data event로 정규화한다.
 *
 * trade/orderbook/default status/error만 허용하고 SIMPLE 축약 필드나 알 수 없는 payload는 Zod fail-fast로
 * 처리한다. 외부 입력을 조용히 무시하지 않아 fixture와 runtime 간 contract drift를 빨리 발견한다.
 */
export function toMarketDataEvent(
  payload: unknown,
  options: {
    exchangeId?: ExchangeId;
    receivedAt: TimestampInput;
  },
): TradeEvent | OrderbookEvent | MarketDataStatusEvent {
  const replayStatus = ReplayStatusSchema.safeParse(payload);

  if (replayStatus.success) {
    return createUpbitMarketDataStatusEvent({
      ...(replayStatus.data.market === undefined ? {} : { market: replayStatus.data.market as MarketCode }),
      ...(options.exchangeId === undefined ? {} : { exchangeId: options.exchangeId }),
      status: replayStatus.data.status as MarketDataConnectionStatus,
      observedAt: replayStatus.data.observed_at,
      ...(replayStatus.data.reason_code === undefined ? {} : { reasonCode: replayStatus.data.reason_code }),
      ...(replayStatus.data.websocket_lag_ms === undefined
        ? {}
        : { websocketLagMs: replayStatus.data.websocket_lag_ms }),
      ...(replayStatus.data.reconnect_count === undefined
        ? {}
        : { reconnectCount: replayStatus.data.reconnect_count }),
      ...(replayStatus.data.metadata === undefined ? {} : { metadata: replayStatus.data.metadata }),
    });
  }

  const statusPayload = UpbitWebSocketStatusSchema.safeParse(payload);

  if (statusPayload.success) {
    return toConnectedStatusEvent(statusPayload.data, {
      observedAt: options.receivedAt,
      ...(options.exchangeId === undefined ? {} : { exchangeId: options.exchangeId }),
    });
  }

  const errorPayload = UpbitWebSocketErrorResponseSchema.safeParse(payload);

  if (errorPayload.success) {
    return toWebSocketErrorStatusEvent(errorPayload.data, {
      observedAt: options.receivedAt,
      ...(options.exchangeId === undefined ? {} : { exchangeId: options.exchangeId }),
    });
  }

  const marketDataPayload = UpbitWebSocketMarketDataPayloadSchema.parse(payload);

  if (marketDataPayload.type === "trade") {
    return toTradeEvent(UpbitWebSocketTradeSchema.parse(marketDataPayload), options);
  }

  return toOrderbookEvent(UpbitWebSocketOrderbookSchema.parse(marketDataPayload), options);
}

function normalizeReplayInput(
  input: unknown,
  defaultReceivedAt: TimestampInput,
): {
  payloads: readonly unknown[];
  receivedAt: TimestampInput;
} {
  if (typeof input === "string" || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return {
      payloads: decodeUpbitWebSocketMessage(input),
      receivedAt: defaultReceivedAt,
    };
  }

  if (isPayloadEnvelope(input)) {
    return {
      payloads: Array.isArray(input.payload) ? input.payload : [input.payload],
      receivedAt: input.receivedAt ?? defaultReceivedAt,
    };
  }

  return {
    payloads: Array.isArray(input) ? input : [input],
    receivedAt: defaultReceivedAt,
  };
}

function isPayloadEnvelope(input: unknown): input is { payload: unknown; receivedAt?: TimestampInput } {
  return typeof input === "object" && input !== null && "payload" in input;
}

function messageToString(message: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof message === "string") {
    return message;
  }

  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString("utf8");
  }

  return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString("utf8");
}

function protectLargeSequentialIds(text: string): string {
  return text.replace(/("sequential_id"\s*:\s*)(\d{16,})/gu, '$1"$2"');
}
