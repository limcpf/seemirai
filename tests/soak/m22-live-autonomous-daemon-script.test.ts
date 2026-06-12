import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m22-live-autonomous-daemon.mjs");

describe("M22 live autonomous daemon script", () => {
  it("fails closed before running without explicit daemon guard", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-daemon-guard-"));
    const configPath = path.join(artifactDir, "m22-config.json");
    const eventLogPath = path.join(artifactDir, "events.jsonl");
    await writeFile(configPath, `${JSON.stringify(createEnabledM22Config(), null, 2)}\n`, "utf8");

    const error = await runScriptExpectingFailure([
      "--config",
      configPath,
      "--event-log-path",
      eventLogPath,
      "--dry-run",
      "--max-runtime-ms",
      "50",
    ]);

    expect(error.stderr).toContain("SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON=1");
  });

  it("emits heartbeat and daily report without creating orders when the candidate file is empty", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-daemon-heartbeat-"));
    const configPath = path.join(artifactDir, "m22-config.json");
    const candidatePath = path.join(artifactDir, "candidates.jsonl");
    const eventLogPath = path.join(artifactDir, "events.jsonl");
    await writeFile(configPath, `${JSON.stringify(createEnabledM22Config(), null, 2)}\n`, "utf8");
    await writeFile(candidatePath, "", "utf8");

    await runScript(
      [
        "--config",
        configPath,
        "--candidate-file",
        candidatePath,
        "--candidate-start",
        "beginning",
        "--event-log-path",
        eventLogPath,
        "--dry-run",
        "--heartbeat-ms",
        "20",
        "--candidate-poll-ms",
        "20",
        "--max-runtime-ms",
        "80",
      ],
      createReadyEnv(),
    );
    const events = readJsonLines(await readFile(eventLogPath, "utf8"));

    expect(events.some((event) => event.type === "m22_pilot_heartbeat")).toBe(true);
    expect(events.some((event) => event.type === "daily_report_generated")).toBe(true);
    expect(events.some((event) => event.type === "order_submitted")).toBe(false);
  });

  it("submits valid candidate-file orders in dry-run mode and writes runner-compatible events", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-daemon-candidate-"));
    const configPath = path.join(artifactDir, "m22-config.json");
    const candidatePath = path.join(artifactDir, "candidates.jsonl");
    const eventLogPath = path.join(artifactDir, "events.jsonl");
    await writeFile(configPath, `${JSON.stringify(createEnabledM22Config(), null, 2)}\n`, "utf8");
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        candidateId: "candidate-001",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "LIMIT",
        postOnly: true,
        requestedPrice: "100000000",
        requestedQuantity: "0.0001",
        requestedNotional: "10000",
        referencePrice: "100000000",
        reason: "test candidate",
      })}\n`,
      "utf8",
    );

    await runScript(
      [
        "--config",
        configPath,
        "--candidate-file",
        candidatePath,
        "--candidate-start",
        "beginning",
        "--event-log-path",
        eventLogPath,
        "--dry-run",
        "--heartbeat-ms",
        "20",
        "--candidate-poll-ms",
        "20",
        "--max-runtime-ms",
        "80",
      ],
      createReadyEnv(),
    );
    const events = readJsonLines(await readFile(eventLogPath, "utf8"));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "broker_submission", market: "KRW-BTC", dryRun: true }),
        expect.objectContaining({ type: "order_submitted", status: "DRY_RUN_SUBMITTED" }),
        expect.objectContaining({ type: "daily_report_generated" }),
      ]),
    );
  });

  it("submits and cancels a live canary candidate against the configured private API base URL", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-daemon-live-canary-"));
    const configPath = path.join(artifactDir, "m22-config.json");
    const candidatePath = path.join(artifactDir, "candidates.jsonl");
    const eventLogPath = path.join(artifactDir, "events.jsonl");
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody.length === 0 ? undefined : JSON.parse(rawBody);
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      response.setHeader("content-type", "application/json");

      if (request.method === "POST" && request.url === "/v1/orders") {
        response.end(
          JSON.stringify({
            uuid: "upbit-live-canary-001",
            identifier: (body as { identifier?: string } | undefined)?.identifier,
            market: "KRW-BTC",
            side: "bid",
            ord_type: "limit",
            state: "wait",
            price: "100000000",
            volume: "0.0001",
            remaining_volume: "0.0001",
            created_at: "2026-06-12T04:00:00+09:00",
          }),
        );
        return;
      }

      if (request.method === "DELETE" && request.url?.startsWith("/v1/order?uuid=upbit-live-canary-001")) {
        response.end(
          JSON.stringify({
            uuid: "upbit-live-canary-001",
            identifier: "m22a-aaaaaaaaaaaaaaaaaaaaaaaaaa",
            market: "KRW-BTC",
            side: "bid",
            ord_type: "limit",
            state: "wait",
            price: "100000000",
            volume: "0.0001",
            remaining_volume: "0.0001",
            created_at: "2026-06-12T04:00:00+09:00",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/v1/order?uuid=upbit-live-canary-001")) {
        response.end(
          JSON.stringify({
            uuid: "upbit-live-canary-001",
            identifier: "m22a-aaaaaaaaaaaaaaaaaaaaaaaaaa",
            market: "KRW-BTC",
            side: "bid",
            ord_type: "limit",
            state: "cancel",
            price: "100000000",
            volume: "0.0001",
            remaining_volume: "0",
            created_at: "2026-06-12T04:00:00+09:00",
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: { name: "not_found", message: "not found" } }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake Upbit server listen failed");
    }

    await writeFile(configPath, `${JSON.stringify(createEnabledM22Config(), null, 2)}\n`, "utf8");
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        candidateId: "candidate-live-canary",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "LIMIT",
        postOnly: true,
        requestedPrice: "100000000",
        requestedQuantity: "0.0001",
        requestedNotional: "10000",
        referencePrice: "100000000",
        idempotencyKey: "m22a-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        reason: "test live canary candidate",
      })}\n`,
      "utf8",
    );

    try {
      await runScript(
        [
          "--config",
          configPath,
          "--candidate-file",
          candidatePath,
          "--candidate-start",
          "beginning",
          "--event-log-path",
          eventLogPath,
          "--cancel-after-submit",
          "--cancel-confirmation-attempts",
          "2",
          "--cancel-confirmation-ms",
          "10",
          "--heartbeat-ms",
          "20",
          "--candidate-poll-ms",
          "20",
          "--max-runtime-ms",
          "80",
        ],
        {
          ...createReadyEnv(),
          SEEMIRAI_UPBIT_ACCESS_KEY: "test-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "test-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_API_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    const events = readJsonLines(await readFile(eventLogPath, "utf8"));

    expect(requests.map((request) => request.method)).toEqual(["POST", "DELETE", "GET"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "broker_submission", market: "KRW-BTC", dryRun: false }),
        expect.objectContaining({ type: "order_submitted", status: "SUBMITTED" }),
        expect.objectContaining({ type: "order_cancel_requested" }),
        expect.objectContaining({ type: "order_cancel_submitted" }),
        expect.objectContaining({ type: "order_cancel_confirmation_check", status: "cancel" }),
        expect.objectContaining({
          type: "order_cancel_confirmed",
          releasedOpenPositionNotionalKrw: "10000",
          openPositionNotionalKrw: "0",
        }),
        expect.objectContaining({
          type: "daily_report_generated",
          openPositionNotionalKrw: "0",
        }),
      ]),
    );
    expect(events.some((event) => event.type === "manual_review_required")).toBe(false);
  });

  it("blocks unsafe candidates without emitting order_submitted", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-daemon-blocked-"));
    const configPath = path.join(artifactDir, "m22-config.json");
    const candidatePath = path.join(artifactDir, "candidates.jsonl");
    const eventLogPath = path.join(artifactDir, "events.jsonl");
    await writeFile(configPath, `${JSON.stringify(createEnabledM22Config(), null, 2)}\n`, "utf8");
    await writeFile(
      candidatePath,
      `${JSON.stringify({
        candidateId: "candidate-over-budget",
        market: "KRW-BTC",
        requestedPrice: "100000000",
        requestedQuantity: "0.0002",
        requestedNotional: "20000",
        referencePrice: "100000000",
      })}\n`,
      "utf8",
    );

    await runScript(
      [
        "--config",
        configPath,
        "--candidate-file",
        candidatePath,
        "--candidate-start",
        "beginning",
        "--event-log-path",
        eventLogPath,
        "--dry-run",
        "--heartbeat-ms",
        "20",
        "--candidate-poll-ms",
        "20",
        "--max-runtime-ms",
        "80",
      ],
      createReadyEnv(),
    );
    const events = readJsonLines(await readFile(eventLogPath, "utf8"));

    expect(events.some((event) => event.type === "order_submitted")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "manual_review_required",
          reasonCode: "candidate_blocked",
        }),
      ]),
    );
  });
});

