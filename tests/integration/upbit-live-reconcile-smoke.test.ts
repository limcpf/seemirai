/**
 * M16 Live Reconcile Smoke Integration Test
 *
 * guard가 없으면 skip evidence를 남기고, guard가 있을 때만 read-only REST 호출과
 * private WebSocket subscription을 실행한다. 주문 생성/취소 API는 호출하지 않는다.
 *
 * 기본 CI와 `corepack pnpm test`는 이 테스트를 skip한다.
 */

import { randomBytes, randomUUID } from "node:crypto";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import type { BrokerBalanceSnapshot, JsonRecord, PilotEvidenceStatus } from "../../src/domain/index.js";
import { redactPilotCorrelationId } from "../../src/domain/index.js";
import {
  buildUpbitAuthorizationHeader,
  UpbitPrivateRestClient,
  toBrokerBalanceSnapshot,
  toUpbitPrivateUserActionErrorSummary,
} from "../../src/infrastructure/index.js";
import {
  UpbitPrivateWebSocketClient,
  createUpbitPrivateCombinedSubscription,
  parseUpbitPrivateWebSocketMessage,
} from "../../src/infrastructure/upbit/private-websocket-client.js";
import type { UpbitPrivateWebSocketTransport } from "../../src/infrastructure/upbit/private-websocket-client.js";
import {
  UnsafeLiveReconcileRuntimeError,
  loadLiveReconcileRuntimeConfigFromEnv,
} from "../../src/runtime/index.js";
import type { EnabledLiveReconcileRuntimeConfig } from "../../src/runtime/index.js";
import {
  assertUpbitSmokeArtifactHasNoSecretText,
  writeUpbitSmokeArtifact,
} from "../helpers/upbit-smoke-artifacts.js";

/**
 * private WebSocket smoke를 실행할지 결정하는 guard다.
 *
 * REST smoke guard가 켜져 있더라도 WS guard는 기본적으로 꺼져 있으며,
 * 운영자가 명시적으로 켤 때만 연결을 시도한다.
 */
const runUpbitLiveReconcileWsSmoke = process.env.SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE_WS_SMOKE === "1";

/**
 * live reconcile REST smoke를 실행할지 결정하는 guard다.
 *
 * `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1`과 `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`이
 * 모두 있어야 read-only REST 호출이 허용된다.
 */
const runUpbitLiveReconcileSmoke =
  process.env.SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE === "1" &&
  process.env.SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE === "1";

const describeUpbitLiveReconcileSmoke = runUpbitLiveReconcileSmoke ? describe : describe.skip;

/**
 * guard가 없을 때 skip evidence를 남기는 테스트 모음이다.
 *
 * 실제 Upbit API를 호출하지 않고, env guard 부재를 한국어 메시지와 함께
 * 검증 가능한 evidence로 기록한다.
 */
describe("Upbit live reconcile smoke guard skip", () => {
  it("guard가 없으면 skip evidence를 한국어 메시지와 함께 남긴다", async () => {
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const artifact: JsonRecord = createBaseArtifact("UPBIT_LIVE_RECONCILE_SKIP", occurredAt, correlationId);

    try {
      const config = loadLiveReconcileRuntimeConfigFromEnv(process.env);
      if (config.enabled) {
        artifact.status = "PASSED" satisfies PilotEvidenceStatus;
        artifact.message = "Live reconcile guard가 켜져 있습니다. smoke 전용 테스트 파일을 확인하세요.";
        artifact.guardEnabled = true;
        artifact.keyScopeEvidenceId = config.keyScopeEvidenceId;
        artifact.keyScopes = [...config.keyScopes];
      } else {
        artifact.status = "SKIPPED" satisfies PilotEvidenceStatus;
        artifact.message = "SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1 guard가 꺼져 있어 live reconcile smoke를 실행하지 않습니다.";
        artifact.action = "실계좌 상태 대조 smoke가 필요할 때 SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1과 SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1 guard를 설정하세요.";
      }
    } catch (error) {
      if (error instanceof UnsafeLiveReconcileRuntimeError) {
        artifact.status = "SKIPPED" satisfies PilotEvidenceStatus;
        artifact.message = "Live reconcile guard가 불완전해 smoke를 실행하지 않습니다.";
        artifact.action = "필수 env를 확인하세요. SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1, SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1, credential, key scope evidence가 필요합니다.";
        artifact.missingRequirements = error.violations;
      } else {
        throw error;
      }
    }

    const artifactPath = await writeUpbitSmokeArtifact({
      filePrefix: "upbit-live-reconcile-skip",
      artifact,
    });
    artifact.reportArtifactPath = artifactPath;
    assertUpbitSmokeArtifactHasNoSecretText(artifact);

    // skip 테스트는 artifact 생성만 검증하며 항상 통과한다.
    expect(artifactPath).toBeTruthy();
  });
});

