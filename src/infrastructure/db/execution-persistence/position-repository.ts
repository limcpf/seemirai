import { sql } from "kysely";
import { toStorageDecimalString } from "../../../shared/index.js";
import { toFillRowInputs } from "./row-mapper.js";
import type {
  ExecutionOrderRecord,
  ExecutionPersistenceTransaction,
  FillRecord,
  PersistPaperExecutionInput,
  PositionRecord,
} from "./types.js";

/**
 * paper execution fill row를 저장한다.
 *
 * broker 최종 상태 검증을 통과한 fill만 저장해 position 회계가 rejected/balance-failed simulation 후보를 근거로 움직이지
 * 않게 한다.
 */
export async function insertPaperExecutionFills(
  database: ExecutionPersistenceTransaction,
  orderId: string,
  input: PersistPaperExecutionInput,
): Promise<FillRecord[]> {
  const rows = toFillRowInputs(orderId, input);
  if (rows.length === 0) {
    return [];
  }

  return database.insertInto("fills").values(rows).returningAll().execute();
}

/**
 * fill 목록을 전략별 포지션 snapshot에 반영한다.
 *
 * BUY는 평균 단가를 누적하고 SELL은 보유 수량 안에서 realized PnL을 계산한다. DB write는 호출자가 넘긴 transaction 안에서만
 * 수행해 주문 snapshot과 포지션 snapshot의 commit 시점을 맞춘다.
 */
export async function upsertPositionFromFills(
  database: ExecutionPersistenceTransaction,
  order: ExecutionOrderRecord,
  fills: readonly FillRecord[],
): Promise<PositionRecord | undefined> {
  let position: PositionRecord | undefined;

  for (const fill of fills) {
    if (fill.side === "BUY") {
      position = await upsertBuyPositionFill(database, order, fill);
      continue;
    }

    position = await applySellPositionFill(database, order, fill);
  }

  return position;
}

/**
 * BUY fill을 포지션 snapshot에 원자적으로 누적한다.
 *
 * 최초 포지션 생성과 기존 포지션 평균 단가 갱신을 `ON CONFLICT DO UPDATE` 하나로 묶어, 동시에 들어온 첫 fill이
 * unique constraint 경합으로 주문 persistence transaction 전체를 롤백시키지 않게 한다.
 */
async function upsertBuyPositionFill(
  database: ExecutionPersistenceTransaction,
  order: ExecutionOrderRecord,
  fill: FillRecord,
): Promise<PositionRecord> {
  const quantity = toStorageDecimalString(fill.quantity);
  const price = toStorageDecimalString(fill.price);
  const result = await sql<PositionRecord>`
    INSERT INTO positions (
      exchange,
      market,
      strategy_id,
      quantity,
      average_entry_price,
      realized_pnl,
      unrealized_pnl,
      updated_at
    )
    VALUES (
      ${order.exchange},
      ${order.market},
      ${order.strategy_id},
      ${quantity},
      ${price},
      '0',
      '0',
      ${fill.filled_at}
    )
    ON CONFLICT (exchange, market, strategy_id) DO UPDATE
    SET
      quantity = positions.quantity + EXCLUDED.quantity,
      average_entry_price = CASE
        WHEN positions.quantity + EXCLUDED.quantity = 0 THEN 0
        ELSE (
          (positions.quantity * positions.average_entry_price)
          + (EXCLUDED.quantity * EXCLUDED.average_entry_price)
        ) / (positions.quantity + EXCLUDED.quantity)
      END,
      realized_pnl = positions.realized_pnl,
      unrealized_pnl = positions.unrealized_pnl,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `.execute(database);

  const position = result.rows[0];
  if (position === undefined) {
    throw new Error("buy position upsert did not return a row");
  }

  return position;
}

/**
 * SELL fill을 기존 포지션 snapshot에 반영한다.
 *
 * 보유 snapshot이 없으면 short position을 만들지 않고 fill record만 남긴다. 이미 보유 중인 수량은 단일 `UPDATE`로
 * 차감해 realized PnL과 잔여 수량이 같은 row version을 기준으로 계산되게 한다.
 */
async function applySellPositionFill(
  database: ExecutionPersistenceTransaction,
  order: ExecutionOrderRecord,
  fill: FillRecord,
): Promise<PositionRecord | undefined> {
  const quantity = toStorageDecimalString(fill.quantity);
  const price = toStorageDecimalString(fill.price);
  const result = await sql<PositionRecord>`
    UPDATE positions
    SET
      realized_pnl = realized_pnl + ((${price}::numeric - average_entry_price) * LEAST(quantity, ${quantity}::numeric)),
      quantity = GREATEST(quantity - ${quantity}::numeric, 0),
      average_entry_price = CASE
        WHEN GREATEST(quantity - ${quantity}::numeric, 0) = 0 THEN 0
        ELSE average_entry_price
      END,
      updated_at = ${fill.filled_at}
    WHERE exchange = ${order.exchange}
      AND market = ${order.market}
      AND strategy_id = ${order.strategy_id}
    RETURNING *
  `.execute(database);

  // 보유 snapshot 없이 들어온 SELL fill은 음수 포지션을 만들지 않고 체결 record만 보존한다.
  return result.rows[0];
}
