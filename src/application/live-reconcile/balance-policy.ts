import { parseFinancialDecimal } from "../../shared/decimal.js";
import type { BrokerBalance } from "../../domain/orders.js";
import type {
  ReconcileLocalOrderSnapshot,
  ReconcileMismatchEvidence,
} from "../../domain/live-reconcile.js";
import type { NumericString, TimestampInput } from "../../domain/types.js";

/* ============================================================
 * Balance Policy — locked/available 설명 가능성 판정
 *
 * 로컬/거래소 잔고 snapshot과 로컬 미체결 주문이 설명하는 locked
 * 금액을 함께 검증한다. snapshot 부재나 설명 불가능한 locked 금액이
 * 있으면 evidence를 생성한다. 이 모듈은 DB write나 외부 API 호출을
 * 하지 않는다.
 * ============================================================ */

/**
 * 단일 통화 잔고 불일치 검증 결과다.
 */
export interface BalanceCheckResult {
  mismatches: ReconcileMismatchEvidence[];
  /** 잔고 상태 요약 */
  status: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE";
}

/**
 * 거래소 잠김 잔고가 로컬 미체결 주문과 로컬 잔고 snapshot으로 설명되는지 검증한다.
 *
 * 매수(BUY) 미체결 주문의 `remainingQuantity × requestedPrice` 합계가
 * 해당 통화의 exchange locked 금액을 설명해야 한다. 매수 주문의
 * requestedPrice가 없으면 locked 설명 불가로 간주한다.
 * 로컬 잔고 snapshot과 거래소 snapshot의 available/locked/total도 같은
 * currency별로 일치해야 한다.
 *
 * KRW 잔고의 locked는 매수 주문의 KRW 예약금을 의미한다.
 * 암호화폐 잔고의 locked는 매도 주문의 수량 예약을 의미한다.
 *
 * @param localOpenOrders 로컬 미체결 주문 목록
 * @param localBalances 로컬에 기록된 잔고 snapshot
 * @param exchangeBalances 거래소 REST 잔고 snapshot
 * @param observedAt 이번 reconcile 실행 시각
 * @returns 통화별 검증 결과
 */
export function checkBalanceLock(
  localOpenOrders: readonly ReconcileLocalOrderSnapshot[],
  localBalances: readonly BrokerBalance[] | undefined,
  exchangeBalances: readonly BrokerBalance[] | undefined,
  observedAt: string,
): BalanceCheckResult {
  const localUnavailable = localBalances === undefined || localBalances.length === 0;
  const exchangeUnavailable = exchangeBalances === undefined || exchangeBalances.length === 0;

  if (localUnavailable && exchangeUnavailable) {
    return {
      mismatches: [
        createBalanceSnapshotUnavailableMismatch(
          "BOTH",
          "로컬 잔고 snapshot과 거래소 REST 잔고 snapshot이 모두 없어 잔고와 미체결 주문 예약금을 대조할 수 없습니다.",
          observedAt,
        ),
      ],
      status: "NOT_AVAILABLE",
    };
  }

  // 로컬/거래소 snapshot 부재는 잔고 검증 실패를 CLEAN으로 숨기지 않기 위해 evidence로 남긴다.
  if (localUnavailable) {
    return {
      mismatches: [
        createBalanceSnapshotUnavailableMismatch(
          "LOCAL",
          "로컬 잔고 snapshot이 없어 거래소 잔고와 미체결 주문 예약금을 대조할 수 없습니다.",
          observedAt,
        ),
      ],
      status: "NOT_AVAILABLE",
    };
  }

  if (exchangeUnavailable) {
    return {
      mismatches: [
        createBalanceSnapshotUnavailableMismatch(
          "EXCHANGE",
          "거래소 REST 잔고 snapshot이 없어 로컬 잔고와 미체결 주문 예약금을 대조할 수 없습니다.",
          observedAt,
        ),
      ],
      status: "NOT_AVAILABLE",
    };
  }

  const localByCurrency = new Map<string, BrokerBalance>();
  for (const balance of localBalances) {
    localByCurrency.set(balance.currency, balance);
  }

  // exchange 잔고를 currency로 색인
  const exchangeByCurrency = new Map<string, BrokerBalance>();
  for (const balance of exchangeBalances) {
    exchangeByCurrency.set(balance.currency, balance);
  }

  // 로컬 미체결 주문으로 설명되는 통화별 locked 금액 계산
  const expectedLockedByCurrency = computeExpectedLocked(localOpenOrders);

  const mismatches: ReconcileMismatchEvidence[] = [];

  appendBalanceSnapshotMismatches(
    mismatches,
    localByCurrency,
    exchangeByCurrency,
    observedAt,
  );

  const lockedCurrencies = new Set([
    ...expectedLockedByCurrency.keys(),
    ...exchangeByCurrency.keys(),
  ]);

  // exchange locked가 0이어도 로컬 open order 예상 예약금이 있으면 mismatch로 fail-closed한다.
  for (const currency of lockedCurrencies) {
    const exchangeLocked = exchangeByCurrency.get(currency)?.locked ?? "0";
    const expectedLocked = expectedLockedByCurrency.get(currency) ?? "0";
    if (!parseFinancialDecimal(expectedLocked).eq(exchangeLocked)) {
      mismatches.push(
        createBalanceLockMismatch(
          currency,
          exchangeLocked,
          expectedLocked,
          `거래소 잠김 잔고(${exchangeLocked})와 로컬 미체결 주문 예상 잠김 금액(${expectedLocked})이 일치하지 않습니다.`,
          observedAt,
          "expected_locked",
        ),
      );
    }
  }

  return {
    mismatches,
    status: mismatches.length > 0 ? "LOCK_MISMATCH" : "OK",
  };
}

