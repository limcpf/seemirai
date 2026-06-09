import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "soak-paper-24h.mjs");

describe("M8 paper soak script", () => {
  it("skips the 24h soak path unless SEEMIRAI_RUN_SOAK is explicitly enabled", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const { stdout } = await runSoak(["--json", "--log-dir", logDir], {
      SEEMIRAI_RUN_SOAK: "0",
    });

    const summary = JSON.parse(stdout) as SoakSummary;
    const longRunGuard = getCheck(summary, "longRunGuard");

    expect(summary.status).toBe("skipped");
    expect(longRunGuard.status).toBe("skipped");
    expect(longRunGuard.evidence.requiredEnv).toBe("SEEMIRAI_RUN_SOAK=1");
    await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
  });

  it("runs a deterministic fixture smoke with stale-data block and live-order count evidence", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const { stdout } = await runSoak(["--fixture-smoke", "--json", "--log-dir", logDir]);

    const summary = JSON.parse(stdout) as SoakSummary;

    expect(summary.status).toBe("passed");
    expect(summary.input).toBe("fixture_smoke");
    expect(summary.metrics.liveOrderApiCalls).toBe(0);
    expect(getCheck(summary, "configSafety").status).toBe("ok");
    expect(getCheck(summary, "liveOrderApiCalls")).toMatchObject({
      status: "ok",
      evidence: {
        count: 0,
      },
    });
    expect(getCheck(summary, "staleDataBlocked")).toMatchObject({
      status: "ok",
      evidence: {
        blockedEvents: 1,
      },
    });
    expect(getCheck(summary, "auditMissing")).toMatchObject({
      status: "ok",
      evidence: {
        count: 0,
      },
    });
    expect(getCheck(summary, "telegramInboundGuarded")).toMatchObject({
      status: "ok",
      evidence: {
        inboundEnabled: false,
        ownerChatAllowlistCount: 0,
        pollingTransportAllowed: true,
      },
    });
    expect(getCheck(summary, "dailyReportGenerated").status).toBe("skipped");

    const rawLog = await readFile(summary.artifacts.rawLogPath, "utf8");
    expect(rawLog.trim().split("\n")).toHaveLength(4);
    await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
  });

  it("probes control URL without posting a state-changing kill-switch request", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", ready: true }));
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.writeHead(500);
      response.end();
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoak([
        "--fixture-smoke",
        "--json",
        "--log-dir",
        logDir,
        "--control-url",
        controlUrl,
        "--control-probe-timeout-ms",
        "500",
      ]);
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(summary.status).toBe("passed");
      expect(requests).toEqual(["GET /readyz", "GET /status"]);
      expect(getCheck(summary, "readyzEndpoint").status).toBe("ok");
      expect(getCheck(summary, "statusEndpoint").status).toBe("ok");
      expect(getCheck(summary, "killSwitchEndpoint")).toMatchObject({
        status: "ok",
        evidence: {
          stateChangingProbeSkipped: true,
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("runs an explicit kill-switch control drill with correlation, cancel, and Telegram evidence", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", ready: true }));
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "POST" && request.url === "/kill-switch") {
        if (request.headers.authorization !== "Bearer drill-token") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "error" }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "ok",
            correlationId: "corr-drill",
            transition: {
              accepted: true,
              fromState: "NORMAL",
              toState: "HARD_STOP",
              reasonCode: "db_write_failure",
              message: "drill accepted",
            },
            actionPlan: {
              newOrdersBlocked: true,
              strategyEvaluationBlocked: true,
              cancelPendingPaperOrders: true,
              autoLiquidateOpenPositions: false,
              requiresManualReview: true,
            },
            reasonMatchesTarget: true,
            recommendedTargetState: "HARD_STOP",
            hardStopCancelJob: {
              jobType: "hard_stop_pending_paper_order_cancel",
              idempotencyKey: "hard_stop_pending_paper_order_cancel:corr-drill",
              created: true,
            },
            evidence: {
              auditEventId: "audit-drill",
              riskEventId: "risk-drill",
            },
            alertDispatch: {
              fingerprint: "alert:test:paper_trading:P0:kill_switch_control:global:global:db_write_failure",
              cooldownHit: false,
              notification: {
                delivered: true,
                providerMessageId: "telegram-drill-message",
                skippedReason: null,
              },
            },
            alertDispatchFailure: null,
          }),
        );
        return;
      }

      response.writeHead(500);
      response.end();
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoak(
        [
          "--fixture-smoke",
          "--json",
          "--log-dir",
          logDir,
          "--control-url",
          controlUrl,
          "--control-probe-timeout-ms",
          "500",
          "--control-drill",
          "--control-drill-correlation-id",
          "corr-drill",
          "--control-token-env",
          "TEST_CONTROL_TOKEN",
        ],
        {
          TEST_CONTROL_TOKEN: "drill-token",
        },
      );
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(summary.status).toBe("passed");
      expect(requests).toEqual(["GET /readyz", "GET /status", "POST /kill-switch", "POST /kill-switch"]);
      expect(getCheck(summary, "controlMissingTokenRejected")).toMatchObject({
        status: "ok",
        evidence: {
          statusCode: 401,
        },
      });
      expect(getCheck(summary, "killSwitchDrill")).toMatchObject({
        status: "ok",
        evidence: {
          correlationId: "corr-drill",
          auditEventId: "audit-drill",
          riskEventId: "risk-drill",
          alertDispatch: {
            delivered: true,
            providerMessageId: "telegram-drill-message",
          },
          hardStopCancelJob: {
            created: true,
          },
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("validates a NORMAL control drill without requiring new-order blocking or hard-stop cancel jobs", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", ready: true }));
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "POST" && request.url === "/kill-switch") {
        if (request.headers.authorization !== "Bearer drill-token") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "error" }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "ok",
            correlationId: "corr-normal-drill",
            transition: {
              accepted: true,
              fromState: "NEW_ORDERS_BLOCKED",
              toState: "NORMAL",
              reasonCode: "operator_clear",
              message: "normal drill accepted",
            },
            actionPlan: {
              newOrdersBlocked: false,
              strategyEvaluationBlocked: false,
              cancelPendingPaperOrders: false,
              autoLiquidateOpenPositions: false,
              requiresManualReview: false,
            },
            reasonMatchesTarget: true,
            recommendedTargetState: "NORMAL",
            hardStopCancelJob: null,
            evidence: {
              auditEventId: "audit-normal-drill",
              riskEventId: "risk-normal-drill",
            },
            alertDispatch: {
              fingerprint: "alert:test:paper_trading:P1:kill_switch_control:global:global:operator_clear",
              cooldownHit: true,
              notification: {
                delivered: false,
                providerMessageId: null,
                skippedReason: "alert_delivery_reserved",
              },
            },
            alertDispatchFailure: null,
          }),
        );
        return;
      }

      response.writeHead(500);
      response.end();
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoak(
        [
          "--fixture-smoke",
          "--json",
          "--log-dir",
          logDir,
          "--control-url",
          controlUrl,
          "--control-drill",
          "--control-drill-target",
          "NORMAL",
          "--control-drill-reason",
          "operator_clear",
          "--control-drill-correlation-id",
          "corr-normal-drill",
          "--control-token-env",
          "TEST_CONTROL_TOKEN",
        ],
        {
          TEST_CONTROL_TOKEN: "drill-token",
        },
      );
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(summary.status).toBe("passed");
      expect(getCheck(summary, "killSwitchDrill")).toMatchObject({
        status: "ok",
        evidence: {
          correlationId: "corr-normal-drill",
          targetState: "NORMAL",
          hardStopCancelJob: null,
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("rejects control drill runs without a control URL", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));

    const failure = await runSoakExpectFailure(["--fixture-smoke", "--json", "--log-dir", logDir, "--control-drill"]);

    expect(failure.stderr).toContain("--control-drill requires --control-url");
  });

  it("fails a control drill when the response transitions to a different target", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", ready: true }));
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "POST" && request.url === "/kill-switch") {
        if (request.headers.authorization !== "Bearer drill-token") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "error" }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(createControlDrillResponse({
            correlationId: "corr-target-mismatch",
            toState: "NEW_ORDERS_BLOCKED",
            newOrdersBlocked: false,
          })),
        );
        return;
      }

      response.writeHead(500);
      response.end();
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoakExpectFailure(
        [
          "--fixture-smoke",
          "--json",
          "--log-dir",
          logDir,
          "--control-url",
          controlUrl,
          "--control-drill",
          "--control-drill-target",
          "NORMAL",
          "--control-drill-correlation-id",
          "corr-target-mismatch",
          "--control-token-env",
          "TEST_CONTROL_TOKEN",
        ],
        {
          TEST_CONTROL_TOKEN: "drill-token",
        },
      );
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(summary.status).toBe("failed");
      expect(getCheck(summary, "killSwitchDrill").evidence.failures).toContain("target_state_mismatch");
    } finally {
      await closeServer(server);
    }
  });

  it("fails a non-HARD_STOP drill when pending cancel remains active", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", ready: true }));
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "POST" && request.url === "/kill-switch") {
        if (request.headers.authorization !== "Bearer drill-token") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "error" }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(createControlDrillResponse({
            correlationId: "corr-unexpected-cancel",
            cancelPendingPaperOrders: true,
            hardStopCancelJob: {
              jobType: "hard_stop_pending_paper_order_cancel",
              idempotencyKey: "hard_stop_pending_paper_order_cancel:corr-unexpected-cancel",
              created: true,
            },
          })),
        );
        return;
      }

      response.writeHead(500);
      response.end();
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoakExpectFailure(
        [
          "--fixture-smoke",
          "--json",
          "--log-dir",
          logDir,
          "--control-url",
          controlUrl,
          "--control-drill",
          "--control-drill-target",
          "NORMAL",
          "--control-drill-correlation-id",
          "corr-unexpected-cancel",
          "--control-token-env",
          "TEST_CONTROL_TOKEN",
        ],
        {
          TEST_CONTROL_TOKEN: "drill-token",
        },
      );
      const summary = JSON.parse(stdout) as SoakSummary;
      const failures = getCheck(summary, "killSwitchDrill").evidence.failures;

      expect(summary.status).toBe("failed");
      expect(failures).toContain("unexpected_pending_cancel_plan");
      expect(failures).toContain("unexpected_hard_stop_cancel_job");
    } finally {
      await closeServer(server);
    }
  });

  it("fails a control drill when durable evidence ids are empty", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", ready: true }));
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "POST" && request.url === "/kill-switch") {
        if (request.headers.authorization !== "Bearer drill-token") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "error" }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(createControlDrillResponse({
            auditEventId: "",
            correlationId: "corr-empty-evidence",
          })),
        );
        return;
      }

      response.writeHead(500);
      response.end();
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoakExpectFailure(
        [
          "--fixture-smoke",
          "--json",
          "--log-dir",
          logDir,
          "--control-url",
          controlUrl,
          "--control-drill",
          "--control-drill-target",
          "NORMAL",
          "--control-drill-correlation-id",
          "corr-empty-evidence",
          "--control-token-env",
          "TEST_CONTROL_TOKEN",
        ],
        {
          TEST_CONTROL_TOKEN: "drill-token",
        },
      );
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(getCheck(summary, "killSwitchDrill").evidence.failures).toContain("durable_evidence_missing");
    } finally {
      await closeServer(server);
    }
  });

  it("records control probe timeouts as failed checks while still writing artifacts", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const server = createServer(() => {
      // timeout 검증용 서버는 일부러 응답하지 않는다. soak script는 이 상태를 실패 check로 기록해야 한다.
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoakExpectFailure([
        "--fixture-smoke",
        "--json",
        "--log-dir",
        logDir,
        "--control-url",
        controlUrl,
        "--control-probe-timeout-ms",
        "50",
      ]);
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(summary.status).toBe("failed");
      expect(getCheck(summary, "statusEndpoint")).toMatchObject({
        status: "fail",
        evidence: {
          timeoutMs: 50,
        },
      });
      await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
      await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });

  it("preserves summary artifacts when public WebSocket soak fails", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const { stdout } = await runSoakExpectFailure(
      [
        "--json",
        "--log-dir",
        logDir,
        "--duration-ms",
        "50",
        "--websocket-url",
        "ws://127.0.0.1:1",
        "--daily-report-generated",
      ],
      {
        SEEMIRAI_RUN_SOAK: "1",
      },
    );
    const summary = JSON.parse(stdout) as SoakSummary;

    expect(summary.status).toBe("failed");
    expect(summary.input).toBe("upbit_public_websocket");
    expect(getCheck(summary, "publicWebSocket")).toMatchObject({
      status: "fail",
    });
    await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
  });
});

