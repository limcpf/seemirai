import { sql } from "kysely";
import type { Insertable, Selectable } from "kysely";
import type {
  AlertCooldownReleaseInput,
  AlertCooldownRecordInput,
  AlertCooldownReservationInput,
  AlertCooldownReservationResult,
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
      deliveryReservedUntil: null,
    });
  }

  public async reserveDelivery(
    input: AlertCooldownReservationInput,
  ): Promise<AlertCooldownReservationResult> {
    return reserveAlertDelivery(this.database, input);
  }

  /**
   * provider 실패 후 in-flight lease만 해제한다.
   *
   * 실패는 성공 전송 기준점이 아니므로 last_sent_at은 바꾸지 않는다. 해제 조건은 이 dispatch가 잡은 lease 만료값과 현재 row가
   * 일치할 때로 제한해, 늦게 끝난 실패 cleanup이 이미 재예약된 새 lease를 지우지 못하게 한다.
   */
  public async releaseDeliveryReservation(input: AlertCooldownReleaseInput): Promise<AlertCooldownState> {
    return releaseAlertDeliveryReservation(this.database, input);
  }

  public async recordSkipped(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return recordAlertCooldownSkipped(this.database, input);
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
    deliveryReservedUntil: AlertCooldownRecordInput["occurredAt"] | null;
  },
): Promise<AlertCooldownState> {
  const row = toAlertCooldownRowInput(input, timestamps);
  const payloadJson = JSON.stringify(row.payload_json);
  const result = await sql<AlertCooldownRecord>`
    INSERT INTO alert_cooldowns (
      fingerprint,
      severity,
      alert_type,
      market,
      strategy_id,
      reason_code,
      last_sent_at,
      last_skipped_at,
      delivery_reserved_until,
      payload_json,
      updated_at
    )
    VALUES (
      ${row.fingerprint},
      ${row.severity},
      ${row.alert_type},
      ${row.market},
      ${row.strategy_id},
      ${row.reason_code},
      ${row.last_sent_at},
      ${row.last_skipped_at},
      ${row.delivery_reserved_until},
      ${payloadJson}::jsonb,
      ${input.occurredAt}
    )
    ON CONFLICT (fingerprint) DO UPDATE SET
      severity = EXCLUDED.severity,
      alert_type = EXCLUDED.alert_type,
      market = EXCLUDED.market,
      strategy_id = EXCLUDED.strategy_id,
      reason_code = EXCLUDED.reason_code,
      last_sent_at = CASE
        WHEN EXCLUDED.last_sent_at IS NULL THEN alert_cooldowns.last_sent_at
        ELSE GREATEST(
          COALESCE(alert_cooldowns.last_sent_at, EXCLUDED.last_sent_at),
          EXCLUDED.last_sent_at
        )
      END,
      last_skipped_at = CASE
        WHEN EXCLUDED.last_skipped_at IS NULL THEN alert_cooldowns.last_skipped_at
        ELSE GREATEST(
          COALESCE(alert_cooldowns.last_skipped_at, EXCLUDED.last_skipped_at),
          EXCLUDED.last_skipped_at
        )
      END,
      delivery_reserved_until = EXCLUDED.delivery_reserved_until,
      payload_json = EXCLUDED.payload_json,
      updated_at = GREATEST(alert_cooldowns.updated_at, EXCLUDED.updated_at)
    RETURNING *
  `.execute(database);
  const record = result.rows[0];
  if (record === undefined) {
    throw new Error("alert cooldown upsert did not return a row");
  }

  return toAlertCooldownState(record);
}

/**
 * provider 호출 전 fingerprint 단위 delivery lease를 atomic하게 예약한다.
 *
 * `INSERT ... ON CONFLICT ... WHERE` 조건 안에서 마지막 성공 전송 cooldown과 기존 reservation 만료 여부를 함께 검사한다.
 * 이 경계가 없으면 같은 장애가 동시에 들어올 때 둘 다 provider 호출 전 상태를 "전송 가능"으로 보고 중복 Telegram 전송을
 * 만들 수 있다.
 */
