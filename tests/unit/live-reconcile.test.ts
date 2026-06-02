import { describe, expect, it } from "vitest";
import {
  buildOrderFingerprint,
  checkBalanceLock,
  checkClosedOrderWindow,
  checkWebSocketGap,
  describeExchangeOrderIdentity,
  matchOrderIdentity,
  reconcileOrders,
  runReconcileEngine,
} from "../../src/application/live-reconcile.js";
import type {
  BrokerBalance,
  ReconcileEngineInput,
  ReconcileExchangeOrderSnapshot,
  ReconcileLocalOrderSnapshot,
  ReconcileWebSocketContext,
  ReconcileClosedOrderWindow,
} from "../../src/domain/index.js";

/* ============================================================
 * M16 Reconcile Diff Engine — Unit Tests
 *
 * 검증 항목:
 * - identity matching 3단계 (identifier, uuid, fingerprint)
 * - untracked exchange open order mismatch
 * - local open order missing on exchange
 * - partial fill mismatch
 * - cancel failure / retry-needed evidence
 * - balance/locked mismatch
 * - closed order window 초과 → manual review
 * - WebSocket gap → manual review/fail-closed
 * - 상태 전진 후보 (fill, partial fill, cancel)
 * - fail-closed 판정과 targetKillSwitchState
 * - engine 전체 orchestrator 통합
 * ============================================================ */

const observedAt = "2026-06-02T12:00:00.000Z";

/* ============================================================
 * Identity Matching Tests
 * ============================================================ */

describe("matchOrderIdentity — identifier / uuid / fingerprint 3단계 매칭", () => {
  it("identifier가 양쪽에 존재하고 일치하면 identifier match", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({ identifier: "my-order-001" }),
      createLocalOrder({ identifier: "my-order-001" }),
    );

    expect(result).toEqual({
      matched: true,
      matchType: "identifier",
      identity: "id:my-order-001",
    });
  });

  it("identifier가 한쪽에만 있으면 match 실패", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({ identifier: "my-order-001" }),
      createLocalOrder({ identifier: undefined }),
    );

    expect(result).toEqual({
      matched: false,
      reason: "identifier_present_only_on_one_side",
    });
  });

  it("identifier가 양쪽에 있지만 다르면 match 실패", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({ identifier: "order-a" }),
      createLocalOrder({ identifier: "order-b" }),
    );

    expect(result).toEqual({
      matched: false,
      reason: 'identifier_mismatch: exchange="order-a" vs local="order-b"',
    });
  });

  it("exchangeOrderId(uuid)가 양쪽에 존재하고 일치하면 uuid match", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({
        identifier: undefined,
        exchangeOrderId: "uuid-12345",
      }),
      createLocalOrder({
        identifier: undefined,
        exchangeOrderId: "uuid-12345",
      }),
    );

    expect(result).toEqual({
      matched: true,
      matchType: "uuid",
      identity: "uuid:uuid-12345",
    });
  });

  it("uuid가 한쪽에만 있으면 match 실패", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({
        identifier: undefined,
        exchangeOrderId: "uuid-12345",
      }),
      createLocalOrder({
        identifier: undefined,
        exchangeOrderId: undefined,
      }),
    );

    expect(result).toEqual({
      matched: false,
      reason: "uuid_present_only_on_one_side",
    });
  });

  it("식별자가 모두 없으면 fingerprint로 match (market, side, quantity, price 일치)", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({
        identifier: undefined,
        exchangeOrderId: undefined,
        market: "KRW-BTC",
        side: "BUY",
        requestedQuantity: "0.001",
        requestedPrice: "50000000",
      }),
      createLocalOrder({
        identifier: undefined,
        exchangeOrderId: undefined,
        market: "KRW-BTC",
        side: "BUY",
        requestedQuantity: "0.001",
        requestedPrice: "50000000",
      }),
    );

    expect(result).toEqual({
      matched: true,
      matchType: "fingerprint",
      identity: "fp:KRW-BTC|BUY|0.001|50000000",
    });
  });

  it("fingerprint가 다르면 match 실패", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({
        identifier: undefined,
        exchangeOrderId: undefined,
        requestedPrice: "50000000",
      }),
      createLocalOrder({
        identifier: undefined,
        exchangeOrderId: undefined,
        requestedPrice: "51000000",
      }),
    );

    expect(result).toMatchObject({
      matched: false,
      reason: expect.stringContaining("fingerprint_mismatch") as string,
    });
  });

  it("identifier가 같아도 uuid가 다르면 match 실패", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({
        identifier: "order-x",
        exchangeOrderId: "uuid-a",
      }),
      createLocalOrder({
        identifier: "order-x",
        exchangeOrderId: "uuid-b",
      }),
    );

    expect(result).toEqual({
      matched: false,
      reason: 'uuid_mismatch_after_identifier_match: exchange="uuid-a" vs local="uuid-b"',
    });
  });

  it("identifier가 같아도 immutable fingerprint가 다르면 match 실패", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({
        identifier: "stale-id",
        requestedPrice: "50000000",
      }),
      createLocalOrder({
        identifier: "stale-id",
        requestedPrice: "51000000",
      }),
    );

    expect(result).toMatchObject({
      matched: false,
      reason: expect.stringContaining("immutable_fingerprint_mismatch") as string,
    });
  });

  it("uuid가 같아도 immutable fingerprint가 다르면 match 실패", () => {
    const result = matchOrderIdentity(
      createExchangeOrder({
        identifier: undefined,
        exchangeOrderId: "uuid-same",
        requestedQuantity: "0.002",
      }),
      createLocalOrder({
        identifier: undefined,
        exchangeOrderId: "uuid-same",
        requestedQuantity: "0.001",
      }),
    );

    expect(result).toMatchObject({
      matched: false,
      reason: expect.stringContaining("immutable_fingerprint_mismatch") as string,
    });
  });
});