/* ============================================================
 * 내부 구현
 * ============================================================ */

/**
 * 로컬 미체결 주문으로 설명되는 통화별 예상 locked 금액을 계산한다.
 *
 * - KRW locked: BUY 주문의 remainingQuantity × requestedPrice 합계
 * - 암호화폐 locked: SELL 주문의 remainingQuantity 합계
 *
 * requestedPrice가 없는 BUY 주문은 locked 설명 불가 → 해당 currency의
 * expected locked 계산에서 0으로 처리하고 별도 mismatch에서 잡는다.
 */
function computeExpectedLocked(
  orders: readonly ReconcileLocalOrderSnapshot[],
): Map<string, NumericString> {
  const lockedByCurrency = new Map<string, NumericString>();

  for (const order of orders) {
    // terminal state인 주문은 locked에서 제외
    if (["CANCELED", "REJECTED", "EXPIRED", "FAILED"].includes(order.status)) {
      continue;
    }

    if (order.side === "BUY") {
      // BUY 주문: KRW locked = remainingQuantity × requestedPrice
      if (order.requestedPrice === undefined) {
        // 가격이 없는 BUY 주문은 locked 계산 불가 → 0으로 남기고 mismatch에서 잡음
        if (!lockedByCurrency.has("KRW")) {
          lockedByCurrency.set("KRW", "0");
        }
      } else {
        const currentLocked = lockedByCurrency.get("KRW") ?? "0";
        // Decimal 안전 계산: orderedLocked = remaining × price
        const orderedLocked = parseFinancialDecimal(order.remainingQuantity)
          .mul(order.requestedPrice)
          .toString();
        lockedByCurrency.set(
          "KRW",
          parseFinancialDecimal(currentLocked).plus(orderedLocked).toString(),
        );
      }
    } else {
      // SELL 주문: 암호화폐 locked = remainingQuantity
      // market에서 currency 추출 (예: "KRW-BTC" → "BTC")
      const currency = extractCryptoCurrency(order.market);
      const currentLocked = lockedByCurrency.get(currency) ?? "0";
      lockedByCurrency.set(
        currency,
        parseFinancialDecimal(currentLocked)
          .plus(order.remainingQuantity)
          .toString(),
      );
    }
  }

  return lockedByCurrency;
}

/**
 * market 문자열에서 암호화폐 심볼을 추출한다.
 *
 * 예: "KRW-BTC" → "BTC", "KRW-ETH" → "ETH"
 */
function extractCryptoCurrency(market: string): string {
  const parts = market.split("-");
  return parts[parts.length - 1] ?? market;
}