export async function reserveAlertDelivery(
  database: Database,
  input: AlertCooldownReservationInput,
): Promise<AlertCooldownReservationResult> {
  const row = toAlertCooldownRowInput(input, {
    lastSentAt: null,
    lastSkippedAt: null,
    deliveryReservedUntil: input.reserveUntil,
  });
  const payloadJson = JSON.stringify(row.payload_json);
  const cooldownCutoff = new Date(toEpochMs(input.occurredAt) - input.cooldownMs).toISOString();
  const result = await sql<AlertCooldownRecord>`
    INSERT INTO alert_cooldowns (
      fingerprint,
      severity,
      alert_type,
      market,
      strategy_id,
      reason_code,
      delivery_reserved_until,
      payload_json,
      updated_at
    )
    VALUES (
      ${row.fingerprint},
      ${row.severity},
      ${row.alert_type},
      ${row.market},
      ${row.strategy_id},
      ${row.reason_code},
      ${row.delivery_reserved_until},
      ${payloadJson}::jsonb,
      ${input.occurredAt}
    )
    ON CONFLICT (fingerprint) DO UPDATE SET
      severity = EXCLUDED.severity,
      alert_type = EXCLUDED.alert_type,
      market = EXCLUDED.market,
      strategy_id = EXCLUDED.strategy_id,
      reason_code = EXCLUDED.reason_code,
      delivery_reserved_until = EXCLUDED.delivery_reserved_until,
      payload_json = EXCLUDED.payload_json,
      updated_at = EXCLUDED.updated_at
    WHERE
      (alert_cooldowns.last_sent_at IS NULL OR alert_cooldowns.last_sent_at <= ${cooldownCutoff})
      AND (
        alert_cooldowns.delivery_reserved_until IS NULL
        OR alert_cooldowns.delivery_reserved_until <= ${input.occurredAt}
      )
    RETURNING *
  `.execute(database);
  const reservedRecord = result.rows[0];

  if (reservedRecord !== undefined) {
    return {
      reserved: true,
      state: toAlertCooldownState(reservedRecord),
    };
  }

  const existingRecord = await database
    .selectFrom("alert_cooldowns")
    .selectAll()
    .where("fingerprint", "=", input.fingerprint)
    .executeTakeFirstOrThrow();

  return {
    reserved: false,
    state: toAlertCooldownState(existingRecord),
  };
}

/**
 * provider 실패 후 이 dispatch가 소유한 delivery lease만 해제한다.
 *
 * provider 호출이 lease 만료보다 늦게 끝나면 다른 요청이 같은 fingerprint를 이미 재예약했을 수 있다. 이때 이전 호출의 실패
 * cleanup이 새 `delivery_reserved_until`을 지우면 다음 요청들이 동시에 provider를 호출할 수 있으므로, 기존 lease 만료값이
 * `reservedUntil`과 정확히 일치하는 경우에만 compare-and-set 방식으로 null 처리한다.
 */
export async function releaseAlertDeliveryReservation(
  database: Database,
  input: AlertCooldownReleaseInput,
): Promise<AlertCooldownState> {
  const row = toAlertCooldownRowInput(input, {
    lastSentAt: null,
    lastSkippedAt: null,
    deliveryReservedUntil: null,
  });
  const payloadJson = JSON.stringify(row.payload_json);
  const result = await sql<AlertCooldownRecord>`
    UPDATE alert_cooldowns
    SET
      severity = ${row.severity},
      alert_type = ${row.alert_type},
      market = ${row.market},
      strategy_id = ${row.strategy_id},
      reason_code = ${row.reason_code},
      delivery_reserved_until = NULL,
      payload_json = ${payloadJson}::jsonb,
      updated_at = GREATEST(alert_cooldowns.updated_at, ${row.updated_at})
    WHERE
      fingerprint = ${row.fingerprint}
      AND delivery_reserved_until = ${input.reservedUntil}
    RETURNING *
  `.execute(database);
  const releasedRecord = result.rows[0];

  if (releasedRecord !== undefined) {
    return toAlertCooldownState(releasedRecord);
  }

  const existingRecord = await database
    .selectFrom("alert_cooldowns")
    .selectAll()
    .where("fingerprint", "=", input.fingerprint)
    .executeTakeFirst();

  // row가 이미 삭제됐거나 새 lease가 들어온 경우에는 추가 write 없이 현재 관측 가능한 상태만 반환한다.
  return existingRecord === undefined
    ? toReleasedCooldownState(input)
    : toAlertCooldownState(existingRecord);
}