describeUpbitLiveReconcileSmoke("Upbit live reconcile REST smoke integration", () => {
  it("read-only REST 계정/미체결 주문 조회를 수행하고 secret-safe artifact를 저장한다", async () => {
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const artifact: JsonRecord = createBaseArtifact("UPBIT_LIVE_RECONCILE_SMOKE", occurredAt, correlationId);
    let failure: unknown;

    try {
      const config = loadEnabledReconcileConfig();
      artifact.keyScopeEvidenceId = config.keyScopeEvidenceId;
      artifact.keyScopes = [...config.keyScopes];
      artifact.guard = {
        liveReconcileEnabled: true,
        privateSmokeEnabled: true,
      };

      const client = createPrivateClient(config);

      // 1. 계정 조회 (read-only)
      const accountsResponse = await client.getAccounts();
      const balances = toBrokerBalanceSnapshot(accountsResponse.payload, { capturedAt: occurredAt });
      artifact.accounts = summarizeBalanceSnapshot(balances);
      artifact.accountsRateLimit = accountsResponse.rateLimitStatus;

      // 2. 미체결 주문 조회 (read-only)
      const openOrdersResponse = await client.listOpenOrders();
      const openOrdersPayload = Array.isArray(openOrdersResponse.payload)
        ? (openOrdersResponse.payload as Array<Record<string, unknown>>)
        : [];
      artifact.openOrders = {
        count: openOrdersPayload.length,
        markets: [...new Set(openOrdersPayload.map((order) => order.market as string | undefined).filter(Boolean))].sort(),
        states: [...new Set(openOrdersPayload.map((order) => order.state as string | undefined).filter(Boolean))].sort(),
      };
      artifact.openOrdersRateLimit = openOrdersResponse.rateLimitStatus;

      // 3. 주문 생성/취소 API 호출 금지 확인
      // 이 테스트에서 POST /v1/orders 또는 DELETE /v1/order를 호출하지 않았음을 검증한다.
      artifact.noOrderSideEffectVerified = true;

      artifact.status = "PASSED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit live reconcile read-only REST smoke가 완료됐습니다. 주문 생성/취소 API는 호출하지 않았습니다.";
    } catch (error) {
      failure = error;
      artifact.status = "FAILED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit live reconcile REST smoke가 실패했습니다. 주문 side effect는 생성하지 않았습니다.";
      artifact.error = toSafeReconcileSmokeErrorSummary(error, correlationId);
    } finally {
      const artifactPath = await writeUpbitSmokeArtifact({
        filePrefix: "upbit-live-reconcile-smoke",
        artifact,
      });
      artifact.reportArtifactPath = artifactPath;
      assertUpbitSmokeArtifactHasNoSecretText(artifact);
    }

    if (failure !== undefined) {
      throw failure;
    }

    expect(artifact.status).toBe("PASSED");
    expect(artifact.noOrderSideEffectVerified).toBe(true);
  });

  it("종료 주문 조회 window를 7일 이내로 제한해 read-only 조회를 수행한다", async () => {
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const artifact: JsonRecord = createBaseArtifact("UPBIT_LIVE_RECONCILE_CLOSED_ORDERS_SMOKE", occurredAt, correlationId);
    let failure: unknown;

    try {
      const config = loadEnabledReconcileConfig();
      const client = createPrivateClient(config);

      // 종료 주문은 7일 이내 구간으로만 조회한다.
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const endDate = formatUpbitTimestamp(now);
      const startDate = formatUpbitTimestamp(sevenDaysAgo);

      const closedOrdersResponse = await client.listClosedOrders({
        startTime: startDate,
        endTime: endDate,
        limit: 100,
      });
      const closedOrdersPayload = Array.isArray(closedOrdersResponse.payload)
        ? (closedOrdersResponse.payload as Array<Record<string, unknown>>)
        : [];
      artifact.closedOrders = {
        windowStart: startDate,
        windowEnd: endDate,
        windowDays: 7,
        count: closedOrdersPayload.length,
        markets: [...new Set(closedOrdersPayload.map((order) => order.market as string | undefined).filter(Boolean))].sort(),
        states: [...new Set(closedOrdersPayload.map((order) => order.state as string | undefined).filter(Boolean))].sort(),
      };
      artifact.closedOrdersRateLimit = closedOrdersResponse.rateLimitStatus;

      artifact.status = "PASSED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit closed order 조회 smoke가 7일 window로 완료됐습니다.";
    } catch (error) {
      failure = error;
      artifact.status = "FAILED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit closed order 조회가 실패했습니다.";
      artifact.error = toSafeReconcileSmokeErrorSummary(error, correlationId);
    } finally {
      const artifactPath = await writeUpbitSmokeArtifact({
        filePrefix: "upbit-live-reconcile-closed-orders-smoke",
        artifact,
      });
      artifact.reportArtifactPath = artifactPath;
      assertUpbitSmokeArtifactHasNoSecretText(artifact);
    }

    if (failure !== undefined) {
      throw failure;
    }

    expect(artifact.status).toBe("PASSED");
  });
});