describe("buildOrderFingerprint", () => {
  it("market, side, quantity, price로 fingerprint를 생성한다", () => {
    expect(buildOrderFingerprint("KRW-BTC", "BUY", "0.001", "50000000")).toBe(
      "KRW-BTC|BUY|0.001|50000000",
    );
  });

  it("price가 없으면 빈 문자열로 대체한다", () => {
    expect(buildOrderFingerprint("KRW-ETH", "SELL", "0.5")).toBe(
      "KRW-ETH|SELL|0.5|",
    );
  });
});

describe("describeExchangeOrderIdentity", () => {
  it("identifier가 있으면 identifier 우선 표시", () => {
    expect(
      describeExchangeOrderIdentity(
        createExchangeOrder({ identifier: "order-1" }),
      ),
    ).toBe("identifier:order-1");
  });

  it("identifier가 없고 uuid가 있으면 uuid 표시", () => {
    expect(
      describeExchangeOrderIdentity(
        createExchangeOrder({
          identifier: undefined,
          exchangeOrderId: "uuid-123",
        }),
      ),
    ).toBe("uuid:uuid-123");
  });

  it("둘 다 없으면 fingerprint 표시", () => {
    expect(
      describeExchangeOrderIdentity(
        createExchangeOrder({
          identifier: undefined,
          exchangeOrderId: undefined,
          requestedPrice: "10000000",
        }),
      ),
    ).toBe("fingerprint:KRW-BTC|BUY|0.001|10000000");
  });
});

/* ============================================================
 * Order Reconcile Tests — mismatch policy
 * ============================================================ */

describe("reconcileOrders — untracked exchange open order", () => {
  it("거래소 open order가 로컬에 없으면 UNTRACKED_EXCHANGE_OPEN_ORDER mismatch 생성", () => {
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "ext-order-1",
        market: "KRW-ETH",
      }),
    ];
    const localOrders: ReconcileLocalOrderSnapshot[] = [];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(results).toHaveLength(1);
    const mismatch = results[0]!.mismatches[0]!;
    expect(mismatch).toMatchObject({
      mismatchType: "UNTRACKED_EXCHANGE_OPEN_ORDER",
      severity: "WARN",
      market: "KRW-ETH",
      orderIdentity: "identifier:ext-order-1",
    });
    expect(mismatch.userMessage).toContain("거래소에 미체결 상태");
    expect(mismatch.requiredAction).toContain("수동 등록");
    // 상태 전진은 생성되지 않아야 함
    expect(results[0]!.stateAdvancement).toBeUndefined();
  });

  it("거래소 ws source도 untracked 판정 대상에 포함한다", () => {
    const exchangeOrders = [
      createExchangeOrder({
        source: "ws",
        identifier: "ws-order-1",
      }),
    ];
    const results = reconcileOrders(exchangeOrders, [], observedAt);

    expect(results).toHaveLength(1);
    expect(results[0]!.mismatches[0]!.mismatchType).toBe(
      "UNTRACKED_EXCHANGE_OPEN_ORDER",
    );
  });

  it("closed/lookup source는 untracked 판정에서 제외한다", () => {
    const exchangeOrders = [
      createExchangeOrder({ source: "closed", identifier: "closed-1" }),
      createExchangeOrder({ source: "lookup", identifier: "lookup-1" }),
    ];
    const results = reconcileOrders(exchangeOrders, [], observedAt);

    // closed/lookup은 untracked open order로 보지 않음
    const mismatches = results.flatMap((r) => r.mismatches);
    expect(
      mismatches.filter(
        (m) => m.mismatchType === "UNTRACKED_EXCHANGE_OPEN_ORDER",
      ),
    ).toHaveLength(0);
  });
});

