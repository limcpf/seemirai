import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UPBIT_PRIVATE_WEBSOCKET_URL,
  UpbitPrivateWebSocketBootstrapBuffer,
  UpbitPrivateWebSocketClient,
  UpbitPrivateWebSocketMyOrderSchema,
  UpbitPrivateWebSocketMyAssetSchema,
  UpbitPrivateWebSocketMessageSchema,
  UpbitPrivateWebSocketPayloadSchema,
  createUpbitPrivateMyOrderSubscription,
  createUpbitPrivateMyAssetSubscription,
  createUpbitPrivateCombinedSubscription,
  parseUpbitPrivateWebSocketMessage,
  toUpbitPrivateMyOrderEvent,
  toUpbitPrivateMyAssetEvent,
} from "../../src/infrastructure/upbit/private-websocket-client.js";
import type {
  UpbitPrivateWebSocketConnectionStatus,
  UpbitPrivateWebSocketTransport,
} from "../../src/infrastructure/upbit/private-websocket-client.js";

/* ============================================================
 * Private WebSocket subscription, schema, mapper, client tests
 *
 * 검증 항목:
 * - subscription payload 생성
 * - Authorization header redaction (payload에 secret 미포함)
 * - myAsset codes 금지 (type으로 검증)
 * - myOrder/myAsset schema parsing
 * - JSON_LIST format 지원
 * - 정규화 mapper
 * - malformed payload fail-fast (raw body 미노출)
 * ============================================================ */

const receivedAt = "2026-06-02T12:00:00.000Z";

describe("Upbit private WebSocket subscriptions", () => {
  it("builds myOrder subscription with specific codes", () => {
    const request = createUpbitPrivateMyOrderSubscription({
      ticket: "reconcile-worker",
      codes: ["KRW-BTC", "KRW-ETH"],
    });

    expect(request).toEqual([
      { ticket: "reconcile-worker" },
      { type: "myOrder", codes: ["KRW-BTC", "KRW-ETH"] },
      { format: "DEFAULT" },
    ]);
  });

  it("builds myOrder subscription without codes (all markets)", () => {
    const request = createUpbitPrivateMyOrderSubscription({
      ticket: "reconcile-worker",
    });

    // codes 필드가 없어야 전체 market 구독을 의미한다.
    expect(request).toEqual([
      { ticket: "reconcile-worker" },
      { type: "myOrder" },
      { format: "DEFAULT" },
    ]);
    expect(request[1]).not.toHaveProperty("codes");
  });

  it("builds myOrder subscription with empty codes array (all markets)", () => {
    const request = createUpbitPrivateMyOrderSubscription({
      ticket: "reconcile-worker",
      codes: [],
    });

    // 빈 배열도 전체 market 구독 → codes 필드 생략
    expect(request).toEqual([
      { ticket: "reconcile-worker" },
      { type: "myOrder" },
      { format: "DEFAULT" },
    ]);
  });

  it("builds myAsset subscription without codes field", () => {
    const request = createUpbitPrivateMyAssetSubscription({
      ticket: "reconcile-worker",
    });

    expect(request).toEqual([
      { ticket: "reconcile-worker" },
      { type: "myAsset" },
      { format: "DEFAULT" },
    ]);
  });

  it("myAsset type does not accept codes parameter", () => {
    // createUpbitPrivateMyAssetSubscription은 codes 인자를 받지 않으므로
    // type 수준에서 codes 지정이 불가능하다. 이는 local fail-closed contract다.
    const request = createUpbitPrivateMyAssetSubscription({
      ticket: "reconcile-worker",
    });

    expect(request[1]).not.toHaveProperty("codes");
    expect(request[1]).toEqual({ type: "myAsset" });
  });

  it("throws when myAsset codes are provided through runtime config boundary", () => {
    expect(() =>
      createUpbitPrivateMyAssetSubscription({
        ticket: "reconcile-worker",
        codes: [],
      } as never),
    ).toThrow("myAsset subscription does not support codes");
  });

  it("supports JSON_LIST format", () => {
    const request = createUpbitPrivateMyOrderSubscription({
      ticket: "reconcile-worker",
      codes: ["KRW-BTC"],
      format: "JSON_LIST",
    });

    expect(request).toEqual([
      { ticket: "reconcile-worker" },
      { type: "myOrder", codes: ["KRW-BTC"] },
      { format: "JSON_LIST" },
    ]);
  });

  it("builds combined subscription for myOrder and myAsset", () => {
    const request = createUpbitPrivateCombinedSubscription(
      { ticket: "reconcile-worker", codes: ["KRW-BTC"] },
      { ticket: "reconcile-worker" },
    );

    expect(request).toEqual([
      { ticket: "reconcile-worker" },
      { type: "myOrder", codes: ["KRW-BTC"] },
      { type: "myAsset" },
      { format: "DEFAULT" },
    ]);
  });

  it("throws when combined subscription receives myAsset codes through runtime config boundary", () => {
    expect(() =>
      createUpbitPrivateCombinedSubscription(
        { ticket: "reconcile-worker", codes: ["KRW-BTC"] },
        { ticket: "reconcile-worker", codes: ["KRW-BTC"] } as never,
      ),
    ).toThrow("myAsset subscription does not support codes");
  });

  it("throws on empty ticket for myOrder", () => {
    expect(() =>
      createUpbitPrivateMyOrderSubscription({ ticket: "" }),
    ).toThrow("Upbit private WebSocket ticket is required");
  });

  it("throws on empty ticket for myAsset", () => {
    expect(() =>
      createUpbitPrivateMyAssetSubscription({ ticket: "" }),
    ).toThrow("Upbit private WebSocket ticket is required");
  });
});