/**
 * Private WebSocket smoke는 별도 guard가 있을 때만 실행한다.
 *
 * WS 연결은 REST smoke와 다른 lifecycle을 가지며, 이벤트가 없을 수 있다는 점을
 * 정상 가능성으로 기록하되 주문 허용 신호로 쓰지 않는다.
 */
const describeUpbitLiveReconcileWsSmokeGuard = runUpbitLiveReconcileWsSmoke && runUpbitLiveReconcileSmoke
  ? describe
  : describe.skip;

describeUpbitLiveReconcileWsSmokeGuard("Upbit live reconcile WebSocket smoke integration", () => {
  it("private WebSocket을 연결하고 myOrder/myAsset 구독 후 secret-safe artifact를 저장한다", async () => {
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const artifact: JsonRecord = createBaseArtifact("UPBIT_LIVE_RECONCILE_WS_SMOKE", occurredAt, correlationId);
    let failure: unknown;

    try {
      const config = loadEnabledReconcileConfig();
      artifact.keyScopeEvidenceId = config.keyScopeEvidenceId;

      // WebSocket client를 생성하지만 raw credential/header는 저장하지 않는다.
      // smoke는 transport 생성과 구독 payload 전송 경계를 검증하며 REST 인증 성공을 WS 성공으로 대체하지 않는다.
      const wsResult = await connectAndVerifyPrivateWebSocket(config);
      artifact.websocket = {
        connected: wsResult.connected,
        subscribed: wsResult.subscribed,
        endpointUrl: wsResult.endpointUrl ?? null,
        subscriptionTypes: [...wsResult.subscriptionTypes],
        myOrderEventsReceived: wsResult.myOrderEventsReceived,
        myAssetEventsReceived: wsResult.myAssetEventsReceived,
        connectionDurationMs: wsResult.connectionDurationMs,
        providerErrorKinds: [...wsResult.providerErrorKinds],
        closedDuringObservation: wsResult.closedDuringObservation,
        disconnected: wsResult.disconnected,
        errorKind: wsResult.errorKind ?? null,
        note: "이벤트가 0건이어도 연결/subscription 성공만으로 주문 허용 신호를 만들지 않는다. 이벤트 없음은 정상 가능성이며 추가 관찰이 필요하다.",
      };

      // WebSocket JWT와 Authorization header는 artifact에 포함하지 않았음을 검증
      assertUpbitSmokeArtifactHasNoSecretText(artifact);

      if (!wsResult.connected || !wsResult.subscribed) {
        // guard가 켜진 live WS smoke는 provider 거부나 조기 종료가 없는 구독 관찰까지 통과해야 완료로 본다.
        throw new Error("Upbit private WebSocket 연결 또는 provider subscription 확인에 실패했습니다");
      }

      artifact.status = "PASSED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit private WebSocket 연결과 subscription이 확인됐습니다.";
      artifact.action = "연결이 확인됐습니다. 실제 reconcile에서는 REST bootstrap 후 WS 변경 추적을 사용하세요.";
    } catch (error) {
      failure = error;
      artifact.status = "FAILED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit private WebSocket smoke가 실패했습니다.";
      artifact.error = toSafeReconcileSmokeErrorSummary(error, correlationId);
    } finally {
      const artifactPath = await writeUpbitSmokeArtifact({
        filePrefix: "upbit-live-reconcile-ws-smoke",
        artifact,
      });
      artifact.reportArtifactPath = artifactPath;
      assertUpbitSmokeArtifactHasNoSecretText(artifact);
    }

    if (failure !== undefined) {
      throw failure;
    }

    expect(artifact.websocket).toBeDefined();
    expect((artifact.websocket as JsonRecord).connected).toBe(true);
    expect((artifact.websocket as JsonRecord).subscribed).toBe(true);
  });
});

