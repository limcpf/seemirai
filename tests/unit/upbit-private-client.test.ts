import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  UnsafeUpbitPrivateRequestError,
  UpbitPrivateRestClient,
  UpbitPrivateRestClientError,
  UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH,
  buildUpbitQueryString,
  buildUpbitUrlQueryString,
  createUpbitJwtToken,
  createUpbitQueryHash,
} from "../../src/infrastructure/upbit/index.js";
import type { UpbitJwtPayload } from "../../src/infrastructure/upbit/index.js";

const credentials = {
  accessKey: "pilot-access-key",
  secretKey: "pilot-secret-key",
};

describe("Upbit private JWT auth", () => {
  it("separates raw query_hash input from URL-encoded query strings", () => {
    expect(
      buildUpbitQueryString([
        { key: "market", value: "KRW-BTC" },
        { key: "states[]", value: ["wait", "watch"] },
        { key: "identifier", value: "smoke:run/001, waiting" },
        { key: "limit", value: 10 },
      ]),
    ).toBe("market=KRW-BTC&states[]=wait&states[]=watch&identifier=smoke:run/001, waiting&limit=10");
    expect(
      buildUpbitUrlQueryString([
        { key: "market", value: "KRW-BTC" },
        { key: "states[]", value: ["wait", "watch"] },
        { key: "identifier", value: "smoke:run/001, waiting" },
        { key: "limit", value: 10 },
      ]),
    ).toBe("market=KRW-BTC&states[]=wait&states[]=watch&identifier=smoke%3Arun%2F001%2C%20waiting&limit=10");
  });

  it("creates HS512 JWT payloads with SHA512 query_hash when query params exist", () => {
    const queryString = "market=KRW-BTC";
    const token = createUpbitJwtToken({
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
      nonce: "nonce-001",
      queryString,
    });
    const decoded = decodeJwt(token);

    expect(decoded.header).toEqual({
      alg: "HS512",
      typ: "JWT",
    });
    expect(decoded.payload).toEqual({
      access_key: credentials.accessKey,
      nonce: "nonce-001",
      query_hash: createHash("sha512").update(queryString, "utf8").digest("hex"),
      query_hash_alg: "SHA512",
    });
    expect(decoded.signature).toBe(
      createHmac("sha512", credentials.secretKey).update(decoded.signingInput, "utf8").digest("base64url"),
    );
  });

  it("omits query_hash for private endpoints without query params", () => {
    const decoded = decodeJwt(
      createUpbitJwtToken({
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey,
        nonce: "nonce-002",
      }),
    );

    expect(decoded.payload).toEqual({
      access_key: credentials.accessKey,
      nonce: "nonce-002",
    });
    expect(decoded.payload.query_hash).toBeUndefined();
    expect(decoded.payload.query_hash_alg).toBeUndefined();
  });
});

