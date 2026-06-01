import type { ExchangeId, JsonRecord, TimestampInput } from "../../domain/index.js";
import type {
  PilotRuntimeConfig,
  PilotRuntimeProfile,
  PilotUpbitKeyScope,
} from "../pilot-config.js";
import type {
  UpbitLiveBroker,
  UpbitLiveBrokerPrivateClient,
  UpbitPrivateCredentials,
} from "../../infrastructure/upbit/index.js";

/**
 * UpbitLiveBroker runtime factory가 private client를 만드는 경계다.
 *
 * production은 credential을 받아 `UpbitPrivateRestClient`를 생성하고, test는 fake client를 주입해 실제 private API 호출 없이
 * guard 조건만 검증한다. 함수 호출 자체는 network side effect를 만들지 않아야 하며, 반환된 client method 호출만 외부 API
 * side effect를 만들 수 있다.
 */
export type UpbitLiveBrokerPrivateClientFactory = (
  credentials: UpbitPrivateCredentials,
) => UpbitLiveBrokerPrivateClient;

/**
 * guarded UpbitLiveBroker runtime을 생성할 때 필요한 입력이다.
 *
 * `liveBrokerEnabled=true`와 M14 pilot order-smoke guard가 모두 있어야만 broker가 조립된다. credential 원문은 factory
 * 내부 client 생성에만 사용하고 summary/log/status로 반환하지 않는 invariant를 유지한다.
 */
export interface CreateGuardedUpbitLiveBrokerRuntimeInput {
  liveBrokerEnabled: boolean;
  pilotConfig: PilotRuntimeConfig;
  privateClientFactory?: UpbitLiveBrokerPrivateClientFactory;
  exchangeId?: ExchangeId;
  clock?: () => TimestampInput;
}

/**
 * guarded UpbitLiveBroker runtime factory의 반환 contract다.
 *
 * `broker`는 실제 private API side effect를 만들 수 있는 adapter이고, `summary`는 운영자 표면에 노출 가능한 secret-safe
 * 상태다. 호출자는 summary만 log/status/report에 전달해야 하며 broker와 credential은 runtime 내부에만 둔다.
 */
export interface GuardedUpbitLiveBrokerRuntime {
  broker: UpbitLiveBroker;
  summary: UpbitLiveBrokerRuntimeSafeSummary;
}

/**
 * UpbitLiveBroker runtime safe summary 생성 입력이다.
 *
 * factory 성공/실패와 무관하게 현재 guard 상태를 secret 없이 설명하기 위한 순수 변환 입력이며, 외부 API 호출 side effect는
 * 없다.
 */
export interface CreateUpbitLiveBrokerRuntimeSafeSummaryInput {
  liveBrokerEnabled: boolean;
  pilotConfig: PilotRuntimeConfig;
}

/**
 * UpbitLiveBroker runtime 상태를 사용자 표면에 노출하기 위한 secret-safe 요약이다.
 *
 * access key, secret key, JWT, Authorization header는 포함하지 않고, 필요한 조치와 추적 가능한 guard evidence id만 남긴다.
 * 이 contract 자체는 외부 side effect가 없다.
 */
export interface UpbitLiveBrokerRuntimeSafeSummary {
  enabled: boolean;
  profile: PilotRuntimeProfile | null;
  privateSmokeEnabled: boolean;
  orderSmokeEnabled: boolean;
  credentialsConfigured: boolean;
  keyScopes: readonly PilotUpbitKeyScope[];
  keyScopeEvidenceId: string | null;
  statusLabel: string;
  message: string;
  action: string | null;
  trace: JsonRecord;
}

/**
 * UpbitLiveBroker runtime guard가 broker 조립 전 차단한 오류다.
 *
 * violations는 운영자가 env/profile/scope evidence를 수정할 수 있는 한국어 원인 목록이며, 이 오류가 발생한 경우 private
 * client factory를 호출하지 않는 invariant를 유지한다. 외부 API side effect는 없다.
 */
export class UnsafeUpbitLiveBrokerRuntimeError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`안전하지 않은 Upbit live broker runtime 설정: ${violations.join(", ")}`);
    this.name = "UnsafeUpbitLiveBrokerRuntimeError";
    this.violations = violations;
  }
}
