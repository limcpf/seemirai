import type { UpbitRateLimitStatus, UpbitRemainingReq } from "../rate-limit.js";

export const UPBIT_PRIVATE_API_BASE_URL = "https://api.upbit.com";
export const UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH = 32;

/**
 * Upbit private API 인증에 필요한 원문 credential이다.
 *
 * 호출 경계는 pilot runtime guard를 이미 통과한 owner-operated smoke runner다. 값은 JWT 서명에만 사용하고 로그,
 * audit, error, status payload에 직접 노출하지 않는 invariant를 유지해야 하며, 이 type 자체는 외부 side effect가 없다.
 */
export interface UpbitPrivateCredentials {
  accessKey: string;
  secretKey: string;
}

/**
 * Upbit JWT payload의 안정 필드다.
 *
 * query가 없는 private GET은 access key와 nonce만 포함하고, query/body가 있는 요청은 SHA512 query hash를 함께 넣는다.
 * 반환 값은 Authorization header 구성 직전의 내부 인증 자료이므로 로그에 남기지 않는다.
 */
export interface UpbitJwtPayload {
  access_key: string;
  nonce: string;
  query_hash?: string;
  query_hash_alg?: "SHA512";
}

/**
 * Upbit JWT 생성 입력이다.
 *
 * secret key와 query string은 서명/해시 계산에만 쓰인다. caller는 같은 query string을 실제 URL 또는 body와 일치시켜야 하며,
 * 이 contract는 외부 API 호출 side effect를 만들지 않는다.
 */
export interface CreateUpbitJwtTokenInput {
  accessKey: string;
  secretKey: string;
  nonce: string;
  queryString?: string;
}

/**
 * Upbit private REST 요청 method를 제한한다.
 *
 * private client 내부 호출 경계에서 사용하며, M14가 허용하는 read/order smoke endpoint method만 표현한다. 값 자체는
 * 외부 side effect를 만들지 않지만, 새로운 method를 추가할 때는 해당 endpoint의 guard와 audit 경계를 함께 검토해야 한다.
 */
export type UpbitPrivateRequestMethod = "GET" | "POST" | "DELETE";

/**
 * Upbit query string을 구성하는 scalar 값이다.
 *
 * query hash 입력은 문자열로 직렬화되므로 boolean/number도 안정 문자열로 변환된다. 객체 payload는 순서와 직렬화 방식이
 * 모호해 여기 포함하지 않으며, 외부 side effect는 없다.
 */
export type UpbitQueryParamValue = string | number | boolean;

/**
 * Upbit JWT query hash와 실제 요청 URL을 함께 구성하는 query 항목이다.
 *
 * key 순서와 중복 key는 query hash에 영향을 주므로 record 대신 순서 있는 배열을 사용한다. 배열 값은 같은 key를 반복해
 * `states[]=wait&states[]=watch` 같은 Upbit 형식을 만들며, 외부 side effect는 없다.
 */
export interface UpbitQueryParam {
  key: string;
  value: UpbitQueryParamValue | readonly UpbitQueryParamValue[];
}

/**
 * 순서가 보존된 Upbit query parameter 목록이다.
 *
 * caller는 이 배열을 URL query와 JWT query hash에 같은 순서로 사용해야 한다. 같은 key 반복을 허용해 Upbit 배열 query를
 * 표현하며, type 자체는 외부 side effect를 만들지 않는다.
 */
export type UpbitQueryParams = readonly UpbitQueryParam[];

/**
 * Upbit private API nonce 생성 경계다.
 *
 * production은 UUID 기반 nonce를 사용하고, test는 결정적 값을 주입해 JWT 서명 검증을 재현한다. nonce는 인증 재사용 방지
 * invariant를 담당하며, 함수 호출 자체는 외부 API side effect를 만들지 않는다.
 */
export type UpbitNonceFactory = () => string;

/**
 * Upbit private REST client 생성 옵션이다.
 *
 * production은 기본 base URL과 global fetch를 사용하고, test는 fetch와 nonce를 주입해 Authorization header를 결정적으로
 * 검증한다. credential은 raw secret이므로 client 밖으로 다시 반환하지 않는다.
 */
