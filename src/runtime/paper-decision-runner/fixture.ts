import {
  PaperDecisionRunner,
  StaticPaperDecisionInputSource,
  createM9ControlledFixtureStrategy,
} from "../../application/index.js";
import type {
  PaperDecisionInputFrame,
  PaperDecisionRunnerResult,
} from "../../application/index.js";
import type {
  JsonRecord,
  OrderbookEvent,
  TimestampInput,
} from "../../domain/index.js";
import {
  PaperBroker,
} from "../../infrastructure/index.js";
import type {
  PaperBrokerBalanceInput,
  PaperBrokerFillOptions,
  PaperBrokerOptions,
} from "../../infrastructure/index.js";

/**
 * M9 paper decision runner fixture 파일의 public schema다.
 *
 * fixture는 market data 수신 smoke가 아니라 decision boundary 검증에 필요한 frame, paper 잔고, fill option만 담는다.
 * 이 구조는 DB 입력 source로 확장할 때도 runner 입력 frame과 broker 초기 조건을 분리해 유지하기 위한 기준이다.
 */
export interface M9PaperDecisionFixture {
  schemaVersion: 1;
  sourceId: string;
  initialBalances: readonly PaperBrokerBalanceInput[];
  fillOptions?: PaperBrokerFillOptions;
  brokerClock?: TimestampInput;
  frames: readonly PaperDecisionInputFrame[];
}

/**
 * fixture smoke용 runtime 조립 결과다.
 *
 * `runner`는 application service이고, `broker`는 in-memory PaperBroker다. 이 runtime은 Upbit private client,
 * live broker, Telegram inbound route를 만들지 않는다.
 */
export interface M9PaperDecisionFixtureRuntime {
  fixture: M9PaperDecisionFixture;
  source: StaticPaperDecisionInputSource;
  broker: PaperBroker;
  runner: PaperDecisionRunner;
}

/**
 * fixture smoke 실행 옵션이다.
 *
 * `maxFrames`는 운영자가 큰 fixture를 샘플링할 때만 사용한다. 기본 controlled fixture에서는 전체 frame을 실행해
 * 최소 1회 paper 주문 제출과 체결 경로를 검증한다.
 */
export interface RunM9PaperDecisionFixtureSmokeOptions {
  fixture: unknown;
  maxFrames?: number;
}

/**
 * M9 paper decision fixture smoke runtime을 만든다.
 *
 * 이 조립기는 deterministic fixture strategy와 PaperBroker만 연결한다. 실거래 broker stub조차 만들지 않아 live order
 * API 호출 경계가 runner 안으로 들어오지 못하게 한다.
 */
export function createM9PaperDecisionFixtureRuntime(input: unknown): M9PaperDecisionFixtureRuntime {
  const fixture = parseM9PaperDecisionFixture(input);
  const source = new StaticPaperDecisionInputSource(
    fixture.frames.map((frame) => ({
      ...frame,
      metadata: {
        ...(frame.metadata ?? {}),
        source_id: fixture.sourceId,
      },
    })),
  );
  const brokerOptions: PaperBrokerOptions = {
    exchangeId: "upbit_krw_spot",
    initialBalances: fixture.initialBalances,
    brokerOrderIdPrefix: "m9-paper-decision-order",
    clock: () => fixture.brokerClock ?? new Date().toISOString(),
  };
  assignIfDefined(brokerOptions, "fillOptions", fixture.fillOptions);
  const broker = new PaperBroker(brokerOptions);
  const runner = new PaperDecisionRunner({
    source,
    strategies: [createM9ControlledFixtureStrategy()],
    broker,
  });

  return {
    fixture,
    source,
    broker,
    runner,
  };
}

/**
 * M9 controlled fixture를 실행하고 decision runner result를 반환한다.
 *
 * 이 함수는 CLI와 테스트가 공유하는 smoke entry다. summary artifact 작성은 script가 담당하고, 여기서는 application
 * runner 결과만 만들어 파일 시스템 side effect를 분리한다.
 */
export async function runM9PaperDecisionFixtureSmoke(
  options: RunM9PaperDecisionFixtureSmokeOptions,
): Promise<PaperDecisionRunnerResult> {
  const runtime = createM9PaperDecisionFixtureRuntime(options.fixture);
  return runtime.runner.run({
    ...(options.maxFrames === undefined ? {} : { maxFrames: options.maxFrames }),
    pnlStartingCashKrw: readInitialKrwAvailable(runtime.fixture),
  });
}

