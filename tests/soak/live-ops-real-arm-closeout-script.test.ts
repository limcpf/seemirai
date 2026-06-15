import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-live-ops-real-arm-closeout.mjs");

describe("Issue 206 live:ops real-arm closeout script", () => {
  it("skips real closeout validation unless the explicit guard is enabled", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-skip-"));
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir], {
      SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT: "0",
    });
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("skipped");
    expect(getCheck(summary, "runGuard")).toMatchObject({
      status: "skipped",
      evidence: { requiredEnv: "SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT=1" },
    });
    expect(getCheck(summary, "operatorInputs").status).toBe("skipped");
  });

  it("runs deterministic fixture smoke without live side effects", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-fixture-"));
    const { stdout } = await runScript(["--fixture-smoke", "--json", "--artifact-dir", artifactDir]);
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(summary.input).toBe("fixture_smoke");
    expect(getCheck(summary, "orderPolicy").status).toBe("ok");
    expect(getCheck(summary, "redactionScan").status).toBe("ok");
  });

  it("rejects fixture manifests when guarded closeout validation is enabled", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-guarded-fixture-"));
    const { stdout } = await runScript(["--fixture-smoke", "--json", "--artifact-dir", artifactDir]);
    const fixtureSummary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary & { artifacts: { manifestPath: string } };
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", fixtureSummary.artifacts.manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "guardedArtifactInput").status).toBe("fail");
  });

  it("passes a complete redacted real-arm closeout manifest", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-pass-"));
    const manifestPath = await writeCloseoutManifest(artifactDir);
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(summary.metrics).toMatchObject({
      requestedNotionalKrw: 5000,
      terminalCancelConfirmed: true,
      openExposureKrw: 0,
      duplicateOrderCount: 0,
    });
    expect(getCheck(summary, "readinessAudit").status).toBe("ok");
  });

  it("fails when the closeout order is not BUY LIMIT post_only KRW-BTC", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-policy-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({ ...run, orderType: "MARKET", timeInForce: "IOC" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderPolicy").status).toBe("fail");
  });

  it("fails when the command is not the actual live:ops foreground execution", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-command-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({ ...manifest, command: "echo live:ops fixture" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "manifestShape")).toMatchObject({ status: "fail" });
  });

  it("fails when the guarded command uses fixture smoke", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-fixture-command-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({ ...manifest, command: `${String(manifest.command)} --fixture-smoke` }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "manifestShape")).toMatchObject({ status: "fail" });
  });

  it("fails when the guarded command only prints help", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-help-command-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({ ...manifest, command: `${String(manifest.command)} --help` }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "manifestShape")).toMatchObject({ status: "fail" });
  });

  it("fails when the guarded command contains additional live ops arguments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-extra-command-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({ ...manifest, command: `${String(manifest.command)} --bogus` }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "manifestShape")).toMatchObject({ status: "fail" });
  });

  it("fails when requested notional is below the Upbit KRW minimum", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-min-notional-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({ ...run, requestedNotionalKrw: "4999" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderPolicy")).toMatchObject({ status: "fail" });
  });

  it("fails when run and reconcile exposure evidence conflict", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-exposure-conflict-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({ ...run, openExposureKrw: 100 }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "reconcileCloseout")).toMatchObject({ status: "fail" });
  });

  it("fails when submit and cancel evidence do not share a direct identifier or broker id", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-chain-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        chainEvidenceId: "operator-note-only",
        identifierSuffix: "submitted-identifier",
        cancelIdentifierSuffix: "different-cancel-identifier",
        brokerOrderIdSuffix: "submitted-order",
        cancelBrokerOrderIdSuffix: "different-cancel-order",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderLifecycle")).toMatchObject({ status: "fail" });
  });

  it("fails when order chain suffixes are generic redaction placeholders", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-chain-placeholder-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        identifierSuffix: "<redacted>",
        cancelIdentifierSuffix: "<redacted>",
        brokerOrderIdSuffix: "redacted",
        cancelBrokerOrderIdSuffix: "redacted",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderLifecycle")).toMatchObject({ status: "fail" });
  });

  it("fails when lifecycle timestamps are in the future", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-future-lifecycle-"));
    const submittedAt = new Date(Date.now() + 86_400_000).toISOString();
    const cancelRequestedAt = new Date(Date.now() + 86_405_000).toISOString();
    const terminalCancelConfirmedAt = new Date(Date.now() + 86_410_000).toISOString();
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({ ...run, submittedAt, cancelRequestedAt, terminalCancelConfirmedAt }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderLifecycle")).toMatchObject({ status: "fail" });
  });

  it("fails when source scan evidence omits commands or match arrays", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({ ...manifest, sourceScan: { status: "passed" } }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "sourceSecurityScan")).toMatchObject({ status: "fail" });
  });

  it("fails when source scan commands did not run the required rg scans", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-command-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: { status: "passed", commands: ["true"], unsafeMatches: [], secretMatches: [] },
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "sourceSecurityScan")).toMatchObject({ status: "fail" });
  });

  it("fails when source scan commands only echo an rg-looking string", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-echo-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "echo rg -n ord_type withdraw src scripts config docs",
            "printf 'rg -n access_key secret_key src scripts docs'",
          ],
          unsafeMatches: [],
          secretMatches: [],
        },
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "sourceSecurityScan")).toMatchObject({ status: "fail" });
  });

  it("fails when source scan commands omit required source paths", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-scope-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: ["rg -n withdraw scripts", "rg -n access_key scripts"],
          unsafeMatches: [],
          secretMatches: [],
        },
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "sourceSecurityScan")).toMatchObject({ status: "fail" });
  });

  it("fails when key scope evidence includes forbidden withdrawal permission", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-key-scope-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        keyScope: {
          grantedScopes: ["자산조회", "주문조회", "주문하기"],
          forbiddenScopesAbsent: ["출금하기"],
          withdrawalEnabled: true,
        },
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when config or env realpath points back into the repository", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-repo-symlink-"));
    const repoConfigTarget = path.join(process.cwd(), "config", "live-ops.example.json");
    const configSymlinkPath = path.join(artifactDir, "repo-config-link.json");
    await symlink(repoConfigTarget, configSymlinkPath);
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        configPath: configSymlinkPath,
        command: `corepack pnpm live:ops -- --config ${configSymlinkPath} --env-file ${String(manifest.envFilePath)} --tui`,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when config or env paths do not exist", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-missing-input-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        configPath: path.join(artifactDir, "missing-live-ops.json"),
        envFilePath: path.join(artifactDir, "missing-live-ops.env"),
        command: `corepack pnpm live:ops -- --config ${path.join(artifactDir, "missing-live-ops.json")} --env-file ${path.join(artifactDir, "missing-live-ops.env")} --tui`,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when guarded manifest realpath points back into the repository", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-repo-manifest-"));
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", path.join(process.cwd(), "package.json")],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "manifestInput")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact realpath points back into the repository", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-symlink-"));
    const repoArtifactTarget = path.join(process.cwd(), "scripts", "run-live-ops-real-arm-closeout.mjs");
    const artifactSymlinkPath = path.join(artifactDir, "repo-artifact-link.json");
    await symlink(repoArtifactTarget, artifactSymlinkPath);
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({ ...manifest, artifactPaths: [artifactSymlinkPath] }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when nested artifact safe summary conflicts with manifest closeout values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-nested-artifact-conflict-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ result: { status: "FAILED", terminalState: "wait" }, metrics: { openExposureKrw: 999999 } }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact safe summary conflicts with manifest closeout values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-conflict-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ status: "FAILED", terminalState: "wait", openExposureKrw: 999999 }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw secret candidates", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-secret-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: "SEEMIRAI_UPBIT_SECRET_KEY=raw-secret-value-that-should-not-appear",
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw provider payload fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-provider-field-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ raw_provider_payload: { uuid: "raw-provider-payload" } }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw Telegram token URLs", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-telegram-url-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: "https://api.telegram.org/bot123456:raw-token-value/sendMessage",
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw database password fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-db-password-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ databasePassword: "raw-database-password-value" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw JSON credential fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-secret-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ access_key: "raw-access-key-value", secret_key: "raw-secret-key-value" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });
});