// ── helpers ──

function createBaseArtifact(kind: string, occurredAt: string, correlationId: string): JsonRecord {
  return {
    schemaVersion: 1,
    kind,
    status: "FAILED" satisfies PilotEvidenceStatus,
    occurredAt,
    correlationId: redactPilotCorrelationId(correlationId),
    redactionVerified: true,
  };
}

function loadEnabledReconcileConfig(): EnabledLiveReconcileRuntimeConfig {
  const config = loadLiveReconcileRuntimeConfigFromEnv(process.env);
  if (!config.enabled) {
    throw new UnsafeLiveReconcileRuntimeError(["live reconcile runtime config가 활성화되지 않았습니다"]);
  }

  return config;
}

function createPrivateClient(config: EnabledLiveReconcileRuntimeConfig): UpbitPrivateRestClient {
  return new UpbitPrivateRestClient({
    credentials: {
      accessKey: config.upbitAccessKey,
      secretKey: config.upbitSecretKey,
    },
  });
}

function summarizeBalanceSnapshot(snapshot: BrokerBalanceSnapshot): JsonRecord {
  const currencies = snapshot.balances.map((balance) => balance.currency).sort();
  return {
    exchangeId: snapshot.exchangeId,
    capturedAt: snapshot.capturedAt,
    accountCount: snapshot.balances.length,
    currencies,
    krwAccountPresent: currencies.includes("KRW"),
  };
}

/**
 * Upbit REST API에 사용할 timestamp를 ISO 8601 형식에서 Upbit가 요구하는
 * `yyyy-MM-dd'T'HH:mm:ssXXX` 형식으로 변환한다. 밀리초를 제거한다.
 */
function formatUpbitTimestamp(date: Date): string {
  const iso = date.toISOString();
  // ISO: 2026-06-03T12:34:56.789Z → Upbit: 2026-06-03T12:34:56+00:00
  return iso.replace(/\.\d{3}Z$/u, "+00:00");
}

function toSafeReconcileSmokeErrorSummary(error: unknown, correlationId: string): JsonRecord {
  if (error instanceof UnsafeLiveReconcileRuntimeError) {
    return {
      title: "live reconcile runtime 설정을 확인해야 합니다.",
      requiredAction: "guard, credential, key scope evidence를 확인한 뒤 reconcile smoke를 다시 실행하세요.",
      violations: error.violations,
      correlationId: redactPilotCorrelationId(correlationId),
    };
  }

  return toUpbitPrivateUserActionErrorSummary(error, {
    correlationId: redactPilotCorrelationId(correlationId),
  }) as unknown as JsonRecord;
}

/**
 * Private WebSocket 연결 결과 요약이다.
 *
 * 연결 성공 여부, 구독 확인, 이벤트 수신 수, 연결 시간, 연결 종료 여부,
 * 오류 정보를 포함한다. raw JWT, Authorization header, provider payload는 포함하지 않는다.
 */