describe("reconcileOrders — local open order missing on exchange", () => {
  it("로컬 미체결 주문이 exchange 어디에도 없으면 LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-1",
        status: "ACCEPTED",
        identifier: "orphan-order",
      }),
    ];
    const exchangeOrders: ReconcileExchangeOrderSnapshot[] = [];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(results).toHaveLength(1);
    const mismatch = results[0]!.mismatches[0]!;
    expect(mismatch).toMatchObject({
      mismatchType: "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE",
      severity: "ERROR",
      orderIdentity: "local:local-1",
    });
    expect(mismatch.userMessage).toContain("로컬에 미체결");
    expect(mismatch.requiredAction).toContain("수동 검토");
  });

  it("로컬 주문이 exchange closed order에서 발견되면 missing 아님", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-1",
        status: "ACCEPTED",
        identifier: "found-in-closed",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "closed",
        identifier: "found-in-closed",
        exchangeStatus: "done",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const missingMismatches = results.flatMap((r) =>
      r.mismatches.filter(
        (m) => m.mismatchType === "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE",
      ),
    );
    expect(missingMismatches).toHaveLength(0);
  });

  it("로컬 주문이 exchange lookup에서 발견되면 missing 아님", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-2",
        identifier: "found-in-lookup",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "lookup",
        identifier: "found-in-lookup",
        exchangeStatus: "cancel",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const missingMismatches = results.flatMap((r) =>
      r.mismatches.filter(
        (m) => m.mismatchType === "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE",
      ),
    );
    expect(missingMismatches).toHaveLength(0);
  });
});

describe("reconcileOrders — cancel failure retry-needed", () => {
  it("local CANCEL_REQUESTED + exchange wait/watch → CANCEL_FAILURE_RETRY_NEEDED", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-cancel",
        status: "CANCEL_REQUESTED",
        identifier: "cancel-fail-1",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "cancel-fail-1",
        exchangeStatus: "wait",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const cancelFailures = results.flatMap((r) =>
      r.mismatches.filter(
        (m) => m.mismatchType === "CANCEL_FAILURE_RETRY_NEEDED",
      ),
    );
    expect(cancelFailures).toHaveLength(1);
    expect(cancelFailures[0]!).toMatchObject({
      severity: "ERROR",
      orderIdentity: "id:cancel-fail-1",
    });
    expect(cancelFailures[0]!.userMessage).toContain("취소 요청한 주문");
    expect(cancelFailures[0]!.requiredAction).toContain("즉시 취소");
  });

  it("local CANCEL_REQUESTED + exchange watch → CANCEL_FAILURE_RETRY_NEEDED", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-cancel-2",
        status: "CANCEL_REQUESTED",
        identifier: "cancel-fail-2",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "cancel-fail-2",
        exchangeStatus: "watch",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(
      results.flatMap((r) => r.mismatches).some(
        (m) => m.mismatchType === "CANCEL_FAILURE_RETRY_NEEDED",
      ),
    ).toBe(true);
  });

  it("local CANCEL_REQUESTED + exchange cancel → cancel failure 아님 (정상 취소)", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-cancel-ok",
        status: "CANCEL_REQUESTED",
        identifier: "cancel-ok",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "cancel-ok",
        exchangeStatus: "cancel",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const cancelFailures = results.flatMap((r) =>
      r.mismatches.filter(
        (m) => m.mismatchType === "CANCEL_FAILURE_RETRY_NEEDED",
      ),
    );
    expect(cancelFailures).toHaveLength(0);
  });
});

describe("reconcileOrders — partial fill mismatch", () => {
  it("remainingQuantity가 다르면 PARTIAL_FILL_MISMATCH", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-partial",
        status: "ACCEPTED",
        identifier: "partial-1",
        remainingQuantity: "0.0005",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "partial-1",
        exchangeStatus: "wait",
        remainingQuantity: "0.0003",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const partialMismatches = results.flatMap((r) =>
      r.mismatches.filter((m) => m.mismatchType === "PARTIAL_FILL_MISMATCH"),
    );
    expect(partialMismatches).toHaveLength(1);
    expect(partialMismatches[0]!.userMessage).toContain("미체결 수량");
  });

  it("remainingQuantity가 같으면 partial fill mismatch 아님", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-equal",
        identifier: "equal-1",
        remainingQuantity: "0.001",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "equal-1",
        remainingQuantity: "0.001",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const partialMismatches = results.flatMap((r) =>
      r.mismatches.filter((m) => m.mismatchType === "PARTIAL_FILL_MISMATCH"),
    );
    expect(partialMismatches).toHaveLength(0);
  });

  it("exchange remainingQuantity가 undefined면 partial fill mismatch 건너뜀", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-no-rem",
        identifier: "no-rem-1",
        remainingQuantity: "0.001",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "no-rem-1",
        remainingQuantity: undefined,
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const partialMismatches = results.flatMap((r) =>
      r.mismatches.filter((m) => m.mismatchType === "PARTIAL_FILL_MISMATCH"),
    );
    expect(partialMismatches).toHaveLength(0);
  });
});