/**
 * cooldown/reservation skip 시각을 기록하되 마지막 성공 전송 시각은 DB의 현재 값을 보존한다.
 *
 * skip은 provider 호출 억제 evidence일 뿐 성공 전송 기준점을 바꾸면 안 된다. `GREATEST`로 lastSkippedAt도 뒤로 되돌아가지
 * 않게 하여 동시에 들어온 skip 기록끼리 최신 시각만 남긴다.
 */
export async function recordAlertCooldownSkipped(
  database: Database,
  input: AlertCooldownRecordInput,
): Promise<AlertCooldownState> {
  const row = toAlertCooldownRowInput(input, {
    lastSentAt: null,
    lastSkippedAt: input.occurredAt,
    deliveryReservedUntil: null,
  });
  const payloadJson = JSON.stringify(row.payload_json);
  const record = await sql<AlertCooldownRecord>`
    INSERT INTO alert_cooldowns (
      fingerprint,
      severity,
      alert_type,
      market,
      strategy_id,
      reason_code,
      last_skipped_at,
      payload_json,
      updated_at
    )
    VALUES (
      ${row.fingerprint},
      ${row.severity},
      ${row.alert_type},
      ${row.market},
      ${row.strategy_id},
      ${row.reason_code},
      ${row.last_skipped_at},
      ${payloadJson}::jsonb,
      ${input.occurredAt}
    )
    ON CONFLICT (fingerprint) DO UPDATE SET
      severity = EXCLUDED.severity,
      alert_type = EXCLUDED.alert_type,
      market = EXCLUDED.market,
      strategy_id = EXCLUDED.strategy_id,
      reason_code = EXCLUDED.reason_code,
      last_sent_at = alert_cooldowns.last_sent_at,
      last_skipped_at = GREATEST(
        COALESCE(alert_cooldowns.last_skipped_at, EXCLUDED.last_skipped_at),
        EXCLUDED.last_skipped_at
      ),
      delivery_reserved_until = alert_cooldowns.delivery_reserved_until,
      payload_json = EXCLUDED.payload_json,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `.execute(database);

  return toAlertCooldownState(record.rows[0] as AlertCooldownRecord);
}

/**
 * application cooldown input을 DB insert row로 변환한다.
 */
export function toAlertCooldownRowInput(
  input: AlertCooldownRecordInput,
  timestamps: {
    lastSentAt: AlertCooldownRecordInput["occurredAt"] | null;
    lastSkippedAt: AlertCooldownRecordInput["occurredAt"] | null;
    deliveryReservedUntil: AlertCooldownRecordInput["occurredAt"] | null;
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
    delivery_reserved_until: timestamps.deliveryReservedUntil,
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
    deliveryReservedUntil: record.delivery_reserved_until,
    payloadJson: record.payload_json,
  };
}

function toReleasedCooldownState(input: AlertCooldownReleaseInput): AlertCooldownState {
  return {
    fingerprint: input.fingerprint,
    severity: input.severity,
    alertType: input.alertType,
    market: input.market,
    strategyId: input.strategyId,
    reasonCode: input.reasonCode,
    lastSentAt: null,
    lastSkippedAt: null,
    deliveryReservedUntil: null,
    payloadJson: input.payloadJson ?? {},
  };
}

function toEpochMs(value: AlertCooldownRecordInput["occurredAt"]): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