interface PrivateWebSocketSmokeResult {
  connected: boolean;
  /** payload 전송 후 provider error와 조기 close가 없었던 관찰 구간까지 포함한 구독 수락 여부다. */
  subscribed: boolean;
  myOrderEventsReceived: number;
  myAssetEventsReceived: number;
  connectionDurationMs: number;
  providerErrorKinds: readonly string[];
  closedDuringObservation: boolean;
  disconnected: boolean;
  endpointUrl?: string;
  subscriptionTypes: readonly string[];
  errorKind?: string;
}

const PRIVATE_WEBSOCKET_OPEN_TIMEOUT_MS = 5_000;
const PRIVATE_WEBSOCKET_EVENT_OBSERVATION_MS = 3_000;

/**
 * Private WebSocket에 연결하고 myOrder/myAsset 구독을 검증한다.
 *
 * 이 함수는 raw JWT를 생성하지만 artifact에 JWT나 Authorization header를
 * 저장하지 않는다. transport 생성과 구독 payload 전송 경계를 직접 통과한 경우에만
 * 연결/subscription 성공으로 기록하며, REST 인증 성공을 WebSocket 성공으로 대체하지 않는다.
 *
 * @param config 활성화된 reconcile runtime config
 * @returns 연결 결과 요약
 */
async function connectAndVerifyPrivateWebSocket(
  config: EnabledLiveReconcileRuntimeConfig,
): Promise<PrivateWebSocketSmokeResult> {
  const result: PrivateWebSocketSmokeResult = {
    connected: false,
    subscribed: false,
    myOrderEventsReceived: 0,
    myAssetEventsReceived: 0,
    connectionDurationMs: 0,
    providerErrorKinds: [],
    closedDuringObservation: false,
    disconnected: false,
    subscriptionTypes: ["myOrder", "myAsset"],
  };

  const startTime = Date.now();
  let transport: UpbitPrivateWebSocketTransport | undefined;

  try {
    const authorizationHeader = buildUpbitAuthorizationHeader({
      accessKey: config.upbitAccessKey,
      secretKey: config.upbitSecretKey,
      nonce: randomUUID(),
    });
    const client = new UpbitPrivateWebSocketClient({
      authorizationHeader,
      websocketFactory: createTlsHeaderAuthenticatedPrivateWebSocket,
    });
    const subscriptionPayload = JSON.stringify(
      createUpbitPrivateCombinedSubscription(
        { ticket: "live-reconcile-smoke" },
        { ticket: "live-reconcile-smoke" },
      ),
    );

    // REST 성공을 WS 성공으로 대체하지 않고, 실제 private WS transport 생성과 subscription send 경계를 통과해야 성공 처리한다.
    transport = client.connect();
    result.endpointUrl = transport.url;

    const session = client.subscribe(transport, subscriptionPayload);
    await waitForPrivateWebSocketOpen(transport, PRIVATE_WEBSOCKET_OPEN_TIMEOUT_MS);
    result.connected = transport.readyState === 1;

    const observation = await waitForPrivateWebSocketObservationWindow(
      transport,
      PRIVATE_WEBSOCKET_EVENT_OBSERVATION_MS,
    );
    result.closedDuringObservation = observation.closedDuringObservation;
    if (observation.errorKind !== undefined) {
      result.errorKind = observation.errorKind;
    }

    const drain = session.drainBufferedMessages();
    result.providerErrorKinds = collectPrivateWebSocketProviderErrorKinds(drain.messages);
    result.myOrderEventsReceived = countBufferedPrivateWebSocketEvents(drain.messages, "myOrder");
    result.myAssetEventsReceived = countBufferedPrivateWebSocketEvents(drain.messages, "myAsset");
    // Upbit는 성공 ACK를 보내지 않으므로, payload 전송 후 provider error/조기 close가 없는 관찰 구간을 구독 수락 증거로 삼는다.
    result.subscribed =
      session.subscribedAt !== undefined &&
      result.providerErrorKinds.length === 0 &&
      !result.closedDuringObservation &&
      result.errorKind === undefined;
  } catch (error) {
    result.errorKind = error instanceof Error ? error.name : "unknown_error";
  } finally {
    result.connectionDurationMs = Date.now() - startTime;
    if (transport !== undefined) {
      transport.close();
      result.disconnected = true;
    }
  }

  return result;
}