async function runScript(args: readonly string[], env: Record<string, string> = {}) {
  return await execFileAsync("node", [scriptPath, ...args], {
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function runScriptExpectingFailure(args: readonly string[], env: Record<string, string> = {}) {
  try {
    await runScript(args, env);
  } catch (error) {
    return error as Error & { stderr?: string };
  }

  throw new Error("script unexpectedly passed");
}

function createReadyEnv(): Record<string, string> {
  return {
    SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON: "1",
    SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT: "1",
    SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID: "operator-arm-evidence",
    SEEMIRAI_M22_BUDGET_EVIDENCE_ID: "budget-evidence",
    SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID: "m21-week-gate-evidence",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "key-scope-evidence",
    SEEMIRAI_M22_TELEGRAM_INBOUND_READY: "1",
    SEEMIRAI_M22_RECONCILE_FRESH: "1",
    SEEMIRAI_M22_PNL_STATUS_READY: "1",
    SEEMIRAI_M22_DECISION_LEDGER_READY: "1",
    SEEMIRAI_M22_EXIT_ENGINE_READY: "1",
  };
}

function readJsonLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createEnabledM22Config(): Record<string, unknown> {
  return {
    withdrawal_enabled: false,
    futures_enabled: false,
    leverage_enabled: false,
    market_order_enabled: false,
    entry_market_order_enabled: false,
    live_autonomous: {
      mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
      enabled: true,
      allowed_markets: ["KRW-BTC"],
      max_order_krw: "10000",
      daily_autonomous_notional_limit_krw: "30000",
      max_open_position_notional_krw: "30000",
      max_daily_loss_krw: "10000",
      max_weekly_loss_krw: "30000",
      max_price_deviation_bps: "30",
      require_m21_week_gate_evidence: true,
      require_m20_inbound_readiness: true,
      require_reconcile_freshness: true,
      require_pnl_status_ready: true,
      require_decision_ledger_ready: true,
      require_exit_engine_ready: true,
      require_operator_arm_evidence_id: true,
      require_budget_evidence_id: true,
      require_key_scope_evidence_id: true,
      identifier_prefix: "m22a-",
      identifier_max_length: 32,
    },
  };
}