export interface UpbitPrivateRestClientOptions {
  credentials: UpbitPrivateCredentials;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  nonceFactory?: UpbitNonceFactory;
}

/**
 * Upbit private REST 응답 envelope이다.
 *
 * payload와 함께 `Remaining-Req` 기반 rate-limit 상태를 반환해 caller가 private smoke 재시도/차단 판단을 같은 근거로
 * 처리한다. payload는 아직 raw provider schema이며, sub PR 4 mapper에서 domain contract로 정규화한다.
 */
export interface UpbitPrivateRestResponse<TPayload> {
  payload: TPayload;
  remainingReq?: UpbitRemainingReq;
  rateLimitStatus: UpbitRateLimitStatus;
}

/**
 * read-only 개별 주문 조회 입력이다.
 *
 * Upbit API는 uuid 또는 identifier 중 하나만 받는다. 이 client는 주문 생성/취소 wrapper가 아니므로, 운영자가 넘긴 기존
 * 식별자는 조회에만 쓰이고 side effect를 만들지 않는다.
 */
export interface UpbitPrivateGetOrderInput {
  uuid?: string;
  identifier?: string;
}

/**
 * Upbit 체결 대기 주문 목록 조회가 허용하는 open order 상태다.
 *
 * 공식 API는 `wait`와 `watch`만 open order 목록에서 조회할 수 있다. M15 live broker는 미체결 주문과 예약 주문 대기를
 * 같은 broker surface에서 관측하기 위해 두 상태를 함께 조회할 수 있어야 하며, type 자체는 외부 side effect를 만들지 않는다.
 */
export type UpbitPrivateOpenOrderState = "wait" | "watch";

/**
 * Upbit 체결 대기 주문 목록 조회 정렬 방향이다.
 *
 * 거래소 API의 `order_by` query 값으로만 전달되며, pagination 순서가 바뀌면 reconcile 입력 순서도 바뀌므로 호출자가
 * 명시한 값만 통과시킨다. type 자체는 외부 side effect를 만들지 않는다.
 */
export type UpbitPrivateOpenOrdersOrderBy = "asc" | "desc";

/**
 * Upbit 체결 대기 주문 목록 조회 입력이다.
 *
 * `state` 단일 파라미터와 `states[]`는 동시에 사용할 수 없으므로 M15 client는 배열형 `states[]`만 지원한다. query 순서는
 * JWT hash와 URL query에 함께 쓰이므로 wrapper가 안정적인 순서로 직렬화해야 한다.
 */
export interface UpbitPrivateListOpenOrdersInput {
  market?: string;
  states?: readonly UpbitPrivateOpenOrderState[];
  page?: number;
  limit?: number;
  orderBy?: UpbitPrivateOpenOrdersOrderBy;
}

/**
 * Upbit 지정가 주문 생성 endpoint 입력이다.
 *
 * low-level private client는 Upbit 공식 `limit` 주문 payload만 만들고, M14 pilot의 KRW/소액/side/profile 제한은 runtime
 * order smoke guard가 별도로 보장한다. 이 입력은 실제 `POST /v1/orders` side effect 직전 경계이므로 raw secret을 포함하지
 * 않고, identifier는 계정 내 고유하고 32자 이하라는 invariant를 유지해야 한다.
 */
export interface UpbitPrivateCreateLimitOrderInput {
  market: string;
  side: "bid" | "ask";
  volume: string;
  price: string;
  identifier: string;
  timeInForce?: "ioc" | "fok" | "post_only";
  smpType?: "cancel_maker" | "cancel_taker" | "reduce";
}

/**
 * Upbit 개별 주문 취소 endpoint 입력이다.
 *
 * uuid 또는 identifier 중 정확히 하나만 허용해 임의 주문 취소를 거래소 호출 전 차단한다. 이 입력은 취소 side effect를
 * 만들 수 있는 경계에 전달되므로, pilot smoke에서는 같은 smoke run에서 생성한 identifier만 사용해야 한다.
 */