describe("reconcileOrders — state advancement candidates", () => {
  it("exchange done + remainingQuantity=0 → FILL_CANDIDATE", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-fill",
        status: "ACCEPTED",
        identifier: "fill-candidate",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "fill-candidate",
        exchangeStatus: "done",
        remainingQuantity: "0",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(results[0]!.stateAdvancement).toMatchObject({
      localOrderId: "local-fill",
      advancementType: "FILL_CANDIDATE",
      targetLocalStatus: "FILLED",
      reasonCode: "exchange_done_fully_filled",
    });
  });

  it("exchange done + remainingQuantity > 0 → PARTIALLY_FILLED_CANDIDATE", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-partial-adv",
        status: "ACCEPTED",
        identifier: "partial-candidate",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "partial-candidate",
        exchangeStatus: "done",
        remainingQuantity: "0.0002",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(results[0]!.stateAdvancement).toMatchObject({
      localOrderId: "local-partial-adv",
      advancementType: "PARTIALLY_FILLED_CANDIDATE",
      targetLocalStatus: "PARTIALLY_FILLED",
      reasonCode: "exchange_done_with_remaining",
    });
  });

  it("exchange cancel + local CANCEL_REQUESTED → CANCEL_CANDIDATE", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-cancel-adv",
        status: "CANCEL_REQUESTED",
        identifier: "cancel-candidate",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "cancel-candidate",
        exchangeStatus: "cancel",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(results[0]!.stateAdvancement).toMatchObject({
      localOrderId: "local-cancel-adv",
      advancementType: "CANCEL_CANDIDATE",
      targetLocalStatus: "CANCELED",
      reasonCode: "exchange_cancel_confirmed",
    });
  });

  it("exchange cancel + local ACCEPTED → EXCHANGE_CANCEL_STATE_MISMATCH, 상태 전진 없음", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-manual-cancel",
        status: "ACCEPTED",
        identifier: "manual-cancel",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "closed",
        identifier: "manual-cancel",
        exchangeStatus: "cancel",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    const mismatches = results.flatMap((r) => r.mismatches);
    expect(mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mismatchType: "EXCHANGE_CANCEL_STATE_MISMATCH",
          severity: "ERROR",
        }),
      ]),
    );
    expect(results[0]!.stateAdvancement).toBeUndefined();
  });

  it("identity 불일치 시 상태 전진 후보가 생성되지 않는다", () => {
    // identifier가 다른 두 주문 → identity 불일치
    const localOrders = [
      createLocalOrder({
        orderId: "local-no-match",
        status: "ACCEPTED",
        identifier: "local-id-1",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "exchange-id-2",
        exchangeStatus: "done",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    // 상태 전진이 생성되지 않아야 함
    const hasAdvancement = results.some((r) => r.stateAdvancement !== undefined);
    expect(hasAdvancement).toBe(false);
  });

  it("local이 이미 FILLED면 exchange done에 대해 전진 불필요", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-already-filled",
        status: "FILLED",
        identifier: "already-filled",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "already-filled",
        exchangeStatus: "done",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(results[0]!.stateAdvancement).toBeUndefined();
  });

  it("local이 이미 PARTIALLY_FILLED면 exchange done+remaining에 대해 전진 불필요", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "local-pf",
        status: "PARTIALLY_FILLED",
        identifier: "already-pf",
      }),
    ];
    const exchangeOrders = [
      createExchangeOrder({
        source: "open",
        identifier: "already-pf",
        exchangeStatus: "done",
        remainingQuantity: "0.0002",
      }),
    ];

    const results = reconcileOrders(exchangeOrders, localOrders, observedAt);

    expect(results[0]!.stateAdvancement).toBeUndefined();
  });
});

/* ============================================================
 * Balance Policy Tests
 * ============================================================ */

