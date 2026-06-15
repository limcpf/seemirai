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

  it("fails when manifest run ord_type conflicts with the order policy", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-run-ord-type-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({ ...run, ord_type: "market" }),
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

  it("fails when order chain suffixes are generic order id placeholders", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-chain-order-id-placeholder-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        identifierSuffix: "<order_id>",
        cancelIdentifierSuffix: "<order_id>",
        brokerOrderIdSuffix: "<broker_order_id>",
        cancelBrokerOrderIdSuffix: "<broker_order_id>",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderLifecycle")).toMatchObject({ status: "fail" });
  });

  it("fails when order chain suffixes use hyphen or camelCase placeholders", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-chain-placeholder-variants-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        identifierSuffix: "<order-id>",
        cancelIdentifierSuffix: "<order-id>",
        brokerOrderIdSuffix: "<brokerOrderId>",
        cancelBrokerOrderIdSuffix: "<brokerOrderId>",
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

  it("fails when required source paths only appear inside the search pattern", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-operands-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n \"ord_type market best withdraw deposit leverage futures margin src scripts config docs\" /tmp/empty",
            "rg -n \"access_key secret_key Authorization Bearer JWT telegram_bot_token botToken raw_provider rawProvider raw_order rawOrder src scripts config docs\" /tmp/empty",
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

  it("fails when source scan commands omit required forbidden pattern families", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-patterns-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n withdraw src scripts config docs",
            "rg -n access_key src scripts config docs",
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

  it("fails when source scan commands omit uppercase secret env names", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-uppercase-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n \"access_key|accessKey|secret_key|secretKey|Authorization|Bearer|JWT|telegram_bot_token|botToken|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when required forbidden patterns only appear as path operands", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-pattern-operands-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n withdraw src scripts config docs ord_type market best deposit leverage futures margin",
            "rg -n access_key src scripts config docs secret_key Authorization Bearer JWT telegram_bot_token botToken raw_provider rawProvider raw_order rawOrder",
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

  it("fails when source scan evidence omits repository working directory", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-cwd-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands exclude the required source paths by glob", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-exclude-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs -g '!src/**' -g '!scripts/**' -g '!config/**' -g '!docs/**'",
            "rg -n \"access_key|secret_key|Authorization|Bearer|JWT|telegram_bot_token|botToken|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs -g '!src/**'",
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

  it("fails when source scan commands use brace exclude globs for required paths", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-brace-exclude-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs -g'!{src,scripts}/**'",
            "rg -n \"access_key|secret_key|Authorization|Bearer|JWT|telegram_bot_token|botToken|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs --glob='!{config,docs}/**'",
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

  it("fails when source scan commands use attached short exclude globs", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-attached-exclude-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs -g'!src/**' -g'!scripts/**'",
            "rg -n \"access_key|secret_key|Authorization|Bearer|JWT|telegram_bot_token|botToken|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs -g'!config/**'",
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

  it("fails when source scan commands suppress ripgrep output", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-quiet-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -nq \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n --files-without-match \"access_key|secret_key|Authorization|Bearer|JWT|telegram_bot_token|botToken|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use ripgrep preprocessors", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-pre-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n --pre=printf \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n --pre-glob='*.ts' \"access_key|secret_key|Authorization|Bearer|JWT|telegram_bot_token|botToken|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands exclude required file extensions", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-extension-exclude-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs -g '!*.ts' -g '!*.mjs'",
            "rg -n \"access_key|secret_key|Authorization|Bearer|JWT|telegram_bot_token|botToken|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs -g '!*.json' -g '!*.md'",
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

  it("fails when source scan commands use ripgrep type or ignore exclusions", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-type-exclude-"));
    const ignorePath = path.join(artifactDir, "scan.ignore");
    await writeFile(ignorePath, "*.ts\n", "utf8");
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n --type-not=ts \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            `rg -n --ignore-file=${ignorePath} "access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder" src scripts config docs`,
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

  it("fails when source scan commands skip searching with max count zero", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-max-count-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n --max-count=0 \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -nm 0 \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use attached max count options", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-attached-max-count-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n -m0 \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n -m=0 \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use type or iglob narrowing", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-type-iglob-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n -t=ts \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n --type=ts --iglob '*.ts' \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use fixed-string mode", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-fixed-strings-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -F -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --fixed-strings -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use pattern files or inverted matches", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-pattern-file-"));
    const patternPath = path.join(artifactDir, "ord_type-market-best-withdraw-deposit-leverage-futures-margin.patterns");
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            `rg -n -f ${patternPath} src scripts config docs`,
            "rg -n -v \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands limit traversal or file size", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-traversal-limit-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n --max-depth=0 \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n --max-filesize=0 \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use PCRE2 no-match patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-pcre2-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n -P \"(*FAIL)(?:ord_type|market|best|withdraw|deposit|leverage|futures|margin)\" src scripts config docs",
            "rg -n --engine=pcre2 \"(*FAIL)(?:access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder)\" src scripts config docs",
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

  it("fails when source scan commands include shell redirection or pipes", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-shell-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs > /dev/null",
            "rg -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs | head -0",
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

  it("fails when source scan patterns escape alternation pipes", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-escaped-alternation-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n \"ord_type\\|market\\|best\\|withdraw\\|deposit\\|leverage\\|futures\\|margin\" src scripts config docs",
            "rg -n \"access_key\\|accessKey\\|ACCESS_KEY\\|secret_key\\|secretKey\\|SECRET_KEY\\|Authorization\\|Bearer\\|JWT\\|telegram_bot_token\\|botToken\\|TELEGRAM_BOT_TOKEN\\|raw_provider\\|rawProvider\\|raw_order\\|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands list files without searching content", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-files-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n --files \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n --files \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("does not echo raw source scan matches in failure summaries", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-redacted-summary-"));
    const rawSecret = "SEEMIRAI_UPBIT_SECRET_KEY=raw-secret-value-that-must-not-echo";
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
          ],
          unsafeMatches: [],
          secretMatches: [{ filePath: "src/secret.ts", line: 1, label: "secret key", snippet: rawSecret }],
        },
      }),
    });

    try {
      await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
      throw new Error("script unexpectedly passed");
    } catch (error) {
      const failed = error as { stdout?: string };
      expect(failed.stdout).toBeTruthy();
      expect(failed.stdout).not.toContain(rawSecret);
      const summary = JSON.parse(failed.stdout ?? "") as LiveOpsRealArmCloseoutSummary;
      expect(summary.status).toBe("failed");
      expect(getCheck(summary, "sourceSecurityScan")).toMatchObject({ status: "fail" });
    }
  });

  it("fails when source scan commands use include globs to narrow the scan", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-include-glob-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg -n -g '*.md' \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg -n --glob='*.json' \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when production env values are fake fixture credentials", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-fake-env-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      envText: [
        "SEEMIRAI_DATABASE_URL=postgres://seemirai:fake-db-password@127.0.0.1:55432/seemirai",
        "SEEMIRAI_UPBIT_ACCESS_KEY=fake-upbit-access-key",
        "SEEMIRAI_UPBIT_SECRET_KEY=dummy-upbit-secret-key",
        "SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기",
        "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID=issue-206-upbit-key-scope-2026-06-15",
        "SEEMIRAI_TELEGRAM_BOT_TOKEN=example-telegram-token",
        "SEEMIRAI_TELEGRAM_CHAT_ID=123456789",
        "SEEMIRAI_TUI_CONTROL_TOKEN=changeme-local-control-token",
        "",
      ].join("\n"),
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

  it("fails when config contains keys rejected by the foreground live ops wrapper", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-config-keys-"));
    const configPath = path.join(artifactDir, "live-ops-extra-key.json");
    await writeFile(configPath, `${JSON.stringify({ ...createLiveOpsConfigFixture(), unexpected_live_ops_key: true }, null, 2)}\n`, "utf8");
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        configPath,
        command: `corepack pnpm live:ops -- --config ${configPath} --env-file ${String(manifest.envFilePath)} --tui`,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when ambient legacy live ops env is set", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-ambient-env-"));
    const manifestPath = await writeCloseoutManifest(artifactDir);
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      { ...createReadyEnv(), SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT: "1" },
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when env key scope has extra permissions", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-env-extra-scope-"));
    const manifestPath = await writeCloseoutManifest(artifactDir);
    await writeFile(path.join(artifactDir, "live-ops.real-arm.env"), [
      "SEEMIRAI_DATABASE_URL=postgres://seemirai:fake-db-password@127.0.0.1:55432/seemirai",
      "SEEMIRAI_UPBIT_ACCESS_KEY=fake-upbit-access-key",
      "SEEMIRAI_UPBIT_SECRET_KEY=fake-upbit-secret-key",
      "SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기,계정관리",
      "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID=issue-206-upbit-key-scope-2026-06-15",
      "SEEMIRAI_TELEGRAM_BOT_TOKEN=fake-telegram-token",
      "SEEMIRAI_TELEGRAM_CHAT_ID=fake-telegram-chat-id",
      "SEEMIRAI_TUI_CONTROL_TOKEN=fake-local-control-token",
      "",
    ].join("\n"), "utf8");
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when source scan cwd is outside the repository root", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-wrong-cwd-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          cwd: "/tmp",
          repositoryRoot: process.cwd(),
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

  it("fails when env key scope evidence id differs from the manifest", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-env-evidence-id-"));
    const manifestPath = await writeCloseoutManifest(artifactDir);
    await writeFile(path.join(artifactDir, "live-ops.real-arm.env"), [
      "SEEMIRAI_DATABASE_URL=postgres://seemirai:fake-db-password@127.0.0.1:55432/seemirai",
      "SEEMIRAI_UPBIT_ACCESS_KEY=fake-upbit-access-key",
      "SEEMIRAI_UPBIT_SECRET_KEY=fake-upbit-secret-key",
      "SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기",
      "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID=different-key-scope-evidence",
      "SEEMIRAI_TELEGRAM_BOT_TOKEN=fake-telegram-token",
      "SEEMIRAI_TELEGRAM_CHAT_ID=fake-telegram-chat-id",
      "SEEMIRAI_TUI_CONTROL_TOKEN=fake-local-control-token",
      "",
    ].join("\n"), "utf8");
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when config or env file does not satisfy the production live ops contract", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-input-contract-"));
    const configPath = path.join(artifactDir, "empty-live-ops.json");
    const envFilePath = path.join(artifactDir, "incomplete-live-ops.env");
    await writeFile(configPath, "{}\n", "utf8");
    await writeFile(envFilePath, "SEEMIRAI_UPBIT_ACCESS_KEY=fake-upbit-access-key\n", "utf8");
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        configPath,
        envFilePath,
        command: `corepack pnpm live:ops -- --config ${configPath} --env-file ${envFilePath} --tui`,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "operatorInputs")).toMatchObject({ status: "fail" });
  });

  it("fails when config or env command paths are relative", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-relative-input-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        configPath: "live-ops.real-arm.json",
        envFilePath: "live-ops.real-arm.env",
        command: "corepack pnpm live:ops -- --config live-ops.real-arm.json --env-file live-ops.real-arm.env --tui",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "manifestShape")).toMatchObject({ status: "fail" });
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

  it("fails when guarded manifest is inside the repository while running from a subdirectory", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-subdir-manifest-"));
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", "../package.json"],
      createReadyEnv(),
      { cwd: path.join(process.cwd(), "scripts") },
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

  it("fails when array artifact records conflict with manifest closeout values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-array-artifact-conflict-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ events: [{ status: "FAILED", terminalState: "wait", openExposureKrw: 999999 }] }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact safe summary omits required closeout evidence fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-empty-artifact-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ note: "redacted" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact safe summary is not parseable JSON", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-json-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: "{\"status\":\"PASSED\"",
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact safe summary conflicts with order policy fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-policy-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "PASSED",
        terminalState: "cancel",
        openExposureKrw: 0,
        market: "KRW-ETH",
        side: "SELL",
        orderType: "MARKET",
        requestedNotionalKrw: 1_000_000,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact order suffix differs from the manifest", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-suffix-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        identifierSuffix: "different-artifact-order",
        cancelIdentifierSuffix: "different-artifact-order",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when duplicate artifact aliases contain conflicting values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-alias-conflict-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        open_exposure_krw: 999999,
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when duplicate terminal state aliases contain conflicting values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-terminal-alias-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        terminal_state: "wait",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("allows non-closeout provider status next to complete artifact evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-provider-status-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        ...createArtifactFixture(),
        marketData: { status: "ACTIVE" },
      }),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "ok" });
  });

  it("accepts direct identifier and broker order id artifact aliases", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-order-alias-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        identifierSuffix: undefined,
        cancelIdentifierSuffix: undefined,
        brokerOrderIdSuffix: undefined,
        cancelBrokerOrderIdSuffix: undefined,
        identifier: "closeout-identifier",
        cancel_identifier: "closeout-identifier",
        broker_order_id: "closeout-order",
        cancel_broker_order_id: "closeout-order",
      })),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "ok" });
  });

  it("fails when artifact safe summary conflicts through snake_case order policy fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-policy-snake-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "PASSED",
        market: "KRW-BTC",
        side: "BUY",
        order_type: "MARKET",
        time_in_force: "IOC",
        requested_notional_krw: 1_000_000,
        submitted_at: "2026-06-15T00:00:00.000Z",
        cancel_requested_at: "2026-06-15T00:00:05.000Z",
        terminal_cancel_confirmed_at: "2026-06-15T00:00:10.000Z",
        terminalState: "cancel",
        open_exposure_krw: 0,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact safe summary conflicts through Upbit ord_type", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-ord-type-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        ord_type: "market",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact lifecycle timestamps conflict with the manifest", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-lifecycle-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "PASSED",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "LIMIT",
        timeInForce: "post_only",
        requestedNotionalKrw: 5000,
        submittedAt: "2099-06-15T00:00:00.000Z",
        cancelRequestedAt: "2099-06-15T00:00:05.000Z",
        terminalCancelConfirmedAt: "2099-06-15T00:00:10.000Z",
        terminalState: "cancel",
        openExposureKrw: 0,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact safe summary is skipped or blocked", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-blocked-artifact-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ status: "BLOCKED", terminalState: "cancel", openExposureKrw: 0 }),
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

  it("fails when artifact-level status is failed even with nested success evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-failed-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "FAILED",
        result: createArtifactFixture(),
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("fails when artifact-level status uses failure code variants", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-error-code-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "ERROR_TIMEOUT",
        result: createArtifactFixture(),
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
  });

  it("allows explicit false fixture smoke markers in real artifacts", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-fixture-false-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        ...createArtifactFixture(),
        fixtureSmoke: false,
      }),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "guardedArtifactInput")).toMatchObject({ status: "ok" });
  });

  it("fails when guarded artifacts contain fixture-only markers without fixture file names", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-fixture-marker-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        ...createArtifactFixture(),
        kind: "ISSUE_206_LIVE_OPS_REAL_ARM_FIXTURE",
        note: "fixture smoke artifact - no live API side effect",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "guardedArtifactInput")).toMatchObject({ status: "fail" });
  });

  it("fails when deeply nested artifact safe summaries conflict with manifest closeout values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-deep-artifact-conflict-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        ...createArtifactFixture(),
        artifact: {
          safeSummary: {
            checks: {
              order: {
                closeout: {
                  status: "FAILED",
                  terminalState: "wait",
                  openExposureKrw: 999999,
                },
              },
            },
          },
        },
      }),
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

  it("fails when redacted env assignment is followed by raw secret text", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-redacted-env-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_UPBIT_SECRET_KEY=<redacted> raw-secret-value",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted env assignment keeps punctuation-separated raw text after a placeholder", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-redacted-env-punctuation-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_UPBIT_SECRET_KEY=<redacted>,raw-secret-value",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain colon-form secret logs", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-secret-colon-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_UPBIT_SECRET_KEY: raw-secret-value-that-should-not-appear",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw database password snake_case fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-db-password-snake-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        db_password: "raw-database-password-value",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw payload strings", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-payload-string-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "raw_provider_payload={\"uuid\":\"raw-provider-payload\"}",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when raw payload placeholders keep a raw tail", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-payload-placeholder-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "raw_order_detail=<redacted> [{\"uuid\":\"raw-order-payload\"}]",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw TUI control token values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-tui-token-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_TUI_CONTROL_TOKEN=raw-local-control-token",
      })),
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

  it("fails when redacted artifacts contain camelCase raw provider payload fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-provider-camel-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ rawProviderPayload: { uuid: "raw-provider-payload" } }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain standalone bearer or JWT tokens", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-bearer-jwt-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: [
        "provider trace: Bearer eyJhbGciOiJIUzI1NiJ9.rawPayload.rawSignature",
        "JWT=eyJhbGciOiJIUzI1NiJ9.rawPayload.rawSignature",
      ].join("\n"),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain lowercase bearer tokens", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-lowercase-bearer-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "provider trace: bearer raw-provider-token-value-1234567890",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw compact JWT text without a prefix", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-jwt-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "provider jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1cGJpdCJ9.signaturevalue123",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts keep bearer token text after a placeholder", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-bearer-placeholder-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "Authorization: Bearer <redacted> eyJhbGciOiJIUzI1NiJ9.rawPayload.rawSignature",
      })),
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

  it("fails when redacted artifacts contain raw Telegram base token URLs", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-telegram-base-url-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: "https://api.telegram.org/bot123456:raw-token-value",
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when Telegram URL placeholders keep raw token tails", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-telegram-placeholder-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: "https://api.telegram.org/bot<redacted>123456:raw-token-tail",
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

  it("fails when redacted JSON credential fields keep raw text after a placeholder", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-redacted-prefix-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ secret_key: "<redacted> raw-secret-value" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when JSON string escapes decode into raw secret assignments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-secret-"));
    const escapedArtifact = JSON.stringify(createArtifactFixture({
      note: "SEEMIRAI_UPBIT_SECRET_KEY=raw-secret-value-from-decoded-json",
    })).replace("SEEMIRAI_UPBIT_SECRET_KEY=raw-secret-value-from-decoded-json", "SEEMIRAI_UPBIT_SECRET_KEY\\u003draw-secret-value-from-decoded-json");
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: escapedArtifact,
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

async function runScript(args: string[], env: NodeJS.ProcessEnv = {}, options: { cwd?: string } = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
  });
}

