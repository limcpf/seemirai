import type { RateLimitPolicy } from "../../domain/index.js";

/**
 * Upbit REST 응답의 `Remaining-Req` 헤더를 정규화한 값이다.
 *
 * 업무 흐름상 scheduler는 `sec` 잔여량과 Upbit 세부 `group`을 같이 알아야 한다. 같은 REST 안에서도
 * `market`, `orderbook` bucket이 다르므로 group을 버리지 않는다.
 */
export interface UpbitRemainingReq {
  group: string;
  deprecatedMin?: number;
  sec: number;
  exhausted: boolean;
}

/**
 * Upbit 요청 제한 상태다.
 *
 * REST 호출 결과를 OK, 일시 제한, 차단으로 나누어 후속 scheduler/runtime이 재시도, 대기, 신규 주문
 * 차단 입력을 동일한 기준으로 처리하게 한다.
 */
export type UpbitRateLimitStatus =
  | {
      kind: "OK";
      remainingReq?: UpbitRemainingReq;
    }
  | {
      kind: "THROTTLED";
      httpStatus: 429;
      remainingReq?: UpbitRemainingReq;
    }
  | {
      kind: "BLOCKED";
      httpStatus: 418;
      remainingReq?: UpbitRemainingReq;
      retryAfterSeconds?: number;
    };

/**
 * `Remaining-Req` 헤더 문자열을 파싱한다.
 *
 * Upbit 문서상 `min`은 deprecated이지만 운영 로그와 snapshot에는 보존할 가치가 있다. 실제 요청 가능
 * 판단은 현재 초 단위 잔여량인 `sec`를 기준으로 한다.
 */
export function parseRemainingReqHeader(headerValue: string): UpbitRemainingReq {
  const fields = new Map<string, string>();

  for (const part of headerValue.split(";")) {
    const [rawKey, rawValue] = part.trim().split("=");

    if (rawKey === undefined || rawValue === undefined) {
      continue;
    }

    fields.set(rawKey.trim().toLowerCase(), rawValue.trim());
  }

  const group = fields.get("group");
  const sec = fields.get("sec");

  if (group === undefined || sec === undefined) {
    throw new Error(`Invalid Upbit Remaining-Req header: ${headerValue}`);
  }

  const parsedSec = Number.parseInt(sec, 10);

  if (!Number.isInteger(parsedSec) || parsedSec < 0) {
    throw new Error(`Invalid Upbit Remaining-Req sec value: ${headerValue}`);
  }

  const min = fields.get("min");
  const parsedMin = min === undefined ? undefined : Number.parseInt(min, 10);

  return {
    group,
    ...(parsedMin !== undefined && Number.isInteger(parsedMin) ? { deprecatedMin: parsedMin } : {}),
    sec: parsedSec,
    exhausted: parsedSec === 0,
  };
}

/**
 * HTTP status와 `Remaining-Req`를 runtime 상태로 변환한다.
 *
 * `sec=0`은 HTTP 200 응답이어도 다음 요청 관점에서는 throttled 상태로 본다. 418은 일정 시간 차단으로
 * 취급해 사람 확인 또는 backoff 정책이 개입할 수 있게 한다.
 */
export function createUpbitRateLimitStatus(
  httpStatus: number,
  remainingReq?: UpbitRemainingReq,
  retryAfterSeconds?: number,
): UpbitRateLimitStatus {
  if (httpStatus === 418) {
    return {
      kind: "BLOCKED",
      httpStatus,
      ...(remainingReq === undefined ? {} : { remainingReq }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }

  if (httpStatus === 429 || remainingReq?.exhausted === true) {
    return {
      kind: "THROTTLED",
      httpStatus: 429,
      ...(remainingReq === undefined ? {} : { remainingReq }),
    };
  }

  return {
    kind: "OK",
    ...(remainingReq === undefined ? {} : { remainingReq }),
  };
}

/**
 * REST rate-limit 상태를 거래소 정책 snapshot에 들어갈 공통 policy로 변환한다.
 *
 * 공통 `group`은 REST/WEBSOCKET 대분류이고, `exchangeGroup`에는 Upbit의 실제 bucket 이름을 남긴다.
 */
export function toRestRateLimitPolicy(
  exchangeId: string,
  remainingReq?: UpbitRemainingReq,
): RateLimitPolicy {
  return {
    exchangeId,
    group: "REST",
    ...(remainingReq === undefined ? {} : { exchangeGroup: remainingReq.group }),
    ...(remainingReq === undefined ? {} : { remaining: remainingReq.sec }),
    policyText:
      "Upbit REST quotation APIs expose Remaining-Req as group/min/sec; min is deprecated and sec is the current remaining request count.",
  };
}

/**
 * WebSocket 제한 정책을 공통 policy로 표현한다.
 *
 * WebSocket PR에서 실제 연결/메시지 제한을 더 구체화하기 전까지, REST와 별도 bucket으로 취급한다는
 * 업무 결정을 snapshot에 남기는 역할이다.
 */
export function toWebSocketRateLimitPolicy(exchangeId: string): RateLimitPolicy {
  return {
    exchangeId,
    group: "WEBSOCKET",
    exchangeGroup: "websocket-connect/websocket-message",
    policyText:
      "Upbit WebSocket quotation connections are IP-scoped without authentication; connection and request-message limits are tracked separately from REST Remaining-Req headers.",
  };
}