describe("Upbit private WebSocket subscription payload secret safety", () => {
  it("does not include Authorization header or JWT in serialized payload", () => {
    const request = createUpbitPrivateMyOrderSubscription({
      ticket: "reconcile-worker",
      codes: ["KRW-BTC"],
    });
    const serialized = JSON.stringify(request);

    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("access_key");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("JWT");
    expect(serialized).not.toContain("/private");
  });

  it("myAsset subscription payload does not contain secret-like fields", () => {
    const request = createUpbitPrivateMyAssetSubscription({
      ticket: "reconcile-worker",
    });
    const serialized = JSON.stringify(request);

    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("access_key");
    expect(serialized).not.toContain("secret");
  });
});

describe("Upbit private WebSocket client", () => {
  it("throws on empty Authorization header", () => {
    expect(
      () =>
        new UpbitPrivateWebSocketClient({
          authorizationHeader: "",
        }),
    ).toThrow("Upbit private WebSocket requires Authorization header");
  });

  it("throws when default factory is used (no headers support)", () => {
    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader: "Bearer test-jwt-token",
    });

    expect(() => client.connect()).toThrow(
      "does not support custom headers",
    );
  });

  it("passes Authorization header to injected factory", () => {
    let capturedAuthHeader: string | undefined;
    let capturedUrl: string | undefined;

    const mockFactory = (url: string, authHeader: string): UpbitPrivateWebSocketTransport => {
      capturedUrl = url;
      capturedAuthHeader = authHeader;
      return {
        url,
        readyState: 1,
        send: () => undefined,
        close: () => undefined,
      };
    };

    const client = new UpbitPrivateWebSocketClient({
      url: UPBIT_PRIVATE_WEBSOCKET_URL,
      authorizationHeader: "Bearer injected-jwt-token",
      websocketFactory: mockFactory,
    });

    const transport = client.connect();

    expect(capturedUrl).toBe(UPBIT_PRIVATE_WEBSOCKET_URL);
    expect(capturedAuthHeader).toBe("Bearer injected-jwt-token");
    expect(transport.url).toBe(UPBIT_PRIVATE_WEBSOCKET_URL);
    // transport에 raw JWT가 노출되지 않는 invariant 확인
    expect(transport).not.toHaveProperty("authorizationHeader");
    expect(JSON.stringify(transport)).not.toContain("injected-jwt-token");
  });

  it("does not expose Authorization header when client is serialized", () => {
    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader: "Bearer serialized-jwt-token",
      websocketFactory: () => ({
        url: UPBIT_PRIVATE_WEBSOCKET_URL,
        readyState: 1,
        send: () => undefined,
        close: () => undefined,
      }),
    });

    const serialized = JSON.stringify(client);
    const enumerableKeys = Object.keys(client);

    expect(serialized).not.toContain("serialized-jwt-token");
    expect(serialized).not.toContain("Bearer");
    expect(enumerableKeys).not.toContain("authorizationHeader");
  });

  it("sends subscription payload on injectable transport", () => {
    const sent: string[] = [];
    const transport: UpbitPrivateWebSocketTransport = {
      url: UPBIT_PRIVATE_WEBSOCKET_URL,
      readyState: 1,
      send: (data) => sent.push(data),
      close: () => undefined,
    };

    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader: "Bearer test-token",
      websocketFactory: () => transport,
    });

    const payload = JSON.stringify(createUpbitPrivateMyOrderSubscription({
      ticket: "test",
      codes: ["KRW-BTC"],
    }));

    client.subscribe(transport, payload);
    expect(sent).toEqual([payload]);
  });

  it("opens bootstrap buffer before sending subscription and drains snapshot messages", () => {
    const sent: string[] = [];
    const now = createClock([
      "2026-06-02T12:00:00.000Z",
      "2026-06-02T12:00:01.000Z",
      "2026-06-02T12:00:02.000Z",
      "2026-06-02T12:00:03.000Z",
      "2026-06-02T12:00:04.000Z",
      "2026-06-02T12:00:05.000Z",
    ]);
    const transport: UpbitPrivateWebSocketTransport = {
      url: UPBIT_PRIVATE_WEBSOCKET_URL,
      readyState: 1,
      send: (data) => sent.push(data),
      close: () => undefined,
    };
    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader: "Bearer test-token",
      websocketFactory: () => transport,
      clock: now,
    });
    const payload = JSON.stringify(createUpbitPrivateCombinedSubscription(
      { ticket: "test" },
      { ticket: "test" },
    ));

    const session = client.subscribe(transport, payload);
    session.markSnapshotStarted();
    session.handleMessage("first-buffered-message");
    session.handleMessage("second-buffered-message");
    session.markSnapshotCompleted();
    const drain = session.drainBufferedMessages();

    expect(sent).toEqual([payload]);
    expect(session.bufferOpenedAt).toBe("2026-06-02T12:00:00.000Z");
    expect(session.subscribedAt).toBe("2026-06-02T12:00:01.000Z");
    expect(drain.messages).toEqual([
      { data: "first-buffered-message", receivedAt: "2026-06-02T12:00:03.000Z" },
      { data: "second-buffered-message", receivedAt: "2026-06-02T12:00:04.000Z" },
    ]);
    expect(drain.evidence).toEqual({
      bufferOpenedAt: "2026-06-02T12:00:00.000Z",
      subscribedAt: "2026-06-02T12:00:01.000Z",
      snapshotStartedAt: "2026-06-02T12:00:02.000Z",
      snapshotCompletedAt: "2026-06-02T12:00:05.000Z",
      drainedAt: "2026-06-02T12:00:05.000Z",
      bufferedMessageCount: 2,
      hasBootstrapGap: false,
    });
  });

  it("captures message events through the subscription bootstrap buffer handler", () => {
    const sent: string[] = [];
    const messageListeners: Array<(event: unknown) => void> = [];
    const transport: UpbitPrivateWebSocketTransport = {
      url: UPBIT_PRIVATE_WEBSOCKET_URL,
      readyState: 1,
      send: (data) => sent.push(data),
      close: () => undefined,
      addEventListener: (type, listener) => {
        if (type === "message") {
          messageListeners.push(listener);
        }
      },
    };
    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader: "Bearer test-token",
      websocketFactory: () => transport,
      clock: createClock([
        "2026-06-02T12:00:00.000Z",
        "2026-06-02T12:00:01.000Z",
        "2026-06-02T12:00:02.000Z",
        "2026-06-02T12:00:03.000Z",
      ]),
    });
    const session = client.subscribe(
      transport,
      JSON.stringify(createUpbitPrivateMyAssetSubscription({ ticket: "test" })),
    );

    messageListeners[0]?.({ data: "event-from-transport" });
    const drain = session.drainBufferedMessages();

    expect(sent).toHaveLength(1);
    expect(drain.messages).toEqual([
      { data: "event-from-transport", receivedAt: "2026-06-02T12:00:02.000Z" },
    ]);
  });

  it("sends subscription after transport opens when readyState is not 1", () => {
    const sent: string[] = [];
    let openListener: (() => void) | undefined;

    const transport: UpbitPrivateWebSocketTransport = {
      url: UPBIT_PRIVATE_WEBSOCKET_URL,
      readyState: 0,
      send: (data) => sent.push(data),
      close: () => undefined,
      addEventListener: (type, listener) => {
        if (type === "open") {
          openListener = () => listener({});
        }
      },
    };

    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader: "Bearer test-token",
      websocketFactory: () => transport,
    });

    const payload = JSON.stringify(createUpbitPrivateMyOrderSubscription({
      ticket: "test",
    }));

    client.subscribe(transport, payload);
    expect(sent).toEqual([]);

    openListener?.();
    expect(sent).toEqual([payload]);
  });

  it("reports bootstrap gap when snapshot starts before subscription is confirmed", () => {
    const buffer = new UpbitPrivateWebSocketBootstrapBuffer({
      now: createClock([
        "2026-06-02T12:00:00.000Z",
        "2026-06-02T12:00:01.000Z",
        "2026-06-02T12:00:02.000Z",
      ]),
    });

    const startedEvidence = buffer.markSnapshotStarted();
    buffer.markSubscribed();
    const completedEvidence = buffer.markSnapshotCompleted();

    expect(startedEvidence).toEqual({
      bufferOpenedAt: "2026-06-02T12:00:00.000Z",
      snapshotStartedAt: "2026-06-02T12:00:01.000Z",
      bufferedMessageCount: 0,
      hasBootstrapGap: true,
      reasonCode: "SUBSCRIPTION_NOT_CONFIRMED_BEFORE_SNAPSHOT",
    });
    expect(completedEvidence.reasonCode).toBe("SUBSCRIPTION_NOT_CONFIRMED_BEFORE_SNAPSHOT");
  });

  it("compares Date timestamps by epoch milliseconds for bootstrap gap evidence", () => {
    const buffer = new UpbitPrivateWebSocketBootstrapBuffer({
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    buffer.markSubscribed(new Date("2026-06-02T12:00:02.000Z"));
    const evidence = buffer.markSnapshotStarted(new Date("2026-06-02T12:00:01.000Z"));

    expect(evidence).toEqual({
      bufferOpenedAt: "2026-06-02T12:00:00.000Z",
      subscribedAt: "2026-06-02T12:00:02.000Z",
      snapshotStartedAt: "2026-06-02T12:00:01.000Z",
      bufferedMessageCount: 0,
      hasBootstrapGap: true,
      reasonCode: "SUBSCRIPTION_NOT_CONFIRMED_BEFORE_SNAPSHOT",
    });
  });

  it("reports undrained buffer after snapshot completion as gap evidence", () => {
    const buffer = new UpbitPrivateWebSocketBootstrapBuffer({
      now: createClock([
        "2026-06-02T12:00:00.000Z",
        "2026-06-02T12:00:01.000Z",
        "2026-06-02T12:00:02.000Z",
        "2026-06-02T12:00:03.000Z",
      ]),
    });

    buffer.markSubscribed();
    buffer.markSnapshotStarted();
    const evidence = buffer.markSnapshotCompleted();

    expect(evidence).toEqual({
      bufferOpenedAt: "2026-06-02T12:00:00.000Z",
      subscribedAt: "2026-06-02T12:00:01.000Z",
      snapshotStartedAt: "2026-06-02T12:00:02.000Z",
      snapshotCompletedAt: "2026-06-02T12:00:03.000Z",
      bufferedMessageCount: 0,
      hasBootstrapGap: true,
      reasonCode: "BUFFER_NOT_DRAINED",
    });
  });

  it("does not leak Authorization header in error messages", () => {
    // 기본 팩토리 사용 시 에러 메시지에 Authorization header raw 값이 포함되지 않음을 확인한다.
    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader: "Bearer super-secret-jwt-value",
    });

    let error: Error | undefined;

    try {
      client.connect();
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).not.toContain("super-secret-jwt-value");
    // 에러 메시지는 구현 제약을 설명해야 하고 secret을 노출하지 않아야 한다.
    expect(error!.message).toContain("does not support custom headers");
    expect(error!.message).not.toContain("Bearer");
  });
});