async function runSoak(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function runSoakExpectFailure(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  try {
    await runSoak(args, env);
  } catch (error) {
    return error as ExecFileFailure;
  }
  throw new Error("Expected soak script to fail");
}

function listenOnLocalhost(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function getCheck(summary: SoakSummary, name: string): SoakCheck {
  const check = summary.checks[name];
  expect(check).toBeDefined();
  return check!;
}

/**
 * control drill 실패 조건을 fixture server에서 재현하기 위한 기본 HTTP 응답이다.
 *
 * 테스트별 override만 바꾸고 correlation/evidence/Telegram dispatch 필드는 유지해, 실패 원인이 target/cancel 검증에만
 * 묶이도록 한다.
 */
function createControlDrillResponse(options: {
  correlationId: string;
  toState?: string;
  newOrdersBlocked?: boolean;
  cancelPendingPaperOrders?: boolean;
  hardStopCancelJob?: Record<string, unknown> | null;
  auditEventId?: string;
  riskEventId?: string;
}) {
  return {
    status: "ok",
    correlationId: options.correlationId,
    transition: {
      accepted: true,
      fromState: "NEW_ORDERS_BLOCKED",
      toState: options.toState ?? "NORMAL",
      reasonCode: "operator_clear",
      message: "drill accepted",
    },
    actionPlan: {
      newOrdersBlocked: options.newOrdersBlocked ?? false,
      strategyEvaluationBlocked: false,
      cancelPendingPaperOrders: options.cancelPendingPaperOrders ?? false,
      autoLiquidateOpenPositions: false,
      requiresManualReview: false,
    },
    reasonMatchesTarget: true,
    recommendedTargetState: options.toState ?? "NORMAL",
    hardStopCancelJob: options.hardStopCancelJob ?? null,
    evidence: {
      auditEventId: options.auditEventId ?? `audit-${options.correlationId}`,
      riskEventId: options.riskEventId ?? `risk-${options.correlationId}`,
    },
    alertDispatch: {
      fingerprint: `alert:test:paper_trading:P1:kill_switch_control:global:global:${options.correlationId}`,
      cooldownHit: false,
      notification: {
        delivered: true,
        providerMessageId: `telegram-${options.correlationId}`,
        skippedReason: null,
      },
    },
    alertDispatchFailure: null,
  };
}

interface SoakSummary {
  status: "skipped" | "passed" | "failed";
  input: string;
  metrics: {
    liveOrderApiCalls: number;
  };
  artifacts: {
    rawLogPath: string;
    summaryPath: string;
    reportPath: string;
  };
  checks: Record<string, SoakCheck>;
}

interface SoakCheck {
  status: "ok" | "skipped" | "fail";
  message: string;
  evidence: Record<string, unknown>;
}

interface ExecFileFailure extends Error {
  stdout: string;
  stderr: string;
  code: number;
}