describe("Upbit private REST client foundation", () => {
  it("calls accounts with Bearer JWT and no query hash", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "accounts-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse([{ currency: "KRW", balance: "50000" }], "group=exchange; min=1800; sec=29");
      },
    });

    const response = await client.getAccounts();
    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));

    expect(capturedRequest).toMatchObject({
      url: "https://api.upbit.com/v1/accounts",
      method: "GET",
    });
    expect(decoded.payload).toMatchObject({
      access_key: credentials.accessKey,
      nonce: "accounts-nonce",
    });
    expect(decoded.payload.query_hash).toBeUndefined();
    expect(response.payload).toEqual([{ currency: "KRW", balance: "50000" }]);
    expect(response.remainingReq).toMatchObject({
      group: "exchange",
      sec: 29,
    });
  });

  it("uses the same query string for orders/chance URL and JWT hash", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "chance-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse({ market: { id: "KRW-BTC" } }, "group=order; min=1800; sec=7");
      },
    });

    await client.getOrderChance("KRW-BTC");

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    expect(capturedRequest?.url).toBe("https://api.upbit.com/v1/orders/chance?market=KRW-BTC");
    expect(decoded.payload).toMatchObject({
      nonce: "chance-nonce",
      query_hash: createUpbitQueryHash("market=KRW-BTC"),
      query_hash_alg: "SHA512",
    });
    expect(decoded.signingInput).not.toContain(credentials.secretKey);
  });

  it("hashes order lookup identifiers before URL encoding", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "lookup-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse({ uuid: "order-uuid" }, "group=order; min=1800; sec=6");
      },
    });

    await client.getOrder({ identifier: "smoke:run/001, waiting" });

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    expect(capturedRequest?.url).toBe(
      "https://api.upbit.com/v1/order?identifier=smoke%3Arun%2F001%2C%20waiting",
    );
    expect(decoded.payload).toMatchObject({
      nonce: "lookup-nonce",
      query_hash: createUpbitQueryHash("identifier=smoke:run/001, waiting"),
      query_hash_alg: "SHA512",
    });
  });

  it("lists open orders with states array hashed before URL encoding", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "open-orders-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    await client.listOpenOrders({
      market: "KRW-BTC",
      states: ["wait", "watch"],
      page: 2,
      limit: 50,
      orderBy: "asc",
    });

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    const expectedQueryString = "market=KRW-BTC&states[]=wait&states[]=watch&page=2&limit=50&order_by=asc";

    expect(capturedRequest).toMatchObject({
      url: "https://api.upbit.com/v1/orders/open?market=KRW-BTC&states[]=wait&states[]=watch&page=2&limit=50&order_by=asc",
      method: "GET",
    });
    expect(decoded.payload).toMatchObject({
      nonce: "open-orders-nonce",
      query_hash: createUpbitQueryHash(expectedQueryString),
      query_hash_alg: "SHA512",
    });
  });

  it("defaults open order listing to wait and watch states", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "open-orders-default-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    await client.listOpenOrders();

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    const expectedQueryString = "states[]=wait&states[]=watch";

    expect(capturedRequest?.url).toBe("https://api.upbit.com/v1/orders/open?states[]=wait&states[]=watch");
    expect(decoded.payload).toMatchObject({
      nonce: "open-orders-default-nonce",
      query_hash: createUpbitQueryHash(expectedQueryString),
      query_hash_alg: "SHA512",
    });
  });

  it("fails locally before fetch when open order list inputs are unsafe", async () => {
    let fetchCalls = 0;
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () => {
        fetchCalls += 1;
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    await expect(
      client.listOpenOrders({ states: ["done" as "wait"], limit: 101, page: 0, orderBy: "latest" as "asc" }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: [
        "체결 대기 주문 조회 states[]는 wait 또는 watch만 허용합니다",
        "체결 대기 주문 조회 page는 1 이상의 정수여야 합니다",
        "체결 대기 주문 조회 limit은 100 이하여야 합니다",
        "체결 대기 주문 조회 order_by는 asc 또는 desc 여야 합니다",
      ],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(client.listOpenOrders({ states: [] })).rejects.toMatchObject({
      violations: ["체결 대기 주문 조회 states[]는 비어 있을 수 없습니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    expect(fetchCalls).toBe(0);
  });

  it("fails locally before fetch when order lookup identifiers are unsafe", async () => {
    let fetchCalls = 0;
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () => {
        fetchCalls += 1;
        return jsonResponse({}, "group=order; min=1800; sec=7");
      },
    });

    await expect(client.getOrder({ uuid: "order-uuid", identifier: "order-identifier" })).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["주문 조회 식별자는 uuid 또는 identifier 중 하나만 지정해야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(client.getOrder({})).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["주문 조회에는 uuid 또는 identifier가 필요합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    expect(fetchCalls).toBe(0);
  });

  it("creates limit orders with JSON body params hashed in the JWT payload", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "create-order-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse({ uuid: "order-uuid", identifier: "m14smoke000000000000000001" }, "group=order; min=1800; sec=7");
      },
    });

    await client.createLimitOrder({
      market: "KRW-BTC",
      side: "bid",
      volume: "0.0001",
      price: "50000000",
      identifier: "m14smoke000000000000000001",
      timeInForce: "post_only",
    });

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    const expectedQueryString =
      "market=KRW-BTC&side=bid&volume=0.0001&price=50000000&ord_type=limit&identifier=m14smoke000000000000000001&time_in_force=post_only";

    expect(capturedRequest).toMatchObject({
      url: "https://api.upbit.com/v1/orders",
      method: "POST",
      body: JSON.stringify({
        market: "KRW-BTC",
        side: "bid",
        volume: "0.0001",
        price: "50000000",
        ord_type: "limit",
        identifier: "m14smoke000000000000000001",
        time_in_force: "post_only",
      }),
    });
    expect(capturedRequest?.headers.get("content-type")).toBe("application/json");
    expect(decoded.payload).toMatchObject({
      nonce: "create-order-nonce",
      query_hash: createUpbitQueryHash(expectedQueryString),
      query_hash_alg: "SHA512",
    });
  });

  it("cancels orders by the same identifier with URL query params hashed before encoding", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "cancel-order-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse({ uuid: "order-uuid", state: "cancel" }, "group=order; min=1800; sec=6");
      },
    });

    await client.cancelOrder({ identifier: "smoke:run/001, cancel" });

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    expect(capturedRequest).toMatchObject({
      url: "https://api.upbit.com/v1/order?identifier=smoke%3Arun%2F001%2C%20cancel",
      method: "DELETE",
    });
    expect(decoded.payload).toMatchObject({
      nonce: "cancel-order-nonce",
      query_hash: createUpbitQueryHash("identifier=smoke:run/001, cancel"),
      query_hash_alg: "SHA512",
    });
  });

  it("lists closed orders with default done and cancel states hashed before URL encoding", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "closed-orders-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    await client.listClosedOrders();

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    const expectedQueryString = "states[]=done&states[]=cancel";

    expect(capturedRequest).toMatchObject({
      url: "https://api.upbit.com/v1/orders/closed?states[]=done&states[]=cancel",
      method: "GET",
    });
    expect(decoded.payload).toMatchObject({
      nonce: "closed-orders-nonce",
      query_hash: createUpbitQueryHash(expectedQueryString),
      query_hash_alg: "SHA512",
    });
  });

  it("lists closed orders with single state and timestamp params hash before URL encoding", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "closed-orders-ts-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    await client.listClosedOrders({
      market: "KRW-BTC",
      state: "done",
      limit: 100,
      orderBy: "desc",
      startTime: "2026-06-01T00:00:00.000Z",
      endTime: "2026-06-02T00:00:00.000Z",
    });

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    const expectedQueryString =
      "market=KRW-BTC&state=done&limit=100&order_by=desc&start_time=1780272000000&end_time=1780358400000";

    expect(capturedRequest?.url).toBe(
      "https://api.upbit.com/v1/orders/closed?market=KRW-BTC&state=done&limit=100&order_by=desc&start_time=1780272000000&end_time=1780358400000",
    );
    expect(decoded.payload).toMatchObject({
      nonce: "closed-orders-ts-nonce",
      query_hash: createUpbitQueryHash(expectedQueryString),
      query_hash_alg: "SHA512",
    });
  });

  it("lists closed orders with numeric timestamps", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "closed-orders-num-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    await client.listClosedOrders({
      startTime: 1746230400000,
      endTime: 1746316800000,
    });

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    const expectedQueryString = "states[]=done&states[]=cancel&start_time=1746230400000&end_time=1746316800000";

    expect(capturedRequest?.url).toBe(
      "https://api.upbit.com/v1/orders/closed?states[]=done&states[]=cancel&start_time=1746230400000&end_time=1746316800000",
    );
    expect(decoded.payload).toMatchObject({
      nonce: "closed-orders-num-nonce",
      query_hash: createUpbitQueryHash(expectedQueryString),
      query_hash_alg: "SHA512",
    });
  });

  it("lists closed orders with numeric timestamp strings", async () => {
    let capturedRequest: CapturedRequest | undefined;
    const client = new UpbitPrivateRestClient({
      credentials,
      nonceFactory: () => "closed-orders-num-string-nonce",
      fetchFn: async (input, init) => {
        capturedRequest = captureRequest(input, init);
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    await client.listClosedOrders({
      startTime: "1746230400000",
      endTime: "1746316800000",
    });

    const authorization = capturedRequest?.headers.get("authorization");
    const decoded = decodeJwt(readBearerToken(authorization));
    const expectedQueryString = "states[]=done&states[]=cancel&start_time=1746230400000&end_time=1746316800000";

    expect(capturedRequest?.url).toBe(
      "https://api.upbit.com/v1/orders/closed?states[]=done&states[]=cancel&start_time=1746230400000&end_time=1746316800000",
    );
    expect(decoded.payload).toMatchObject({
      nonce: "closed-orders-num-string-nonce",
      query_hash: createUpbitQueryHash(expectedQueryString),
      query_hash_alg: "SHA512",
    });
  });

  it("fails locally before fetch when closed order inputs are unsafe", async () => {
    let fetchCalls = 0;
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () => {
        fetchCalls += 1;
        return jsonResponse([], "group=default; min=1800; sec=29");
      },
    });

    // state와 states[] 동시 지정
    await expect(
      client.listClosedOrders({
        state: "done",
        states: ["cancel"],
      }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["종료 주문 조회 state와 states[]는 동시에 지정할 수 없습니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);

    // 빈 states[]
    await expect(
      client.listClosedOrders({ states: [] }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["종료 주문 조회 states[]는 비어 있을 수 없습니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);

    // limit 초과
    await expect(
      client.listClosedOrders({ limit: 1001 }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["종료 주문 조회 limit은 1000 이하여야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);

    // 유효하지 않은 상태
    await expect(
      client.listClosedOrders({ states: ["done" as "done", "invalid" as "done"] }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["종료 주문 조회 states[]는 done 또는 cancel만 허용합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);

    // limit이 양의 정수가 아님
    await expect(
      client.listClosedOrders({ limit: 0 }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["종료 주문 조회 limit는 1 이상의 정수여야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);

    // 종료 시각이 시작 시각보다 앞서면 reconcile window가 의미를 잃으므로 거래소 호출 전에 차단
    await expect(
      client.listClosedOrders({
        startTime: "2026-06-02T00:00:00.000Z",
        endTime: "2026-06-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["종료 주문 조회 end_time은 start_time 이후여야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);

    // Upbit closed order 조회는 7일 초과 window를 받으면 snapshot 신뢰성이 흔들리므로 fail-closed 한다.
    await expect(
      client.listClosedOrders({
        startTime: "2026-06-01T00:00:00.000Z",
        endTime: "2026-06-09T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["종료 주문 조회 start_time/end_time window는 7일 이하여야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);

    expect(fetchCalls).toBe(0);
  });

  it("fails locally before fetch when order create or cancel inputs are unsafe", async () => {
    let fetchCalls = 0;
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () => {
        fetchCalls += 1;
        return jsonResponse({}, "group=order; min=1800; sec=7");
      },
    });

    await expect(
      client.createLimitOrder({
        market: "KRW-BTC",
        side: "bid",
        volume: "0.0001",
        price: "50000000",
        identifier: "x".repeat(UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH + 1),
        timeInForce: "post_only",
      }),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: [`주문 생성 identifier는 ${UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH}자 이하여야 합니다`],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(
      client.createLimitOrder({
        market: "KRW-BTC",
        side: "bid",
        volume: "0.0001",
        price: "50000000",
        identifier: "m14smoke000000000000000001",
        timeInForce: "post_only",
        smpType: "cancel_maker",
      }),
    ).rejects.toMatchObject({
      violations: ["post_only 주문은 smp_type과 함께 사용할 수 없습니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(
      client.cancelOrder({ uuid: "order-uuid", identifier: "order-identifier" }),
    ).rejects.toMatchObject({
      violations: ["주문 취소 식별자는 uuid 또는 identifier 중 하나만 지정해야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(client.cancelOrder({})).rejects.toMatchObject({
      violations: ["주문 취소에는 uuid 또는 identifier가 필요합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    expect(fetchCalls).toBe(0);
  });

  it("normalizes permission failures without preserving raw provider body", async () => {
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () =>
        errorResponse(
          403,
          "Forbidden",
          { error: { name: "out_of_scope", message: "provider-secret-body" } },
          "group=exchange; min=1800; sec=28",
        ),
    });

    try {
      await client.getAccounts();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "UpbitPrivateRestClientError",
        status: 403,
        kind: "PERMISSION_DENIED",
        userMessage: "Upbit 권한이 부족합니다. pilot profile에 필요한 권한 증거를 다시 확인하세요.",
        trace: {
          httpStatus: 403,
          upbitErrorName: "out_of_scope",
        },
      } satisfies Partial<UpbitPrivateRestClientError>);
      expect(String(error)).not.toContain("provider-secret-body");
    }
  });

  it("classifies out_of_scope as permission failure even when Upbit returns 401", async () => {
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () =>
        errorResponse(
          401,
          "Unauthorized",
          { error: { name: "out_of_scope", message: "권한이 부족합니다" } },
          "group=exchange; min=1800; sec=0",
        ),
    });

    await expect(client.getAccounts()).rejects.toMatchObject({
      status: 401,
      kind: "PERMISSION_DENIED",
      userMessage: "Upbit 권한이 부족합니다. pilot profile에 필요한 권한 증거를 다시 확인하세요.",
      trace: {
        httpStatus: 401,
        upbitErrorName: "out_of_scope",
      },
    } satisfies Partial<UpbitPrivateRestClientError>);
  });

  it("keeps authentication failures ahead of exhausted Remaining-Req hints", async () => {
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () =>
        errorResponse(
          401,
          "Unauthorized",
          { error: { name: "invalid_access_key" } },
          "group=exchange; min=1800; sec=0",
        ),
    });

    await expect(client.getAccounts()).rejects.toMatchObject({
      status: 401,
      kind: "AUTHENTICATION_FAILED",
      rateLimitStatus: {
        kind: "THROTTLED",
        httpStatus: 429,
      },
    } satisfies Partial<UpbitPrivateRestClientError>);
  });

  it("normalizes fetch rejections without leaking raw network errors", async () => {
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () => {
        throw new TypeError("tls reset raw-provider-detail");
      },
    });

    try {
      await client.getAccounts();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "UpbitPrivateRestClientError",
        status: 0,
        kind: "REQUEST_FAILED",
        userMessage: "Upbit private API에 연결하지 못했습니다. 추가 요청을 중단하고 네트워크 상태를 확인하세요.",
      } satisfies Partial<UpbitPrivateRestClientError>);
      expect(String(error)).not.toContain("raw-provider-detail");
    }
  });

  it("wraps malformed Remaining-Req headers as private provider response errors", async () => {
    const client = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          statusText: "OK",
          headers: {
            "content-type": "application/json",
            "remaining-req": "malformed-raw-header",
          },
        }),
    });

    try {
      await client.getAccounts();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "UpbitPrivateRestClientError",
        status: 200,
        kind: "INVALID_PROVIDER_RESPONSE",
        userMessage: "Upbit 요청 제한 헤더를 해석하지 못했습니다. 원문 헤더를 저장하지 않고 수동 확인으로 전환합니다.",
      } satisfies Partial<UpbitPrivateRestClientError>);
      expect(String(error)).not.toContain("malformed-raw-header");
    }
  });

  it("keeps rate-limit status on throttled and blocked responses", async () => {
    const throttledClient = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () =>
        errorResponse(
          429,
          "Too Many Requests",
          { error: { name: "too_many_requests" } },
          "group=order; min=1800; sec=0",
        ),
    });
    const blockedClient = new UpbitPrivateRestClient({
      credentials,
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { name: "too_many_requests" } }), {
          status: 418,
          statusText: "I'm a teapot",
          headers: {
            "content-type": "application/json",
            "remaining-req": "group=order; min=1800; sec=0",
            "retry-after": "60",
          },
        }),
    });

    await expect(throttledClient.getOrderChance("KRW-BTC")).rejects.toMatchObject({
      kind: "RATE_LIMIT_THROTTLED",
      rateLimitStatus: {
        kind: "THROTTLED",
        httpStatus: 429,
      },
    } satisfies Partial<UpbitPrivateRestClientError>);
    await expect(blockedClient.getOrderChance("KRW-BTC")).rejects.toMatchObject({
      kind: "RATE_LIMIT_BLOCKED",
      rateLimitStatus: {
        kind: "BLOCKED",
        httpStatus: 418,
        retryAfterSeconds: 60,
      },
    } satisfies Partial<UpbitPrivateRestClientError>);
  });
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

interface DecodedJwt {
  header: unknown;
  payload: UpbitJwtPayload;
  signature: string;
  signingInput: string;
}

function captureRequest(input: string | URL | Request, init: RequestInit | undefined): CapturedRequest {
  const request = input instanceof Request ? input : undefined;
  return {
    url: input.toString(),
    method: init?.method ?? request?.method ?? "GET",
    headers: new Headers(init?.headers ?? request?.headers),
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  };
}

function readBearerToken(authorization: string | null | undefined): string {
  if (authorization === null || authorization === undefined) {
    throw new Error("Authorization header missing");
  }

  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || token === undefined || token.length === 0) {
    throw new Error(`Unexpected Authorization header: ${authorization}`);
  }

  return token;
}

function decodeJwt(token: string): DecodedJwt {
  const [encodedHeader, encodedPayload, signature] = token.split(".");

  if (encodedHeader === undefined || encodedPayload === undefined || signature === undefined) {
    throw new Error(`Invalid JWT token: ${token}`);
  }

  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown,
    payload: JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as UpbitJwtPayload,
    signature,
    signingInput: `${encodedHeader}.${encodedPayload}`,
  };
}

function jsonResponse(payload: unknown, remainingReq: string): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "application/json",
      "remaining-req": remainingReq,
    },
  });
}

function errorResponse(status: number, statusText: string, payload: unknown, remainingReq: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    statusText,
    headers: {
      "content-type": "application/json",
      "remaining-req": remainingReq,
    },
  });
}