describe("Upbit private WebSocket myOrder schema and mapper", () => {
  it("parses myOrder fixture payload through schema", async () => {
    const payload = await readJsonFixture("private-websocket-myorder.json");
    const parsed = UpbitPrivateWebSocketMyOrderSchema.parse(payload);

    expect(parsed.type).toBe("myOrder");
    expect(parsed.uuid).toBe("9a3b6c8d-1e2f-4a5b-8c7d-9e0f1a2b3c4d");
    expect(parsed.code).toBe("KRW-BTC");
    expect(parsed.ask_bid).toBe("BID");
    expect(parsed.state).toBe("wait");
    expect(parsed.price).toBe("100000000");
    expect(parsed.volume).toBe("0.001");
    expect(parsed.remaining_volume).toBe("0.0005");
    expect(parsed.executed_volume).toBe("0.0005");
    expect(parsed.avg_price).toBe("100000000");
    expect(parsed.paid_fee).toBe("250");
    expect(parsed.fee_currency).toBe("KRW");
    expect(parsed.order_timestamp).toBe(1750000000000);
    expect(parsed.timestamp).toBe(1750000000000);
    expect(parsed.stream_type).toBe("SNAPSHOT");
  });

  it("maps myOrder payload to normalized event", async () => {
    const payload = UpbitPrivateWebSocketMyOrderSchema.parse(
      await readJsonFixture("private-websocket-myorder.json"),
    );
    const event = toUpbitPrivateMyOrderEvent(payload, { receivedAt });

    expect(event.type).toBe("MY_ORDER");
    expect(event.exchangeId).toBe("upbit_krw_spot");
    expect(event.orderId).toBe("9a3b6c8d-1e2f-4a5b-8c7d-9e0f1a2b3c4d");
    expect(event.market).toBe("KRW-BTC");
    expect(event.side).toBe("BID");
    expect(event.state).toBe("wait");
    expect(event.price).toBe("100000000");
    expect(event.volume).toBe("0.001");
    expect(event.eventVolume).toBe("0.001");
    expect(event.remainingVolume).toBe("0.0005");
    expect(event.executedVolume).toBe("0.0005");
    expect(event.tradePrice).toBe("100000000");
    expect(event.paidFee).toBe("250");
    expect(event.feeCurrency).toBe("KRW");
    expect(event.orderTimestamp).toBe("2025-06-15T15:06:40.000Z");
    expect(event.eventTimestamp).toBe("2025-06-15T15:06:40.000Z");
    expect(event.streamType).toBe("SNAPSHOT");
    expect(event.receivedAt).toBe(receivedAt);
  });

  it("maps myOrder ask side correctly", async () => {
    const payload = UpbitPrivateWebSocketMyOrderSchema.parse({
      type: "myOrder",
      uuid: "test-uuid",
      code: "KRW-BTC",
      ask_bid: "ASK",
      state: "trade",
      price: "101000000",
      volume: "0.001",
      remaining_volume: "0",
      executed_volume: "0.001",
      avg_price: "101000000",
      paid_fee: "250",
      fee_currency: "KRW",
      order_timestamp: 1750000000000,
      timestamp: 1750000000000,
      stream_type: "REALTIME",
    });
    const event = toUpbitPrivateMyOrderEvent(payload, { receivedAt });

    expect(event.side).toBe("ASK");
    expect(event.state).toBe("trade");
    expect(event.volume).toBe("0.001");
    expect(event.eventVolume).toBe("0.001");
    expect(event.streamType).toBe("REALTIME");
  });

  it("keeps trade event volume separate from reconstructed order volume", () => {
    const payload = UpbitPrivateWebSocketMyOrderSchema.parse({
      type: "myOrder",
      uuid: "test-uuid",
      code: "KRW-BTC",
      ask_bid: "BID",
      state: "trade",
      price: "100000000",
      volume: "0.0001",
      remaining_volume: "0.0007",
      executed_volume: "0.0003",
      avg_price: "100000000",
      paid_fee: "10",
      order_timestamp: 1750000000000,
      timestamp: 1750000000000,
      stream_type: "REALTIME",
    });
    const event = toUpbitPrivateMyOrderEvent(payload, { receivedAt });

    expect(event.volume).toBe("0.001");
    expect(event.eventVolume).toBe("0.0001");
  });

  it("accepts myOrder prevented state for SMP event tracking", () => {
    const payload = UpbitPrivateWebSocketMyOrderSchema.parse({
      type: "myOrder",
      uuid: "test-uuid",
      code: "KRW-BTC",
      ask_bid: "BID",
      state: "prevented",
      price: "101000000",
      volume: "0.001",
      remaining_volume: "0",
      executed_volume: "0",
      avg_price: "0",
      paid_fee: "0",
      order_timestamp: 1750000000000,
      timestamp: 1750000000000,
      stream_type: "REALTIME",
    });
    const event = toUpbitPrivateMyOrderEvent(payload, { receivedAt });

    expect(event.state).toBe("prevented");
    expect(event.feeCurrency).toBeUndefined();
  });

  it("fails fast on malformed myOrder payload", async () => {
    const malformed = {
      type: "myOrder",
      // uuid 누락
      code: "KRW-BTC",
    };

    expect(() => UpbitPrivateWebSocketMyOrderSchema.parse(malformed)).toThrow();
  });

  it("fails fast on myOrder with invalid market format", () => {
    const malformed = {
      type: "myOrder",
      uuid: "test-uuid",
      code: "INVALID",
      ask_bid: "BID",
      state: "wait",
      price: "1000",
      volume: "1",
      remaining_volume: "0",
      executed_volume: "1",
      avg_price: "1000",
      paid_fee: "0",
      fee_currency: "KRW",
      order_timestamp: 1750000000000,
      timestamp: 1750000000000,
      stream_type: "SNAPSHOT",
    };

    expect(() => UpbitPrivateWebSocketMyOrderSchema.parse(malformed)).toThrow();
  });
});

