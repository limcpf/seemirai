import type { Insertable, Selectable } from "kysely";
import type { JsonRecord, TimestampInput } from "../../domain/index.js";
import type { Database } from "./database.js";
import type { RiskEventsTable } from "./schema.js";

export type RiskEventRecord = Selectable<RiskEventsTable>;
export type RiskEventRowInput = Insertable<RiskEventsTable>;

export interface AppendRiskEventInput {
  riskType: string;
  action: string;
  occurredAt: TimestampInput;
  severity?: RiskEventsTable["severity"];
  market?: string;
  strategyId?: string;
  orderId?: string;
  payloadJson?: JsonRecord;
}

/**
 * 리스크 판단 event를 `risk_events`에 append-only로 저장하는 repository다.
 */
export class PostgresRiskEventRepository {
  public constructor(private readonly database: Database) {}

  /**
   * 리스크 event를 append하고 저장된 row를 반환한다.
   */
  public async appendEvent(input: AppendRiskEventInput): Promise<RiskEventRecord> {
    return appendRiskEvent(this.database, input);
  }
}

/**
 * 리스크 event를 `risk_events`에 append한다.
 */
export async function appendRiskEvent(
  database: Database,
  input: AppendRiskEventInput,
): Promise<RiskEventRecord> {
  const inserted = await database
    .insertInto("risk_events")
    .values(toRiskEventRow(input))
    .returningAll()
    .executeTakeFirstOrThrow();

  return inserted;
}

/**
 * application/domain 리스크 판단을 `risk_events` insert row로 변환한다.
 */
export function toRiskEventRow(input: AppendRiskEventInput): RiskEventRowInput {
  // risk_events payload에는 검색 컬럼과 같은 판단 키를 중복 저장해 JSON만 봐도 맥락이 복원되게 한다.
  const payloadJson: JsonRecord = {
    ...(input.payloadJson ?? {}),
    risk_type: input.riskType,
    action: input.action,
  };
  const row: RiskEventRowInput = {
    risk_type: input.riskType,
    severity: input.severity ?? "WARN",
    market: input.market ?? null,
    strategy_id: input.strategyId ?? null,
    order_id: input.orderId ?? null,
    action: input.action,
    payload_json: payloadJson,
    occurred_at: input.occurredAt,
  };

  return row;
}
