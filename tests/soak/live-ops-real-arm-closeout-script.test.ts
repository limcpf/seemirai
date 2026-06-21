import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-live-ops-real-arm-closeout.mjs");
const closeoutSourceScanPaths = [
  "src/runtime/live-ops-config.ts",
  "src/runtime/live-ops-config",
  "src/runtime/live-ops-decision-policy.ts",
  "src/runtime/live-ops-decision-policy",
  "src/runtime/live-ops-live-execution.ts",
  "src/runtime/live-ops-live-execution",
  "src/runtime/live-ops-analysis-decision.ts",
  "src/runtime/live-ops-analysis-decision",
  "src/application/live-autonomous-entry-runtime/service.ts",
  "src/infrastructure/upbit/private-client.ts",
  "src/infrastructure/upbit/private-client/client.ts",
  "src/infrastructure/upbit/private-client/auth.ts",
  "src/infrastructure/upbit/live-broker/service.ts",
  "src/infrastructure/upbit/private-mappers.ts",
  "src/infrastructure/upbit/private-mappers",
  "scripts/run-live-ops.mjs",
  "scripts/run-live-ops-support.mjs",
  "scripts/run-live-ops-pnl-closeout.mjs",
  "scripts/run-live-ops-pnl-closeout-support.mjs",
  "config/live-ops.example.json",
  "config/live-ops.env.example",
].join(" ");
const closeoutSourceScanPathsWithoutRuntimePublicEntries = [
  "src/runtime/live-ops-config",
  "src/runtime/live-ops-decision-policy",
  "src/runtime/live-ops-live-execution",
  "src/runtime/live-ops-analysis-decision",
  "src/application/live-autonomous-entry-runtime/service.ts",
  "src/infrastructure/upbit/private-client.ts",
  "src/infrastructure/upbit/private-client/client.ts",
  "src/infrastructure/upbit/private-client/auth.ts",
  "src/infrastructure/upbit/live-broker/service.ts",
  "src/infrastructure/upbit/private-mappers.ts",
  "src/infrastructure/upbit/private-mappers",
  "scripts/run-live-ops.mjs",
  "scripts/run-live-ops-support.mjs",
  "scripts/run-live-ops-pnl-closeout.mjs",
  "scripts/run-live-ops-pnl-closeout-support.mjs",
  "config/live-ops.example.json",
  "config/live-ops.env.example",
].join(" ");
const closeoutSourceScanPathsWithoutLiveBroker = [
  "src/runtime/live-ops-config.ts",
  "src/runtime/live-ops-config",
  "src/runtime/live-ops-decision-policy.ts",
  "src/runtime/live-ops-decision-policy",
  "src/runtime/live-ops-live-execution.ts",
  "src/runtime/live-ops-live-execution",
  "src/runtime/live-ops-analysis-decision.ts",
  "src/runtime/live-ops-analysis-decision",
  "src/application/live-autonomous-entry-runtime/service.ts",
  "src/infrastructure/upbit/private-client.ts",
  "src/infrastructure/upbit/private-client/client.ts",
  "src/infrastructure/upbit/private-client/auth.ts",
  "src/infrastructure/upbit/private-mappers.ts",
  "src/infrastructure/upbit/private-mappers",
  "scripts/run-live-ops.mjs",
  "scripts/run-live-ops-support.mjs",
  "scripts/run-live-ops-pnl-closeout.mjs",
  "scripts/run-live-ops-pnl-closeout-support.mjs",
  "config/live-ops.example.json",
  "config/live-ops.env.example",
].join(" ");
const closeoutSourceScanPathsWithoutPrivateClientAuth = [
  "src/runtime/live-ops-config.ts",
  "src/runtime/live-ops-config",
  "src/runtime/live-ops-decision-policy.ts",
  "src/runtime/live-ops-decision-policy",
  "src/runtime/live-ops-live-execution.ts",
  "src/runtime/live-ops-live-execution",
  "src/runtime/live-ops-analysis-decision.ts",
  "src/runtime/live-ops-analysis-decision",
  "src/application/live-autonomous-entry-runtime/service.ts",
  "src/infrastructure/upbit/private-client.ts",
  "src/infrastructure/upbit/private-client/client.ts",
  "src/infrastructure/upbit/live-broker/service.ts",
  "src/infrastructure/upbit/private-mappers.ts",
  "src/infrastructure/upbit/private-mappers",
  "scripts/run-live-ops.mjs",
  "scripts/run-live-ops-support.mjs",
  "scripts/run-live-ops-pnl-closeout.mjs",
  "scripts/run-live-ops-pnl-closeout-support.mjs",
  "config/live-ops.example.json",
  "config/live-ops.env.example",
].join(" ");
const closeoutSourceScanPathsWithoutPrivateMappers = [
  "src/runtime/live-ops-config.ts",
  "src/runtime/live-ops-config",
  "src/runtime/live-ops-decision-policy.ts",
  "src/runtime/live-ops-decision-policy",
  "src/runtime/live-ops-live-execution.ts",
  "src/runtime/live-ops-live-execution",
  "src/runtime/live-ops-analysis-decision.ts",
  "src/runtime/live-ops-analysis-decision",
  "src/application/live-autonomous-entry-runtime/service.ts",
  "src/infrastructure/upbit/private-client.ts",
  "src/infrastructure/upbit/private-client/client.ts",
  "src/infrastructure/upbit/private-client/auth.ts",
  "src/infrastructure/upbit/live-broker/service.ts",
  "src/infrastructure/upbit/private-mappers.ts",
  "scripts/run-live-ops.mjs",
  "scripts/run-live-ops-support.mjs",
  "scripts/run-live-ops-pnl-closeout.mjs",
  "scripts/run-live-ops-pnl-closeout-support.mjs",
  "config/live-ops.example.json",
  "config/live-ops.env.example",
].join(" ");
const closeoutPriceBestOrderTypeUnsafePattern = "|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(PRICE|price|BEST|best)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(PRICE|price|BEST|best)";
const closeoutUnsafeSourceScanCommand = "rg --no-config -uuu -n '[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?price|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?market|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?best|[\\x27\"]?key[\\x27\"]?\\s*:\\s*[\\x27\"]ord_type[\\x27\"][^\\r\\n{}]*,[^\\r\\n{}]*[\\x27\"]?value[\\x27\"]?\\s*:\\s*[\\x27\"]?(price|market|best)|시장가[^\\r\\n]*(허용|활성|enabled|true)|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)"
  + closeoutPriceBestOrderTypeUnsafePattern
  + "|[\\x27\"]?withdrawal_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?deposit_enabled[\\x27\"]?\\s*[:=]\\s*true|\\/v1\\/deposits|\\/v1\\/withdraws|[\\x27\"]?futures_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?leverage_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?market_order_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?entry_market_order_enabled[\\x27\"]?\\s*[:=]\\s*true' "
  + closeoutSourceScanPaths;