describe("Upbit private WebSocket raw message parser", () => {
  it("preserves numeric lexemes before JSON.parse for DEFAULT messages", () => {
    const parsed = parseUpbitPrivateWebSocketMessage(
      `{
        "type":"myAsset",
        "assets":[
          {
            "currency":"BTC",
            "balance":0.12345678901234567890,
            "locked":0.00000000000000000001
          }
        ],
        "asset_timestamp":1750000000000,
        "timestamp":1750000000000,
        "stream_type":"REALTIME"
      }`,
    );

    expect(parsed).toMatchObject({
      type: "myAsset",
      assets: [
        {
          currency: "BTC",
          balance: "0.12345678901234567890",
          locked: "0.00000000000000000001",
        },
      ],
    });
  });

  it("fails closed when precision fields are already parsed as JS numbers", () => {
    expect(() =>
      UpbitPrivateWebSocketMyAssetSchema.parse({
        type: "myAsset",
        assets: [
          {
            currency: "BTC",
            balance: 0.12345678901234568,
            locked: "0",
          },
        ],
        asset_timestamp: 1750000000000,
        timestamp: 1750000000000,
        stream_type: "REALTIME",
      }),
    ).toThrow();
  });

  it("parses JSON_LIST array messages", () => {
    const parsed = parseUpbitPrivateWebSocketMessage(
      `[{
        "type":"myOrder",
        "uuid":"json-list-order",
        "code":"KRW-BTC",
        "ask_bid":"BID",
        "state":"wait",
        "price":100000000.123456789,
        "volume":0.001,
        "remaining_volume":0.001,
        "executed_volume":0,
        "avg_price":0,
        "paid_fee":0,
        "order_timestamp":1750000000000,
        "timestamp":1750000000000,
        "stream_type":"REALTIME"
      }]`,
    );

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([
      expect.objectContaining({
        type: "myOrder",
        price: "100000000.123456789",
        volume: "0.001",
        avg_price: "0",
      }),
    ]);
    expect(UpbitPrivateWebSocketMessageSchema.parse(parsed)).toEqual(parsed);
  });
});