/**
 * unknown fixture 입력을 runtime이 소비할 수 있는 `M9PaperDecisionFixture`로 검증한다.
 *
 * 최소 검증만 수행하지만, controlled smoke의 안전 조건인 schema version, frame 목록, initial balance, orderbook
 * 구조는 fail-fast로 확인한다.
 */
export function parseM9PaperDecisionFixture(input: unknown): M9PaperDecisionFixture {
  const record = readRecord(input, "fixture");
  if (record.schemaVersion !== 1) {
    throw new Error("M9 paper decision fixture schemaVersion must be 1");
  }

  const sourceId = readString(record.sourceId, "fixture.sourceId");
  const initialBalances = readArray(record.initialBalances, "fixture.initialBalances").map((balance, index) =>
    parseInitialBalance(balance, index),
  );
  const frames = readArray(record.frames, "fixture.frames").map((frame, index) => parseFrame(frame, index, sourceId));
  const fixture: M9PaperDecisionFixture = {
    schemaVersion: 1,
    sourceId,
    initialBalances,
    frames,
  };

  if (record.fillOptions !== undefined) {
    fixture.fillOptions = readRecord(record.fillOptions, "fixture.fillOptions") as PaperBrokerFillOptions;
  }
  if (record.brokerClock !== undefined) {
    fixture.brokerClock = readTimestamp(record.brokerClock, "fixture.brokerClock");
  }

  return fixture;
}

function parseInitialBalance(input: unknown, index: number): PaperBrokerBalanceInput {
  const record = readRecord(input, `fixture.initialBalances[${index}]`);
  const balance: PaperBrokerBalanceInput = {
    currency: readString(record.currency, `fixture.initialBalances[${index}].currency`),
    available: readString(record.available, `fixture.initialBalances[${index}].available`),
  };

  assignIfDefined(balance, "locked", readOptionalString(record.locked));
  assignIfDefined(balance, "total", readOptionalString(record.total));
  assignIfDefined(balance, "updatedAt", readOptionalTimestamp(record.updatedAt));
  assignIfDefined(balance, "metadata", readOptionalRecord(record.metadata));

  return balance;
}

function parseFrame(input: unknown, index: number, sourceId: string): PaperDecisionInputFrame {
  const record = readRecord(input, `fixture.frames[${index}]`);
  const frame: PaperDecisionInputFrame = {
    id: readString(record.id, `fixture.frames[${index}].id`),
    observedAt: readTimestamp(record.observedAt, `fixture.frames[${index}].observedAt`),
    exchangeId: readString(record.exchangeId, `fixture.frames[${index}].exchangeId`),
    market: readString(record.market, `fixture.frames[${index}].market`),
    features: readRecord(record.features, `fixture.frames[${index}].features`),
    metadata: {
      ...(readOptionalRecord(record.metadata) ?? {}),
      source_id: sourceId,
    },
  };

  assignIfDefined(frame, "orderbook", parseOptionalOrderbook(record.orderbook, index));
  assignIfDefined(frame, "costInput", readOptionalRecord(record.costInput));
  assignIfDefined(frame, "risk", readOptionalRecord(record.risk));
  assignIfDefined(frame, "universe", readOptionalRecord(record.universe));

  return frame;
}

function parseOptionalOrderbook(input: unknown, frameIndex: number): OrderbookEvent | undefined {
  if (input === undefined) {
    return undefined;
  }

  const record = readRecord(input, `fixture.frames[${frameIndex}].orderbook`);
  if (record.type !== "ORDERBOOK") {
    throw new Error(`fixture.frames[${frameIndex}].orderbook.type must be ORDERBOOK`);
  }

  return record as unknown as OrderbookEvent;
}

function readRecord(input: unknown, label: string): JsonRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as JsonRecord;
}

function readOptionalRecord(input: unknown): JsonRecord | undefined {
  if (input === undefined) {
    return undefined;
  }

  return readRecord(input, "optional record");
}

function readArray(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array`);
  }

  return input;
}

function readString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return input;
}

function readOptionalString(input: unknown): string | undefined {
  return input === undefined ? undefined : readString(input, "optional string");
}

function readTimestamp(input: unknown, label: string): TimestampInput {
  return readString(input, label);
}

function readOptionalTimestamp(input: unknown): TimestampInput | undefined {
  return input === undefined ? undefined : readTimestamp(input, "optional timestamp");
}

function readInitialKrwAvailable(fixture: M9PaperDecisionFixture): string {
  const krwBalance = fixture.initialBalances.find((balance) => balance.currency.toUpperCase() === "KRW");
  return krwBalance?.available ?? "0";
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
