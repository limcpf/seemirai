import type { TimestampInput } from "../../../domain/index.js";
import type {
  UpbitPrivateWebSocketBootstrapBufferOptions,
  UpbitPrivateWebSocketBootstrapGapEvidence,
  UpbitPrivateWebSocketBufferedMessage,
  UpbitPrivateWebSocketBufferedMessageDrain,
  UpbitPrivateWebSocketClientOptions,
  UpbitPrivateWebSocketFactory,
  UpbitPrivateWebSocketSubscriptionSession,
  UpbitPrivateWebSocketTransport,
} from "./types.js";
import { UPBIT_PRIVATE_WEBSOCKET_URL } from "./types.js";

/**
 * 기본 private WebSocket transport 생성 팩토리다.
 *
 * Authorization header를 transport 생성 시점에 전달한다.
 * 반환된 transport와 이후 event payload에 raw JWT나
 * Authorization header를 저장하지 않는 invariant를 유지한다.
 *
 * Node.js 24의 globalThis.WebSocket은 생성자 headers 옵션을
 * 지원하지 않으므로 이 기본 구현은 fail-fast한다.
 * runtime worker는 ws package 또는 headers를 지원하는
 * WebSocket 구현으로 factory를 교체해야 한다.
 *
 * raw token을 query string으로 대체하지 않는다.
 */
export function createDefaultUpbitPrivateWebSocket(
  url: string,
  authorizationHeader: string,
): UpbitPrivateWebSocketTransport {
  if (authorizationHeader.trim().length === 0) {
    throw new Error("Upbit private WebSocket requires non-empty Authorization header");
  }

  // globalThis.WebSocket은 생성자 headers 옵션을 지원하지 않으므로
  // Authorization header를 전달할 수 없다. raw token을 URL query나
  // path에 포함하지 않고 fail-closed 한다.
  throw new Error(
    "globalThis.WebSocket does not support custom headers. " +
    "Upbit private WebSocket requires Authorization header in the connection request. " +
    "Inject a WebSocket factory that supports headers (e.g., ws package or Node.js experimental). " +
    "See UpbitPrivateWebSocketFactory contract.",
  );
}

/**
 * Subscription-first bootstrap buffer다.
 *
 * WebSocket 구독 payload 전송 전 buffer를 먼저 열고, REST snapshot이
 * 끝날 때까지 들어온 message를 메모리에 보존한다. raw message는
 * drain caller에게만 반환하며, 상태/감사 로그에는 gap evidence만
 * 남겨 secret과 provider raw body가 요약 표면으로 전파되지 않는
 * invariant를 유지한다.
 */
export class UpbitPrivateWebSocketBootstrapBuffer implements UpbitPrivateWebSocketSubscriptionSession {
  public readonly bufferOpenedAt: string;
  readonly #now: () => TimestampInput;
  #subscribedAt: RecordedTimestamp | undefined;
  #snapshotStartedAt: RecordedTimestamp | undefined;
  #snapshotCompletedAt: RecordedTimestamp | undefined;
  #drainedAt: RecordedTimestamp | undefined;
  #isClosed = false;
  #lastBufferedMessageCount = 0;
  readonly #messages: UpbitPrivateWebSocketBufferedMessage[] = [];

