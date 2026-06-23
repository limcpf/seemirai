import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnsafeLiveOpsConfigError,
  defaultLiveOpsConfig,
  detectLegacyLiveOpsEnv,
  findSecretLikeConfigPaths,
  formatLiveOpsModeForUser,
  loadLiveOpsConfig,
  loadLiveOpsSecretsFromEnv,
  parseLiveOpsEnvFileContent,
  validateLiveOpsStartupContract,
} from "../../src/runtime/index.js";

const fixtureEnv = [
  "SEEMIRAI_DATABASE_URL=postgres://seemirai:fake-password@127.0.0.1:55432/seemirai",
  "SEEMIRAI_UPBIT_ACCESS_KEY=fake-access-key",
  "SEEMIRAI_UPBIT_SECRET_KEY=fake-secret-key",
  "SEEMIRAI_TELEGRAM_BOT_TOKEN=fake-telegram-token",
  "SEEMIRAI_TELEGRAM_CHAT_ID=fake-chat-id",
  "SEEMIRAI_TUI_CONTROL_TOKEN=fake-control-token",
].join("\n");

describe("production live ops config/env contract", () => {
  it("명시 production live ops config는 KRW-BTC 단일, 소액 예산, TUI 필수 계약을 가진다", () => {
    const config = loadLiveOpsConfig(defaultLiveOpsConfig);

    expect(config).toMatchObject({
      mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
      live_trading_enabled: true,
      paper_no_key: false,
      withdrawal_enabled: false,
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
      analysis: {
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
      tui: {
        foreground_enabled: true,
        attach_enabled: true,
        control_requires_two_step_confirmation: true,
      },
    });
  });

  it("live trading opt-in이 누락된 config는 secret env가 있어도 ready가 되지 않는다", () => {
    const result = validateLiveOpsStartupContract({
      configInput: {},
      envFileContent: fixtureEnv,
    });

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected blocked contract");
    expect(result.errors.join("\n")).toContain("mode");
    expect(result.errors.join("\n")).toContain("live_trading_enabled");
    expect(result.errors.join("\n")).toContain("paper_no_key");
  });

  it("secret-like key가 JSON config에 들어오면 startup contract에서 차단한다", () => {
    const configInput = {
      ...loadLiveOpsConfig(defaultLiveOpsConfig),
      secrets: {
        upbit_access_key: "do-not-store-in-json",
      },
    };

    expect(findSecretLikeConfigPaths(configInput)).toContain("$.secrets");

    const result = validateLiveOpsStartupContract({
      configInput,
      envFileContent: fixtureEnv,
    });

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected blocked contract");
    expect(result.errors.join("\n")).toContain("secret-like key");
  });

  it("decision policy는 정적 cleanup_probe allowlist 밖 값을 허용하지 않는다", () => {
    const config = loadLiveOpsConfig(defaultLiveOpsConfig);

    expect(() => loadLiveOpsConfig({
      ...config,
      analysis: {
        ...config.analysis,
        decision_policy: {
          id: "file_strategy",
          script_path: "/tmp/strategy.js",
        },
      },
    })).toThrow();
  });

  it("legacy milestone env는 production live ops readiness 입력으로 쓰지 않는다", () => {
    const violations = detectLegacyLiveOpsEnv({
      SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON: "1",
      SEEMIRAI_M22_DECISION_LEDGER_READY: "1",
      SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE: "1",
    });

    expect(violations.map((violation) => violation.envName)).toEqual([
      "SEEMIRAI_M22_DECISION_LEDGER_READY",
      "SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON",
      "SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE",
    ]);
  });

  it("process env의 legacy flag는 env file override로 숨길 수 없다", () => {
    const result = validateLiveOpsStartupContract({
      configInput: loadLiveOpsConfig(defaultLiveOpsConfig),
      env: {
        SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE: "1",
      },
      envFileContent: `${fixtureEnv}\nSEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=0`,
    });

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected blocked contract");
    expect(result.errors.join("\n")).toContain("SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE");
  });

  it("env file parser와 secret loader는 credential을 JSON config와 분리한다", () => {
    const parsed = parseLiveOpsEnvFileContent(`export SEEMIRAI_DATABASE_URL="postgres://example"\n${fixtureEnv}`);
    expect(parsed.errors).toEqual([]);

    const secrets = loadLiveOpsSecretsFromEnv(parsed.values, { requireTuiControlToken: true });

    expect(secrets.databaseUrl).toBe("postgres://seemirai:fake-password@127.0.0.1:55432/seemirai");
    expect(secrets.tuiControlToken).toBe("fake-control-token");
  });

  it("safe user-facing mode 문구는 PAPER_NO_KEY raw code를 첫 화면에 노출하지 않는다", () => {
    const message = formatLiveOpsModeForUser({ mode: "PAPER_NO_KEY", paperNoKey: true });

    expect(message).toContain("모의 운영");
    expect(message).not.toContain("PAPER_NO_KEY");
  });

  it("safe fixture env/config는 startup contract를 통과한다", async () => {
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    const envFileContent = await readFile(path.join(process.cwd(), "tests", "fixtures", "live-ops", "fake.env"), "utf8");

    const result = validateLiveOpsStartupContract({
      configInput: config,
      env: {},
      envFileContent,
    });

    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error(result.message);
    expect(JSON.stringify(result)).not.toContain("fake-upbit-secret-key");
  });

  it("assert error는 secret 원문 없이 한국어 실패 메시지를 제공한다", () => {
    const result = validateLiveOpsStartupContract({
      configInput: { paper_no_key: true },
      envFileContent: "SEEMIRAI_UPBIT_SECRET_KEY=very-secret",
    });

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected blocked contract");
    const error = new UnsafeLiveOpsConfigError(result.errors);
    expect(error.message).toContain("production live ops를 시작하지 않았습니다");
    expect(error.message).not.toContain("very-secret");
  });
});
