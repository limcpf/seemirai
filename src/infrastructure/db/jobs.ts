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

/**
 * 실행 가능한 job 묶음을 claim하는 조건이다.
 *
 * `jobType`을 지정하면 공용 jobs table에서 특정 worker가 자기 책임 job만 가져간다. 지정하지 않으면 기존처럼 모든 job type을
 * 대상으로 하므로, caller는 worker 경계가 섞이지 않는 상황에서만 생략해야 한다.
 */
export interface ClaimPendingJobsOptions {
  workerId: string;
  jobType?: string;
  limit?: number;
  now?: Date | string;
}

/**
 * 하나의 idempotency key job을 직접 claim하는 조건이다.
 *
 * `jobType`을 지정하면 key가 같더라도 다른 worker 책임 row를 claim하지 않는다. 수동 실행은 이미 예약된 같은 key job을 즉시
 * 실행해야 할 수 있으므로 `ignoreRunAfter`로 예약 시각 검사를 우회할 수 있다. scheduler 경계에서는 이 값을 쓰지 않아야
 * 예약 시간이 지켜진다.
 */
export interface ClaimJobByIdempotencyKeyOptions {
  workerId: string;
  idempotencyKey: string;
  jobType?: string;
  now?: Date | string;
  ignoreRunAfter?: boolean;
}

/**
 * worker가 claim한 job을 완료 처리하기 위한 조건이다.
 *
 * `workerId`와 lock metadata를 함께 확인해 다른 worker가 claim한 job을 완료 처리하지 못하게 한다.
 */
export interface CompleteJobOptions {
  jobId: string;
  workerId: string;
  completedAt?: Date | string;
}

/**
 * worker가 claim한 job의 실패를 기록하기 위한 조건이다.
 *
 * 실패 원인은 `last_error`에 남기고, 재시도 가능하면 `retryAfter` 이후 다시 claim 가능하게 만든다.
 */
export interface FailJobOptions {
  jobId: string;
  workerId: string;
  errorMessage: string;
  failedAt?: Date | string;
  retryAfter?: Date | string;
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
  const jobTypeCondition =
    options.jobType === undefined ? sql`` : sql`AND job_type = ${options.jobType}`;

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
          ${jobTypeCondition}
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
 * idempotency key가 가리키는 실행 가능 job 하나를 worker에게 할당한다.
 *
 * 수동 daily report 실행은 scheduler와 같은 job row를 재사용해야 중복 전송을 막을 수 있다. 이 함수는 key 단위로 기존
 * `PENDING` row를 claim하고, 이미 완료/실행 중인 row는 건드리지 않는다.
 *
 * @param database Kysely database connection
 * @param options worker 식별자, idempotency key, 기준 시각
 * @returns claim한 job record 또는 현재 claim할 수 없으면 `undefined`
 */
export async function claimJobByIdempotencyKey(
  database: Database,
  options: ClaimJobByIdempotencyKeyOptions,
): Promise<JobRecord | undefined> {
  const now = options.now ?? new Date();
  const runAfterCondition = options.ignoreRunAfter ? sql`` : sql`AND run_after <= ${now}`;
  const jobTypeCondition =
    options.jobType === undefined ? sql`` : sql`AND job_type = ${options.jobType}`;
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
        AND idempotency_key = ${options.idempotencyKey}
        ${jobTypeCondition}
        ${runAfterCondition}
        AND attempt_count < max_attempts
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `.execute(database);

  return result.rows[0];
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

/**
 * 실행 중인 job 실패를 기록하고 재시도 가능 여부에 따라 `PENDING` 또는 `FAILED`로 전환한다.
 *
 * `attempt_count`는 claim 시 이미 증가했으므로, 아직 `attempt_count < max_attempts`이면 같은 idempotency key job을 다시
 * claim할 수 있게 lease를 해제하고 예약 시각을 갱신한다. 재시도 한도를 소진하면 사람이 확인할 수 있도록 `FAILED`에 고정한다.
 *
 * @param database Kysely database connection
 * @param options 실패 처리할 job ID, worker ID, 실패 원인, 다음 예약 시각
 * @returns 갱신된 job record
 */
export async function failJob(database: Database, options: FailJobOptions): Promise<JobRecord> {
  const failedAt = options.failedAt ?? new Date();
  const retryAfter = options.retryAfter ?? failedAt;
  const failed = await database
    .updateTable("jobs")
    .set({
      status: sql<JobStatus>`CASE WHEN attempt_count < max_attempts THEN 'PENDING' ELSE 'FAILED' END`,
      run_after: retryAfter,
      locked_at: null,
      locked_by: null,
      last_error: options.errorMessage,
      updated_at: failedAt,
    })
    .where("id", "=", options.jobId)
    .where("status", "=", "RUNNING")
    .where("locked_by", "=", options.workerId)
    .where("locked_at", "is not", null)
    .returningAll()
    .executeTakeFirst();

  if (failed === undefined) {
    throw new Error("running job lock was not found for failure handling");
  }

  return failed;
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
