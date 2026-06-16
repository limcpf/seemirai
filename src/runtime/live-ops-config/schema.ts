import { z } from "zod";

export const LIVE_OPS_PRODUCTION_MODE = "LIVE_AUTONOMOUS_SMALL_BUDGET";
export const LIVE_OPS_DEFAULT_MARKET = "KRW-BTC";
export const LIVE_OPS_CLEANUP_PROBE_DECISION_POLICY_ID = "cleanup_probe";

const MarketCodeSchema = z.string().regex(/^KRW-[A-Z0-9]+$/u, "KRW market code is required");
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NonNegativeDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "must be a non-negative decimal string");
const PositiveDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "must be a non-negative decimal string")
  .refine((value) => Number(value) > 0, "must be greater than 0");

/**
 * production live ops JSON 설정의 기본 계약이다.
 *
 * 이 값은 저장소에 커밋 가능한 non-secret 운영 정책만 담는다. credential, token, DB URL은 env loader가 별도로 읽어야 하며,
 * 이 기본값은 외부 API, DB, Telegram, TUI side effect를 만들지 않는다.
 */
export const defaultLiveOpsConfig = {
  schema_version: 1,
  mode: LIVE_OPS_PRODUCTION_MODE,
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
    markets: [LIVE_OPS_DEFAULT_MARKET],
    default_market: LIVE_OPS_DEFAULT_MARKET,
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
    stale_after_ms: 30_000,
  },
  analysis: {
    candle_interval_seconds: 60,
    feature_interval_seconds: 5,
    decision_interval_seconds: 5,
    record_hold_decision: true,
    decision_policy: {
      id: LIVE_OPS_CLEANUP_PROBE_DECISION_POLICY_ID,
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
    provider_timeout_ms: 5_000,
  },
  tui: {
    foreground_enabled: true,
    attach_enabled: true,
    refresh_interval_ms: 1_000,
    control_requires_two_step_confirmation: true,
    controls_enabled: true,
  },
} as const;

/**
 * production live ops JSON config schema다.
 *
 * schema는 one-click 운영 앱이 읽을 정책값만 허용한다. M22/M23 pilot env나 secret 저장소 shape를 이 JSON에 섞으면 strict
 * validation에서 실패해야 하며, 성공한 설정도 후속 startup guard와 DB/provider probe 전에는 live broker 조립 근거가 아니다.
 */
