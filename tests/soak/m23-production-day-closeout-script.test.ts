import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repositoryRoot, "scripts", "run-m23-production-day-closeout.mjs");
const validatorPath = path.join(repositoryRoot, "scripts", "run-m23-stability-closeout.mjs");
const runtimeProvenance = {
  sourceCommitSha: "a".repeat(40),
  configFingerprint: `sha256:${"b".repeat(64)}`,
  envFingerprint: `sha256:${"c".repeat(64)}`,
  expectedMigrationVersion: 14,
  appliedMigrationVersion: 14,
};

describe("M23 production day closeout script", () => {
  it("KST day를 정확한 UTC half-open window로 변환한다", async () => {
    const output = await runModuleExpression(`
      const valid = module.createKstDayWindow("2026-07-15");
      let invalidError;
      try { module.createKstDayWindow("2026-02-30"); } catch (error) { invalidError = error.message; }
      process.stdout.write(JSON.stringify({ valid, invalidError }));
    `);
    expect(output.valid).toMatchObject({
      day: "2026-07-15",
      startedAt: "2026-07-14T15:00:00.000Z",
      finishedAt: "2026-07-15T15:00:00.000Z",
    });
    expect(output.invalidError).toContain("유효한 달력 날짜");
  });

  it("알 수 없는 CLI 인자와 값 누락을 fail-fast 한다", async () => {
    const output = await runModuleExpression(`
      const errors = [];
      for (const args of [["--unknown"], ["--day"]]) {
        try { module.parseProductionDayCloseoutArgs(args); } catch (error) { errors.push(error.message); }
      }
      process.stdout.write(JSON.stringify(errors));
    `) as string[];
    expect(output[0]).toContain("알 수 없는 인자");
    expect(output[1]).toContain("--day 값이 필요");
  });

  it("fixture summary가 actual validator의 production segment contract를 만족한다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-production-days-"));
    const segmentDays = Array.from({ length: 7 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`);
    const segments = [];

    for (const day of segmentDays) {
      const dayWindow = createTestKstDayWindow(day);
      const generatedAt = new Date(dayWindow.endMs + 5_000).toISOString();
      await execFileAsync(
        process.execPath,
        [scriptPath, "--fixture-smoke", "--day", day, "--artifact-dir", artifactDir, "--json"],
        {
          cwd: repositoryRoot,
          env: process.env,
        },
      );
      const summaryPath = path.join(artifactDir, `production-day-${day}.json`);
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
        finishedAt: string;
        dailyReportGeneratedAt: string;
        decisionEvidenceGeneratedAt: string;
        evidenceIds: {
          decisionEvidenceId: string;
          dailyReportEvidenceId: string;
          alertEvidenceIds: string[];
        };
      };
      expect(summary.finishedAt).toBe(new Date(dayWindow.endMs).toISOString());
      // fixture CLI clock은 고정돼 있으므로 report 생성 evidence만 각 segment의 실제 종료 이후 시각으로 맞춘다.
      summary.dailyReportGeneratedAt = generatedAt;
      summary.decisionEvidenceGeneratedAt = generatedAt;
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      segments.push({
        day,
        summaryPath: path.basename(summaryPath),
        decisionEvidenceId: summary.evidenceIds.decisionEvidenceId,
        decisionEvidenceDay: day,
        dailyReportEvidenceId: summary.evidenceIds.dailyReportEvidenceId,
        alertEvidenceIds: summary.evidenceIds.alertEvidenceIds,
        runtimeProvenance,
      });
    }

    const startupPath = path.join(artifactDir, "startup.json");
    await writeFile(startupPath, `${JSON.stringify({
      kind: "live_ops_daemon_startup",
      status: "ready",
      startedAt: "2026-06-30T14:00:00.000Z",
      runtimeProvenance,
    }, null, 2)}\n`, "utf8");
    const recoveryPath = path.join(artifactDir, "recovery.json");
    await writeFile(recoveryPath, `${JSON.stringify(createRecoverySummary(), null, 2)}\n`, "utf8");
    const manifestPath = path.join(artifactDir, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      issue: 267,
      mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
      startupArtifactPath: path.basename(startupPath),
      runtimeProvenance,
      liveArmedEvidenceId: "production-live-armed-evidence",
      keyScopeEvidenceId: "production-key-scope-evidence",
      operatorArmEvidenceId: "production-operator-arm-evidence",
      budgetEvidenceId: "production-budget-evidence",
      segments,
      recoveryDrillSummaryPath: path.basename(recoveryPath),
      backupRestore: { status: "passed", evidenceId: "production-db-backup-restore-evidence" },
      sourceScan: {
        evidenceId: "production-source-scan-evidence",
        liveOrderApiGuarded: true,
        marketBestOrderDefaultOpened: false,
        withdrawalOrDepositPathOpened: false,
        rawSecretExposure: false,
      },
    }, null, 2)}\n`, "utf8");

    const validator = await execFileAsync(
      process.execPath,
      [validatorPath, "--manifest", manifestPath, "--artifact-dir", artifactDir, "--json"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT: "1" },
      },
    );
    const summary = JSON.parse(validator.stdout) as { status: string; checks: Record<string, { status: string }> };
    expect(summary.status).toBe("passed");
    expect(summary.checks.segmentDuration?.status).toBe("ok");
    expect(summary.checks.segmentCompleteness?.status).toBe("ok");
  });

  it("fixture artifact는 create-only이고 운영 계정 전용 mode로 기록된다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-production-create-only-"));
    const args = [scriptPath, "--fixture-smoke", "--day", "2026-07-01", "--artifact-dir", artifactDir, "--json"];
    await execFileAsync(process.execPath, args, { cwd: repositoryRoot, env: process.env });
    await expect(execFileAsync(process.execPath, args, { cwd: repositoryRoot, env: process.env })).rejects.toMatchObject({ code: 1 });
    const fileStat = await stat(path.join(artifactDir, "production-day-2026-07-01.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("actual mode는 명시 guard 없이 provider 경계를 열지 않는다", async () => {
    await expect(execFileAsync(
      process.execPath,
      [scriptPath, "--day", "2026-07-01"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT: "0" },
      },
    )).rejects.toMatchObject({ code: 1 });
  });

  it("provider 이전 precondition 실패도 create-only failure artifact로 남긴다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-production-precondition-failure-"));
    const output = await runModuleExpression(`
      process.env.SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT = "1";
      let message;
      try {
        await module.runProductionDayCloseoutCli([
          "--day", "2026-07-15", "--first-day", "2026-07-15",
          "--config", "/missing/config", "--env-file", "/missing/env",
          "--status-file", "/missing/status", "--startup-artifact-file", "/missing/startup",
          "--pid-file", "/missing/pid", "--scheduler-event-log-file", "/missing/events",
          "--artifact-dir", ${JSON.stringify(artifactDir)},
          "--expected-source-commit-sha", "${"a".repeat(40)}",
        ], {
          clock: () => new Date("2026-07-15T14:59:59.000Z"),
          stdout: { write() {} },
        });
      } catch (error) { message = error.message; }
      process.stdout.write(JSON.stringify({ message }));
    `);
    const files = await readdir(artifactDir);
    expect(output.message).toContain("아직 종료되지 않았습니다");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^production-day-2026-07-15-failure-.*\.json$/u);
    expect(JSON.parse(await readFile(path.join(artifactDir, files[0]!), "utf8"))).toMatchObject({
      status: "failed",
      reportDate: "2026-07-15",
      error: "Error",
    });
  });

  it("현재 config/env 원문 fingerprint가 daemon provenance와 다르면 차단한다", async () => {
    const configRawText = "{\n  \"mode\": \"live\"\n}\n";
    const envRawText = "DATABASE_URL=postgres://example\n";
    const configFingerprint = `sha256:${createHash("sha256").update(configRawText).digest("hex")}`;
    const envFingerprint = `sha256:${createHash("sha256").update(envRawText).digest("hex")}`;
    const output = await runModuleExpression(`
      const provenance = { configFingerprint: ${JSON.stringify(configFingerprint)}, envFingerprint: ${JSON.stringify(envFingerprint)} };
      const valid = module.assertRuntimeInputFingerprints({
        provenance,
        configRawText: ${JSON.stringify(configRawText)},
        envRawText: ${JSON.stringify(envRawText)},
      });
      const errors = [];
      for (const input of [
        { provenance, configRawText: "{}", envRawText: ${JSON.stringify(envRawText)} },
        { provenance, configRawText: ${JSON.stringify(configRawText)}, envRawText: "CHANGED=1\\n" },
      ]) {
        try { module.assertRuntimeInputFingerprints(input); } catch (error) { errors.push(error.message); }
      }
      process.stdout.write(JSON.stringify({ valid, errors }));
    `);
    expect(output.valid).toEqual({ configFingerprint, envFingerprint });
    expect(output.errors).toEqual([
      "현재 config fingerprint가 daemon startup provenance와 다릅니다.",
      "현재 env fingerprint가 daemon startup provenance와 다릅니다.",
    ]);
  });

  it("하루 decision coverage는 최소 개수, 양 끝 경계, 최대 gap을 모두 요구한다", async () => {
    const output = await runModuleExpression(`
      const window = module.createKstDayWindow("2026-07-15");
      const valid = {
        decisionCount: 1440,
        distinctDedupeCount: 1440,
        firstDecisionAt: new Date(window.startMs + 1000).toISOString(),
        latestDecisionAt: new Date(window.endMs - 1000).toISOString(),
        maxDecisionGapMs: 60000,
      };
      module.assertDecisionCoverage(valid, window);
      const errors = [];
      for (const invalid of [
        { ...valid, decisionCount: 1, distinctDedupeCount: 1 },
        { ...valid, maxDecisionGapMs: 180001 },
        { ...valid, firstDecisionAt: new Date(window.startMs + 180001).toISOString() },
      ]) {
        try { module.assertDecisionCoverage(invalid, window); } catch (error) { errors.push(error.message); }
      }
      process.stdout.write(JSON.stringify(errors));
    `) as string[];
    expect(output).toHaveLength(3);
    expect(output[0]).toContain("최소 개수");
    expect(output[1]).toContain("최대 gap");
    expect(output[2]).toContain("시작 경계");
  });

  it("open position은 손실과 합산한 50,000 KRW ceiling 미만이면 허용한다", async () => {
    const output = await runModuleExpression(`
      const allowed = module.assertCloseoutExposureCeiling({
        dailyRealizedLossKrw: "10000",
        weeklyRealizedLossKrw: "19000",
        openPositionNotionalKrw: "30000",
      });
      let blocked;
      try {
        module.assertCloseoutExposureCeiling({
          dailyRealizedLossKrw: "20000",
          weeklyRealizedLossKrw: "20000",
          openPositionNotionalKrw: "30000",
        });
      } catch (error) { blocked = error.message; }
      process.stdout.write(JSON.stringify({ allowed, blocked }));
    `);
    expect(output.allowed).toEqual({ ceilingRealizedLossKrw: "19000", combinedExposureKrw: "49000" });
    expect(output.blocked).toContain("50,000 KRW ceiling 이상");
  });

  it("KST 경계 counter delta와 guarded decision 수가 같아야 실제 제출 evidence로 인정한다", async () => {
    const output = await runModuleExpression(`
      const window = module.createKstDayWindow("2026-07-15");
      const zero = {
        tickCount: 100, successCount: 100, holdCount: 100, blockCount: 0,
        manualReviewCount: 0, transientFailureCount: 0, submittedOrderCount: 2,
        exitRequoteCount: 0, duplicateOrderCount: 0, reconcileMismatchCount: 0,
        untrackedFillCount: 0, liveOrderCleanupFailureCount: 0, crashCount: 0,
        unhandledRejectionCount: 0,
      };
      const finish = { ...zero, tickCount: 1540, successCount: 1540, holdCount: 1539, submittedOrderCount: 3 };
      const boundary = (boundaryAt, counters) => ({
        type: "daemon_counter_boundary", boundaryAt, observedAt: boundaryAt,
        daemonStartedAt: "2026-07-13T20:00:00.000Z",
        latestTickStartedAt: new Date(Date.parse(boundaryAt) - 30000).toISOString(),
        sourceCommitSha: "a".repeat(40), counters,
      });
      const evidence = module.deriveDaemonDayEvidence({
        eventLogRaw: [boundary(window.startedAt, zero), boundary(window.finishedAt, finish)].map(JSON.stringify).join("\\n"),
        window,
        daemonStartedAt: "2026-07-13T20:00:00.000Z",
        sourceCommitSha: "a".repeat(40),
      });
      const valid = module.assertLiveSubmissionEvidence({
        counters: evidence.counters,
        databaseEvidence: { actionableDecisionCount: 1, malformedActionableDecisionCount: 0 },
        liveArtifacts: { cleanupSubmissionCount: 1 },
      });
      let mismatch;
      try {
        module.assertLiveSubmissionEvidence({
          counters: evidence.counters,
          databaseEvidence: { actionableDecisionCount: 0, malformedActionableDecisionCount: 0 },
          liveArtifacts: { cleanupSubmissionCount: 1 },
        });
      } catch (error) { mismatch = error.message; }
      let cleanupMissing;
      try {
        module.assertLiveSubmissionEvidence({
          counters: evidence.counters,
          databaseEvidence: { actionableDecisionCount: 1, malformedActionableDecisionCount: 0 },
          liveArtifacts: { cleanupSubmissionCount: 0 },
        });
      } catch (error) { cleanupMissing = error.message; }
      process.stdout.write(JSON.stringify({ counters: evidence.counters, valid, mismatch, cleanupMissing }));
    `);
    expect(output.counters).toMatchObject({ tickCount: 1440, submittedOrderCount: 1 });
    expect(output.valid).toEqual({ submittedOrderCount: 1, riskGateBypassCount: 0 });
    expect(output.mismatch).toContain("broker 제출과 guarded actionable decision");
    expect(output.cleanupMissing).toContain("cleanup artifact 개수");
  });

  it("decision aggregate는 Issue 267 대상 exchange, market, strategy scope만 조회한다", async () => {
    const output = await runModuleExpression(`
      let captured;
      const pool = {
        async query(text, params) {
          captured = { text, params };
          return { rows: [{
            migration_version: 14, kill_switch_state: "NORMAL", decision_count: 1440,
            actionable_decision_count: 0, malformed_actionable_decision_count: 0,
            distinct_dedupe_count: 1440, first_decision_at: "2026-07-14T15:00:01.000Z",
            latest_decision_at: "2026-07-15T14:59:59.000Z", max_decision_gap_ms: 60000,
            database_order_count: 0, fill_count: 0,
          }] };
        },
      };
      const evidence = await module.readDatabaseEvidence(pool, module.createKstDayWindow("2026-07-15"));
      process.stdout.write(JSON.stringify({ captured, evidence }));
    `);
    expect(output.captured.text).toContain("exchange = $3 and market = $4 and strategy_id = $5");
    expect(output.captured.params.slice(2)).toEqual(["UPBIT", "KRW-BTC", "live_ops_autonomous_24x7_core"]);
    expect(output.evidence.decisionScope).toEqual({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
    });
  });

  it("daily report audit은 KST day 종료 이후 생성된 행만 evidence로 사용한다", async () => {
    const output = await runModuleExpression(`
      const rows = [
        { id: "early", occurred_at: "2026-07-15T14:59:59.999Z" },
        { id: "boundary", occurred_at: "2026-07-15T15:00:00.000Z" },
        { id: "late", occurred_at: new Date("2026-07-15T15:01:00.000Z") },
      ];
      process.stdout.write(JSON.stringify(module.filterPostWindowDailyReportAuditRows(rows, "2026-07-15T15:00:00.000Z")));
    `) as Array<{ id: string }>;
    expect(output.map((row) => row.id)).toEqual(["boundary", "late"]);
  });

  it("일반 daily report audit은 Issue 267 M23 closeout 전달 evidence로 재사용하지 않는다", async () => {
    const output = await runModuleExpression(`
      const rows = [
        {
          id: "generic", actor: "daily_report_runner", correlation_id: "generic-run",
          occurred_at: "2026-07-15T15:01:00.000Z",
        },
        {
          id: "closeout", actor: "codex-issue-267-day-closeout",
          correlation_id: "issue-267-production-day-2026-07-15-run-1",
          occurred_at: "2026-07-15T15:01:01.000Z",
        },
        {
          id: "recovery", actor: "codex-issue-267-day-closeout",
          correlation_id: "issue-267-delivery-recovery-2026-07-15",
          occurred_at: "2026-07-15T15:01:02.000Z",
        },
      ];
      process.stdout.write(JSON.stringify(module.filterIssue267CloseoutDailyReportAuditRows(
        rows, "2026-07-15", "2026-07-15T15:00:00.000Z",
      )));
    `) as Array<{ id: string }>;
    expect(output.map((row) => row.id)).toEqual(["closeout", "recovery"]);
  });

  it("제출 cleanup은 matching reservation을 요구하고 PnL 입력 변경은 evidence fingerprint를 바꾼다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-live-artifacts-"));
    const missingReservationDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-live-artifacts-missing-"));
    const attemptSuffix = "a".repeat(26);
    const cleanupFile = `cleanup-ops-${attemptSuffix}.json`;
    const reservation = {
      attemptId: `ops-${attemptSuffix}`,
      strategyId: "live_ops_autonomous_24x7_core",
      market: "KRW-BTC",
      reservedAt: "2026-07-14T16:00:00.000Z",
    };
    const cleanup = {
      attemptId: reservation.attemptId,
      strategyId: reservation.strategyId,
      market: reservation.market,
      kind: "live_ops_autonomous_exit_closeout",
      side: "SELL",
      status: "FILLED",
      filledAt: "2026-07-14T16:00:02.000Z",
      terminalCheckedAt: "2026-07-14T16:00:02.000Z",
      filledQuantity: "0.0001",
      filledPrice: "90000000",
      filledNotionalKrw: "9000",
      entryFeeKrw: "4",
      exitFeeKrw: "4.5",
      realizedPnlKrw: "-100",
    };
    await writeFile(path.join(artifactDir, cleanupFile), `${JSON.stringify(cleanup)}\n`, "utf8");
    await writeFile(path.join(missingReservationDir, cleanupFile), `${JSON.stringify({
      ...cleanup,
      kind: "live_ops_autonomous_entry_fill_closeout",
      side: "BUY",
      realizedPnlKrw: undefined,
    })}\n`, "utf8");

    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const window = module.createKstDayWindow("2026-07-15");
      const first = await module.readLiveArtifactEvidence(${JSON.stringify(artifactDir)}, window);
      const changed = ${JSON.stringify(cleanup)};
      changed.realizedPnlKrw = "-200";
      await fs.writeFile(${JSON.stringify(path.join(artifactDir, cleanupFile))}, JSON.stringify(changed));
      const second = await module.readLiveArtifactEvidence(${JSON.stringify(artifactDir)}, window);
      let missingReservation;
      try { await module.readLiveArtifactEvidence(${JSON.stringify(missingReservationDir)}, window); }
      catch (error) { missingReservation = error.message; }
      process.stdout.write(JSON.stringify({ first, second, missingReservation }));
    `);
    expect(output.first.realizedLossKrw).toBe("100");
    expect(output.second.realizedLossKrw).toBe("200");
    expect(output.second.evidenceId).not.toBe(output.first.evidenceId);
    expect(output.missingReservation).toContain("BUY 제출 cleanup과 일치하는 대상 strategy reservation이 없습니다");
  });

  it("주간 손실은 같은 provenance와 first-day를 가진 연속 선행 일자만 집계한다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-rollout-losses-"));
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const firstDay = "2026-07-15";
      const previous = module.createFixtureProductionDaySummary({
        day: firstDay,
        generatedAt: new Date("2026-07-15T15:00:05.000Z"),
      });
      previous.metrics.dailyRealizedLossKrw = "120";
      await fs.writeFile(${JSON.stringify(path.join(artifactDir, "production-day-2026-07-15.json"))}, JSON.stringify(previous));
      await fs.writeFile(${JSON.stringify(path.join(artifactDir, "production-day-2020-01-01.json"))}, JSON.stringify({
        status: "passed", metrics: { dailyRealizedLossKrw: "999999" },
      }));
      const losses = await module.readPreviousProductionDayLosses({
        artifactDir: ${JSON.stringify(artifactDir)}, firstDay, day: "2026-07-16",
        runtimeProvenance: ${JSON.stringify(runtimeProvenance)},
      });
      previous.runtimeProvenance = { ...previous.runtimeProvenance, sourceCommitSha: "d".repeat(40) };
      await fs.writeFile(${JSON.stringify(path.join(artifactDir, "production-day-2026-07-15.json"))}, JSON.stringify(previous));
      let mismatch;
      try {
        await module.readPreviousProductionDayLosses({
          artifactDir: ${JSON.stringify(artifactDir)}, firstDay, day: "2026-07-16",
          runtimeProvenance: ${JSON.stringify(runtimeProvenance)},
        });
      } catch (error) { mismatch = error.message; }
      process.stdout.write(JSON.stringify({ losses, mismatch, days: module.createRolloutPreviousDays(firstDay, "2026-07-21") }));
    `);
    expect(output.losses).toEqual(["120"]);
    expect(output.mismatch).toContain("현재 rollout window/provenance와 다릅니다");
    expect(output.days).toEqual(["2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20"]);
  });

  it("daily report live ops snapshot에 후보 없음과 HOLD 판단 이유를 포함한다", async () => {
    const output = await runModuleExpression(`
      const captured = module.createDailyReportLiveOpsStatus({
        applicationModule: { createLiveOpsStatusSummary(input) { return input; } },
        status: {
          latestTickStartedAt: "2026-07-15T15:00:30.000Z",
          latestSummary: {
            status: "ready", message: "운영 준비 완료", dbReadiness: { ready: true },
            marketData: { ready: true, latestHeartbeatAt: "2026-07-15T15:00:30.000Z", message: "시세 정상" },
            analysisDecision: {
              ready: true, decisionCategory: "HOLD", orderIntentCount: 0,
              latestDecisionAt: "2026-07-15T15:00:30.000Z", message: "진입 조건 미충족으로 HOLD했습니다.",
            },
            liveExecution: { ready: true, attemptedOrderCount: 0, brokerGuard: { ready: true, keyScopeEvidenceId: "scope-1" } },
            reconcilePnlStatus: { ready: true, pnlStatusLabel: "대기", budgetUsedKrw: "0" },
            telegramAlert: { ready: true, statusLabel: "알림 정상" },
          },
        },
        config: {
          mode: "LIVE_AUTONOMOUS_SMALL_BUDGET", live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"] },
          budget: {
            max_order_krw: "10000", daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        databaseEvidence: { killSwitchState: "NORMAL" },
        privateRead: { openOrderCount: 0, observedAt: "2026-07-15T15:01:00.000Z", openPositionNotionalKrw: "10000" },
        generatedAt: new Date("2026-07-15T15:01:00.000Z"),
      });
      process.stdout.write(JSON.stringify(captured));
    `);
    expect(output.latestCandidate).toMatchObject({
      statusLabel: "주문 후보 없음",
      message: "진입 조건 미충족으로 HOLD했습니다.",
    });
    expect(output.latestDecision.statusLabel).toBe("보유 유지 판단");
    expect(output.openExposureKrw).toBe("10000");
  });

  it("기존 passed artifact는 현재 rollout provenance와 daemon boundary가 모두 같을 때만 재사용한다", async () => {
    const output = await runModuleExpression(`
      const day = "2026-07-15";
      const window = module.createKstDayWindow(day);
      const runtimeProvenance = ${JSON.stringify(runtimeProvenance)};
      const daemonBoundaries = { startedAt: window.startedAt, finishedAt: window.finishedAt };
      const summary = {
        status: "passed", reportDate: day, input: "live_ops_daemon_day",
        rolloutWindowFirstDay: day,
        mode: "LIVE_AUTONOMOUS_SMALL_BUDGET", dryRun: false, liveOrderCapable: true,
        startedAt: window.startedAt, finishedAt: window.finishedAt, runtimeProvenance,
        checks: { heartbeat: { evidence: { daemonCounterBoundaries: daemonBoundaries } } },
      };
      const input = { summary, day, firstDay: day, window, runtimeProvenance, daemonBoundaries };
      process.stdout.write(JSON.stringify({
        valid: module.isReusableProductionDayArtifact(input),
        wrongSource: module.isReusableProductionDayArtifact({
          ...input,
          runtimeProvenance: { ...runtimeProvenance, sourceCommitSha: "d".repeat(40) },
        }),
        wrongFinish: module.isReusableProductionDayArtifact({
          ...input,
          summary: { ...summary, finishedAt: new Date(window.endMs + 60000).toISOString() },
        }),
      }));
    `);
    expect(output).toEqual({ valid: true, wrongSource: false, wrongFinish: false });
  });

  it("daily report delivery recovery는 별도 job에서 성공을 audit한 뒤 완료한다", async () => {
    const output = await runModuleExpression(`
      const calls = [];
      const job = { id: "recovery-job", status: "PENDING" };
      const infrastructureModule = {
        async enqueueJob(_database, input) { calls.push(["enqueue", input]); return { created: true, job }; },
        async claimJobByIdempotencyKey(_database, input) { calls.push(["claim", input]); return job; },
        async completeJob(_database, input) { calls.push(["complete", input]); return { ...job, status: "COMPLETED" }; },
        async failJob(_database, input) { calls.push(["fail", input]); return { ...job, status: "PENDING" }; },
        PostgresAuditLogRepository: class {
          async appendEvent(event) { calls.push(["audit", event]); return { auditEventId: "audit-1" }; }
        },
      };
      const result = await module.runDailyReportDeliveryRecovery({
        database: {}, infrastructureModule,
        notifier: { async sendDailyReport() { calls.push(["send"]); return { delivered: true, providerMessageId: "42" }; } },
        notification: { reportDate: "2026-07-15", summary: "요약", generatedAt: new Date() },
        day: "2026-07-15", generatedAt: new Date("2026-07-15T15:01:00.000Z"),
      });
      process.stdout.write(JSON.stringify({ result, calls }));
    `);
    expect(output.result).toEqual({ status: "DELIVERED", auditEventId: "audit-1" });
    expect(output.calls.map((call: unknown[]) => call[0])).toEqual(["enqueue", "claim", "audit", "send", "audit", "complete"]);
    expect(output.calls[0][1]).toMatchObject({
      jobType: "report.daily.delivery_recovery",
      idempotencyKey: "report.daily.delivery_recovery:2026-07-15",
    });
  });

  it("daily report delivery recovery provider 실패는 raw 오류 없이 같은 job을 재예약한다", async () => {
    const output = await runModuleExpression(`
      const calls = [];
      const job = { id: "recovery-job", status: "PENDING" };
      const infrastructureModule = {
        async enqueueJob() { return { created: true, job }; },
        async claimJobByIdempotencyKey() { return job; },
        async completeJob(_database, input) { calls.push(["complete", input]); },
        async failJob(_database, input) { calls.push(["fail", input]); return { ...job, status: "PENDING" }; },
        PostgresAuditLogRepository: class { async appendEvent() { return { auditEventId: "generated" }; } },
      };
      let message;
      try {
        await module.runDailyReportDeliveryRecovery({
          database: {}, infrastructureModule,
          notifier: { async sendDailyReport() { throw new Error("secret provider detail"); } },
          notification: {}, day: "2026-07-15", generatedAt: new Date("2026-07-15T15:01:00.000Z"),
        });
      } catch (error) { message = error.message; }
      process.stdout.write(JSON.stringify({ message, calls }));
    `);
    expect(output.message).toContain("재시도를 예약");
    expect(output.message).not.toContain("secret provider detail");
    expect(output.calls).toHaveLength(1);
    expect(output.calls[0][1]).toMatchObject({ errorMessage: "daily_report_delivery_recovery_provider_failed" });
  });
});

async function runModuleExpression(expression: string): Promise<any> {
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(scriptPath)}); ${expression}`,
    ],
    { cwd: repositoryRoot, env: process.env },
  );
  return JSON.parse(result.stdout);
}

function createTestKstDayWindow(day: string) {
  const endMs = Date.parse(`${day}T00:00:00.000Z`) - (9 * 60 * 60 * 1_000) + 86_400_000;
  return { endMs };
}

function createRecoverySummary() {
  const checks = [
    "eventLogsParsed",
    "restartEvidence",
    "heartbeatRecovery",
    "duplicateLiveOrder",
    "reconcileRecovery",
    "statusRecovery",
    "dailyReportRecovery",
    "failClosedDrills",
    "backupRestore",
    "closeoutZeroCounters",
    "secretScan",
  ];
  return {
    status: "passed",
    input: "recovery_artifacts",
    checks: Object.fromEntries(checks.map((check) => [check, { status: "ok" }])),
  };
}
