import type { BrokerBalance, BrokerOrder, JsonRecord } from "../../../domain/index.js";

/**
 * BrokerOrder를 외부 호출자에게 반환하기 전에 복제한다.
 *
 * metadata까지 deep clone해 호출자가 반환 객체를 mutate해도 broker 내부 canonical state가 바뀌지 않게 한다.
 */
export function cloneBrokerOrder(order: BrokerOrder): BrokerOrder {
  const clonedOrder: BrokerOrder = { ...order };
  if (order.metadata !== undefined) {
    clonedOrder.metadata = cloneJsonRecord(order.metadata);
  }

  return clonedOrder;
}

/**
 * BrokerBalance를 외부 호출자에게 반환하기 전에 복제한다.
 *
 * 잔고 metadata가 운영 evidence로 재사용될 수 있으므로 snapshot read가 broker state mutation 경로가 되지 않게 한다.
 */
export function cloneBrokerBalance(balance: BrokerBalance): BrokerBalance {
  const clonedBalance: BrokerBalance = { ...balance };
  if (balance.metadata !== undefined) {
    clonedBalance.metadata = cloneJsonRecord(balance.metadata);
  }

  return clonedBalance;
}

function cloneJsonRecord(record: JsonRecord): JsonRecord {
  const clonedRecord: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    clonedRecord[key] = cloneJsonValue(value);
  }

  return clonedRecord;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // 반환 객체를 수정해도 broker 내부 canonical state가 바뀌지 않도록 nested 배열도 분리한다.
    return value.map(cloneJsonValue);
  }

  if (isJsonRecord(value)) {
    // paper_fill_simulation/balance_mutation 같은 nested metadata는 외부 호출자에게 mutable하게 노출되지 않아야 한다.
    return cloneJsonRecord(value);
  }

  return value;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