describe("checkBalanceLock — 잠김 잔고 설명 가능성", () => {
  it("BUY 미체결 주문의 remaining×price 합계가 KRW locked와 일치하면 OK", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "buy-1",
        side: "BUY",
        market: "KRW-BTC",
        requestedPrice: "50000000",
        requestedQuantity: "0.001",
        remainingQuantity: "0.001",
        status: "ACCEPTED",
      }),
    ];
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "50000",
        total: "1050000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock(
      localOrders,
      exchangeBalances,
      exchangeBalances,
      observedAt,
    );

    expect(result.status).toBe("OK");
    expect(result.mismatches).toHaveLength(0);
  });

  it("KRW locked이 로컬 미체결로 설명되지 않으면 BALANCE_LOCK_MISMATCH", () => {
    const localOrders: ReconcileLocalOrderSnapshot[] = [];
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "50000",
        total: "1050000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock(
      localOrders,
      exchangeBalances,
      exchangeBalances,
      observedAt,
    );

    expect(result.status).toBe("LOCK_MISMATCH");
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!).toMatchObject({
      mismatchType: "BALANCE_LOCK_MISMATCH",
      currency: "KRW",
      severity: "ERROR",
    });
    expect(result.mismatches[0]!.userMessage).toContain("KRW");
    expect(result.mismatches[0]!.userMessage).toContain("잠김 잔고");
  });

  it("locked이 0이면 설명 불필요 → OK", () => {
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock(
      [],
      exchangeBalances,
      exchangeBalances,
      observedAt,
    );

    expect(result.status).toBe("OK");
  });

  it("양쪽 balance snapshot이 모두 없으면 NOT_AVAILABLE만 반환한다", () => {
    const result = checkBalanceLock([], undefined, undefined, observedAt);
    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.mismatches).toHaveLength(0);
  });

  it("로컬 balance snapshot만 없으면 BALANCE_SNAPSHOT_UNAVAILABLE", () => {
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock([], undefined, exchangeBalances, observedAt);

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mismatchType: "BALANCE_SNAPSHOT_UNAVAILABLE",
          severity: "ERROR",
        }),
      ]),
    );
  });

  it("SELL 미체결은 암호화폐 locked로 계산한다", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "sell-btc",
        side: "SELL",
        market: "KRW-BTC",
        requestedQuantity: "0.001",
        remainingQuantity: "0.0005",
        status: "ACCEPTED",
      }),
    ];
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "BTC",
        available: "0.01",
        locked: "0.0005",
        total: "0.0105",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock(
      localOrders,
      exchangeBalances,
      exchangeBalances,
      observedAt,
    );

    expect(result.status).toBe("OK");
  });

  it("여러 BUY 주문의 locked 합계를 계산한다", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "buy-1",
        side: "BUY",
        requestedPrice: "10000000",
        remainingQuantity: "0.001",
        status: "ACCEPTED",
      }),
      createLocalOrder({
        orderId: "buy-2",
        side: "BUY",
        requestedPrice: "20000000",
        remainingQuantity: "0.0005",
        status: "ACCEPTED",
      }),
    ];
    // expected locked = 0.001×10000000 + 0.0005×20000000 = 10000 + 10000 = 20000
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "20000",
        total: "1020000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock(
      localOrders,
      exchangeBalances,
      exchangeBalances,
      observedAt,
    );

    expect(result.status).toBe("OK");
  });

  it("terminal 상태(CANCELED 등)의 주문은 locked 계산에서 제외한다", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "buy-canceled",
        side: "BUY",
        requestedPrice: "50000000",
        remainingQuantity: "0.001",
        status: "CANCELED",
      }),
    ];
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock(
      localOrders,
      exchangeBalances,
      exchangeBalances,
      observedAt,
    );

    expect(result.status).toBe("OK");
  });

  it("거래소 locked가 0이어도 로컬 미체결 예상 locked가 있으면 BALANCE_LOCK_MISMATCH", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "buy-open-no-exchange-lock",
        side: "BUY",
        requestedPrice: "10000000",
        remainingQuantity: "0.001",
        status: "ACCEPTED",
      }),
    ];
    const balances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock(localOrders, balances, balances, observedAt);

    expect(result.status).toBe("LOCK_MISMATCH");
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mismatchType: "BALANCE_LOCK_MISMATCH",
          currency: "KRW",
        }),
      ]),
    );
  });

  it("로컬 balance snapshot 필드가 거래소와 다르면 BALANCE_LOCK_MISMATCH", () => {
    const localBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "900000",
        locked: "0",
        total: "900000",
        updatedAt: observedAt,
      },
    ];
    const exchangeBalances: BrokerBalance[] = [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        updatedAt: observedAt,
      },
    ];

    const result = checkBalanceLock([], localBalances, exchangeBalances, observedAt);

    expect(result.status).toBe("LOCK_MISMATCH");
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mismatchType: "BALANCE_LOCK_MISMATCH",
          currency: "KRW",
        }),
      ]),
    );
  });
});

/* ============================================================
 * Closed Order Window Tests
 * ============================================================ */