  public constructor(options: UpbitPrivateWebSocketBootstrapBufferOptions = {}) {
    this.#now = options.now ?? defaultClock;
    const openedAt = recordTimestamp(this.#now());
    this.bufferOpenedAt = openedAt.value;
  }

  public get subscribedAt(): string | undefined {
    return this.#subscribedAt?.value;
  }

  public get snapshotStartedAt(): string | undefined {
    return this.#snapshotStartedAt?.value;
  }

  public get snapshotCompletedAt(): string | undefined {
    return this.#snapshotCompletedAt?.value;
  }

  /**
   * WebSocket 구독 payload 전송 완료를 기록한다.
   *
   * REST snapshot보다 구독 전송 확인이 먼저라는 evidence를 남기기
   * 위해 send 직후 또는 open event send 직후에만 호출한다.
   */
  public markSubscribed(observedAt: TimestampInput = this.#now()): UpbitPrivateWebSocketBootstrapGapEvidence {
    this.#subscribedAt = recordTimestamp(observedAt);
    return this.getGapEvidence();
  }

  public handleMessage(data: unknown, receivedAt: TimestampInput = this.#now()): void {
    if (this.#isClosed) {
      return;
    }

    this.#messages.push({ data, receivedAt: recordTimestamp(receivedAt).value });
    this.#lastBufferedMessageCount = this.#messages.length;
  }

  public markSnapshotStarted(observedAt: TimestampInput = this.#now()): UpbitPrivateWebSocketBootstrapGapEvidence {
    this.#snapshotStartedAt = recordTimestamp(observedAt);
    return this.getGapEvidence();
  }

  public markSnapshotCompleted(observedAt: TimestampInput = this.#now()): UpbitPrivateWebSocketBootstrapGapEvidence {
    this.#snapshotCompletedAt = recordTimestamp(observedAt);
    return this.getGapEvidence();
  }

  public drainBufferedMessages(observedAt: TimestampInput = this.#now()): UpbitPrivateWebSocketBufferedMessageDrain {
    if (this.#isClosed) {
      return {
        messages: [],
        evidence: this.getGapEvidence(),
      };
    }

    this.#drainedAt = recordTimestamp(observedAt);
    this.#lastBufferedMessageCount = this.#messages.length;
    this.#isClosed = true;
    const messages = this.#messages.splice(0);

    return {
      messages,
      evidence: this.getGapEvidence(),
    };
  }

  public getGapEvidence(): UpbitPrivateWebSocketBootstrapGapEvidence {
    const bufferedMessageCount = this.#messages.length > 0
      ? this.#messages.length
      : this.#lastBufferedMessageCount;
    const reasonCode = this.resolveReasonCode();
    const evidence = {
      bufferOpenedAt: this.bufferOpenedAt,
      bufferedMessageCount,
      hasBootstrapGap: reasonCode !== undefined,
      ...(this.#subscribedAt === undefined ? {} : { subscribedAt: this.#subscribedAt.value }),
      ...(this.#snapshotStartedAt === undefined ? {} : { snapshotStartedAt: this.#snapshotStartedAt.value }),
      ...(this.#snapshotCompletedAt === undefined ? {} : { snapshotCompletedAt: this.#snapshotCompletedAt.value }),
      ...(this.#drainedAt === undefined ? {} : { drainedAt: this.#drainedAt.value }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    };

    return evidence;
  }

  private resolveReasonCode(): UpbitPrivateWebSocketBootstrapGapEvidence["reasonCode"] {
    if (
      this.#snapshotStartedAt !== undefined &&
      (this.#subscribedAt === undefined || this.#snapshotStartedAt.epochMs < this.#subscribedAt.epochMs)
    ) {
      return "SUBSCRIPTION_NOT_CONFIRMED_BEFORE_SNAPSHOT";
    }

    if (this.#snapshotCompletedAt !== undefined && this.#drainedAt === undefined) {
      return "BUFFER_NOT_DRAINED";
    }

    return undefined;
  }
}

/**
 * Private WebSocket client다.
 *
 * Authorization header를 transport 생성 단계에만 전달하고,
 * 이후 event payload에는 secret을 포함하지 않는다.
 * runtime worker가 실제 message loop와 재연결 정책을
 * 이 client 위에 얹는다.
 *
 * test에서 websocketFactory를 주입해 인증 header 전달을
 * 검증할 수 있다.
 */
export class UpbitPrivateWebSocketClient {
  private readonly url: string;
  private readonly websocketFactory: UpbitPrivateWebSocketFactory;
  private readonly clock: () => TimestampInput;
  #authorizationHeader: string;

  public constructor(options: UpbitPrivateWebSocketClientOptions) {
    if (options.authorizationHeader.trim().length === 0) {
      throw new Error("Upbit private WebSocket requires Authorization header");
    }

    this.url = options.url ?? UPBIT_PRIVATE_WEBSOCKET_URL;
    this.#authorizationHeader = options.authorizationHeader;
    this.websocketFactory = options.websocketFactory ?? createDefaultUpbitPrivateWebSocket;
    this.clock = options.clock ?? defaultClock;
  }

  /**
   * Upbit private WebSocket 연결을 열고 transport를 반환한다.
   *
   * Authorization header는 factory에 전달되며, 반환된 transport나
   * 이후 event payload에 raw JWT/Authorization header를 저장하지
   * 않는 invariant를 유지한다.
   *
   * factory가 header 전달을 지원하지 않으면 fail-fast한다.
   */
  public connect(): UpbitPrivateWebSocketTransport {
    return this.websocketFactory(this.url, this.#authorizationHeader);
  }

  /**
   * 구독 payload를 transport로 전송하고 bootstrap buffer session을 반환한다.
   *
   * transport가 open 상태면 즉시 보내고, open event를 지원하면
   * 최초 open 시점에 전송한다. buffer는 send보다 먼저 열리며,
   * runtime worker는 REST snapshot 직전/직후에 session method를
   * 호출해 subscription-first gap evidence를 남겨야 한다.
   *
   * Authorization header는 이미 transport 생성 시점에 주입되었으므로
   * subscribe payload와 gap evidence에는 secret이 포함되지 않는다.
   */
  public subscribe(
    transport: UpbitPrivateWebSocketTransport,
    payload: string,
  ): UpbitPrivateWebSocketSubscriptionSession {
    const session = new UpbitPrivateWebSocketBootstrapBuffer({ now: this.clock });
    const send = (): void => {
      transport.send(payload);
      session.markSubscribed();
    };

    if (transport.addEventListener !== undefined) {
      // snapshot 이전 WebSocket account event 유실 여부를 증명하기 위해 구독 전부터 handler를 연결한다.
      transport.addEventListener("message", (event) => {
        session.handleMessage(readWebSocketMessageData(event));
      });
    }

    if (transport.readyState === 1 || transport.addEventListener === undefined) {
      send();
      return session;
    }

    transport.addEventListener("open", send, { once: true });
    return session;
  }
}

function defaultClock(): string {
  return new Date().toISOString();
}

interface RecordedTimestamp {
  value: string;
  epochMs: number;
}

function recordTimestamp(input: TimestampInput): RecordedTimestamp {
  const epochMs = input instanceof Date ? input.getTime() : Date.parse(input);

  if (!Number.isFinite(epochMs)) {
    throw new Error("Upbit private WebSocket timestamp must be a valid Date or ISO string");
  }

  return {
    value: new Date(epochMs).toISOString(),
    epochMs,
  };
}

function readWebSocketMessageData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data: unknown }).data;
  }

  return event;
}