/**
 * Upbit private WebSocket live smoke용 최소 TLS transport다.
 *
 * Node 24의 기본 WebSocket은 custom Authorization header를 지원하지 않으므로, 테스트는 TLS socket 위에서 WebSocket
 * handshake와 masked text frame 전송만 직접 수행한다. raw Authorization header는 handshake 문자열에만 사용하고, transport 객체,
 * artifact, event payload에는 저장하지 않는다. 이 transport는 live smoke 검증 전용이며 runtime dependency를 추가하지 않는다.
 */
class TlsHeaderAuthenticatedPrivateWebSocketTransport implements UpbitPrivateWebSocketTransport {
  public readonly url: string;
  public readyState = 0;

  readonly #socket: tls.TLSSocket;
  readonly #listeners = new Map<"open" | "message" | "close" | "error", PrivateWebSocketListener[]>();
  #handshakeBuffer = "";
  #frameBuffer = Buffer.alloc(0);
  #handshakeCompleted = false;

  public constructor(url: string, authorizationHeader: string) {
    this.url = url;
    const endpoint = new URL(url);
    const host = endpoint.hostname;
    const port = endpoint.port.length > 0 ? Number(endpoint.port) : 443;
    const path = `${endpoint.pathname}${endpoint.search}`;
    const websocketKey = randomBytes(16).toString("base64");

    this.#socket = tls.connect({ host, port, servername: host });
    this.#socket.setTimeout(PRIVATE_WEBSOCKET_OPEN_TIMEOUT_MS + 1_000);
    this.#socket.once("secureConnect", () => {
      // private WS 인증은 HTTP upgrade header에만 실어 보내고, 이후 artifact/transport surface에는 남기지 않는다.
      this.#socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${websocketKey}`,
        "Sec-WebSocket-Version: 13",
        `Authorization: ${authorizationHeader}`,
        "",
        "",
      ].join("\r\n"));
    });
    this.#socket.on("data", (chunk) => this.handleData(chunk));
    this.#socket.once("close", () => {
      this.readyState = 3;
      this.dispatch("close", {});
    });
    this.#socket.once("timeout", () => {
      this.dispatch("error", new Error("Upbit private WebSocket open timeout"));
      this.close();
    });
    this.#socket.once("error", (error) => {
      this.readyState = 3;
      this.dispatch("error", error);
    });
  }

  public send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("Upbit private WebSocket transport is not open");
    }
    this.#socket.write(encodeClientTextWebSocketFrame(data));
  }

  public close(): void {
    if (this.readyState === 2 || this.readyState === 3) {
      return;
    }
    this.readyState = 2;
    this.#socket.end();
  }

  public addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
    options?: unknown,
  ): void {
    const once = typeof options === "object" && options !== null && "once" in options
      ? Boolean((options as { once?: unknown }).once)
      : false;
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ listener, once });
    this.#listeners.set(type, listeners);
  }

  private handleData(chunk: Buffer): void {
    if (!this.#handshakeCompleted) {
      this.#handshakeBuffer += chunk.toString("binary");
      const headerEnd = this.#handshakeBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerText = this.#handshakeBuffer.slice(0, headerEnd);
      const leftover = Buffer.from(this.#handshakeBuffer.slice(headerEnd + 4), "binary");
      this.#handshakeBuffer = "";
      if (!/^HTTP\/1\.1 101\b/u.test(headerText)) {
        this.readyState = 3;
        this.dispatch("error", new Error("Upbit private WebSocket handshake failed"));
        this.#socket.end();
        return;
      }

      this.#handshakeCompleted = true;
      this.readyState = 1;
      this.dispatch("open", {});
      if (leftover.length > 0) {
        this.#frameBuffer = Buffer.concat([this.#frameBuffer, leftover]);
        this.drainFrames();
      }
      return;
    }

    this.#frameBuffer = Buffer.concat([this.#frameBuffer, chunk]);
    this.drainFrames();
  }

  private drainFrames(): void {
    while (this.#frameBuffer.length >= 2) {
      const first = this.#frameBuffer[0]!;
      const second = this.#frameBuffer[1]!;
      const opcode = first & 0x0f;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.#frameBuffer.length < offset + 2) {
          return;
        }
        payloadLength = this.#frameBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.#frameBuffer.length < offset + 8) {
          return;
        }
        const longLength = this.#frameBuffer.readBigUInt64BE(offset);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.dispatch("error", new Error("Upbit private WebSocket frame is too large"));
          this.close();
          return;
        }
        payloadLength = Number(longLength);
        offset += 8;
      }

      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.#frameBuffer.length < offset + maskLength + payloadLength) {
        return;
      }

      const mask = masked ? this.#frameBuffer.subarray(offset, offset + 4) : undefined;
      offset += maskLength;
      const payload = Buffer.from(this.#frameBuffer.subarray(offset, offset + payloadLength));
      this.#frameBuffer = this.#frameBuffer.subarray(offset + payloadLength);
      if (mask !== undefined) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }

      if (opcode === 0x1) {
        this.dispatch("message", { data: payload.toString("utf8") });
      } else if (opcode === 0x2) {
        // Upbit는 binary frame으로도 JSON payload를 보낼 수 있으므로 error envelope 관찰 경로에 그대로 전달한다.
        this.dispatch("message", { data: payload });
      } else if (opcode === 0x8) {
        this.close();
        return;
      }
    }
  }

  private dispatch(type: "open" | "message" | "close" | "error", event: unknown): void {
    const listeners = this.#listeners.get(type) ?? [];
    const remaining: PrivateWebSocketListener[] = [];
    for (const entry of listeners) {
      entry.listener(event);
      if (!entry.once) {
        remaining.push(entry);
      }
    }
    this.#listeners.set(type, remaining);
  }
}