async function runScriptExpectingFailure(args: string[], env: NodeJS.ProcessEnv, options: { cwd?: string } = {}) {
  try {
    const { stdout } = await runScript(args, env, options);
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
    envText?: string;
    manifestMutator?: (manifest: Record<string, unknown>) => Record<string, unknown>;
    runMutator?: (run: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  await mkdir(artifactDir, { recursive: true });
  const configPath = path.join(artifactDir, "live-ops.real-arm.json");
  const envFilePath = path.join(artifactDir, "live-ops.real-arm.env");
  const artifactPath = path.join(artifactDir, "issue-206-live-ops-real-arm-artifact.json");
  const manifestPath = path.join(artifactDir, "issue-206-live-ops-real-arm-manifest.json");
  await writeFile(configPath, `${JSON.stringify(createLiveOpsConfigFixture(), null, 2)}\n`, "utf8");
  await writeFile(envFilePath, options.envText ?? [
    "SEEMIRAI_DATABASE_URL=postgres://seemirai:operator-db-password@127.0.0.1:55432/seemirai",
    "SEEMIRAI_UPBIT_ACCESS_KEY=owner-live-upbit-access-key-2026-06-15",
    "SEEMIRAI_UPBIT_SECRET_KEY=owner-live-upbit-secret-key-2026-06-15",
    "SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기",
    "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID=issue-206-upbit-key-scope-2026-06-15",
    "SEEMIRAI_TELEGRAM_BOT_TOKEN=123456789:AAOwnerLiveTelegramCredentialValue",
    "SEEMIRAI_TELEGRAM_CHAT_ID=123456789",
    "SEEMIRAI_TUI_CONTROL_TOKEN=owner-live-local-control-credential",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    artifactPath,
    options.artifactText ?? JSON.stringify(createArtifactFixture()),
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
      cwd: process.cwd(),
      repositoryRoot: process.cwd(),
      commands: [
        "rg -n \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
        "rg -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

function createArtifactFixture(overrides: Record<string, unknown> = {}) {
  return {
    status: "PASSED",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    timeInForce: "post_only",
    requestedNotionalKrw: 5000,
    submittedAt: "2026-06-15T00:00:00.000Z",
    cancelRequestedAt: "2026-06-15T00:00:05.000Z",
    terminalCancelConfirmedAt: "2026-06-15T00:00:10.000Z",
    terminalState: "cancel",
    identifierSuffix: "closeout-identifier",
    cancelIdentifierSuffix: "closeout-identifier",
    brokerOrderIdSuffix: "closeout-order",
    cancelBrokerOrderIdSuffix: "closeout-order",
    openExposureKrw: 0,
    ...overrides,
  };
}

function createLiveOpsConfigFixture() {
  return {
    schema_version: 1,
    mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    exchange: "UPBIT",
    market: "KRW_SPOT",
    live_trading_enabled: true,
    paper_no_key: false,
    withdrawal_enabled: false,
    cross_exchange_arbitrage_enabled: false,
    futures_enabled: false,
    leverage_enabled: false,
    market_order_enabled: false,
    entry_market_order_enabled: false,
    universe: {
      markets: ["KRW-BTC"],
      default_market: "KRW-BTC",
    },
    budget: {
      max_order_krw: "10000",
      daily_autonomous_notional_limit_krw: "30000",
      max_open_position_notional_krw: "30000",
      operations_stop_ceiling_krw: "49999",
    },
    workers: {
      db_readiness: true,
      market_data: true,
      analysis_decision: true,
      live_execution: true,
      reconcile_pnl_status: true,
      telegram: true,
      tui: true,
    },
    market_data: {
      provider: "UPBIT_PUBLIC",
      websocket_enabled: true,
      rest_policy_snapshot_enabled: true,
      stale_after_ms: 30000,
    },
    analysis: {
      candle_interval_seconds: 60,
      feature_interval_seconds: 5,
      decision_interval_seconds: 5,
      record_hold_decision: true,
    },
    telegram: {
      startup_alert_enabled: true,
      live_order_capable_alert_enabled: true,
      trade_event_alerts_enabled: true,
      provider_timeout_ms: 5000,
    },
    tui: {
      foreground_enabled: true,
      attach_enabled: true,
      refresh_interval_ms: 1000,
      control_requires_two_step_confirmation: true,
      controls_enabled: true,
    },
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
