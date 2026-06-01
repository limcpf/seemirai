import type { ExchangeId, TimestampInput } from "../../../domain/index.js";
import type { UpbitRateLimitStatus } from "../rate-limit.js";
import type { UpbitPrivateErrorKind } from "../private-client.js";

/**
 * Upbit private payload를 domain contract로 정규화할 때 필요한 호출 경계 옵션이다.
 *
 * mapper는 외부 API를 호출하지 않고, 이미 받은 provider payload를 검증해 domain snapshot으로 바꾼다. `capturedAt`은
 * 계정/주문 가능 정보/주문 조회 payload가 관측된 시각이며, 같은 smoke evidence 안에서는 동일한 기준 시각을 유지해야 한다.
 */
export interface MapUpbitPrivatePayloadOptions {
  exchangeId?: ExchangeId;
  capturedAt: TimestampInput;
}

/**
 * Upbit private payload mapper가 구분하는 원천 schema 이름이다.
 *
 * schema 이름은 raw provider payload 대신 audit trace와 테스트에서 어느 경계가 실패했는지 표현하는 안정 식별자다.
 */
export type UpbitPrivatePayloadSchemaName =
  | "ACCOUNTS"
  | "ORDER_CHANCE"
  | "ORDER_LOOKUP"
  | "OPEN_ORDERS";

/**
 * Upbit private 오류 요약에 포함할 선택 추적 입력이다.
 *
 * `correlationId`는 smoke run 또는 audit event와 연결하기 위한 값이며, access key, JWT, Authorization header처럼
 * 민감한 인증 자료를 넣지 않는 invariant를 유지해야 한다.
 */
export interface CreateUpbitPrivateErrorSummaryOptions {
  correlationId?: string;
}

/**
 * Upbit private 오류의 사용자 표면과 분리된 추적 정보다.
 *
 * 운영자가 재현과 감사에 필요한 HTTP status, Upbit error name, rate-limit 상태, 로컬 위반 사항만 보존한다. raw provider body,
 * raw header, secret, JWT는 이 trace에 들어가면 안 된다.
 */
export interface UpbitPrivateErrorSummaryTrace {
  kind: UpbitPrivateErrorKind | "UNSAFE_REQUEST" | "PAYLOAD_MAPPING_FAILED" | "UNKNOWN";
  httpStatus?: number;
  upbitErrorName?: string;
  rateLimitStatus?: UpbitRateLimitStatus;
  violations?: readonly string[];
  payloadSchema?: UpbitPrivatePayloadSchemaName;
  payloadIssuePaths?: readonly string[];
  correlationId?: string;
}

/**
 * Upbit private 실패를 사용자 행동 언어와 추적 정보로 나눈 safe summary다.
 *
 * `title`, `message`, `requiredAction`은 운영자가 바로 읽는 한국어 표면이고, 안정 식별자는 `trace` 아래로 분리한다. 이 구조는
 * `/status`, CLI, smoke artifact, audit summary에서 secret 없이 같은 메시지 contract를 재사용하기 위한 값이다.
 */
export interface UpbitPrivateUserActionErrorSummary {
  title: string;
  message: string;
  requiredAction: string;
  trace: UpbitPrivateErrorSummaryTrace;
}

/**
 * private payload mapping 실패 오류 생성 입력이다.
 *
 * provider payload 원문은 계정/주문 세부값을 포함할 수 있으므로 오류에는 schema 이름과 문제가 난 path만 남기고 raw 값을
 * 보존하지 않는다.
 */
export interface UpbitPrivatePayloadMappingErrorOptions {
  schema: UpbitPrivatePayloadSchemaName;
  userMessage: string;
  issuePaths: readonly string[];
}