describe("checkClosedOrderWindow", () => {
  it("생성 시각이 window 이전이면 CLOSED_ORDER_WINDOW_EXCEEDED", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "old-order",
        status: "ACCEPTED",
        createdAt: "2026-05-20T00:00:00.000Z",
      }),
    ];
    const window: ReconcileClosedOrderWindow = {
      windowStart: "2026-06-01T00:00:00.000Z",
      windowEnd: "2026-06-02T00:00:00.000Z",
      windowExhausted: false,
      queryCount: 1,
    };

    const mismatches = checkClosedOrderWindow(localOrders, window, observedAt);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!).toMatchObject({
      mismatchType: "CLOSED_ORDER_WINDOW_EXCEEDED",
      severity: "WARN",
      market: "KRW-BTC",
      orderIdentity: "local:old-order",
    });
    expect(mismatches[0]!.userMessage).toContain("조회 기간");
    expect(mismatches[0]!.requiredAction).toContain("수동 검토");
  });

  it("생성 시각이 window 안이면 mismatch 없음", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "recent-order",
        createdAt: "2026-06-01T06:00:00.000Z",
      }),
    ];
    const window: ReconcileClosedOrderWindow = {
      windowStart: "2026-06-01T00:00:00.000Z",
      windowEnd: "2026-06-02T00:00:00.000Z",
      windowExhausted: false,
      queryCount: 1,
    };

    const mismatches = checkClosedOrderWindow(localOrders, window, observedAt);

    expect(mismatches).toHaveLength(0);
  });

  it("createdAt이 없으면 window 판정 건너뜀", () => {
    const localOrders = [
      createLocalOrder({
        orderId: "no-date-order",
        createdAt: undefined,
      }),
    ];
    const window: ReconcileClosedOrderWindow = {
      windowStart: "2026-06-01T00:00:00.000Z",
      windowEnd: "2026-06-02T00:00:00.000Z",
      windowExhausted: false,
      queryCount: 1,
    };

    const mismatches = checkClosedOrderWindow(localOrders, window, observedAt);

    expect(mismatches).toHaveLength(0);
  });
});

/* ============================================================
 * WebSocket Gap Tests
 * ============================================================ */

describe("checkWebSocketGap", () => {
  it("bootstrap 이전 이벤트가 있으면 WEBSOCKET_GAP_MANUAL_REVIEW", () => {
    const wsContext: ReconcileWebSocketContext = {
      bootstrapCompleteAt: "2026-06-02T12:00:00.000Z",
      events: [
        {
          type: "myOrder",
          occurredAt: "2026-06-02T11:59:00.000Z", // bootstrap 이전
          payload: { market: "KRW-BTC" },
        },
      ],
    };

    const mismatches = checkWebSocketGap(wsContext, observedAt);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!).toMatchObject({
      mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
      severity: "WARN",
    });
    expect(mismatches[0]!.userMessage).toContain("bootstrap");
    expect(mismatches[0]!.trace).toMatchObject({
      preBootstrapEventCount: 1,
    });
  });

  it("disconnectEvidence가 있으면 WEBSOCKET_GAP_MANUAL_REVIEW (ERROR)", () => {
    const wsContext: ReconcileWebSocketContext = {
      events: [],
      disconnectEvidence: {
        disconnectedAt: "2026-06-02T11:00:00.000Z",
        gapDurationMs: 300000,
        reconnectCount: 2,
      },
    };

    const mismatches = checkWebSocketGap(wsContext, observedAt);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!).toMatchObject({
      mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
      severity: "ERROR",
    });
  });

  it("bootstrap 이후 이벤트만 있고 disconnect 없으면 mismatch 없음", () => {
    const wsContext: ReconcileWebSocketContext = {
      bootstrapCompleteAt: "2026-06-02T12:00:00.000Z",
      events: [
        {
          type: "myOrder",
          occurredAt: "2026-06-02T12:01:00.000Z",
          payload: {},
        },
      ],
    };

    const mismatches = checkWebSocketGap(wsContext, observedAt);

    expect(mismatches).toHaveLength(0);
  });
});

/* ============================================================
 * Engine Integration Tests
 * ============================================================ */

