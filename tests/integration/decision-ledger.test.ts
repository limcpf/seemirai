import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { sql } from "kysely";
import type { DecisionLedgerFrame, DecisionEvidenceItem } from "../../src/application/decision-ledger.js";
import {
  DECISION_LEDGER_VERSION,
} from "../../src/application/decision-ledger.js";
import {
  applyMigrations,
  createDatabase,
  createPostgresPool,
  DecisionLedgerEvidenceFrameConflictError,
  destroyDatabase,
  loadLocalDatabaseConfig,
  PostgresDecisionLedgerRepository,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("decision ledger PostgreSQL integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  afterAll(async () => {
    if (database !== undefined) {
      await destroyDatabase(database);
      database = undefined;
      pool = undefined;
      return;
    }

    await pool?.end();
    pool = undefined;
  });

  async function getDatabase(): Promise<Database> {
    if (database !== undefined) {
      return database;
    }

    const config = await loadLocalDatabaseConfig();
    pool = createPostgresPool(config);
    await applyMigrations(pool);
    database = createDatabase(pool);
    return database;
  }

  function makeFrame(unique: string, extra?: Partial<{
    market: string | null;
    strategyId: string | null;
    category: DecisionLedgerFrame["category"];
    reasonCounts: Record<string, number>;
    sourceRunId: string | null;
    correlationId: string | null;
    trace: Record<string, unknown>;
  }>): DecisionLedgerFrame {
    const override = extra ?? {};
    const sourceRunId = "sourceRunId" in override ? override.sourceRunId : "run-test-001";
    const correlationId = "correlationId" in override ? override.correlationId : "corr-test-001";

    const base = {
      ledgerVersion: DECISION_LEDGER_VERSION as typeof DECISION_LEDGER_VERSION,
      sourceRunId: sourceRunId as string | null,
      sourceFrameId: `frame-${unique}`,
      exchange: "UPBIT",
      market: (override.market ?? "KRW-BTC") as string | null,
      strategyId: (override.strategyId ?? "strategy.mean-reversion") as string | null,
      category: (override.category ?? "HOLD") as DecisionLedgerFrame["category"],
      summaryStatus: "RECORDED" as const,
      observedAt: new Date("2026-06-06T00:00:00Z"),
      decisionAt: new Date("2026-06-06T00:00:01Z"),
      correlationId: correlationId as string | null,
      reasonCounts: override.reasonCounts ?? { insufficient_expected_return: 1 },
      dedupeKey: `test-${unique}-${Date.now()}`,
      trace: override.trace ?? { sourceTable: "decision_ledger_frames" },
    };

    return base as DecisionLedgerFrame;
  }

  function makeEvidence(unique: string, extra?: Partial<{
    evidenceKind: DecisionEvidenceItem["evidenceKind"];
    category: DecisionEvidenceItem["category"];
    reasonCode: string | null;
    userMessage: string;
    source: string;
    sourceId: string | null;
    payload: Record<string, unknown>;
  }>): DecisionEvidenceItem {
    const override = extra ?? {};
    return {
      evidenceKind: (override.evidenceKind ?? "STRATEGY_DECISION") as DecisionEvidenceItem["evidenceKind"],
      category: (override.category ?? "HOLD") as DecisionEvidenceItem["category"],
      reasonCode: override.reasonCode ?? "insufficient_expected_return",
      userMessage: override.userMessage ?? "기대 수익이 비용을 충당하지 못해 진입을 보류했습니다.",
      impact: "현재 시장 조건에서는 매수보다 현금 보유가 유리합니다.",
      action: null,
      occurredAt: new Date("2026-06-06T00:00:00Z"),
      source: override.source ?? "strategy.mean-reversion",
      sourceId: override.sourceId ?? ("strategy.mean-reversion" as string | null),
      payload: override.payload ?? { expectedReturnBps: "15", requiredReturnBps: "30" },
      evidenceFingerprint: `fp-${unique}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      trace: { sourceId: "strategy.mean-reversion" },
    } as DecisionEvidenceItem;
  }

  describe("appendFrame", () => {
    it("새 frame을 append하면 inserted=true로 반환된다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frame = makeFrame("basic");

      const result = await repository.appendFrame({ frame });

      expect(result.inserted).toBe(true);
      expect(result.record.ledger_version).toBe(DECISION_LEDGER_VERSION);
      expect(result.record.source_frame_id).toBe(frame.sourceFrameId);
      expect(result.record.category).toBe("HOLD");
      expect(result.record.dedupe_key).toBe(frame.dedupeKey);
      expect(result.record.id).toBeDefined();
      expect(result.record.created_at).toBeDefined();
    });

    it("같은 dedupeKey로 재실행하면 inserted=false와 기존 record를 반환한다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frame = makeFrame("dedupe");

      const first = await repository.appendFrame({ frame });
      expect(first.inserted).toBe(true);

      const second = await repository.appendFrame({ frame });
      expect(second.inserted).toBe(false);
      expect(second.record.id).toBe(first.record.id);
      expect(second.record.dedupe_key).toBe(first.record.dedupe_key);
    });

    it("서로 다른 dedupeKey를 가진 frame은 각각 insert된다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const frame1 = makeFrame("multi-1");
      const frame2 = makeFrame("multi-2");

      const result1 = await repository.appendFrame({ frame: frame1 });
      const result2 = await repository.appendFrame({ frame: frame2 });

      expect(result1.inserted).toBe(true);
      expect(result2.inserted).toBe(true);
      expect(result1.record.id).not.toBe(result2.record.id);
    });

    it("market과 strategyId가 null인 CASH_HOLD frame도 저장된다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frame: DecisionLedgerFrame = {
        ledgerVersion: DECISION_LEDGER_VERSION,
        sourceRunId: null,
        sourceFrameId: `frame-cash-${Date.now()}`,
        exchange: "UPBIT",
        market: null,
        strategyId: null,
        category: "CASH_HOLD",
        summaryStatus: "RECORDED",
        observedAt: new Date("2026-06-06T00:00:00Z"),
        decisionAt: new Date("2026-06-06T00:00:01Z"),
        correlationId: null,
        reasonCounts: { all_strategies_hold: 2 },
        dedupeKey: `test-cash-hold-${Date.now()}`,
        trace: {
          correlationUnavailableReason: "주문 후보 0건",
          sourceRunUnavailableReason: "fixture",
        },
      };

      const result = await repository.appendFrame({ frame });

      expect(result.inserted).toBe(true);
      expect(result.record.market).toBeNull();
      expect(result.record.strategy_id).toBeNull();
      expect(result.record.correlation_id).toBeNull();
      expect(result.record.category).toBe("CASH_HOLD");
    });
  });

  describe("findFrameByDedupeKey", () => {
    it("저장된 frame을 dedupeKey로 조회할 수 있다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frame = makeFrame("find");

      await repository.appendFrame({ frame });

      const found = await repository.findFrameByDedupeKey(frame.dedupeKey);
      expect(found).toBeDefined();
      expect(found!.source_frame_id).toBe(frame.sourceFrameId);
    });

    it("존재하지 않는 dedupeKey는 undefined를 반환한다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const found = await repository.findFrameByDedupeKey(`nonexistent-${Date.now()}`);
      expect(found).toBeUndefined();
    });
  });

  describe("appendEvidenceItems", () => {
    it("frame에 evidence를 append하고 frame 기준으로 조회할 수 있다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frame = makeFrame("ev-append");

      const frameResult = await repository.appendFrame({ frame });
      const frameId = frameResult.record.id;

      const evidence1 = makeEvidence("ev1");
      const evidence2 = makeEvidence("ev2", {
        evidenceKind: "COST_BREAKDOWN",
        category: "COST_REJECTED",
        reasonCode: "insufficient_expected_return",
        userMessage: "비용이 기대 수익을 초과했습니다.",
        source: "cost-model",
        sourceId: "cost-001",
        payload: { requiredReturnBps: "30", expectedReturnBps: "15" },
      });

      const result = await repository.appendEvidenceItems(frameId, [
        { item: evidence1 },
        { item: evidence2 },
      ]);

      expect(result.inserted).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.records).toHaveLength(2);

      // frame 기준으로 evidence 조회
      const evidenceRecords = await repository.findEvidenceByFrameId(frameId);
      expect(evidenceRecords).toHaveLength(2);
      const kinds = evidenceRecords.map((r) => r.evidence_kind).sort();
      expect(kinds).toEqual(["COST_BREAKDOWN", "STRATEGY_DECISION"]);
    });

    it("같은 evidenceFingerprint는 중복 insert되지 않는다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frame = makeFrame("ev-dedup");

      const frameResult = await repository.appendFrame({ frame });
      const frameId = frameResult.record.id;

      const evidence = makeEvidence("ev-dedup-single");

      const first = await repository.appendEvidenceItems(frameId, [{ item: evidence }]);
      expect(first.inserted).toBe(1);

      const second = await repository.appendEvidenceItems(frameId, [{ item: evidence }]);
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(1);

      // 중복 insert도 모든 fingerprint의 record를 반환한다
      expect(second.records).toHaveLength(1);
      expect(second.records[0]!.evidence_fingerprint).toBe(evidence.evidenceFingerprint);
    });

    it("일부 evidence만 중복일 때 나머지는 정상 insert된다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frame = makeFrame("ev-partial");

      const frameResult = await repository.appendFrame({ frame });
      const frameId = frameResult.record.id;

      const evidence1 = makeEvidence("ev-partial-1");
      const evidence2 = makeEvidence("ev-partial-2", {
        evidenceKind: "RISK_DECISION",
        category: "RISK_REJECTED",
        userMessage: "리스크 한도 초과",
        source: "risk-gate",
        sourceId: "risk-001",
      });

      // 먼저 evidence1만 저장
      await repository.appendEvidenceItems(frameId, [{ item: evidence1 }]);

      // evidence1(중복) + evidence2(신규) 동시 저장
      const result = await repository.appendEvidenceItems(frameId, [
        { item: evidence1 },
        { item: evidence2 },
      ]);

      expect(result.inserted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.records).toHaveLength(2);
    });

    it("같은 evidenceFingerprint가 다른 frame에 이미 있으면 충돌로 차단한다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const frame1 = await repository.appendFrame({ frame: makeFrame("ev-conflict-frame-1") });
      const frame2 = await repository.appendFrame({ frame: makeFrame("ev-conflict-frame-2") });
      const evidence = makeEvidence("ev-conflict", {
        payload: { expectedReturnBps: "15", requiredReturnBps: "30" },
      });

      await repository.appendEvidenceItems(frame1.record.id, [{ item: evidence }]);

      await expect(
        repository.appendEvidenceItems(frame2.record.id, [{ item: evidence }]),
      ).rejects.toThrow(DecisionLedgerEvidenceFrameConflictError);
    });

    it("빈 evidence 목록은 아무 작업도 하지 않는다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const result = await repository.appendEvidenceItems(
        "00000000-0000-0000-0000-000000000000",
        [],
      );

      expect(result.inserted).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.records).toHaveLength(0);
    });
  });

  describe("findEvidenceByFrameId / findEvidenceByFrameIds", () => {
    it("여러 frame의 evidence를 batch로 조회할 수 있다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const frame1 = makeFrame("batch-1");
      const frame2 = makeFrame("batch-2");

      const fr1 = await repository.appendFrame({ frame: frame1 });
      const fr2 = await repository.appendFrame({ frame: frame2 });

      await repository.appendEvidenceItems(fr1.record.id, [
        { item: makeEvidence("batch-ev1") },
      ]);
      await repository.appendEvidenceItems(fr2.record.id, [
        { item: makeEvidence("batch-ev2") },
      ]);

      const evidence = await repository.findEvidenceByFrameIds([
        fr1.record.id,
        fr2.record.id,
      ]);
      expect(evidence).toHaveLength(2);
    });

    it("빈 frameId 목록은 빈 배열을 반환한다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const evidence = await repository.findEvidenceByFrameIds([]);
      expect(evidence).toHaveLength(0);
    });
  });

  describe("evidence append with various categories", () => {
    it("모든 evidence kind를 frame에 append할 수 있다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const frame: DecisionLedgerFrame = {
        ledgerVersion: DECISION_LEDGER_VERSION,
        sourceRunId: "run-test-buy",
        sourceFrameId: `frame-all-kinds-${Date.now()}`,
        exchange: "UPBIT",
        market: "KRW-BTC",
        strategyId: "strategy.mean-reversion",
        category: "BUY",
        summaryStatus: "RECORDED",
        observedAt: new Date("2026-06-06T00:00:00Z"),
        decisionAt: new Date("2026-06-06T00:00:01Z"),
        correlationId: "corr-test-buy",
        reasonCounts: {},
        dedupeKey: `test-all-kinds-${Date.now()}`,
        trace: {},
      };

      const frameResult = await repository.appendFrame({ frame });
      const frameId = frameResult.record.id;

      // 각 evidence kind를 명시적으로 생성
      const items: DecisionEvidenceItem[] = [
        {
          evidenceKind: "STRATEGY_DECISION",
          category: "BUY",
          reasonCode: "strong_trend",
          userMessage: "상승 추세가 감지되어 매수 신호를 생성했습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "strategy.mean-reversion",
          sourceId: "strategy.mean-reversion",
          payload: { expectedReturnBps: "50" },
          evidenceFingerprint: `fp-all-kind-1-${Date.now()}`,
          trace: {},
        },
        {
          evidenceKind: "ORDER_INTENT",
          category: "BUY",
          reasonCode: null,
          userMessage: "매수 주문 후보가 생성되었습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "order-intent",
          sourceId: "intent-001",
          payload: { side: "buy", notionalKrw: "100000" },
          evidenceFingerprint: `fp-all-kind-2-${Date.now()}`,
          trace: {},
        },
        {
          evidenceKind: "DISCARD_REASON",
          category: "DISCARD",
          reasonCode: "strategy_block",
          userMessage: "전략이 진입을 차단했습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "strategy.mean-reversion",
          sourceId: "strategy.mean-reversion",
          payload: {},
          evidenceFingerprint: `fp-all-kind-3-${Date.now()}`,
          trace: {},
        },
        {
          evidenceKind: "COST_BREAKDOWN",
          category: "COST_REJECTED",
          reasonCode: "insufficient_expected_return",
          userMessage: "비용이 기대 수익을 초과했습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "cost-model",
          sourceId: "cost-001",
          payload: {},
          evidenceFingerprint: `fp-all-kind-4-${Date.now()}`,
          trace: {},
        },
        {
          evidenceKind: "RISK_DECISION",
          category: "RISK_REJECTED",
          reasonCode: "exposure_limit",
          userMessage: "리스크 한도를 초과했습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "risk-gate",
          sourceId: "risk-001",
          payload: {},
          evidenceFingerprint: `fp-all-kind-5-${Date.now()}`,
          trace: {},
        },
        {
          evidenceKind: "EXECUTION_RESULT",
          category: "EXECUTED",
          reasonCode: null,
          userMessage: "주문이 체결되었습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "paper-broker",
          sourceId: "order-001",
          payload: {},
          evidenceFingerprint: `fp-all-kind-6-${Date.now()}`,
          trace: {},
        },
        {
          evidenceKind: "PNL_STATUS_CONTEXT",
          category: "BUY",
          reasonCode: null,
          userMessage: "PnL context를 연결했습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "pnl-accounting",
          sourceId: "pnl-001",
          payload: {},
          evidenceFingerprint: `fp-all-kind-7-${Date.now()}`,
          trace: {},
        },
        {
          evidenceKind: "EXPLANATION_SUMMARY",
          category: "BUY",
          reasonCode: null,
          userMessage: "결정론적 설명을 생성했습니다.",
          impact: null, action: null,
          occurredAt: new Date(),
          source: "deterministic-summary",
          sourceId: null,
          payload: {},
          evidenceFingerprint: `fp-all-kind-8-${Date.now()}`,
          trace: {},
        },
      ];

      const result = await repository.appendEvidenceItems(
        frameId,
        items.map((item) => ({ item })),
      );

      expect(result.inserted).toBe(8);

      const stored = await repository.findEvidenceByFrameId(frameId);
      expect(stored).toHaveLength(8);
    });

    it("EXPLANATION_FAILURE evidence를 저장할 수 있다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);

      const frame: DecisionLedgerFrame = {
        ledgerVersion: DECISION_LEDGER_VERSION,
        sourceRunId: "run-test-hold",
        sourceFrameId: `frame-llm-${Date.now()}`,
        exchange: "UPBIT",
        market: "KRW-BTC",
        strategyId: "strategy.mean-reversion",
        category: "HOLD",
        summaryStatus: "RECORDED",
        observedAt: new Date("2026-06-06T00:00:00Z"),
        decisionAt: new Date("2026-06-06T00:00:01Z"),
        correlationId: "corr-test-hold",
        reasonCounts: {},
        dedupeKey: `test-llm-fail-${Date.now()}`,
        trace: {},
      };

      const frameResult = await repository.appendFrame({ frame });
      const frameId = frameResult.record.id;

      const evidence: DecisionEvidenceItem = {
        evidenceKind: "EXPLANATION_FAILURE",
        category: "EXPLANATION_FAILED",
        reasonCode: "llm_timeout",
        userMessage: "LLM 설명 생성이 시간 초과로 실패했습니다.",
        impact: null,
        action: null,
        occurredAt: new Date(),
        source: "llm-summary",
        sourceId: null,
        payload: { provider: "test", timeoutMs: 30000 },
        evidenceFingerprint: `fp-llm-fail-${Date.now()}`,
        trace: {},
      };

      const result = await repository.appendEvidenceItems(frameId, [{ item: evidence }]);
      expect(result.inserted).toBe(1);
      expect(result.records[0]!.evidence_kind).toBe("EXPLANATION_FAILURE");
      expect(result.records[0]!.category).toBe("EXPLANATION_FAILED");
    });
  });

  describe("database constraints", () => {
    it("frame category에 EXPLANATION_FAILED를 직접 insert할 수 없다", async () => {
      const db = await getDatabase();

      await expect(sql`
        INSERT INTO decision_ledger_frames (
          ledger_version,
          source_frame_id,
          exchange,
          category,
          summary_status,
          observed_at,
          decision_at,
          dedupe_key
        )
        VALUES (
          'm18.decision_ledger.v1',
          'frame-invalid-db-category',
          'UPBIT',
          'EXPLANATION_FAILED',
          'RECORDED',
          '2026-06-06T00:00:00Z'::timestamptz,
          '2026-06-06T00:00:01Z'::timestamptz,
          'db-invalid-frame-category'
        )
      `.execute(db)).rejects.toThrow();
    });

    it("EXPLANATION_FAILURE 전용 category 조합을 DB constraint로 강제한다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frameResult = await repository.appendFrame({ frame: makeFrame("db-evidence-combo") });

      await expect(sql`
        INSERT INTO decision_ledger_evidence (
          frame_id,
          evidence_kind,
          category,
          user_message,
          source,
          evidence_fingerprint,
          occurred_at
        )
        VALUES (
          ${frameResult.record.id}::uuid,
          'RISK_DECISION',
          'EXPLANATION_FAILED',
          '설명 실패 category를 리스크 근거로 저장하려 했습니다.',
          'risk-gate',
          'db-invalid-evidence-combo',
          '2026-06-06T00:00:02Z'::timestamptz
        )
      `.execute(db)).rejects.toThrow();
    });

    it("저장된 ledger frame은 update로 덮어쓸 수 없다", async () => {
      const db = await getDatabase();
      const repository = new PostgresDecisionLedgerRepository(db);
      const frameResult = await repository.appendFrame({ frame: makeFrame("db-append-only") });

      await expect(
        db
          .updateTable("decision_ledger_frames")
          .set({ summary_status: "PARTIAL" })
          .where("id", "=", frameResult.record.id)
          .execute(),
      ).rejects.toThrow(/append-only/u);
    });
  });
});