describe("Upbit private WebSocket myAsset schema and mapper", () => {
  it("parses myAsset fixture payload through schema", async () => {
    const payload = await readJsonFixture("private-websocket-myasset.json");
    const parsed = UpbitPrivateWebSocketMyAssetSchema.parse(payload);

    expect(parsed.type).toBe("myAsset");
    expect(parsed.asset_uuid).toBe("asset-fixture-uuid");
    expect(parsed.assets).toHaveLength(2);
    expect(parsed.assets[0]?.currency).toBe("KRW");
    expect(parsed.assets[0]?.balance).toBe("5000000");
    expect(parsed.assets[0]?.locked).toBe("100000");
    expect(parsed.assets[1]?.currency).toBe("BTC");
    expect(parsed.assets[1]?.balance).toBe("0.5");
    expect(parsed.assets[1]?.locked).toBe("0.1");
    expect(parsed.asset_timestamp).toBe(1750000000000);
    expect(parsed.timestamp).toBe(1750000000000);
    expect(parsed.stream_type).toBe("SNAPSHOT");
  });

  it("maps myAsset payload to normalized event", async () => {
    const payload = UpbitPrivateWebSocketMyAssetSchema.parse(
      await readJsonFixture("private-websocket-myasset.json"),
    );
    const event = toUpbitPrivateMyAssetEvent(payload, { receivedAt });

    expect(event.type).toBe("MY_ASSET");
    expect(event.exchangeId).toBe("upbit_krw_spot");
    expect(event.balances).toHaveLength(2);
    expect(event.balances[0]).toEqual({
      currency: "KRW",
      balance: "5000000",
      locked: "100000",
    });
    expect(event.balances[1]).toEqual({
      currency: "BTC",
      balance: "0.5",
      locked: "0.1",
    });
    expect(event.eventTimestamp).toBe("2025-06-15T15:06:40.000Z");
    expect(event.streamType).toBe("SNAPSHOT");
    expect(event.receivedAt).toBe(receivedAt);
  });

  it("handles empty asset list", () => {
    const payload = UpbitPrivateWebSocketMyAssetSchema.parse({
      type: "myAsset",
      assets: [],
      asset_timestamp: 1750000000000,
      timestamp: 1750000000000,
      stream_type: "REALTIME",
    });
    const event = toUpbitPrivateMyAssetEvent(payload, { receivedAt });

    expect(event.balances).toEqual([]);
    expect(event.streamType).toBe("REALTIME");
  });

  it("fails fast on malformed myAsset payload", () => {
    const malformed = {
      type: "myAsset",
      // assets 필드 누락
      asset_timestamp: 1750000000000,
      timestamp: 1750000000000,
      stream_type: "SNAPSHOT",
    };

    expect(() => UpbitPrivateWebSocketMyAssetSchema.parse(malformed)).toThrow();
  });

  it("fails fast on myAsset with invalid balance format", () => {
    const malformed = {
      type: "myAsset",
      assets: [
        {
          currency: "KRW",
          balance: "not-a-number",
          locked: "0",
        },
      ],
      asset_timestamp: 1750000000000,
      timestamp: 1750000000000,
      stream_type: "SNAPSHOT",
    };

    expect(() => UpbitPrivateWebSocketMyAssetSchema.parse(malformed)).toThrow();
  });
});

