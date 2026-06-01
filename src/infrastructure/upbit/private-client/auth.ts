import { createHash, createHmac } from "node:crypto";
import type {
  CreateUpbitJwtTokenInput,
  UpbitJwtPayload,
  UpbitQueryParam,
  UpbitQueryParamValue,
  UpbitQueryParams,
} from "./types.js";

const UPBIT_JWT_HEADER = {
  alg: "HS512",
  typ: "JWT",
} as const;

/**
 * Upbit query hash 기준 문자열을 만든다.
 *
 * 호출자는 이 반환값을 URL query와 JWT `query_hash` 입력에 동일하게 사용해야 한다. 입력 순서와 중복 key를 보존해
 * Upbit 인증 서버가 계산하는 해시와 어긋나지 않게 하며, 외부 side effect는 없다.
 */
export function buildUpbitQueryString(params: UpbitQueryParams = []): string {
  return params.flatMap(toQueryStringEntries).join("&");
}

/**
 * Upbit JWT query hash를 생성한다.
 *
 * Upbit private API 문서 기준 SHA512 hex digest를 사용한다. 빈 query는 JWT payload에 넣지 않아야 하므로 caller가
 * 빈 문자열 여부를 판단한다.
 */
export function createUpbitQueryHash(queryString: string): string {
  return createHash("sha512").update(queryString, "utf8").digest("hex");
}

/**
 * Upbit private API용 JWT를 생성한다.
 *
 * access key와 nonce는 payload에, secret key는 HS512 서명에만 사용한다. query string이 있으면 SHA512 query hash를
 * 포함해 URL/body 변조를 인증 단계에서 감지하게 하며, 반환 token은 로그와 audit에 남기면 안 된다.
 */
export function createUpbitJwtToken(input: CreateUpbitJwtTokenInput): string {
  const payload: UpbitJwtPayload = {
    access_key: input.accessKey,
    nonce: input.nonce,
  };

  if (input.queryString !== undefined && input.queryString.length > 0) {
    payload.query_hash = createUpbitQueryHash(input.queryString);
    payload.query_hash_alg = "SHA512";
  }

  const signingInput = `${toBase64UrlJson(UPBIT_JWT_HEADER)}.${toBase64UrlJson(payload)}`;
  const signature = createHmac("sha512", input.secretKey).update(signingInput, "utf8").digest("base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Upbit Authorization header 값을 만든다.
 *
 * 호출자는 반환값을 HTTP header에만 사용해야 하며, 실패 trace나 로그에는 raw JWT를 남기지 않는다. 이 함수는 문자열 생성만
 * 수행하고 외부 side effect는 없다.
 */
export function buildUpbitAuthorizationHeader(input: CreateUpbitJwtTokenInput): string {
  return `Bearer ${createUpbitJwtToken(input)}`;
}

function toQueryStringEntries(param: UpbitQueryParam): readonly string[] {
  const values = Array.isArray(param.value) ? param.value : [param.value];
  return values.map((value) => `${encodeUpbitQueryPart(param.key)}=${encodeUpbitQueryPart(toQueryValue(value))}`);
}

function toQueryValue(value: UpbitQueryParamValue): string {
  return typeof value === "string" ? value : String(value);
}

function encodeUpbitQueryPart(value: string): string {
  return encodeURIComponent(value).replace(/%5B/gu, "[").replace(/%5D/gu, "]");
}

function toBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