describe("runReconcileEngine — 전체 orchestrator", () => {
  const defaultWindow: ReconcileClosedOrderWindow = {
    windowStart: "2026-05-26T00:00:00.000Z",
    windowEnd: "2026-06-02T00:00:00.000Z",
    windowExhausted: false,
    queryCount: 1,
  };

  const defaultWsContext: ReconcileWebSocketContext = {
    bootstrapCompleteAt: observedAt,
    events: [],
  };

  it("모든 snapshot이 일치하면 CLEAN 결과와 failClosed=false 반환", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "matched-1",
          exchangeStatus: "wait",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "local-matched-1",
          identifier: "matched-1",
          status: "ACCEPTED",
        }),
      ],
      localBalances: [
        {
          currency: "KRW",
          available: "1000000",
          locked: "10000",
          total: "1010000",
          updatedAt: observedAt,
        },
      ],
      exchangeBalances: [
        {
          currency: "KRW",
          available: "1000000",
          locked: "10000",
          total: "1010000",
          updatedAt: observedAt,
        },
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.summary).toMatchObject({
      result: "CLEAN",
      mismatchCount: 0,
    });
    expect(output.failClosed).toBe(false);
    expect(output.targetKillSwitchState).toBeUndefined();
  });

  it("UNTRACKED_EXCHANGE_OPEN_ORDER → WARN이어도 failClosed=true, NEW_ORDERS_BLOCKED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "untracked-1",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.summary.result).toBe("MISMATCH_DETECTED");
    expect(output.mismatches).toHaveLength(1);
    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("NEW_ORDERS_BLOCKED");
  });

  it("PARTIAL_FILL_MISMATCH → WARN이어도 failClosed=true, NEW_ORDERS_BLOCKED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "partial-warn",
          remainingQuantity: "0.0003",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "local-partial-warn",
          identifier: "partial-warn",
          remainingQuantity: "0.0005",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mismatchType: "PARTIAL_FILL_MISMATCH",
          severity: "WARN",
        }),
      ]),
    );
    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("NEW_ORDERS_BLOCKED");
  });

  it("LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE → failClosed=true, NEW_ORDERS_BLOCKED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "orphan-1",
          status: "ACCEPTED",
          identifier: "orphan-1",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("NEW_ORDERS_BLOCKED");
  });

  it("CANCEL_FAILURE_RETRY_NEEDED → failClosed=true, MANUAL_REVIEW_REQUIRED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "cancel-fail",
          exchangeStatus: "wait",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "local-cf",
          status: "CANCEL_REQUESTED",
          identifier: "cancel-fail",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("EXCHANGE_CANCEL_STATE_MISMATCH → failClosed=true, MANUAL_REVIEW_REQUIRED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [],
      exchangeClosedOrders: [
        createExchangeOrder({
          source: "closed",
          identifier: "manual-cancel-engine",
          exchangeStatus: "cancel",
        }),
      ],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "local-manual-cancel-engine",
          status: "ACCEPTED",
          identifier: "manual-cancel-engine",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mismatchType: "EXCHANGE_CANCEL_STATE_MISMATCH",
        }),
      ]),
    );
    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("BALANCE_LOCK_MISMATCH → failClosed=true, MANUAL_REVIEW_REQUIRED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [],
      localBalances: [
        {
          currency: "KRW",
          available: "1000000",
          locked: "99999",
          total: "1099999",
          updatedAt: observedAt,
        },
      ],
      exchangeBalances: [
        {
          currency: "KRW",
          available: "1000000",
          locked: "99999",
          total: "1099999",
          updatedAt: observedAt,
        },
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("WEBSOCKET_GAP_MANUAL_REVIEW → failClosed=true, MANUAL_REVIEW_REQUIRED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: {
        events: [],
        disconnectEvidence: {
          disconnectedAt: observedAt,
          gapDurationMs: 60000,
        },
      },
      localOpenOrders: [],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("CLOSED_ORDER_WINDOW_EXCEEDED → WARN이어도 failClosed=true, MANUAL_REVIEW_REQUIRED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "old-order",
          status: "ACCEPTED",
          createdAt: "2026-05-20T00:00:00.000Z",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.summary.result).toBe("MISMATCH_DETECTED");
    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("bootstrap 이전 WebSocket 이벤트 → WARN이어도 failClosed=true, MANUAL_REVIEW_REQUIRED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: {
        bootstrapCompleteAt: observedAt,
        events: [
          {
            type: "myOrder",
            occurredAt: "2026-06-02T11:59:00.000Z",
            payload: {},
          },
        ],
      },
      localOpenOrders: [],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
          severity: "WARN",
        }),
      ]),
    );
    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("복합 mismatch — ERROR+CANCEL_FAILURE가 우선하여 MANUAL_REVIEW_REQUIRED", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "cf-1",
          exchangeStatus: "wait",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "local-cf-1",
          status: "CANCEL_REQUESTED",
          identifier: "cf-1",
        }),
        createLocalOrder({
          orderId: "orphan",
          status: "ACCEPTED",
          identifier: "orphan-x",
        }),
      ],
      localBalances: [
        {
          currency: "KRW",
          available: "1000000",
          locked: "50000",
          total: "1050000",
          updatedAt: observedAt,
        },
      ],
      exchangeBalances: [
        {
          currency: "KRW",
          available: "1000000",
          locked: "50000",
          total: "1050000",
          updatedAt: observedAt,
        },
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    // CANCEL_FAILURE가 MANUAL_REVIEW_REQUIRED로 승격
    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
    // 4개 mismatch: cancel failure + missing local + balance lock + (untracked는 없음)
    expect(output.summary.mismatchCount).toBeGreaterThanOrEqual(3);
  });

  it("복합 mismatch — 수동 검토 상태를 이후 LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE가 낮추지 않는다", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "cancel-then-missing",
          exchangeStatus: "wait",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "local-cancel-first",
          status: "CANCEL_REQUESTED",
          identifier: "cancel-then-missing",
        }),
        createLocalOrder({
          orderId: "local-missing-after",
          status: "ACCEPTED",
          identifier: "missing-after",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mismatchType: "CANCEL_FAILURE_RETRY_NEEDED" }),
        expect.objectContaining({ mismatchType: "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE" }),
      ]),
    );
    expect(output.failClosed).toBe(true);
    expect(output.targetKillSwitchState).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("state advancements가 identity-matched pair에 대해 올바르게 생성된다", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "done-order",
          exchangeStatus: "done",
          remainingQuantity: "0",
        }),
        createExchangeOrder({
          source: "open",
          identifier: "cancel-req",
          exchangeStatus: "cancel",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "local-done",
          status: "ACCEPTED",
          identifier: "done-order",
        }),
        createLocalOrder({
          orderId: "local-cancel",
          status: "CANCEL_REQUESTED",
          identifier: "cancel-req",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.stateAdvancements).toHaveLength(2);
    expect(output.stateAdvancements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localOrderId: "local-done",
          advancementType: "FILL_CANDIDATE",
          targetLocalStatus: "FILLED",
        }),
        expect.objectContaining({
          localOrderId: "local-cancel",
          advancementType: "CANCEL_CANDIDATE",
          targetLocalStatus: "CANCELED",
        }),
      ]),
    );
  });

  it("summary에 mismatch count와 분류별 통계가 포함된다", () => {
    const input: ReconcileEngineInput = {
      exchangeOpenOrders: [
        createExchangeOrder({
          source: "open",
          identifier: "u-1",
          market: "KRW-ETH",
        }),
        createExchangeOrder({
          source: "open",
          identifier: "u-2",
          market: "KRW-XRP",
        }),
      ],
      exchangeClosedOrders: [],
      orderLookups: [],
      websocketContext: defaultWsContext,
      localOpenOrders: [
        createLocalOrder({
          orderId: "missing-1",
          status: "ACCEPTED",
          identifier: "m-1",
        }),
      ],
      closedOrderWindow: defaultWindow,
      observedAt,
    };

    const output = runReconcileEngine(input);

    expect(output.summary).toMatchObject({
      result: "MISMATCH_DETECTED",
      mismatchCount: 3,
      untrackedExchangeOrders: 2,
      missingLocalOrders: 1,
      openOrderCount: {
        exchange: 2,
        local: 1,
      },
    });
  });
});