const closeoutCamelCredentialPropertySecretPattern = "|[\\x27\"]?accessKey[\\x27\"]?\\s*:\\s*[\\x27\"][A-Za-z0-9._-]{16,}[\\x27\"]|[\\x27\"]?secretKey[\\x27\"]?\\s*:\\s*[\\x27\"][A-Za-z0-9._\\/=+-]{16,}[\\x27\"]";
const closeoutSnakeCredentialPropertySecretPattern = "|[\\x27\"]?access_key[\\x27\"]?\\s*:\\s*[\\x27\"][A-Za-z0-9._-]{16,}[\\x27\"]|[\\x27\"]?secret_key[\\x27\"]?\\s*:\\s*[\\x27\"][A-Za-z0-9._\\/=+-]{16,}[\\x27\"]";
const closeoutRawJwtSecretPattern = "|\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b|[\\x27\"]?jwt[\\x27\"]?\\s*[:=]\\s*[\\x27\"]eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+[\\x27\"]";
const closeoutSecretSourceScanCommand = "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|postgres(?:ql)?:\\/\\/[^:<\\s\"\\x27]+:[^@<\\s\"\\x27]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+"
  + closeoutCamelCredentialPropertySecretPattern
  + closeoutSnakeCredentialPropertySecretPattern
  + "|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|\\bTELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|[\\x27\"]?Authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|[\\x27\"]?authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+"
  + closeoutRawJwtSecretPattern
  + "|raw_provider_payload|rawProviderPayload|raw_order_detail|rawOrderDetail' "
  + closeoutSourceScanPaths;
const closeoutUnsafeSourceScanCommandWithoutRuntimePublicEntries = closeoutUnsafeSourceScanCommand.replace(closeoutSourceScanPaths, closeoutSourceScanPathsWithoutRuntimePublicEntries);
const closeoutSecretSourceScanCommandWithoutRuntimePublicEntries = closeoutSecretSourceScanCommand.replace(closeoutSourceScanPaths, closeoutSourceScanPathsWithoutRuntimePublicEntries);
const closeoutSourceScanPathsWithoutUpbitPublicEntries = closeoutSourceScanPaths
  .replace("src/infrastructure/upbit/private-client.ts ", "")
  .replace("src/infrastructure/upbit/private-mappers.ts ", "");