describe("Upbit private WebSocket payload union schema", () => {
  it("parses myOrder payload through union schema", async () => {
    const payload = await readJsonFixture("private-websocket-myorder.json");
    const parsed = UpbitPrivateWebSocketPayloadSchema.parse(payload);

    expect(parsed.type).toBe("myOrder");
  });

  it("parses myAsset payload through union schema", async () => {
    const payload = await readJsonFixture("private-websocket-myasset.json");
    const parsed = UpbitPrivateWebSocketPayloadSchema.parse(payload);

    expect(parsed.type).toBe("myAsset");
  });

  it("fails fast on unknown private WebSocket payload type", () => {
    const unknown = {
      type: "unknownType",
      data: "some value",
    };

    expect(() => UpbitPrivateWebSocketPayloadSchema.parse(unknown)).toThrow();
  });

  it("fails fast on completely malformed payload", () => {
    expect(() => UpbitPrivateWebSocketPayloadSchema.parse(null)).toThrow();
    expect(() => UpbitPrivateWebSocketPayloadSchema.parse(42)).toThrow();
    expect(() => UpbitPrivateWebSocketPayloadSchema.parse("invalid")).toThrow();
  });
});

describe("Upbit private WebSocket lifecycle contract types", () => {
  it("accepts all lifecycle connection status values", () => {
    const statuses: UpbitPrivateWebSocketConnectionStatus[] = [
      "CONNECTED",
      "DISCONNECTED",
      "RECONNECTING",
      "DEGRADED",
    ];

    // 모든 상태가 유효한 type임을 확인 (컴파일 타임 검증)
    expect(statuses).toHaveLength(4);
  });
});

describe("Upbit private WebSocket endpoint constant", () => {
  it("uses the correct private WebSocket endpoint", () => {
    expect(UPBIT_PRIVATE_WEBSOCKET_URL).toBe(
      "wss://api.upbit.com/websocket/v1/private",
    );
  });
});

async function readJsonFixture(filename: string): Promise<unknown> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "upbit", filename);
  const json = await readFile(fixturePath, "utf8");

  return JSON.parse(json) as unknown;
}

function createClock(values: readonly string[]): () => string {
  let index = 0;

  return () => {
    const value = values[index] ?? values.at(-1);
    index += 1;

    if (value === undefined) {
      throw new Error("clock fixture requires at least one timestamp");
    }

    return value;
  };
}