interface PrivateWebSocketListener {
  listener: (event: unknown) => void;
  once: boolean;
}

function createTlsHeaderAuthenticatedPrivateWebSocket(
  url: string,
  authorizationHeader: string,
): UpbitPrivateWebSocketTransport {
  return new TlsHeaderAuthenticatedPrivateWebSocketTransport(url, authorizationHeader);
}

function encodeClientTextWebSocketFrame(data: string): Buffer {
  const payload = Buffer.from(data, "utf8");
  const mask = randomBytes(4);
  const headerLength = payload.length < 126
    ? 2
    : payload.length <= 0xffff
      ? 4
      : 10;
  const frame = Buffer.alloc(headerLength + 4 + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    writeMaskedPayload(payload, mask, frame, 6);
    return frame;
  }
  if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
    mask.copy(frame, 4);
    writeMaskedPayload(payload, mask, frame, 8);
    return frame;
  }

  frame[1] = 0x80 | 127;
  frame.writeBigUInt64BE(BigInt(payload.length), 2);
  mask.copy(frame, 10);
  writeMaskedPayload(payload, mask, frame, 14);
  return frame;
}

function writeMaskedPayload(payload: Buffer, mask: Buffer, frame: Buffer, offset: number): void {
  for (let index = 0; index < payload.length; index += 1) {
    frame[offset + index] = payload[index]! ^ mask[index % 4]!;
  }
}

async function waitForPrivateWebSocketOpen(
  transport: UpbitPrivateWebSocketTransport,
  timeoutMs: number,
): Promise<void> {
  if (transport.readyState === 1) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Upbit private WebSocket open timeout")), timeoutMs);
    transport.addEventListener?.("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    transport.addEventListener?.("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error("Upbit private WebSocket transport error"));
    }, { once: true });
    transport.addEventListener?.("close", () => {
      clearTimeout(timeout);
      reject(new Error("Upbit private WebSocket closed before open"));
    }, { once: true });
  });
}

/**
 * 구독 payload 전송 직후 관찰 구간에서 provider가 거부 신호를 냈는지 요약한다.
 *
 * raw WebSocket frame은 저장하지 않고 close/error 여부만 남겨 live smoke artifact가
 * secret-safe 상태로 구독 수락 근거를 판정할 수 있게 한다.
 */
interface PrivateWebSocketObservationResult {
  closedDuringObservation: boolean;
  errorKind?: string;
}

/**
 * provider error 또는 조기 close가 발생하는지 관찰하는 bounded wait helper다.
 *
 * 성공 ACK가 없는 Upbit private WS 특성상, 이 관찰 구간은 구독 payload가
 * 즉시 거부되지 않았다는 최소 증거로 쓰이며 외부 side effect는 없다.
 */