const closeoutUnsafeSourceScanCommandWithoutUpbitPublicEntries = closeoutUnsafeSourceScanCommand.replace(closeoutSourceScanPaths, closeoutSourceScanPathsWithoutUpbitPublicEntries);
const closeoutSecretSourceScanCommandWithoutUpbitPublicEntries = closeoutSecretSourceScanCommand.replace(closeoutSourceScanPaths, closeoutSourceScanPathsWithoutUpbitPublicEntries);
const closeoutUnsafeSourceScanCommandWithoutPriceBestOrderType = closeoutUnsafeSourceScanCommand.replace(closeoutPriceBestOrderTypeUnsafePattern, "");
const closeoutSecretSourceScanCommandWithoutCamelCredentialProperties = closeoutSecretSourceScanCommand.replace(closeoutCamelCredentialPropertySecretPattern, "");
const closeoutSecretSourceScanCommandWithoutSnakeCredentialProperties = closeoutSecretSourceScanCommand.replace(closeoutSnakeCredentialPropertySecretPattern, "");
const closeoutSecretSourceScanCommandWithoutRawJwt = closeoutSecretSourceScanCommand.replace(closeoutRawJwtSecretPattern, "");

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

  it("passes when source scan keeps explicit order-risk terms without broad market-order patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-no-generic-market-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            closeoutSecretSourceScanCommand,
          ],
        },
      }),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "sourceSecurityScan").status).toBe("ok");
  });

  it("fails when source scan commands replace precise ord_type best payload coverage with bare MARKET", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-english-market-order-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '\"?ord_type\"?\\s*[:=]\\s*\"?price|\"?ord_type\"?\\s*[:=]\\s*\"?market|\"?order_type\"?\\s*[:=]\\s*\"?(market|MARKET)|\"?orderType\"?\\s*[:=]\\s*\"?(market|MARKET)|MARKET|시장가|withdraw|출금|deposit|입금|leverage|futures|margin' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit snake_case order_type market-order artifact patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-snake-order-type-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '\"?ord_type\"?\\s*[:=]\\s*\"?price|\"?ord_type\"?\\s*[:=]\\s*\"?market|\"?ord_type\"?\\s*[:=]\\s*\"?best|\"?orderType\"?\\s*[:=]\\s*\"?(market|MARKET)|시장가|withdraw|출금|deposit|입금|leverage|futures|margin' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit camelCase orderType market-order artifact patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-camel-order-type-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '\"?ord_type\"?\\s*[:=]\\s*\"?price|\"?ord_type\"?\\s*[:=]\\s*\"?market|\"?ord_type\"?\\s*[:=]\\s*\"?best|\"?order_type\"?\\s*[:=]\\s*\"?(market|MARKET)|시장가|withdraw|출금|deposit|입금|leverage|futures|margin' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit PRICE/BEST orderType artifact patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-price-best-order-type-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommandWithoutPriceBestOrderType,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit single-quoted order payload coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-single-quote-order-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '\"?ord_type\"?\\s*[:=]\\s*\"?price|\"?ord_type\"?\\s*[:=]\\s*\"?market|\"?ord_type\"?\\s*[:=]\\s*\"?best|\"?order_type\"?\\s*[:=]\\s*\"?(market|MARKET)|\"?orderType\"?\\s*[:=]\\s*\"?(market|MARKET)|\"?withdrawal_enabled\"?\\s*[:=]\\s*true|\"?deposit_enabled\"?\\s*[:=]\\s*true|\\/v1\\/deposits|\\/v1\\/withdraws|\"?futures_enabled\"?\\s*[:=]\\s*true|\"?leverage_enabled\"?\\s*[:=]\\s*true|\"?market_order_enabled\"?\\s*[:=]\\s*true|\"?entry_market_order_enabled\"?\\s*[:=]\\s*true' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit ord_type key/value order payload coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-ord-type-key-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?price|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?market|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?best|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?withdrawal_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?deposit_enabled[\\x27\"]?\\s*[:=]\\s*true|\\/v1\\/deposits|\\/v1\\/withdraws|[\\x27\"]?futures_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?leverage_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?market_order_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?entry_market_order_enabled[\\x27\"]?\\s*[:=]\\s*true' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit Korean market-order allowance coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-korean-market-order-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?price|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?market|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?best|[\\x27\"]?key[\\x27\"]?\\s*:\\s*[\\x27\"]ord_type[\\x27\"][^\\r\\n{}]*,[^\\r\\n{}]*[\\x27\"]?value[\\x27\"]?\\s*:\\s*[\\x27\"]?(price|market|best)|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?withdrawal_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?deposit_enabled[\\x27\"]?\\s*[:=]\\s*true|\\/v1\\/deposits|\\/v1\\/withdraws|[\\x27\"]?futures_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?leverage_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?market_order_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?entry_market_order_enabled[\\x27\"]?\\s*[:=]\\s*true' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit deposit path coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-deposit-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '\"?ord_type\"?\\s*[:=]\\s*\"?price|\"?ord_type\"?\\s*[:=]\\s*\"?market|\"?ord_type\"?\\s*[:=]\\s*\"?best|\"?order_type\"?\\s*[:=]\\s*\"?(market|MARKET)|\"?orderType\"?\\s*[:=]\\s*\"?(market|MARKET)|\"?withdrawal_enabled\"?\\s*[:=]\\s*true|\"?futures_enabled\"?\\s*[:=]\\s*true|\"?leverage_enabled\"?\\s*[:=]\\s*true|\"?market_order_enabled\"?\\s*[:=]\\s*true|\"?entry_market_order_enabled\"?\\s*[:=]\\s*true' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit withdrawal API path coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-withdraw-path-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?price|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?market|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?best|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?withdrawal_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?deposit_enabled[\\x27\"]?\\s*[:=]\\s*true|\\/v1\\/deposits|[\\x27\"]?futures_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?leverage_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?market_order_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?entry_market_order_enabled[\\x27\"]?\\s*[:=]\\s*true' "
              + closeoutSourceScanPaths,
            closeoutSecretSourceScanCommand,
          ],
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

  it("fails when source scan commands omit camelCase raw payload field coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-camel-raw-payload-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|postgres(?:ql)?:\\/\\/[^:<\\s\"\\x27]+:[^@<\\s\"\\x27]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|[\\x27\"]?Authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|[\\x27\"]?authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|raw_provider_payload|raw_order_detail' "
              + closeoutSourceScanPaths,
          ],
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

  it("fails when source scan commands omit raw Postgres credential URL coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-postgres-url-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|[\\x27\"]?Authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|[\\x27\"]?authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|raw_provider_payload|rawProviderPayload|raw_order_detail|rawOrderDetail' "
              + closeoutSourceScanPaths,
          ],
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

  it("fails when source scan commands omit quoted Authorization bearer coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-quoted-authorization-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|postgres(?:ql)?:\\/\\/[^:<\\s\"\\x27]+:[^@<\\s\"\\x27]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|Authorization\\s*[:=]\\s*\"?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|authorization\\s*[:=]\\s*\"?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|raw_provider_payload|rawProviderPayload|raw_order_detail|rawOrderDetail' "
              + closeoutSourceScanPaths,
          ],
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

  it("fails when source scan commands omit the Upbit live broker adapter path", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-live-broker-path-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?price|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?market|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?best|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?withdrawal_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?deposit_enabled[\\x27\"]?\\s*[:=]\\s*true|\\/v1\\/deposits|\\/v1\\/withdraws|[\\x27\"]?futures_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?leverage_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?market_order_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?entry_market_order_enabled[\\x27\"]?\\s*[:=]\\s*true' "
              + closeoutSourceScanPathsWithoutLiveBroker,
            "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|postgres(?:ql)?:\\/\\/[^:<\\s\"\\x27]+:[^@<\\s\"\\x27]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|[\\x27\"]?Authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|[\\x27\"]?authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|raw_provider_payload|rawProviderPayload|raw_order_detail|rawOrderDetail' "
              + closeoutSourceScanPathsWithoutLiveBroker,
          ],
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

  it("fails when source scan commands omit the Upbit private client auth path", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-private-auth-path-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?price|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?market|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?best|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?withdrawal_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?deposit_enabled[\\x27\"]?\\s*[:=]\\s*true|\\/v1\\/deposits|\\/v1\\/withdraws|[\\x27\"]?futures_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?leverage_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?market_order_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?entry_market_order_enabled[\\x27\"]?\\s*[:=]\\s*true' "
              + closeoutSourceScanPathsWithoutPrivateClientAuth,
            "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|postgres(?:ql)?:\\/\\/[^:<\\s\"\\x27]+:[^@<\\s\"\\x27]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|\\bTELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|[\\x27\"]?Authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|[\\x27\"]?authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|raw_provider_payload|rawProviderPayload|raw_order_detail|rawOrderDetail' "
              + closeoutSourceScanPathsWithoutPrivateClientAuth,
          ],
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

  it("fails when source scan commands omit the Upbit private mapper path", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-private-mapper-path-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            "rg --no-config -uuu -n '[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?price|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?market|[\\x27\"]?ord_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?best|[\\x27\"]?order_type[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?orderType[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(market|MARKET)|[\\x27\"]?withdrawal_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?deposit_enabled[\\x27\"]?\\s*[:=]\\s*true|\\/v1\\/deposits|\\/v1\\/withdraws|[\\x27\"]?futures_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?leverage_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?market_order_enabled[\\x27\"]?\\s*[:=]\\s*true|[\\x27\"]?entry_market_order_enabled[\\x27\"]?\\s*[:=]\\s*true' "
              + closeoutSourceScanPathsWithoutPrivateMappers,
            "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|postgres(?:ql)?:\\/\\/[^:<\\s\"\\x27]+:[^@<\\s\"\\x27]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|\\bTELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|[\\x27\"]?Authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|[\\x27\"]?authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|raw_provider_payload|rawProviderPayload|raw_order_detail|rawOrderDetail' "
              + closeoutSourceScanPathsWithoutPrivateMappers,
          ],
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

  it("fails when source scan commands omit legacy Telegram token literal coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-legacy-telegram-token-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            "rg --no-config -uuu -n 'SEEMIRAI_DATABASE_URL\\s*=\\s*postgres:\\/\\/[^\\s<:]+:[^\\s<@]+@|postgres(?:ql)?:\\/\\/[^:<\\s\"\\x27]+:[^@<\\s\"\\x27]+@|SEEMIRAI_UPBIT_ACCESS_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_UPBIT_SECRET_KEY\\s*=\\s*[^<\\s]+|SEEMIRAI_TELEGRAM_BOT_TOKEN\\s*=\\s*[0-9]+:[A-Za-z0-9_-]+|SEEMIRAI_TUI_CONTROL_TOKEN\\s*=\\s*[^<\\s]+|[\\x27\"]?Authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|[\\x27\"]?authorization[\\x27\"]?\\s*[:=]\\s*[\\x27\"]?(Bearer|bearer)\\s+[A-Za-z0-9._-]+|raw_provider_payload|rawProviderPayload|raw_order_detail|rawOrderDetail' "
              + closeoutSourceScanPaths,
          ],
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

  it("fails when manifest run time_in_force conflicts with the order policy", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-run-time-in-force-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({ ...run, time_in_force: "ioc" }),
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

  it("fails when the guarded command contains shell separators in path arguments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-command-separator-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => {
        const configPath = `${String(manifest.configPath)};touch`;
        return {
          ...manifest,
          configPath,
          command: `corepack pnpm live:ops -- --config ${configPath} --env-file ${String(manifest.envFilePath)} --tui`,
        };
      },
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

  it("fails when provided order suffix pairs conflict", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-chain-pair-conflict-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        identifierSuffix: "same-identifier",
        cancelIdentifierSuffix: "same-identifier",
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

  it("fails when order chain suffixes append suffix text to placeholders", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-chain-placeholder-suffix-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        identifierSuffix: "uuid-suffix",
        cancelIdentifierSuffix: "uuid-suffix",
        brokerOrderIdSuffix: "order-suffix",
        cancelBrokerOrderIdSuffix: "order-suffix",
      }),
      artifactText: JSON.stringify(createArtifactFixture({
        identifierSuffix: "uuid-suffix",
        cancelIdentifierSuffix: "uuid-suffix",
        brokerOrderIdSuffix: "order-suffix",
        cancelBrokerOrderIdSuffix: "order-suffix",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderLifecycle")).toMatchObject({ status: "fail" });
  });

  it("fails when order chain suffixes use fixture placeholders", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-chain-fixture-suffix-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        identifierSuffix: "fixture-identifier",
        cancelIdentifierSuffix: "fixture-identifier",
        brokerOrderIdSuffix: "fixture-order",
        cancelBrokerOrderIdSuffix: "fixture-order",
      }),
      artifactText: JSON.stringify(createArtifactFixture({
        identifierSuffix: "fixture-identifier",
        cancelIdentifierSuffix: "fixture-identifier",
        brokerOrderIdSuffix: "fixture-order",
        cancelBrokerOrderIdSuffix: "fixture-order",
      })),
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

  it("fails when lifecycle timestamps omit time components", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-date-only-lifecycle-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({
        ...run,
        submittedAt: "2026-06-15",
        cancelRequestedAt: "2026-06-15",
        terminalCancelConfirmedAt: "2026-06-15",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "orderLifecycle")).toMatchObject({ status: "fail" });
  });

  it("fails when lifecycle timestamps normalize impossible calendar dates", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-invalid-calendar-lifecycle-"));
    const submittedAt = "2026-02-30T00:00:00.000Z";
    const cancelRequestedAt = "2026-02-30T00:00:05.000Z";
    const terminalCancelConfirmedAt = "2026-02-30T00:00:10.000Z";
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      runMutator: (run) => ({ ...run, submittedAt, cancelRequestedAt, terminalCancelConfirmedAt }),
      artifactText: JSON.stringify(createArtifactFixture({ submittedAt, cancelRequestedAt, terminalCancelConfirmedAt })),
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

  it("fails when source scan commands omit runtime public entry files", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-runtime-entry-files-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommandWithoutRuntimePublicEntries,
            closeoutSecretSourceScanCommandWithoutRuntimePublicEntries,
          ],
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

  it("fails when source scan commands omit Upbit public entry files", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-upbit-entry-files-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommandWithoutUpbitPublicEntries,
            closeoutSecretSourceScanCommandWithoutUpbitPublicEntries,
          ],
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

  it("fails when source scan commands omit Upbit credential property literal coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-upbit-credential-properties-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            closeoutSecretSourceScanCommandWithoutCamelCredentialProperties,
          ],
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

  it("fails when source scan commands omit snake_case Upbit credential property literal coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-snake-upbit-credential-properties-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            closeoutSecretSourceScanCommandWithoutSnakeCredentialProperties,
          ],
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

  it("fails when source scan commands omit raw compact JWT literal coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-raw-jwt-literal-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          ...(manifest.sourceScan as Record<string, unknown>),
          commands: [
            closeoutUnsafeSourceScanCommand,
            closeoutSecretSourceScanCommandWithoutRawJwt,
          ],
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

  it("fails when source scan commands use clustered short exclude globs", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-clustered-exclude-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          commands: [
            "rg --no-config -uuu -ng'!src/**' \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -ng'!config/**' \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use count-only output", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-count-output-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --count \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n --count-matches \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
            "rg --no-config -uuu -nc \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands hide coverage terms in option values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-option-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --field-match-separator \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n --field-match-separator \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands hide coverage terms in context separator values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-context-separator-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --context-separator \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n --context-separator \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands hide coverage terms in sort values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-sort-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --sort \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n --sortr \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands hide coverage terms in color values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-color-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --color \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n --color \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands hide coverage terms in path separator values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-path-separator-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --path-separator \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n --path-separator \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands hide coverage terms in context count values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-context-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --after-context \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n --before-context \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|authorization|Bearer|bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n -C \"raw_update|rawUpdate\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands hide coverage terms in threads values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-threads-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --threads \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n -j \"access_key|accessKey|ACCESS_KEY|api_key|apiKey|API_KEY|secret_key|secretKey|SECRET_KEY|api_secret|apiSecret|API_SECRET|Authorization|authorization|Bearer|bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|postgresPassword|postgres_password|POSTGRES_PASSWORD|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands allow ripgrep config files", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-rg-config-"));
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

  it("fails when source scan commands omit unrestricted traversal", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-hidden-ignore-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when unrestricted traversal appears only after an option terminator", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-terminator-traversal-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -n -- -uuu \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -n -- -uuu \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use line-regexp matching", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-line-regexp-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -n -x \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -n --line-regexp \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use word-regexp matching", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-word-regexp-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n -w \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n --word-regexp \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands omit long matching lines or stop early", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-omit-long-lines-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --max-columns=1 \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n --stop-on-nonmatch \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands attach max-column values to short options", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-attached-max-columns-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -nM1 \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n -M1 \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use regex patterns that ripgrep cannot parse", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-invalid-regex-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"(?!)ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n \"(?!)access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use no-match regex fragments as fake coverage", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-no-match-regex-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type$^|market$^|best$^|withdraw$^|deposit$^|leverage$^|futures$^|margin$^\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key$^|accessKey$^|ACCESS_KEY$^|secret_key$^|secretKey$^|SECRET_KEY$^|Authorization$^|Bearer$^|JWT$^|telegram_bot_token$^|botToken$^|TELEGRAM_BOT_TOKEN$^|raw_provider$^|rawProvider$^|raw_order$^|rawOrder$^\" src scripts config docs",
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

  it("fails when source scan commands mutate required terms with regex suffixes", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-regex-suffix-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type{2}|market{2}|시장가{2}|best{2}|withdraw{2}|출금{2}|deposit{2}|입금{2}|leverage{2}|futures{2}|margin{2}\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key{2}|accessKey{2}|ACCESS_KEY{2}|secret_key{2}|secretKey{2}|SECRET_KEY{2}|Authorization{2}|Bearer{2}|JWT{2}|jwt{2}|telegram_bot_token{2}|botToken{2}|TELEGRAM_BOT_TOKEN{2}|SEEMIRAI_TUI_CONTROL_TOKEN{2}|tuiControlToken{2}|tui_control_token{2}|DATABASE_URL{2}|databasePassword{2}|database_password{2}|db_password{2}|pg_password{2}|raw_provider{2}|rawProvider{2}|raw_order{2}|rawOrder{2}|raw_update{2}|rawUpdate{2}\" src scripts config docs",
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

  it("fails when source scan commands use regex patterns that cannot be parsed", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-parse-error-regex-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type[|market[|시장가[|best[|withdraw[|출금[|deposit[|입금[|leverage[|futures[|margin[\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key[|accessKey[|ACCESS_KEY[|secret_key[|secretKey[|SECRET_KEY[|Authorization[|Bearer[|JWT[|jwt[|telegram_bot_token[|botToken[|TELEGRAM_BOT_TOKEN[|SEEMIRAI_TUI_CONTROL_TOKEN[|tuiControlToken[|tui_control_token[|DATABASE_URL[|databasePassword[|database_password[|db_password[|pg_password[|raw_provider[|rawProvider[|raw_order[|rawOrder[|raw_update[|rawUpdate[\" src scripts config docs",
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

  it("fails when source scan commands use regex backreferences", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-backreference-regex-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"(ord_type)\\1|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n \"(access_key)\\1|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|authorization|Bearer|bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" src scripts config docs",
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

  it("fails when source scan commands anchor required terms", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-anchored-regex-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"^ord_type|^market|^시장가|^best|^withdraw|^출금|^deposit|^입금|^leverage|^futures|^margin\" src scripts config docs",
            "rg --no-config -uuu -n \"^access_key|^accessKey|^ACCESS_KEY|^secret_key|^secretKey|^SECRET_KEY|^Authorization|^authorization|^Bearer|^bearer|^JWT|^jwt|^telegram_bot_token|^botToken|^TELEGRAM_BOT_TOKEN|^SEEMIRAI_TUI_CONTROL_TOKEN|^tuiControlToken|^tui_control_token|^DATABASE_URL|^databasePassword|^database_password|^db_password|^pg_password|^raw_provider|^rawProvider|^raw_order|^rawOrder|^raw_update|^rawUpdate\" src scripts config docs",
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

  it("fails when source scan commands hide required paths behind shell comments or newlines", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-shell-comment-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" /tmp/empty # src scripts config docs",
            "rg --no-config -uuu -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" /tmp/empty\n: src scripts config docs",
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

  it("fails when source scan commands leave quotes unclosed", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-unclosed-quote-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin src scripts config docs",
            "rg --no-config -uuu -n 'access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder src scripts config docs",
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

  it("fails when source scan commands override unrestricted traversal", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-traversal-override-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --ignore \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n --no-hidden \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use replacement values as fake patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-replace-pattern-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --replace \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" \"a^\" src scripts config docs",
            "rg --no-config -uuu -n -r \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" \"a^\" src scripts config docs",
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

  it("fails when source scan commands use metadata-only ripgrep modes", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-metadata-mode-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --type-list \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n --pcre2-version \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands disable line numbers after enabling them", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-no-line-number-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n --no-line-number \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n -N \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands use short max-depth or no-filename output", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-depth-filename-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n -d0 \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n -I \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when line-number flags only appear inside quoted search patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-quoted-line-number-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu \"ord_type -n market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu \"access_key --line-number accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands contain command substitution", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-substitution-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -n \"$(printf 'a^'; : ord_type market best withdraw deposit leverage futures margin)\" src scripts config docs",
            "rg --no-config -n \"$(printf 'a^'; : access_key accessKey ACCESS_KEY secret_key secretKey SECRET_KEY Authorization Bearer JWT telegram_bot_token botToken TELEGRAM_BOT_TOKEN raw_provider rawProvider raw_order rawOrder)\" src scripts config docs",
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

  it("fails when source scan commands contain shell variable expansion", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-variable-expansion-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"$ord_type_market_best_withdraw_deposit_leverage_futures_margin\" src scripts config docs",
            "rg --no-config -uuu -n \"${access_key_accessKey_ACCESS_KEY_secret_key_secretKey_SECRET_KEY_Authorization_Bearer_JWT_telegram_bot_token_botToken_TELEGRAM_BOT_TOKEN_raw_provider_rawProvider_raw_order_rawOrder}\" src scripts config docs",
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
          secretMatches: [{ filePath: "src/secret.ts", line: 1, label: rawSecret, snippet: rawSecret }],
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
      expect(JSON.stringify(getCheck(summary, "sourceSecurityScan"))).toContain("[redacted-label]");
    }
  });

  it("does not echo raw source scan commands in failure summaries", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-raw-command-"));
    const rawSecret = "SEEMIRAI_UPBIT_SECRET_KEY=raw-secret-value-inside-command";
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            `rg --no-config -uuu -n "${rawSecret}|ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin" src scripts config docs`,
            "rg --no-config -uuu -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
          ],
          unsafeMatches: [],
          secretMatches: [],
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
      expect(JSON.stringify(getCheck(summary, "sourceSecurityScan"))).not.toContain(rawSecret);
    }
  });

  it("fails when source scan commands omit required alternative spellings", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-alt-spelling-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type|market|best|withdraw|deposit|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key|ACCESS_KEY|secret_key|SECRET_KEY|Authorization|Bearer|JWT|telegram_bot_token|TELEGRAM_BOT_TOKEN|raw_provider|raw_order\" src scripts config docs",
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

  it("fails when source scan commands prefix fake search terms", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-prefixed-terms-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"xord_type|xmarket|x시장가|xbest|xwithdraw|x출금|xdeposit|x입금|xleverage|xfutures|xmargin\" src scripts config docs",
            "rg --no-config -uuu -n \"xaccess_key|xaccessKey|xACCESS_KEY|xsecret_key|xsecretKey|xSECRET_KEY|xAuthorization|xBearer|xJWT|xjwt|xtelegram_bot_token|xbotToken|xTELEGRAM_BOT_TOKEN|xSEEMIRAI_TUI_CONTROL_TOKEN|xtuiControlToken|xtui_control_token|xDATABASE_URL|xdatabasePassword|xdatabase_password|xdb_password|xpg_password|xraw_provider|xrawProvider|xraw_order|xrawOrder\" src scripts config docs",
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

  it("fails when source scan commands omit TUI or database credential patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-tui-db-secret-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands omit raw update patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-raw-update-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder\" src scripts config docs",
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

  it("fails when source scan commands omit lowercase auth header patterns", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-lowercase-auth-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|Bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" src scripts config docs",
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

  it("fails when source scan commands omit API and postgres secret aliases", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-source-scan-api-postgres-aliases-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({
        ...manifest,
        sourceScan: {
          status: "passed",
          cwd: process.cwd(),
          repositoryRoot: process.cwd(),
          commands: [
            "rg --no-config -uuu -n \"ord_type|market|시장가|best|withdraw|출금|deposit|입금|leverage|futures|margin\" src scripts config docs",
            "rg --no-config -uuu -n \"access_key|accessKey|ACCESS_KEY|secret_key|secretKey|SECRET_KEY|Authorization|authorization|Bearer|bearer|JWT|jwt|telegram_bot_token|botToken|TELEGRAM_BOT_TOKEN|SEEMIRAI_TUI_CONTROL_TOKEN|tuiControlToken|tui_control_token|DATABASE_URL|databasePassword|database_password|db_password|pg_password|raw_provider|rawProvider|raw_order|rawOrder|raw_update|rawUpdate\" src scripts config docs",
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

  it("fails when production env values are fixture credentials", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-fixture-env-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      envText: [
        "SEEMIRAI_DATABASE_URL=postgres://seemirai:fixture-db-password@127.0.0.1:55432/seemirai",
        "SEEMIRAI_UPBIT_ACCESS_KEY=fixture-upbit-access-key",
        "SEEMIRAI_UPBIT_SECRET_KEY=fixture-upbit-secret-key",
        "SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기",
        "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID=issue-206-upbit-key-scope-2026-06-15",
        "SEEMIRAI_TELEGRAM_BOT_TOKEN=fixture-telegram-token",
        "SEEMIRAI_TELEGRAM_CHAT_ID=123456789",
        "SEEMIRAI_TUI_CONTROL_TOKEN=fixture-local-control-token",
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

  it("fails when production env values contain redacted placeholder fragments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-redacted-env-value-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      envText: [
        "SEEMIRAI_DATABASE_URL=postgres://seemirai:<redacted>@127.0.0.1:55432/seemirai",
        "SEEMIRAI_UPBIT_ACCESS_KEY=owner-live-upbit-access-key-2026-06-15",
        "SEEMIRAI_UPBIT_SECRET_KEY=owner-live-upbit-secret-key-2026-06-15",
        "SEEMIRAI_UPBIT_KEY_SCOPE=자산조회,주문조회,주문하기",
        "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID=issue-206-upbit-key-scope-2026-06-15",
        "SEEMIRAI_TELEGRAM_BOT_TOKEN=123456789:<redacted>",
        "SEEMIRAI_TELEGRAM_CHAT_ID=123456789",
        "SEEMIRAI_TUI_CONTROL_TOKEN=owner-live-local-control-credential",
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

  it("fails when decision policy contains an arbitrary strategy path", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-policy-key-"));
    const configPath = path.join(artifactDir, "live-ops-policy-extra-key.json");
    const config = createLiveOpsConfigFixture();
    (config.analysis.decision_policy.cleanup_probe as Record<string, unknown>).script_path = "./unsafe-strategy.js";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

  it("fails when artifact safe summary omits provided order suffix fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-suffix-missing-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        brokerOrderIdSuffix: undefined,
        cancelBrokerOrderIdSuffix: undefined,
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

  it("allows non-closeout provider market summaries next to complete artifact evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-provider-market-summary-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        order: createArtifactFixture(),
        providerSummary: { market: "KRW-ETH", status: "ACTIVE" },
      }),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "ok" });
  });

  it("allows non-closeout provider timeout summaries next to complete artifact evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-provider-timeout-summary-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        order: createArtifactFixture(),
        providerSummary: { status: "TIMEOUT", market: "KRW-ETH" },
      }),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "ok" });
  });

  it("allows non-closeout timestamp and identifiers next to complete artifact evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-non-order-identifier-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        order: createArtifactFixture(),
        telegram: { status: "SENT", submittedAt: "2026-06-15T00:00:00.000Z", identifier: "telegram-message-safe-id" },
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

  it("accepts snake_case order_type as the canonical safe summary order type", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-order-type-alias-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        orderType: undefined,
        order_type: "LIMIT",
      })),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "ok" });
  });

  it("accepts manifest run order_type alias as the canonical order type", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-run-order-type-alias-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => {
        const run = manifest.run as Record<string, unknown>;
        return {
          ...manifest,
          run: {
            ...run,
            orderType: undefined,
            order_type: "LIMIT",
          },
        };
      },
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "orderPolicy")).toMatchObject({ status: "ok" });
  });

  it("accepts CANCEL_CONFIRMED terminal_state as terminal cancel evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-terminal-confirmed-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        terminalState: undefined,
        terminal_state: "CANCEL_CONFIRMED",
      })),
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "ok" });
  });

  it("accepts manifest run terminal_state CANCEL_CONFIRMED as terminal cancel evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-run-terminal-confirmed-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => {
        const run = manifest.run as Record<string, unknown>;
        return {
          ...manifest,
          run: {
            ...run,
            terminalState: undefined,
            terminal_state: "CANCEL_CONFIRMED",
          },
        };
      },
    });
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as LiveOpsRealArmCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "orderLifecycle")).toMatchObject({ status: "ok" });
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

  it("fails when artifact-level status is timeout even with nested success evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-timeout-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "TIMEOUT",
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

  it("fails when artifact-level status is uncertain even with nested success evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-uncertain-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "BROKER_SUBMISSION_UNCERTAIN",
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

  it("fails when artifact-level status is unknown even with nested success evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-unknown-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "UNKNOWN",
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

  it("fails when artifact-level status is rejected even with nested success evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-rejected-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "ORDER_REJECTED",
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

  it("fails when order lifecycle attempt status is failed next to nested success evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-lifecycle-failed-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        orderAttempt: {
          status: "FAILED",
          submittedAt: "2026-06-15T00:00:00.000Z",
          identifierSuffix: "closeout-identifier",
        },
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

  it("fails when artifact-level status uses blocked suffix variants", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-blocked-suffix-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "RISK_BLOCKED",
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

  it("fails when artifact-level status requires manual review even with nested success evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-manual-review-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "MANUAL_REVIEW_REQUIRED",
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

  it("fails when artifact-level status uses space-separated manual review text", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-artifact-wrapper-manual-review-text-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        status: "Manual Review Required",
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

  it("fails when guarded artifacts contain decoded fixture-only markers", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-fixture-decoded-marker-"));
    const rawArtifact = JSON.stringify({
      ...createArtifactFixture(),
      kind: "ISSUE_206_LIVE_OPS_REAL_ARM_FIXTURE",
    }).replace("FIXTURE", "\\u0046IXTURE");
    const manifestPath = await writeCloseoutManifest(artifactDir, { artifactText: rawArtifact });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "guardedArtifactInput")).toMatchObject({ status: "fail" });
  });

  it("fails when guarded manifest contains fixture-only markers", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-manifest-fixture-marker-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      manifestMutator: (manifest) => ({ ...manifest, kind: "ISSUE_206_LIVE_OPS_REAL_ARM_FIXTURE" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "guardedArtifactInput")).toMatchObject({ status: "fail" });
  });

  it("fails when very deeply nested artifact safe summaries conflict with manifest closeout values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-very-deep-artifact-conflict-"));
    let nested: Record<string, unknown> = {
      status: "FAILED",
      terminalState: "wait",
      openExposureKrw: 999999,
    };
    for (let index = 0; index < 12; index += 1) {
      nested = { [`layer${index}`]: nested };
    }
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        ...createArtifactFixture(),
        nested,
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "artifactFiles")).toMatchObject({ status: "fail" });
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

  it("fails when redacted env assignment keeps JSON text after a placeholder", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-redacted-env-json-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_UPBIT_SECRET_KEY=<redacted>,{\"tail\":\"raw\"}",
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

  it("fails when redacted artifacts contain generic API credential fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-api-credential-fields-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        apiKey: "upbit-access-key-raw-value",
        apiSecret: "upbit-secret-key-raw-value",
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

  it("fails when redacted artifacts contain postgres password JSON fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-postgres-password-json-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        postgresPassword: "operator-db-password-value",
        postgres_password: "operator-db-password-value",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain postgres password env assignments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-postgres-password-env-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_POSTGRES_PASSWORD=operator-db-password-value",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain raw database URL fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-db-url-field-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        databaseUrl: "postgres://db-host/seemirai",
        database_url: "postgres://db-host/seemirai",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain database URL env assignments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-db-url-env-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_DATABASE_URL=postgres://db-host/seemirai",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when database URL placeholders keep raw JSON tails", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-db-url-placeholder-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "SEEMIRAI_DATABASE_URL=<redacted>,{\"tail\":\"postgres://db-host/seemirai\"}",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain free-form database URLs", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-db-url-free-form-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "database endpoint postgres://db-host/seemirai",
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

  it("fails when redacted artifacts contain raw update string payloads", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-update-string-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "raw_update={\"update_id\":123456}",
        detail: "rawUpdatePayload=[{\"message\":\"raw-telegram-update\"}]",
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

  it("fails when raw payload placeholders keep a punctuation-separated raw tail", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-payload-punctuation-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "raw_order_detail=<redacted>,{\"uuid\":\"raw-order-payload\"}",
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when raw payload placeholders keep dot slash or hyphen tails", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-payload-symbol-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: [
          "raw_order_detail=<redacted>.raw-order-payload",
          "raw_provider_payload=<redacted>/raw-provider-payload",
          "rawUpdatePayload=<redacted>-raw-update-payload",
        ].join("\n"),
      })),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when quoted raw payload placeholders keep a raw tail", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-raw-payload-quoted-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "raw_order_detail=\"<redacted>\",{\"uuid\":\"raw-order-payload\"}",
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

  it("fails when bearer placeholders keep punctuation-separated raw tails", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-bearer-placeholder-punctuation-tail-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify(createArtifactFixture({
        note: "Authorization: Bearer <redacted>,raw-provider-token-tail",
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

  it("fails when redacted artifacts contain SEEMIRAI Telegram JSON token fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-seemirai-telegram-json-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ SEEMIRAI_TELEGRAM_BOT_TOKEN: "123456:raw-telegram-token-value" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain SEEMIRAI camelCase credential fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-seemirai-camel-json-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        seemiraiUpbitSecretKey: "raw-secret-key-value",
        seemiraiTelegramBotToken: "123456:raw-telegram-token-value",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when redacted artifacts contain hyphenated credential JSON fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-hyphen-json-secret-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        "access-key": "raw-access-key-value",
        "upbit-secret-key": "raw-secret-key-value",
      }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when JSON key escapes decode into hyphenated raw credential fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-hyphen-key-"));
    const escapedArtifact = JSON.stringify(createArtifactFixture({
      "upbit-secret-key": "raw-secret-key-value",
      "telegram-bot-token": "123456:raw-telegram-token-value",
    }))
      .replace("upbit-secret-key", "upbit\\u002dsecret\\u002dkey")
      .replace("telegram-bot-token", "telegram\\u002dbot\\u002dtoken");
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

  it("fails when redacted artifacts contain generic token JSON fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-generic-json-token-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({ token: "raw-control-token-value" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "redactionScan")).toMatchObject({ status: "fail" });
  });

  it("fails when JSON key escapes decode into generic token fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-token-key-"));
    const escapedArtifact = JSON.stringify({ token: "raw-control-token-value" })
      .replace("token", "to\\u006ben");
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

  it("fails when decoded credential placeholders keep raw tails", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-token-placeholder-tail-"));
    const escapedArtifact = JSON.stringify({
      token: "<redacted>,raw-control-token-tail",
      access_key: "<redacted>;raw-access-key-tail",
    })
      .replace("token", "to\\u006ben")
      .replace("access_key", "access\\u005fkey");
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

  it("fails when redacted artifacts contain query hash fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-query-hash-"));
    const manifestPath = await writeCloseoutManifest(artifactDir, {
      artifactText: JSON.stringify({
        queryHash: "raw-query-hash-value",
        query_hash: "raw-query-hash-value",
      }),
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

  it("fails when deeply nested JSON string escapes decode into raw secret assignments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-deep-escaped-secret-"));
    const rawSecret = "SEEMIRAI_UPBIT_SECRET_KEY=raw-secret-value-from-deep-decoded-json";
    let nested: Record<string, unknown> = { note: rawSecret };
    for (let index = 0; index < 12; index += 1) {
      nested = { [`layer${index}`]: nested };
    }
    const escapedArtifact = JSON.stringify(createArtifactFixture({ nested }))
      .replace(rawSecret, "SEEMIRAI_UPBIT_SECRET_KEY\\u003draw-secret-value-from-deep-decoded-json");
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

  it("fails when JSON key escapes decode into raw secret fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-key-"));
    const escapedArtifact = JSON.stringify({
      secret_key: "raw-secret-value-from-decoded-key",
      raw_provider_payload: { uuid: "raw-provider-payload" },
    })
      .replace("secret_key", "secret\\u005fkey")
      .replace("raw_provider_payload", "raw\\u005fprovider\\u005fpayload");
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

  it("fails when JSON key escapes decode into raw payload fields with empty values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-raw-payload-empty-"));
    const escapedArtifact = JSON.stringify({
      raw_provider_payload: {},
      rawOrderPayload: {},
    })
      .replace("raw_provider_payload", "raw\\u005fprovider\\u005fpayload")
      .replace("rawOrderPayload", "rawOrder\\u0050ayload");
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

  it("fails when JSON key escapes decode into raw update fields with empty values", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-raw-update-empty-"));
    const escapedArtifact = JSON.stringify({ raw_update: {} })
      .replace("raw_update", "raw\\u005fupdate");
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

  it("fails when camelCase JSON key escapes decode into raw credential fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-issue-206-closeout-json-escaped-camel-key-"));
    const escapedArtifact = JSON.stringify({
      accessKey: "raw-access-key-value",
      secretKey: "raw-secret-key-value",
      botToken: "raw-telegram-bot-token",
      databaseUrl: "postgres://db-host/seemirai",
    })
      .replace("accessKey", "access\\u004bey")
      .replace("secretKey", "secret\\u004bey")
      .replace("botToken", "bot\\u0054oken")
      .replace("databaseUrl", "database\\u0055rl");
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
        closeoutUnsafeSourceScanCommand,
        closeoutSecretSourceScanCommand,
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
      decision_policy: {
        id: "cleanup_probe",
        cleanup_probe: {
          max_notional_krw: "10000",
          tick_size_krw: "1000",
          price_offset_ticks: 1,
          quantity_scale: 8,
          expected_loss_bps_of_equity: "5",
        },
      },
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