export interface UpbitPrivateCancelOrderInput {
  uuid?: string;
  identifier?: string;
}

/**
 * private API 실패를 운영자가 이해할 수 있는 분류로 정규화한 값이다.
 *
 * 내부 Upbit error name과 HTTP status는 trace에 분리하고, 사용자 표면은 한국어 조치 문구를 먼저 보여주기 위한 중간
 * contract다. 이 type 자체는 외부 side effect를 만들지 않는다.
 */
export type UpbitPrivateErrorKind =
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "RATE_LIMIT_THROTTLED"
  | "RATE_LIMIT_BLOCKED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_PROVIDER_RESPONSE"
  | "REQUEST_FAILED";

/**
 * private API 실패의 추적 정보다.
 *
 * raw Authorization header, JWT, secret, provider body는 넣지 않는다. 복구와 audit에 필요한 HTTP status, Upbit error name,
 * rate-limit 상태만 분리 보존한다.
 */
export interface UpbitPrivateErrorTrace {
  httpStatus?: number;
  upbitErrorName?: string;
  rateLimitStatus?: UpbitRateLimitStatus;
}

/**
 * Upbit private REST 실패 오류 생성 입력이다.
 *
 * 호출 경계는 provider 응답을 받은 직후의 client 내부이며, raw body나 raw Authorization header 없이 한국어 사용자 문구와
 * 추적 정보를 분리해 보존하는 invariant를 유지한다.
 */
export interface UpbitPrivateRestClientErrorOptions {
  status: number;
  statusText: string;
  kind: UpbitPrivateErrorKind;
  userMessage: string;
  rateLimitStatus: UpbitRateLimitStatus;
  trace: UpbitPrivateErrorTrace;
}

/**
 * Upbit private REST 호출 실패 오류다.
 *
 * 호출 경계는 private API wrapper 내부이며, 상위 runner는 `kind`, `userMessage`, `trace`만 사용해 수동 조치와 audit evidence를
 * 만든다. raw secret, JWT, Authorization header, provider body는 보존하지 않는 invariant를 유지한다.
 */
export class UpbitPrivateRestClientError extends Error {
  public readonly status: number;
  public readonly kind: UpbitPrivateErrorKind;
  public readonly userMessage: string;
  public readonly rateLimitStatus: UpbitRateLimitStatus;
  public readonly trace: UpbitPrivateErrorTrace;

  public constructor(options: UpbitPrivateRestClientErrorOptions) {
    super(`Upbit private API 요청 실패: ${options.userMessage}`);
    this.name = "UpbitPrivateRestClientError";
    this.status = options.status;
    this.kind = options.kind;
    this.userMessage = options.userMessage;
    this.rateLimitStatus = options.rateLimitStatus;
    this.trace = options.trace;
  }
}

/**
 * 로컬 fail-closed 요청 오류 생성 입력이다.
 *
 * 거래소 호출 전 발견한 위반 사항만 담아야 하며, 이 값을 만드는 동안 fetch나 DB write 같은 외부 side effect는 없어야 한다.
 */
export interface UnsafeUpbitPrivateRequestErrorOptions {
  violations: readonly string[];
}

/**
 * Upbit private API 호출 전 로컬 invariant 위반 오류다.
 *
 * uuid/identifier 동시 지정처럼 거래소 호출 전에 닫아야 하는 입력 문제를 표현한다. 이 오류가 발생하면 fetch를 호출하지
 * 않으며, 외부 side effect 없이 한국어 위반 목록만 반환한다.
 */
export class UnsafeUpbitPrivateRequestError extends Error {
  public readonly violations: readonly string[];

  public constructor(options: UnsafeUpbitPrivateRequestErrorOptions) {
    super(`안전하지 않은 Upbit private API 요청: ${options.violations.join(", ")}`);
    this.name = "UnsafeUpbitPrivateRequestError";
    this.violations = options.violations;
  }
}