export const LiveOpsConfigSchema = z
  .object({
    schema_version: z.literal(1).default(defaultLiveOpsConfig.schema_version),
    mode: z.literal(LIVE_OPS_PRODUCTION_MODE),
    exchange: z.literal("UPBIT").default(defaultLiveOpsConfig.exchange),
    market: z.literal("KRW_SPOT").default(defaultLiveOpsConfig.market),
    live_trading_enabled: z.literal(true),
    paper_no_key: z.literal(false),
    withdrawal_enabled: z.literal(false).default(defaultLiveOpsConfig.withdrawal_enabled),
    cross_exchange_arbitrage_enabled: z.literal(false).default(
      defaultLiveOpsConfig.cross_exchange_arbitrage_enabled,
    ),
    futures_enabled: z.literal(false).default(defaultLiveOpsConfig.futures_enabled),
    leverage_enabled: z.literal(false).default(defaultLiveOpsConfig.leverage_enabled),
    market_order_enabled: z.literal(false).default(defaultLiveOpsConfig.market_order_enabled),
    entry_market_order_enabled: z.literal(false).default(defaultLiveOpsConfig.entry_market_order_enabled),
    universe: z
      .object({
        markets: z.array(MarketCodeSchema).min(1).default([...defaultLiveOpsConfig.universe.markets]),
        default_market: MarketCodeSchema.default(defaultLiveOpsConfig.universe.default_market),
      })
      .strict()
      .default(() => ({
        markets: [...defaultLiveOpsConfig.universe.markets],
        default_market: defaultLiveOpsConfig.universe.default_market,
      })),
    budget: z
      .object({
        max_order_krw: PositiveDecimalStringSchema.default(defaultLiveOpsConfig.budget.max_order_krw),
        daily_autonomous_notional_limit_krw: PositiveDecimalStringSchema.default(
          defaultLiveOpsConfig.budget.daily_autonomous_notional_limit_krw,
        ),
        max_open_position_notional_krw: PositiveDecimalStringSchema.default(
          defaultLiveOpsConfig.budget.max_open_position_notional_krw,
        ),
        operations_stop_ceiling_krw: PositiveDecimalStringSchema.default(
          defaultLiveOpsConfig.budget.operations_stop_ceiling_krw,
        ),
      })
      .strict()
      .default(defaultLiveOpsConfig.budget),
    workers: z
      .object({
        db_readiness: z.literal(true).default(defaultLiveOpsConfig.workers.db_readiness),
        market_data: z.literal(true).default(defaultLiveOpsConfig.workers.market_data),
        analysis_decision: z.literal(true).default(defaultLiveOpsConfig.workers.analysis_decision),
        live_execution: z.literal(true).default(defaultLiveOpsConfig.workers.live_execution),
        reconcile_pnl_status: z.literal(true).default(defaultLiveOpsConfig.workers.reconcile_pnl_status),
        telegram: z.literal(true).default(defaultLiveOpsConfig.workers.telegram),
        tui: z.literal(true).default(defaultLiveOpsConfig.workers.tui),
      })
      .strict()
      .default(defaultLiveOpsConfig.workers),
    market_data: z
      .object({
        provider: z.literal("UPBIT_PUBLIC").default(defaultLiveOpsConfig.market_data.provider),
        websocket_enabled: z.literal(true).default(defaultLiveOpsConfig.market_data.websocket_enabled),
        rest_policy_snapshot_enabled: z.literal(true).default(
          defaultLiveOpsConfig.market_data.rest_policy_snapshot_enabled,
        ),
        stale_after_ms: PositiveIntegerSchema.default(defaultLiveOpsConfig.market_data.stale_after_ms),
      })
      .strict()
      .default(defaultLiveOpsConfig.market_data),
    analysis: z
      .object({
        candle_interval_seconds: PositiveIntegerSchema.default(defaultLiveOpsConfig.analysis.candle_interval_seconds),
        feature_interval_seconds: PositiveIntegerSchema.default(defaultLiveOpsConfig.analysis.feature_interval_seconds),
        decision_interval_seconds: PositiveIntegerSchema.default(
          defaultLiveOpsConfig.analysis.decision_interval_seconds,
        ),
        record_hold_decision: z.literal(true).default(defaultLiveOpsConfig.analysis.record_hold_decision),
        decision_policy: z
          .object({
            id: z.literal(LIVE_OPS_CLEANUP_PROBE_DECISION_POLICY_ID).default(
              defaultLiveOpsConfig.analysis.decision_policy.id,
            ),
            cleanup_probe: z
              .object({
                max_notional_krw: z.literal("10000").default(
                  defaultLiveOpsConfig.analysis.decision_policy.cleanup_probe.max_notional_krw,
                ),
                tick_size_krw: PositiveDecimalStringSchema.default(
                  defaultLiveOpsConfig.analysis.decision_policy.cleanup_probe.tick_size_krw,
                ),
                price_offset_ticks: PositiveIntegerSchema.default(
                  defaultLiveOpsConfig.analysis.decision_policy.cleanup_probe.price_offset_ticks,
                ),
                quantity_scale: PositiveIntegerSchema.max(12).default(
                  defaultLiveOpsConfig.analysis.decision_policy.cleanup_probe.quantity_scale,
                ),
                expected_loss_bps_of_equity: NonNegativeDecimalStringSchema.default(
                  defaultLiveOpsConfig.analysis.decision_policy.cleanup_probe.expected_loss_bps_of_equity,
                ),
              })
              .strict()
              .default(defaultLiveOpsConfig.analysis.decision_policy.cleanup_probe),
          })
          .strict()
          .default(defaultLiveOpsConfig.analysis.decision_policy),
      })
      .strict()
      .default(defaultLiveOpsConfig.analysis),
    telegram: z
      .object({
        startup_alert_enabled: z.literal(true).default(defaultLiveOpsConfig.telegram.startup_alert_enabled),
        live_order_capable_alert_enabled: z
          .literal(true)
          .default(defaultLiveOpsConfig.telegram.live_order_capable_alert_enabled),
        trade_event_alerts_enabled: z.literal(true).default(defaultLiveOpsConfig.telegram.trade_event_alerts_enabled),
        provider_timeout_ms: PositiveIntegerSchema.default(defaultLiveOpsConfig.telegram.provider_timeout_ms),
      })
      .strict()
      .default(defaultLiveOpsConfig.telegram),
    tui: z
      .object({
        foreground_enabled: z.literal(true).default(defaultLiveOpsConfig.tui.foreground_enabled),
        attach_enabled: z.literal(true).default(defaultLiveOpsConfig.tui.attach_enabled),
        refresh_interval_ms: PositiveIntegerSchema.max(5_000).default(defaultLiveOpsConfig.tui.refresh_interval_ms),
        control_requires_two_step_confirmation: z
          .literal(true)
          .default(defaultLiveOpsConfig.tui.control_requires_two_step_confirmation),
        controls_enabled: z.boolean().default(defaultLiveOpsConfig.tui.controls_enabled),
      })
      .strict()
      .default(defaultLiveOpsConfig.tui),
  })
  .strict()
  .superRefine((config, context) => {
    validateSingleDefaultMarket(config, context);
    validateBudgetLimits(config, context);
  });

