import type {
  TelegramInboundCommandDedupeInput,
  TelegramInboundCommandDedupeResult,
  TelegramInboundCommandDedupeStore,
} from "../../application/index.js";
import { telegramInboundCommandJobType } from "../../application/index.js";
import type { Database } from "./database.js";
import { findJobByIdempotencyKey } from "./jobs.js";

/**
 * 기존 jobs table의 `idempotency_key` unique constraint로 Telegram inbound command 중복 실행을 막는 저장소다.
 *
 * dedupe row는 실행할 worker job이 아니라 이미 관찰한 command receipt이므로 `COMPLETED` 상태로 즉시 기록한다. 이 구현은 raw
 * Telegram update나 message text를 저장하지 않고 caller가 넘긴 safe metadata만 payload에 남긴다.
 */
export class PostgresTelegramInboundDedupeStore implements TelegramInboundCommandDedupeStore {
  public constructor(private readonly database: Database) {}

  public async record(input: TelegramInboundCommandDedupeInput): Promise<TelegramInboundCommandDedupeResult> {
    const inserted = await this.database
      .insertInto("jobs")
      .values({
        job_type: telegramInboundCommandJobType,
        idempotency_key: input.idempotencyKey,
        payload_json: input.metadata ?? {},
        status: "COMPLETED",
        run_after: input.occurredAt,
        max_attempts: 1,
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted !== undefined) {
      // 첫 관찰에서 jobs row를 선점해야 같은 Telegram update 재전달이 control side effect를 반복하지 않는다.
      return {
        idempotencyKey: input.idempotencyKey,
        duplicate: false,
        storedAt: toIsoTimestamp(inserted.created_at),
        store: "jobs",
        receiptId: inserted.id,
      };
    }

    const existing = await findJobByIdempotencyKey(this.database, input.idempotencyKey);
    if (existing === undefined) {
      throw new Error("telegram inbound dedupe insert conflicted but existing row was not found");
    }
    if (existing.job_type !== telegramInboundCommandJobType) {
      throw new Error("telegram inbound dedupe key conflicted with another job type");
    }

    return {
      idempotencyKey: input.idempotencyKey,
      duplicate: true,
      storedAt: toIsoTimestamp(existing.created_at),
      store: "jobs",
      receiptId: existing.id,
    };
  }
}

/**
 * PostgreSQL Telegram inbound dedupe store를 만든다.
 */
export function createPostgresTelegramInboundDedupeStore(
  database: Database,
): PostgresTelegramInboundDedupeStore {
  return new PostgresTelegramInboundDedupeStore(database);
}

function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
