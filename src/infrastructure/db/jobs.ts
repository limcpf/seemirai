import { sql } from "kysely";
import type { Insertable, Selectable } from "kysely";
import type { Database } from "./database.js";
import type { JobsTable } from "./schema.js";

export type JobRecord = Selectable<JobsTable>;
export type JobStatus = JobRecord["status"];

export interface EnqueueJobInput {
  jobType: string;
  idempotencyKey: string;
  payloadJson?: Record<string, unknown>;
  runAfter?: Date | string;
  maxAttempts?: number;
}

export interface EnqueueJobResult {
  job: JobRecord;
  created: boolean;
}

export interface ClaimPendingJobsOptions {
  workerId: string;
  limit?: number;
  now?: Date | string;
}

export interface CompleteJobOptions {
  jobId: string;
  workerId: string;
  completedAt?: Date | string;
}

/**
 * 작업 큐에 job을 등록한다.
 *
 * 흐름:
 * 1. `jobs.idempotency_key` unique constraint를 기준으로 새 row를 삽입한다.
 * 2. 같은 key가 이미 있으면 삽입하지 않고 기존 row를 다시 조회한다.
 * 3. 호출자는 `created` 값으로 신규 등록과 중복 요청을 구분한다.
 *
 * @param database Kysely database connection
 * @param input 등록할 작업 종류, 중복 차단 key, payload, 예약 시각
 * @returns 등록됐거나 이미 존재하던 job record와 신규 생성 여부
 */
export async function enqueueJob(
  database: Database,
  input: EnqueueJobInput,
): Promise<EnqueueJobResult> {
  const values = toInsertableJob(input);
  const inserted = await database
    .insertInto("jobs")
    .values(values)
    .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
    .returningAll()
    .executeTakeFirst();

  if (inserted !== undefined) {
    return {
      job: inserted,
      created: true,
    };
  }

  const existing = await findJobByIdempotencyKey(database, input.idempotencyKey);
  if (existing === undefined) {
    throw new Error("job insert conflicted but existing row was not found");
  }

  return {
    job: existing,
    created: false,
  };
}

/**
 * idempotency key로 job을 조회한다.
 *
 * @param database Kysely database connection
 * @param idempotencyKey 조회할 업무 중복 차단 key
 * @returns key에 해당하는 job record 또는 `undefined`
 */
export async function findJobByIdempotencyKey(
  database: Database,
  idempotencyKey: string,
): Promise<JobRecord | undefined> {
  return database
    .selectFrom("jobs")
    .selectAll()
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
}

/**
 * 실행 가능한 `PENDING` job을 worker에게 할당한다.
 *
 * 흐름:
 * 1. transaction 안에서 실행 가능 시간이 지난 `PENDING` row를 오래된 순서로 고른다.
 * 2. `FOR UPDATE SKIP LOCKED`로 다른 worker가 이미 고른 row는 건너뛴다.
 * 3. 선택된 row를 `RUNNING`으로 바꾸고 lock metadata와 attempt count를 갱신한다.
 * 4. 갱신된 row를 반환해 worker가 실제 작업을 실행하게 한다.
 *
 * @param database Kysely database connection
 * @param options worker 식별자, claim 개수, 기준 시각
 * @returns 이번 worker가 claim한 job record 목록
 */
export async function claimPendingJobs(
  database: Database,
  options: ClaimPendingJobsOptions,
): Promise<JobRecord[]> {
  const limit = options.limit ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("job claim limit must be a positive safe integer");
  }

  const now = options.now ?? new Date();

  return database.transaction().execute(async (transaction) => {
    const result = await sql<JobRecord>`
      UPDATE jobs
      SET
        status = 'RUNNING',
        locked_at = ${now},
        locked_by = ${options.workerId},
        attempt_count = attempt_count + 1,
        updated_at = ${now}
      WHERE id IN (
        SELECT id
        FROM jobs
        WHERE status = 'PENDING'
          AND run_after <= ${now}
          AND attempt_count < max_attempts
        ORDER BY run_after ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING *
    `.execute(transaction);

    return result.rows;
  });
}

/**
 * 실행이 끝난 job을 완료 상태로 전환한다.
 *
 * @param database Kysely database connection
 * @param options 완료 처리할 job ID, claim한 worker ID, 완료 기준 시각
 * @returns 갱신된 job record
 */
export async function completeJob(
  database: Database,
  options: CompleteJobOptions,
): Promise<JobRecord> {
  const completedAt = options.completedAt ?? new Date();
  const completed = await database
    .updateTable("jobs")
    .set({
      status: "COMPLETED",
      locked_at: null,
      locked_by: null,
      updated_at: completedAt,
    })
    .where("id", "=", options.jobId)
    .where("status", "=", "RUNNING")
    .where("locked_by", "=", options.workerId)
    .where("locked_at", "is not", null)
    .returningAll()
    .executeTakeFirst();

  if (completed === undefined) {
    throw new Error("running job lock was not found for the worker");
  }

  return completed;
}

function toInsertableJob(input: EnqueueJobInput): Insertable<JobsTable> {
  const values: Insertable<JobsTable> = {
    job_type: input.jobType,
    idempotency_key: input.idempotencyKey,
    status: "PENDING",
  };

  if (input.payloadJson !== undefined) {
    values.payload_json = input.payloadJson;
  }

  if (input.runAfter !== undefined) {
    values.run_after = input.runAfter;
  }

  if (input.maxAttempts !== undefined) {
    values.max_attempts = input.maxAttempts;
  }

  return values;
}