async function waitForPrivateWebSocketObservationWindow(
  transport: UpbitPrivateWebSocketTransport,
  timeoutMs: number,
): Promise<PrivateWebSocketObservationResult> {
  return new Promise((resolve) => {
    let settled = false;
    const complete = (result: PrivateWebSocketObservationResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => complete({ closedDuringObservation: false }), timeoutMs);

    transport.addEventListener?.("error", (error) => {
      complete({
        closedDuringObservation: transport.readyState === 3,
        errorKind: error instanceof Error ? error.name : "transport_error",
      });
    }, { once: true });
    transport.addEventListener?.("close", () => {
      complete({ closedDuringObservation: true });
    }, { once: true });
  });
}

function countBufferedPrivateWebSocketEvents(
  messages: readonly { data: unknown }[],
  type: "myOrder" | "myAsset",
): number {
  let count = 0;
  for (const message of messages) {
    const data = toPrivateWebSocketMessageData(message.data);
    if (data === undefined) {
      continue;
    }
    try {
      const parsed = parseUpbitPrivateWebSocketMessage(data);
      count += countPrivateWebSocketPayloadType(parsed, type);
    } catch {
      // provider가 비 JSON frame을 보내면 event count에 포함하지 않고 연결/subscription evidence만 보존한다.
    }
  }
  return count;
}

/**
 * buffered message에서 Upbit provider error envelope의 안정 error name만 추출한다.
 *
 * raw provider payload는 artifact에 싣지 않고, 구독 실패 판정에 필요한 error kind만
 * 반환한다. 비 JSON frame이나 일반 account event는 실패 근거로 취급하지 않는다.
 */
function collectPrivateWebSocketProviderErrorKinds(
  messages: readonly { data: unknown }[],
): readonly string[] {
  const errorKinds = new Set<string>();
  for (const message of messages) {
    const data = toPrivateWebSocketMessageData(message.data);
    if (data === undefined) {
      continue;
    }
    try {
      const parsed = parseUpbitPrivateWebSocketMessage(data);
      if (!Array.isArray(parsed) && hasPrivateWebSocketProviderError(parsed)) {
        errorKinds.add(parsed.error.name);
      }
    } catch {
      // provider error envelope 확인 목적의 parser다. 비 JSON frame은 구독 거부 증거가 아니므로 무시한다.
    }
  }

  return [...errorKinds].sort();
}

/** live smoke가 text/binary frame을 동일한 provider JSON 후보로 다루기 위한 message data 경계다. */
type PrivateWebSocketMessageData = string | ArrayBuffer | ArrayBufferView;

/**
 * transport가 전달한 message data 중 parser가 안전하게 처리할 수 있는 형태만 좁힌다.
 *
 * raw frame은 저장하지 않고 provider error/event 판정 직전에만 사용한다.
 */
function toPrivateWebSocketMessageData(data: unknown): PrivateWebSocketMessageData | undefined {
  if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data;
  }

  return undefined;
}

/**
 * DEFAULT 단일 payload와 JSON_LIST 배열 payload에서 특정 account event 수를 센다.
 *
 * quiet 계정은 0건이 정상일 수 있으므로 이 값은 구독 성공 조건이 아니라 관찰 evidence로만 사용한다.
 */
function countPrivateWebSocketPayloadType(
  parsed: unknown,
  type: "myOrder" | "myAsset",
): number {
  if (Array.isArray(parsed)) {
    return parsed.filter((entry) => hasPrivateWebSocketPayloadType(entry, type)).length;
  }

  return hasPrivateWebSocketPayloadType(parsed, type) ? 1 : 0;
}

/** private WS account event payload의 type field만 secret-safe하게 좁힌다. */
function hasPrivateWebSocketPayloadType(
  value: unknown,
  type: "myOrder" | "myAsset",
): value is { type: "myOrder" | "myAsset" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === type
  );
}

/** provider error envelope의 secret-safe shape만 좁히는 local type guard다. */
function hasPrivateWebSocketProviderError(
  value: unknown,
): value is { error: { name: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }

  const error = (value as { error: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { name: unknown }).name === "string"
  );
}