export type LiveOpsConfig = z.infer<typeof LiveOpsConfigSchema>;

/**
 * unknown input을 production live ops 설정으로 해석한다.
 *
 * 반환값은 config/env contract만 보장한다. DB migration, provider credential, market data freshness는 후속 Sub PR의 startup
 * readiness가 별도로 증명해야 하며 이 함수는 외부 side effect를 수행하지 않는다.
 */
export function loadLiveOpsConfig(input: unknown): LiveOpsConfig {
  return LiveOpsConfigSchema.parse(input);
}

function validateSingleDefaultMarket(config: { universe: { markets: string[]; default_market: string } }, context: z.RefinementCtx): void {
  if (config.universe.markets.length !== 1 || config.universe.markets[0] !== LIVE_OPS_DEFAULT_MARKET) {
    // Issue #196의 production 첫 market은 BTC 단일이며 M24 확장 전에는 다중 market이 예산/노출 경계를 흐릴 수 있어 닫는다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["universe", "markets"],
      message: "production live ops first market must be exactly KRW-BTC",
    });
  }

  if (config.universe.default_market !== LIVE_OPS_DEFAULT_MARKET) {
    // 기본 market과 실제 universe가 갈라지면 TUI/Telegram 첫 화면이 주문 가능 종목을 잘못 안내할 수 있다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["universe", "default_market"],
      message: "production live ops default_market must be KRW-BTC",
    });
  }
}

function validateBudgetLimits(
  config: {
    budget: {
      max_order_krw: string;
      daily_autonomous_notional_limit_krw: string;
      max_open_position_notional_krw: string;
      operations_stop_ceiling_krw: string;
    };
  },
  context: z.RefinementCtx,
): void {
  const maxOrder = Number(config.budget.max_order_krw);
  const daily = Number(config.budget.daily_autonomous_notional_limit_krw);
  const open = Number(config.budget.max_open_position_notional_krw);
  const ceiling = Number(config.budget.operations_stop_ceiling_krw);

  if (maxOrder !== 10_000) {
    // Sub PR 01은 기존 M22/M23 승인 예산을 production contract로 고정하고 자동 확대는 후속 issue로 분리한다.
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["budget", "max_order_krw"], message: "max_order_krw must be 10000" });
  }
  if (daily !== 30_000) {
    // 일일 주문 한도 완화는 실거래 노출 증가이므로 #196 foundation에서 허용하지 않는다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budget", "daily_autonomous_notional_limit_krw"],
      message: "daily_autonomous_notional_limit_krw must be 30000",
    });
  }
  if (open !== 30_000) {
    // open exposure 상한은 live order capable 표시와 broker submit guard가 같은 숫자를 보게 고정한다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budget", "max_open_position_notional_krw"],
      message: "max_open_position_notional_krw must be 30000",
    });
  }
  if (ceiling >= 50_000) {
    // 운영 중지 ceiling은 50,000 KRW에 도달하기 전에 멈추기 위한 상한이므로 "미만" 조건을 계약에 둔다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budget", "operations_stop_ceiling_krw"],
      message: "operations_stop_ceiling_krw must be below 50000",
    });
  }
}