/* ============================================================
 * Test Fixtures
 * ============================================================ */

type OptionalPropertyKeys<T extends object> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? K : never;
}[keyof T];

type FixtureOverrides<T extends object> = Omit<
  Partial<T>,
  OptionalPropertyKeys<T>
> & {
  [K in OptionalPropertyKeys<T>]?: T[K] | undefined;
};

function createExchangeOrder(
  overrides: FixtureOverrides<ReconcileExchangeOrderSnapshot> = {},
): ReconcileExchangeOrderSnapshot {
  const base: ReconcileExchangeOrderSnapshot = {
    identifier: "test-exchange-order",
    market: "KRW-BTC",
    side: "BUY",
    exchangeStatus: "wait",
    requestedQuantity: "0.001",
    requestedPrice: "10000000",
    source: "open",
    capturedAt: observedAt,
  };

  return applyFixtureOverrides(base, overrides);
}

function createLocalOrder(
  overrides: FixtureOverrides<ReconcileLocalOrderSnapshot> = {},
): ReconcileLocalOrderSnapshot {
  const base: ReconcileLocalOrderSnapshot = {
    orderId: "test-local-order",
    identifier: "test-local-order",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    status: "ACCEPTED",
    requestedQuantity: "0.001",
    remainingQuantity: "0.001",
    requestedPrice: "10000000",
    updatedAt: observedAt,
  };

  return applyFixtureOverrides(base, overrides);
}

function applyFixtureOverrides<T extends object>(
  base: T,
  overrides: FixtureOverrides<T>,
): T {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