function appendBalanceSnapshotMismatches(
  mismatches: ReconcileMismatchEvidence[],
  localByCurrency: ReadonlyMap<string, BrokerBalance>,
  exchangeByCurrency: ReadonlyMap<string, BrokerBalance>,
  observedAt: TimestampInput,
): void {
  const currencies = new Set([
    ...localByCurrency.keys(),
    ...exchangeByCurrency.keys(),
  ]);

  for (const currency of currencies) {
    const local = localByCurrency.get(currency);
    const exchange = exchangeByCurrency.get(currency);

    if (local === undefined && exchange !== undefined) {
      mismatches.push(
        createBalanceLockMismatch(
          currency,
          exchange.locked,
          "LOCAL_SNAPSHOT_MISSING",
          `거래소에는 ${currency} 잔고가 있지만 로컬 잔고 snapshot에 해당 통화가 없습니다.`,
          observedAt,
          "local_snapshot_missing",
        ),
      );
      continue;
    }

    if (local !== undefined && exchange === undefined) {
      mismatches.push(
        createBalanceLockMismatch(
          currency,
          "EXCHANGE_SNAPSHOT_MISSING",
          local.locked,
          `로컬에는 ${currency} 잔고가 있지만 거래소 잔고 snapshot에 해당 통화가 없습니다.`,
          observedAt,
          "exchange_snapshot_missing",
        ),
      );
      continue;
    }

    if (local === undefined || exchange === undefined) {
      continue;
    }

    appendBalanceFieldMismatch(mismatches, currency, "available", local.available, exchange.available, observedAt);
    appendBalanceFieldMismatch(mismatches, currency, "locked", local.locked, exchange.locked, observedAt);
    appendBalanceFieldMismatch(mismatches, currency, "total", local.total, exchange.total, observedAt);
  }
}

function appendBalanceFieldMismatch(
  mismatches: ReconcileMismatchEvidence[],
  currency: string,
  field: "available" | "locked" | "total",
  localValue: NumericString,
  exchangeValue: NumericString,
  observedAt: TimestampInput,
): void {
  if (parseFinancialDecimal(localValue).eq(exchangeValue)) {
    return;
  }

  mismatches.push(
    createBalanceLockMismatch(
      currency,
      exchangeValue,
      localValue,
      `로컬 ${field} 값(${localValue})과 거래소 ${field} 값(${exchangeValue})이 일치하지 않습니다.`,
      observedAt,
      field,
    ),
  );
}

/**
 * balance lock mismatch evidence를 생성한다.
 */
function createBalanceLockMismatch(
  currency: string,
  exchangeLocked: NumericString,
  expectedLocked: NumericString,
  detailMessage: string,
  observedAt: TimestampInput,
  field: string = "locked",
): ReconcileMismatchEvidence {
  return {
    mismatchType: "BALANCE_LOCK_MISMATCH",
    severity: "ERROR",
    currency,
    userMessage: `거래소 ${currency} 잠김 잔고 불일치: ${detailMessage}`,
    requiredAction: `수동 검토 필요: ${currency} 잠김 잔고 내역을 거래소 웹/앱에서 확인하고 로컬 미체결 주문의 수량/가격을 대조하세요.`,
    evidenceFingerprint: `balance-lock:${currency}:${field}:${observedAt}`,
    trace: {
      currency,
      exchangeLocked,
      expectedLocked,
      field,
      timestamp: observedAt,
    },
    occurredAt: observedAt,
  };
}

function createBalanceSnapshotUnavailableMismatch(
  source: "LOCAL" | "EXCHANGE" | "BOTH",
  detailMessage: string,
  observedAt: TimestampInput,
): ReconcileMismatchEvidence {
  return {
    mismatchType: "BALANCE_SNAPSHOT_UNAVAILABLE",
    severity: "ERROR",
    userMessage: `잔고 snapshot 판정 불가: ${detailMessage}`,
    requiredAction: "수동 검토 필요: 로컬 저장소와 거래소 REST 잔고 조회 상태를 확인한 뒤 reconcile을 다시 실행하세요.",
    evidenceFingerprint: `balance-snapshot-unavailable:${source}:${observedAt}`,
    trace: {
      source,
      timestamp: observedAt,
    },
    occurredAt: observedAt,
  };
}
