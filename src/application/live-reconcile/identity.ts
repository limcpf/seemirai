import type {
  ReconcileExchangeOrderSnapshot,
  ReconcileLocalOrderSnapshot,
} from "../../domain/live-reconcile.js";

/* ============================================================
 * Order Identity / Fingerprint Matching
 *
 * 거래소 주문과 로컬 주문이 같은 주문인지 판단하는 순수 함수들이다.
 * identifier, uuid, fingerprint 3단계 fallback으로 identity를 확인하되,
 * identifier/uuid가 일치해도 market/side/quantity/price fingerprint가
 * 어긋나면 identity 불일치로 처리해 자동 상태 전진을 막는다.
 * ============================================================ */

/**
 * identity 일치 유형이다.
 *
 * - `identifier`: 클라이언트가 부여한 identifier와 immutable fingerprint가 일치
 * - `uuid`: 거래소가 부여한 exchangeOrderId와 immutable fingerprint가 일치
 * - `fingerprint`: 식별자가 없을 때 (market, side, quantity, price)가 일치
 */
export type IdentityMatchType = "identifier" | "uuid" | "fingerprint";

/** identity 일치 성공 결과다. */
export interface IdentityMatchSuccess {
  matched: true;
  matchType: IdentityMatchType;
  /** 결정론적 identity 문자열. evidence fingerprint 생성에 사용한다. */
  identity: string;
}

/** identity 일치 실패 결과다. */
export interface IdentityMatchFailure {
  matched: false;
  reason: string;
}

export type IdentityMatchResult = IdentityMatchSuccess | IdentityMatchFailure;

/* ============================================================
 * Public API
 * ============================================================ */

/**
 * 거래소 주문과 로컬 주문이 같은 주문인지 판단한다.
 *
 * 판정 순서:
 * 1. identifier가 양쪽에 모두 있고 일치하고 fingerprint도 일치 → identifier match
 * 2. exchangeOrderId가 양쪽에 모두 있고 일치하고 fingerprint도 일치 → uuid match
 * 3. 식별자가 한쪽에만 있거나 식별자/fingerprint가 어긋나면 → 불일치
 * 4. 둘 다 없으면 → (market, side, quantity, price) fingerprint 비교
 *
 * @param exchange 거래소 주문 identity 정보
 * @param local 로컬 주문 identity 정보
 * @returns 일치 여부와 matchType/identity 또는 불일치 reason
 */
export function matchOrderIdentity(
  exchange: Pick<
    ReconcileExchangeOrderSnapshot,
    "exchangeOrderId" | "identifier" | "market" | "side" | "requestedQuantity" | "requestedPrice"
  >,
  local: Pick<
    ReconcileLocalOrderSnapshot,
    "exchangeOrderId" | "identifier" | "market" | "side" | "requestedQuantity" | "requestedPrice"
  >,
): IdentityMatchResult {
  // 1. identifier가 같아도 원주문 fingerprint가 다르면 stale mapping으로 보고 자동 전진을 막는다.
  if (exchange.identifier !== undefined && local.identifier !== undefined) {
    if (exchange.identifier !== local.identifier) {
      return {
        matched: false,
        reason: `identifier_mismatch: exchange="${exchange.identifier}" vs local="${local.identifier}"`,
      };
    }

    if (
      exchange.exchangeOrderId !== undefined &&
      local.exchangeOrderId !== undefined &&
      exchange.exchangeOrderId !== local.exchangeOrderId
    ) {
      return {
        matched: false,
        reason: `uuid_mismatch_after_identifier_match: exchange="${exchange.exchangeOrderId}" vs local="${local.exchangeOrderId}"`,
      };
    }

    const fingerprintMatch = compareImmutableFingerprint(exchange, local);
    if (!fingerprintMatch.matched) {
      return fingerprintMatch;
    }

    return {
      matched: true,
      matchType: "identifier",
      identity: `id:${exchange.identifier}`,
    };
  }

  // 2. uuid가 같아도 fingerprint가 다르면 다른 주문으로 보고 상태 전진 후보를 만들지 않는다.
  if (
    exchange.exchangeOrderId !== undefined &&
    local.exchangeOrderId !== undefined
  ) {
    if (exchange.exchangeOrderId !== local.exchangeOrderId) {
      return {
        matched: false,
        reason: `uuid_mismatch: exchange="${exchange.exchangeOrderId}" vs local="${local.exchangeOrderId}"`,
      };
    }

    const fingerprintMatch = compareImmutableFingerprint(exchange, local);
    if (!fingerprintMatch.matched) {
      return fingerprintMatch;
    }

    return {
      matched: true,
      matchType: "uuid",
      identity: `uuid:${exchange.exchangeOrderId}`,
    };
  }

  // identifier가 한쪽에만 있고 uuid bridge도 없으면 자동 match 금지
  if (exchange.identifier !== undefined || local.identifier !== undefined) {
    return {
      matched: false,
      reason: "identifier_present_only_on_one_side",
    };
  }

  // uuid가 한쪽에만 있으면 자동 match 금지
  if (
    exchange.exchangeOrderId !== undefined ||
    local.exchangeOrderId !== undefined
  ) {
    return {
      matched: false,
      reason: "uuid_present_only_on_one_side",
    };
  }

  // 3. 둘 다 식별자가 없으면 fingerprint 비교
  return matchByFingerprint(exchange, local);
}

