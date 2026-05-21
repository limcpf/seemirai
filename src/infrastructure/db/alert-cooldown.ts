import type { Insertable, Selectable } from "kysely";
import type {
  AlertCooldownRecordInput,
  AlertCooldownState,
  AlertCooldownStore,
} from "../../application/index.js";
import type { Database } from "./database.js";
import type { AlertCooldownsTable } from "./schema.js";

export type AlertCooldownRecord = Selectable<AlertCooldownsTable>;
export type AlertCooldownRowInput = Insertable<AlertCooldownsTable>;

/**
 * P0/P1 alert cooldown을 PostgreSQL에 저장하는 repository다.
 *
 * 같은 fingerprint의 마지막 전송/skip 시각을 durable하게 보존해 프로세스 재시작 후에도 중복 Telegram 전송을 억제한다.
 */
export class PostgresAlertCooldownRepository implements AlertCooldownStore {
  public constructor(private readonly database: Database) {}

  public async findByFingerprint(fingerprint: string): Promise<AlertCooldownState | undefined> {
    const record = await this.database
      .selectFrom("alert_cooldowns")
      .selectAll()
      .where("fingerprint", "=", fingerprint)
      .executeTakeFirst();

    return record === undefined ? undefined : toAlertCooldownState(record);
  }

  public async recordSent(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return upsertAlertCooldown(this.database, input, {
      lastSentAt: input.occurredAt,
      lastSkippedAt: null,
    });
  }

  public async recordSkipped(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    const previous = await this.findByFingerprint(input.fingerprint);
    return upsertAlertCooldown(this.database, input, {
      lastSentAt: previous?.lastSentAt ?? null,
      lastSkippedAt: input.occurredAt,
    });
  }
}

/**
 * alert cooldown row를 삽입하거나 같은 fingerprint row를 갱신한다.
 *
 * `fingerprint`는 cooldown의 idempotency key 역할을 하므로 upsert로 한 row만 유지한다. 전송 성공과 cooldown skip은 서로 다른
 * timestamp 컬럼을 갱신해 운영자가 실제 provider 호출과 억제된 호출을 구분할 수 있게 한다.
 */
export async function upsertAlertCooldown(
  database: Database,
  input: AlertCooldownRecordInput,
  timestamps: {
    lastSentAt: AlertCooldownRecordInput["occurredAt"] | null;
    lastSkippedAt: AlertCooldownRecordInput["occurredAt"] | null;
  },
): Promise<AlertCooldownState> {
  const row = toAlertCooldownRowInput(input, timestamps);
  const record = await database
    .insertInto("alert_cooldowns")
    .values(row)
    .onConflict((conflict) =>
      conflict.column("fingerprint").doUpdateSet({
        severity: row.severity,
        alert_type: row.alert_type,
        market: row.market,
        strategy_id: row.strategy_id,
        reason_code: row.reason_code,
        last_sent_at: row.last_sent_at,
        last_skipped_at: row.last_skipped_at,
        payload_json: row.payload_json,
        updated_at: input.occurredAt,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toAlertCooldownState(record);
}

/**
 * application cooldown input을 DB insert row로 변환한다.
 */
export function toAlertCooldownRowInput(
  input: AlertCooldownRecordInput,
  timestamps: {
    lastSentAt: AlertCooldownRecordInput["occurredAt"] | null;
    lastSkippedAt: AlertCooldownRecordInput["occurredAt"] | null;
  },
): AlertCooldownRowInput {
  return {
    fingerprint: input.fingerprint,
    severity: input.severity,
    alert_type: input.alertType,
    market: input.market,
    strategy_id: input.strategyId,
    reason_code: input.reasonCode,
    last_sent_at: timestamps.lastSentAt,
    last_skipped_at: timestamps.lastSkippedAt,
    payload_json: input.payloadJson ?? {},
    updated_at: input.occurredAt,
  };
}

/**
 * DB row를 application cooldown state로 변환한다.
 */
export function toAlertCooldownState(record: AlertCooldownRecord): AlertCooldownState {
  return {
    fingerprint: record.fingerprint,
    severity: record.severity,
    alertType: record.alert_type,
    market: record.market,
    strategyId: record.strategy_id,
    reasonCode: record.reason_code,
    lastSentAt: record.last_sent_at,
    lastSkippedAt: record.last_skipped_at,
    payloadJson: record.payload_json,
  };
}
