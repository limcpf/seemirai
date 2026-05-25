import type { Insertable, Selectable, Transaction } from "kysely";
import type { BrokerOrder, OrderSubmission } from "../../../domain/index.js";
import type { parseFinancialDecimal } from "../../../shared/index.js";
import type {
  DatabaseSchema,
  FillsTable,
  OrderEventsTable,
  OrdersTable,
  PaperOrdersTable,
  PositionsTable,
} from "../schema.js";

/**
 * `orders` 테이블에서 읽은 execution 주문 snapshot이다.
 *
 * repository가 DB write 후 반환하는 durable 주문 상태이며, 호출자는 이 값을 기준으로 후속 fill/event/position 결과가
 * 같은 주문을 가리키는지 확인한다. 읽기 전용 record라 외부 side effect는 없다.
 */
export type ExecutionOrderRecord = Selectable<OrdersTable>;

/**
 * `paper_orders` 테이블에서 읽은 paper broker 전용 실행 snapshot이다.
 *
 * paper simulation metadata와 latency evidence를 보존하는 조회 결과이며, 실제 주문 API 호출 여부를 열지 않는 paper
 * persistence 경계 안에서만 생성된다.
 */
export type PaperOrderRecord = Selectable<PaperOrdersTable>;

/**
 * `fills` 테이블에서 읽은 체결 회계 record다.
 *
 * broker 최종 상태와 fill evidence 검증을 통과한 뒤에만 생성되어 position update의 입력으로 사용된다.
 */
export type FillRecord = Selectable<FillsTable>;

/**
 * `positions` 테이블에서 읽은 전략별 포지션 snapshot이다.
 *
 * BUY/SELL fill 반영 뒤의 durable 상태를 표현하며, repository 외부에서는 직접 mutation하지 않는다.
 */
export type PositionRecord = Selectable<PositionsTable>;

/**
 * `order_events` 테이블에서 읽은 주문 상태 전이 event record다.
 *
 * 주문 snapshot과 append-only event log가 같은 transaction에서 갱신됐다는 근거로 반환된다.
 */
export type ExecutionOrderEventRecord = Selectable<OrderEventsTable>;

/**
 * `orders` insert에 사용하는 canonical row 입력이다.
 *
 * broker 제출 전 승인된 intent와 cost/risk snapshot을 DB column 계약에 맞게 정규화한 값이며 DB write 자체는 수행하지 않는다.
 */
export type ExecutionOrderRowInput = Insertable<OrdersTable>;

/**
 * `paper_orders` insert에 사용하는 paper broker metadata row 입력이다.
 *
 * time-in-force, post-only, simulation payload를 저장 가능한 형태로 좁힌 값이며 DB write 자체는 수행하지 않는다.
 */
export type PaperOrderRowInput = Insertable<PaperOrdersTable>;

/**
 * `fills` insert에 사용하는 체결 row 입력이다.
 *
 * fill simulation evidence 중 broker 최종 상태와 일치하는 체결만 포함하며 DB write 자체는 수행하지 않는다.
 */
export type FillRowInput = Insertable<FillsTable>;

/**
 * execution persistence가 공유하는 transaction 경계다.
 *
 * 주문 snapshot, 상태 event, fill, position write를 하나의 PostgreSQL transaction 안에서 묶어 idempotent 재시도와
 * 복구 시점의 관측 기준을 일치시킨다.
 */
export type ExecutionPersistenceTransaction = Transaction<DatabaseSchema>;

/**
 * 금액/수량 비교에 쓰는 Decimal 인스턴스 타입이다.
 *
 * DB numeric 문자열을 scale 차이와 분리해 비교하기 위한 내부 타입이며 자체 side effect는 없다.
 */
export type FinancialDecimal = ReturnType<typeof parseFinancialDecimal>;

/**
 * paper broker 실행 결과를 durable execution state로 저장하기 위한 입력이다.
 *
 * `submission`은 CostModel/RiskGate를 통과한 주문 후보이고, `brokerOrder`는 PaperBroker side effect 결과다. 두 값의
 * 주문 정체성이 일치해야 하며, 불일치하면 DB write 전에 fail-closed 한다.
 */
export interface PersistPaperExecutionInput {
  submission: OrderSubmission;
  brokerOrder: BrokerOrder;
  correlationId?: string;
  simulatedLatencyMs?: number;
}

/**
 * paper execution persistence의 완료 결과다.
 *
 * `created=false`는 같은 idempotency key의 재시도라서 fill/position/event side effect를 반복하지 않았다는 뜻이다.
 * `created=true`일 때는 order, paper order, event log, fill, position snapshot이 같은 transaction 결과를 나타낸다.
 */
export interface PersistPaperExecutionResult {
  created: boolean;
  order: ExecutionOrderRecord;
  paperOrder?: PaperOrderRecord;
  fills: readonly FillRecord[];
  position?: PositionRecord;
  orderEvents: readonly ExecutionOrderEventRecord[];
}
