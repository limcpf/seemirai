import type { BrokerBalance, TimestampInput } from "../../../domain/index.js";
import { addDecimalStrings, normalizeCurrency, normalizeDecimalString } from "./decimal-math.js";
import type { PaperBrokerBalanceInput } from "./types.js";

/**
 * PaperBroker 생성 시 주입된 잔고 입력을 broker snapshot으로 정규화한다.
 *
 * total이 없으면 available+locked로 계산하고 metadata는 얕게 복사해 호출자 객체 변경이 broker 초기 상태를 바꾸지 않게 한다.
 */
export function normalizeInitialBalance(input: PaperBrokerBalanceInput, fallbackUpdatedAt: TimestampInput): BrokerBalance {
  const locked = input.locked ?? "0";
  const total = input.total ?? addDecimalStrings(input.available, locked);
  const balance: BrokerBalance = {
    currency: normalizeCurrency(input.currency),
    available: normalizeDecimalString(input.available),
    locked: normalizeDecimalString(locked),
    total: normalizeDecimalString(total),
    updatedAt: input.updatedAt ?? fallbackUpdatedAt,
  };
  if (input.metadata !== undefined) {
    balance.metadata = { ...input.metadata };
  }

  return balance;
}

/**
 * 아직 관측되지 않은 통화에 delta를 적용할 때 사용하는 0 잔고 snapshot이다.
 *
 * 주문 side effect 중 새 통화 lock/release가 발생해도 map lookup 실패를 별도 예외로 만들지 않고 같은 balance update 경로를
 * 통과시킨다.
 */
export function createZeroBalance(currency: string, updatedAt: TimestampInput): BrokerBalance {
  return {
    currency: normalizeCurrency(currency),
    available: "0",
    locked: "0",
    total: "0",
    updatedAt,
  };
}
