import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  StaticPaperDecisionInputSource,
} from "../../src/application/index.js";
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
});
