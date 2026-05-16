import type { RateLimitPolicy } from "../../domain/index.js";

export interface UpbitRemainingReq {
  group: string;
  deprecatedMin?: number;
  sec: number;
  exhausted: boolean;
}

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

export function toRestRateLimitPolicy(
  exchangeId: string,
  remainingReq?: UpbitRemainingReq,
): RateLimitPolicy {
  return {
    exchangeId,
    group: "REST",
    ...(remainingReq === undefined ? {} : { remaining: remainingReq.sec }),
    policyText:
      "Upbit REST quotation APIs expose Remaining-Req as group/min/sec; min is deprecated and sec is the current remaining request count.",
  };
}

export function toWebSocketRateLimitPolicy(exchangeId: string): RateLimitPolicy {
  return {
    exchangeId,
    group: "WEBSOCKET",
    policyText:
      "Upbit WebSocket quotation connections are IP-scoped without authentication; connection and request-message limits are tracked separately from REST Remaining-Req headers.",
  };
}