/**
 * 주문의 결정론적 fingerprint를 생성한다.
 *
 * (market, side, requestedQuantity, requestedPrice) 조합을
 * `|` 구분자로 이어붙여 식별자 없이도 같은 주문인지 비교할 수 있다.
 * fingerprint가 일치해도 identifier 기반 일치보다 신뢰도가 낮으므로
 * 자동 상태 전진을 제한할 수 있다.
 *
 * @returns `${market}|${side}|${quantity}|${price ?? ''}` 형식의 fingerprint
 */
export function buildOrderFingerprint(
  market: string,
  side: string,
  quantity: string,
  price?: string,
): string {
  return `${market}|${side}|${quantity}|${price ?? ""}`;
}

/**
 * 거래소 주문의 표시용 identity 문자열을 만든다.
 *
 * identifier가 있으면 우선하고, 없으면 uuid를 사용하며, 둘 다 없으면
 * fingerprint를 반환한다. mismatch evidence의 `orderIdentity` 필드에
 * 사용한다.
 */
export function describeExchangeOrderIdentity(
  order: Pick<
    ReconcileExchangeOrderSnapshot,
    "exchangeOrderId" | "identifier" | "market" | "side" | "requestedQuantity" | "requestedPrice"
  >,
): string {
  if (order.identifier !== undefined) {
    return `identifier:${order.identifier}`;
  }
  if (order.exchangeOrderId !== undefined) {
    return `uuid:${order.exchangeOrderId}`;
  }
  return `fingerprint:${buildOrderFingerprint(order.market, order.side, order.requestedQuantity, order.requestedPrice)}`;
}

/* ============================================================
 * 내부 구현
 * ============================================================ */

/**
 * identifier/uuid 기반 match 이후 immutable 주문 fingerprint를 검증한다.
 *
 * 이 함수는 거래소 state를 적용할 전이 입력과 identity matching 조건을
 * 분리하기 위한 순수 guard다. market, side, 원주문 수량, 원주문 가격이
 * 다르면 같은 identifier/uuid라도 stale mapping 또는 충돌로 보고 외부
 * side effect 없이 match 실패만 반환한다.
 */
function compareImmutableFingerprint(
  exchange: {
    market: string;
    side: string;
    requestedQuantity: string;
    requestedPrice?: string;
  },
  local: {
    market: string;
    side: string;
    requestedQuantity: string;
    requestedPrice?: string;
  },
): IdentityMatchFailure | { matched: true } {
  const exchangeFp = buildOrderFingerprint(
    exchange.market,
    exchange.side,
    exchange.requestedQuantity,
    exchange.requestedPrice,
  );
  const localFp = buildOrderFingerprint(
    local.market,
    local.side,
    local.requestedQuantity,
    local.requestedPrice,
  );

  if (exchangeFp === localFp) {
    return { matched: true };
  }

  return {
    matched: false,
    reason: `immutable_fingerprint_mismatch: exchange="${exchangeFp}" vs local="${localFp}"`,
  };
}

/**
 * 식별자가 없는 두 주문을 (market, side, quantity, price) fingerprint로 비교한다.
 *
 * identifier/uuid가 모두 없을 때만 도달하는 마지막 fallback이며,
 * fingerprint 일치는 identifier 기반 일치보다 신뢰도가 낮다.
 */
function matchByFingerprint(
  exchange: {
    market: string;
    side: string;
    requestedQuantity: string;
    requestedPrice?: string;
  },
  local: {
    market: string;
    side: string;
    requestedQuantity: string;
    requestedPrice?: string;
  },
): IdentityMatchResult {
  const exchangeFp = buildOrderFingerprint(
    exchange.market,
    exchange.side,
    exchange.requestedQuantity,
    exchange.requestedPrice,
  );
  const localFp = buildOrderFingerprint(
    local.market,
    local.side,
    local.requestedQuantity,
    local.requestedPrice,
  );

  if (exchangeFp === localFp) {
    return {
      matched: true,
      matchType: "fingerprint",
      identity: `fp:${exchangeFp}`,
    };
  }

  return {
    matched: false,
    reason: `fingerprint_mismatch: exchange="${exchangeFp}" vs local="${localFp}"`,
  };
}
