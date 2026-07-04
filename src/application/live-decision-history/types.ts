import type { JsonRecord } from "../../domain/index.js";

/**
 * live ops decision history에 저장하는 판단 종류다.
 *
 * `ORDER_INTENT` 같은 화면용 범주가 아니라 사후 분석과 calibration이 직접 집계할 수 있는 매수/매도/보류/차단 단위로 낮춘다.
 * 이 타입은 순수 데이터 contract라 DB write나 broker side effect를 만들지 않는다.
 */
export type LiveDecisionHistoryDecisionKind = "HOLD" | "BUY" | "SELL" | "BLOCK";

/**
 * HOLD 폭주를 줄이기 위해 decision tick을 접는 정책이다.
 *
 * `HOLD_REASON_1M_BUCKET`은 같은 market/strategy/reason의 HOLD를 1분 bucket당 한 row로 접고,
 * `SOURCE_TICK`은 BUY/SELL/BLOCK처럼 개별 tick 재실행만 멱등 처리한다.
 */
export type LiveDecisionHistoryDedupePolicy = "HOLD_REASON_1M_BUCKET" | "SOURCE_TICK";

/**
 * live decision tick 생성 입력이다.
 *
 * 책임:
 * - live ops analysis/live execution summary를 durable DB row로 낮추기 위한 secret-free 필드를 모은다.
 * - feature snapshot과 thresholds는 JSONB 저장 전 row mapper에서 한 번 더 secret/raw payload 검증을 받는다.
 *
 * invariant:
 * - `orderIntentCount`는 0 이상의 정수여야 한다.
 * - BUY/SELL은 하나 이상의 후보를 의미하고, HOLD/BLOCK은 후보 0건 또는 차단 상태를 의미한다.
 * - raw provider payload, credential, token, DB URL은 어떤 JSON 필드에도 들어가면 안 된다.
 *
 * side effect:
 * - 이 입력은 값 객체이며 외부 API, DB, broker, notification side effect를 만들지 않는다.
 */
export interface LiveDecisionHistoryTickInput {
  readonly exchange: string;
  readonly market: string;
  readonly strategyId: string;
  readonly decisionKind: LiveDecisionHistoryDecisionKind;
  readonly reasonCode: string;
  readonly featureSnapshot: JsonRecord;
  readonly thresholds: JsonRecord;
  readonly orderIntentCount: number;
  readonly observedAt: Date;
  readonly decisionAt: Date;
  readonly sourceTickId: string;
  readonly correlationId?: string | null;
  readonly trace?: JsonRecord;
}

/**
 * dedupe 정책이 확정된 live decision tick이다.
 *
 * repository는 이 객체를 그대로 row mapper에 전달한다. `dedupeKey`는 같은 tick 재실행 또는 HOLD bucket 중복 저장을
 * 차단하는 stable key이고, `dedupeBucketStartedAt`은 retention/report query에서 bucket 단위를 확인하기 위한 시간 경계다.
 */
export interface LiveDecisionHistoryTick extends LiveDecisionHistoryTickInput {
  readonly dedupePolicy: LiveDecisionHistoryDedupePolicy;
  readonly dedupeBucketStartedAt: Date;
  readonly dedupeKey: string;
}

/**
 * live decision history repository append 입력이다.
 *
 * runtime writer port와 PostgreSQL repository가 같은 모양을 사용해 테스트 fake와 실제 DB 구현을 바꿔 끼울 수 있게 한다.
 */
export interface AppendLiveDecisionHistoryTickInput {
  readonly tick: LiveDecisionHistoryTick;
}

/**
 * live decision history append 결과다.
 *
 * `inserted=false`는 같은 dedupe key가 이미 저장되어 이번 호출이 멱등 재실행으로 접혔다는 뜻이다.
 */
export interface AppendLiveDecisionHistoryTickResult {
  readonly inserted: boolean;
}