async function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
  });
}

async function runScriptExpectingFailure(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await runScript(args, env);
    throw new Error(`script unexpectedly passed: ${stdout}`);
  } catch (error) {
    const failed = error as { stdout?: string };
    expect(failed.stdout).toBeTruthy();
    return JSON.parse(failed.stdout ?? "") as LiveOpsRealArmCloseoutSummary;
  }
}

async function writeCloseoutManifest(
  artifactDir: string,
  options: {
    artifactText?: string;
    manifestMutator?: (manifest: Record<string, unknown>) => Record<string, unknown>;
    runMutator?: (run: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  await mkdir(artifactDir, { recursive: true });
  const configPath = path.join(artifactDir, "live-ops.real-arm.json");
  const envFilePath = path.join(artifactDir, "live-ops.real-arm.env");
  const artifactPath = path.join(artifactDir, "issue-206-live-ops-real-arm-artifact.json");
  const manifestPath = path.join(artifactDir, "issue-206-live-ops-real-arm-manifest.json");
  await writeFile(configPath, JSON.stringify({ redacted: true }), "utf8");
  await writeFile(envFilePath, "SEEMIRAI_UPBIT_ACCESS_KEY=<redacted>\n", "utf8");
  await writeFile(
    artifactPath,
    options.artifactText ?? JSON.stringify({ status: "PASSED", terminalState: "cancel", openExposureKrw: 0 }),
    "utf8",
  );
  const run = options.runMutator?.(createRunFixture()) ?? createRunFixture();
  const baseManifest = {
    issue: 206,
    mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    command: `corepack pnpm live:ops -- --config ${configPath} --env-file ${envFilePath} --tui`,
    configPath,
    envFilePath,
    operatorArmEvidenceId: "issue-206-operator-arm-2026-06-15",
    keyScopeEvidenceId: "issue-206-upbit-key-scope-2026-06-15",
    keyScope: {
      grantedScopes: ["자산조회", "주문조회", "주문하기"],
      forbiddenScopesAbsent: ["출금하기"],
      withdrawalEnabled: false,
    },
    artifactPaths: [artifactPath],
    run,
    reconcile: {
      openExposureKrw: 0,
      openOrderCount: 0,
      mismatchCount: 0,
      untrackedFillCount: 0,
      manualReviewCount: 0,
    },
    counters: {
      crashCount: 0,
      unhandledRejectionCount: 0,
      duplicateOrderCount: 0,
      reconcileMismatchCount: 0,
      untrackedFillCount: 0,
      liveOrderCleanupFailureCount: 0,
    },
    telegram: {
      evidenceIds: {
        startup: "telegram-startup",
        liveOrderCapable: "telegram-live-order-capable",
        orderSubmitted: "telegram-order-submitted",
        cancelRequested: "telegram-cancel-requested",
        cancelConfirmed: "telegram-cancel-confirmed",
      },
    },
    tui: { evidenceId: "tui-live-ops-status" },
    sourceScan: {
      status: "passed",
      commands: [
        "rg -n \"ord_type.*market|ord_type.*best|withdraw|출금|deposit|입금|leverage|futures\" src scripts config docs",
        "rg -n \"access_key|secret_key|Authorization|JWT|telegram_bot_token|raw_provider|raw_order\" src scripts config docs",
      ],
      unsafeMatches: [],
      secretMatches: [],
    },
    readinessAudit: {
      status: "PASS",
      evidenceId: "finish-readiness-audit-issue-206",
    },
  };
  const manifest = options.manifestMutator?.(baseManifest) ?? baseManifest;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function createRunFixture() {
  return {
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    timeInForce: "post_only",
    requestedNotionalKrw: "5000",
    submittedAt: "2026-06-15T00:00:00.000Z",
    cancelRequestedAt: "2026-06-15T00:00:05.000Z",
    terminalCancelConfirmedAt: "2026-06-15T00:00:10.000Z",
    terminalState: "cancel",
    identifierSuffix: "closeout-identifier",
    cancelIdentifierSuffix: "closeout-identifier",
    brokerOrderIdSuffix: "closeout-order",
    cancelBrokerOrderIdSuffix: "closeout-order",
    openExposureKrw: 0,
    openOrderCount: 0,
    reconcileMismatchCount: 0,
    untrackedFillCount: 0,
    manualReviewCount: 0,
  };
}

function createReadyEnv(): NodeJS.ProcessEnv {
  return { SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT: "1" };
}

function getCheck(summary: LiveOpsRealArmCloseoutSummary, name: string) {
  const check = summary.checks[name];
  if (check === undefined) {
    throw new Error(`missing check: ${name}`);
  }
  return check;
}

interface LiveOpsRealArmCloseoutSummary {
  status: "passed" | "failed" | "skipped";
  input: string;
  artifacts: Record<string, string>;
  metrics: Record<string, unknown>;
  checks: Record<string, { status: "ok" | "fail" | "skipped"; evidence?: Record<string, unknown> }>;
}
