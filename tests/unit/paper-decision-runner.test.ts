import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PaperDecisionRunner,
  StaticPaperDecisionInputSource,
} from "../../src/application/index.js";
import {
  PaperBroker,
} from "../../src/infrastructure/index.js";
import {
  runM9PaperDecisionFixtureSmoke,
} from "../../src/runtime/index.js";

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "m9", "paper-decision-runner.json");

describe("M9 paper decision runner", () => {
  it("runs controlled fixture through strategy, cost/risk gates, PaperBroker, and metrics", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.framesProcessed).toBe(4);
    expect(result.metrics).toMatchObject({
      strategyEvaluationCount: 4,
      orderCandidateCount: 3,
      orderIntentCount: 3,
      costRejectedCount: 1,
      riskRejectedCount: 1,
      paperOrderSubmittedCount: 1,
      paperFillCount: 1,
      fillRate: 1,
      liveOrderApiCalls: 0,
      holdReasonCounts: {
        fixture_waiting_for_signal: 1,
      },
      blockingReasonCounts: {
        "cost:cost_margin_insufficient": 1,
        "hold:fixture_waiting_for_signal": 1,
        "risk:expected_loss_limit_exceeded": 1,
      },
    });
    expect(result.metrics.costSummary).toMatchObject({
      evaluatedCount: 3,
      allowedCount: 2,
      rejectedCount: 1,
      averageCostBps: "13",
      averageRequiredReturnBps: "23",
    });
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 1,
      averageSlippageBps: "0",
      minSlippageBps: "0",
      maxSlippageBps: "0",
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      startingCashKrw: "1000000",
      endingCashKrw: "989995",
      positionMarketValueKrw: "9999",
      realizedPnlKrw: "0",
      unrealizedPnlKrw: "-6",
      totalPnlKrw: "-6",
      totalReturnBps: "-0.06",
      totalFeesKrw: "5",
      submittedOrderCount: 1,
      filledOrderCount: 1,
    });
    expect(result.trace.map((record) => record.stage)).toContain("EXECUTION_RESULT");
  });

  it("keeps zero-order runs explainable with hold reason counts", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.frames = [fixture.frames[0]];

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.metrics.paperOrderSubmittedCount).toBe(0);
    expect(result.metrics.paperFillCount).toBe(0);
    expect(result.metrics.fillRate).toBe(0);
    expect(result.metrics.holdReasonCounts).toEqual({
      fixture_waiting_for_signal: 1,
    });
    expect(result.metrics.blockingReasonCounts).toEqual({
      "hold:fixture_waiting_for_signal": 1,
    });
    expect(result.metrics.costSummary).toMatchObject({
      evaluatedCount: 0,
      averageCostBps: null,
    });
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 0,
      averageSlippageBps: null,
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      startingCashKrw: "1000000",
      endingCashKrw: "1000000",
      positionMarketValueKrw: "0",
      totalPnlKrw: "0",
      totalFeesKrw: "0",
      submittedOrderCount: 0,
      filledOrderCount: 0,
    });
  });

  it("excludes broker-rejected orders from fill and slippage metrics", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.initialBalances = [
      {
        currency: "KRW",
        available: "1",
      },
    ];
    fixture.frames = [fixture.frames[3]];

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.metrics.paperOrderSubmittedCount).toBe(1);
    expect(result.metrics.paperFillCount).toBe(0);
    expect(result.metrics.fillRate).toBe(0);
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 0,
      averageSlippageBps: null,
    });
    expect(result.metrics.discardReasonCounts).toEqual({
      paper_broker_rejected: 1,
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      startingCashKrw: "1",
      endingCashKrw: "1",
      totalPnlKrw: "0",
      submittedOrderCount: 1,
      filledOrderCount: 0,
    });
  });

  it("uses phase 1.5 approved alt universe evidence for TOP_ALT safety buffer defaults", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const frame = fixture.frames[3];
    fixture.frames = [frame];
    fixture.universe = {
      phase15ApprovedAltMarkets: ["KRW-SOL"],
    };
    frame.market = "KRW-SOL";
    frame.orderbook.market = "KRW-SOL";
    frame.features.expected_return_bps = "35";
    delete frame.features.safety_buffer_bps;
    delete frame.universe;

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.metrics.costRejectedCount).toBe(0);
    expect(result.metrics.paperOrderSubmittedCount).toBe(1);
    expect(result.metrics.costSummary).toMatchObject({
      evaluatedCount: 1,
      allowedCount: 1,
      averageRequiredReturnBps: "33",
    });
  });

  it("deduplicates repeated broker order ids in submission and fill metrics", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.frames = [fixture.frames[3], fixture.frames[3]];

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.framesProcessed).toBe(2);
    expect(result.metrics.orderIntentCount).toBe(2);
    expect(result.metrics.paperOrderSubmittedCount).toBe(1);
    expect(result.metrics.paperFillCount).toBe(1);
    expect(result.metrics.fillRate).toBe(1);
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 1,
      averageSlippageBps: "0",
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      submittedOrderCount: 1,
      filledOrderCount: 1,
      totalFeesKrw: "5",
    });
  });

  it("does not yield frames when static source replay limit is zero", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const source = new StaticPaperDecisionInputSource([fixture.frames[0]]);
    const frames = [];

    for await (const frame of source.replay({ limit: 0 })) {
      frames.push(frame);
    }

    expect(frames).toEqual([]);
  });

  it("does not consume a replay frame beyond maxFrames", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    let pulledFrameCount = 0;
    let observedLimit: number | undefined;
    const source = {
      async *replay(request: { limit?: number } = {}) {
        observedLimit = request.limit;
        for (const frame of fixture.frames.slice(0, 2)) {
          pulledFrameCount += 1;
          yield frame;
        }
      },
    };
    const broker = new PaperBroker({
      exchangeId: "upbit_krw_spot",
      initialBalances: fixture.initialBalances,
    });
    const runner = new PaperDecisionRunner({
      source,
      strategies: [],
      broker,
    });

    const result = await runner.run({ maxFrames: 1 });

    expect(result.framesProcessed).toBe(1);
    expect(pulledFrameCount).toBe(1);
    expect(observedLimit).toBe(1);
  });
});
