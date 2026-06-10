import { Decimal } from "decimal.js";
import { z } from "zod";
import { LIVE_AUTONOMOUS_SMALL_BUDGET_MODE } from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";

const UPBIT_IDENTIFIER_MAX_LENGTH = 64;
export const LIVE_AUTONOMOUS_IDENTIFIER_MAX_LENGTH = 32;
export const LIVE_AUTONOMOUS_IDENTIFIER_RANDOM_HEX_LENGTH = 26;
export const LIVE_AUTONOMOUS_MAX_ORDER_KRW_LIMIT = 10_000;
export const LIVE_AUTONOMOUS_DAILY_NOTIONAL_KRW_LIMIT = 30_000;
export const LIVE_AUTONOMOUS_OPEN_POSITION_NOTIONAL_KRW_LIMIT = 30_000;

const MarketCodeSchema = z.string().regex(/^KRW-[A-Z0-9]+$/u, "KRW market code is required");
const PositiveDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "must be a non-negative decimal string")
  .refine((value) => parseDecimal(value).gt(0), "must be greater than 0");
const NonNegativeDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "must be a non-negative decimal string");
const IdentifierPrefixSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/u, "identifier_prefix must use lowercase ascii letters, digits, or hyphen")
  .min(1);

export const liveAutonomousDefaultAllowedMarkets = ["KRW-BTC"] as const;

/**
 * M22 제한적 완전 자동매매 기본 설정이다.
 *
 * 기본값은 비활성이며, `enabled=true`라도 readiness guard가 operator arm, 예산, key scope, M21 1주 gate, M20/M16/M17/M18/M19
 * readiness evidence를 모두 확인하기 전에는 private client나 live broker가 조립되지 않아야 한다. 이 객체는 설정 contract만
 * 제공하고 외부 API 호출 side effect를 만들지 않는다.
 */
export const defaultLiveAutonomousConfig: {
  mode: typeof LIVE_AUTONOMOUS_SMALL_BUDGET_MODE;
  enabled: boolean;
  allowed_markets: string[];
  max_order_krw: string;
  daily_autonomous_notional_limit_krw: string;
  max_open_position_notional_krw: string;
  max_daily_loss_krw: string;
  max_weekly_loss_krw: string;
  max_price_deviation_bps: string;
  require_m21_week_gate_evidence: true;
  require_m20_inbound_readiness: true;
  require_reconcile_freshness: true;
  require_pnl_status_ready: true;
  require_decision_ledger_ready: true;
  require_exit_engine_ready: true;
  require_operator_arm_evidence_id: true;
  require_budget_evidence_id: true;
  require_key_scope_evidence_id: true;
  identifier_prefix: string;
  identifier_max_length: number;
} = {
  mode: LIVE_AUTONOMOUS_SMALL_BUDGET_MODE,
  enabled: false,
  allowed_markets: [...liveAutonomousDefaultAllowedMarkets],
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
  identifier_max_length: LIVE_AUTONOMOUS_IDENTIFIER_MAX_LENGTH,
};

/**
 * M22 제한적 완전 자동매매 runtime config schema다.
 *
 * shape, 예산 상한, readiness guard opt-out, identifier 보수 제한을 load 단계에서 검증한다. 실제 evidence 존재 여부와 broker 조립
 * 여부는 후속 startup guard가 fail-closed로 판단하며, 이 schema는 입력 검증 외 side effect를 갖지 않는다.
 */
export const LiveAutonomousConfigSchema = z
  .object({
    mode: z.literal(LIVE_AUTONOMOUS_SMALL_BUDGET_MODE).default(LIVE_AUTONOMOUS_SMALL_BUDGET_MODE),
    enabled: z.boolean().default(false),
    allowed_markets: z.array(MarketCodeSchema).min(1).default([...liveAutonomousDefaultAllowedMarkets]),
    max_order_krw: PositiveDecimalStringSchema.default(defaultLiveAutonomousConfig.max_order_krw),
    daily_autonomous_notional_limit_krw: PositiveDecimalStringSchema.default(
      defaultLiveAutonomousConfig.daily_autonomous_notional_limit_krw,
    ),
    max_open_position_notional_krw: PositiveDecimalStringSchema.default(
      defaultLiveAutonomousConfig.max_open_position_notional_krw,
    ),
    max_daily_loss_krw: PositiveDecimalStringSchema.default(defaultLiveAutonomousConfig.max_daily_loss_krw),
    max_weekly_loss_krw: PositiveDecimalStringSchema.default(defaultLiveAutonomousConfig.max_weekly_loss_krw),
    max_price_deviation_bps: NonNegativeDecimalStringSchema.default(defaultLiveAutonomousConfig.max_price_deviation_bps),
    require_m21_week_gate_evidence: z
      .literal(true)
      .default(defaultLiveAutonomousConfig.require_m21_week_gate_evidence),
    require_m20_inbound_readiness: z
      .literal(true)
      .default(defaultLiveAutonomousConfig.require_m20_inbound_readiness),
    require_reconcile_freshness: z.literal(true).default(defaultLiveAutonomousConfig.require_reconcile_freshness),
    require_pnl_status_ready: z.literal(true).default(defaultLiveAutonomousConfig.require_pnl_status_ready),
    require_decision_ledger_ready: z.literal(true).default(defaultLiveAutonomousConfig.require_decision_ledger_ready),
    require_exit_engine_ready: z.literal(true).default(defaultLiveAutonomousConfig.require_exit_engine_ready),
    require_operator_arm_evidence_id: z
      .literal(true)
      .default(defaultLiveAutonomousConfig.require_operator_arm_evidence_id),
    require_budget_evidence_id: z.literal(true).default(defaultLiveAutonomousConfig.require_budget_evidence_id),
    require_key_scope_evidence_id: z
      .literal(true)
      .default(defaultLiveAutonomousConfig.require_key_scope_evidence_id),
    identifier_prefix: IdentifierPrefixSchema.default(defaultLiveAutonomousConfig.identifier_prefix),
    identifier_max_length: z
      .number()
      .int()
      .positive()
      .max(UPBIT_IDENTIFIER_MAX_LENGTH)
      .default(defaultLiveAutonomousConfig.identifier_max_length),
  })
  .strict()
  .default(defaultLiveAutonomousConfig)
  .superRefine((config, context) => {
    validateUniqueMarkets(config.allowed_markets, context);
    validateBudgets(config, context);
    validateIdentifierPolicy(config.identifier_prefix, config.identifier_max_length, context);
  });

/**
 * M22 제한적 완전 자동매매 runtime 설정이다.
 *
 * 이 값은 startup guard와 autonomous order runtime의 입력일 뿐이다. `enabled=true`라도 필수 readiness/evidence가 없으면 live broker
 * 조립 전 fail-closed 해야 하며, 기본 `PAPER_NO_KEY` runtime은 이 설정을 읽는 것만으로 live order API를 호출하지 않는다.
 */
export type LiveAutonomousRuntimeConfig = z.infer<typeof LiveAutonomousConfigSchema>;

function validateUniqueMarkets(markets: readonly string[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const market of markets) {
    if (seen.has(market)) {
      // 중복 market은 budget/exposure 집계를 이중 계산하게 만들 수 있어 startup 이전 config 단계에서 닫는다.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_markets"],
        message: "allowed_markets must not contain duplicates",
      });
      return;
    }
    seen.add(market);
  }
}

function validateBudgets(
  config: {
    max_order_krw: string;
    daily_autonomous_notional_limit_krw: string;
    max_open_position_notional_krw: string;
    max_daily_loss_krw: string;
    max_weekly_loss_krw: string;
  },
  context: z.RefinementCtx,
): void {
  const maxOrder = parseDecimal(config.max_order_krw);
  const dailyLimit = parseDecimal(config.daily_autonomous_notional_limit_krw);
  const maxOpenPosition = parseDecimal(config.max_open_position_notional_krw);
  const maxDailyLoss = parseDecimal(config.max_daily_loss_krw);
  const maxWeeklyLoss = parseDecimal(config.max_weekly_loss_krw);

  if (maxOrder.lt(5_000)) {
    // Upbit KRW 최소 주문금액보다 낮은 자동 주문 상한은 모든 후보를 제출 직전 실패시키므로 설정 단계에서 차단한다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_order_krw"],
      message: "max_order_krw must be at least 5000",
    });
  }

  if (maxOrder.gt(LIVE_AUTONOMOUS_MAX_ORDER_KRW_LIMIT)) {
    // M22는 소액 자동매매 pilot이므로 단일 주문 상한을 기본 운영 승인값보다 크게 열지 않는다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_order_krw"],
      message: "max_order_krw must not exceed 10000 for M22",
    });
  }

  if (dailyLimit.lt(maxOrder)) {
    // 일일 자동 예산이 단일 주문 상한보다 작으면 첫 주문부터 항상 실패하므로 운영 설정 오류로 본다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["daily_autonomous_notional_limit_krw"],
      message: "daily_autonomous_notional_limit_krw must be greater than or equal to max_order_krw",
    });
  }

  if (dailyLimit.gt(LIVE_AUTONOMOUS_DAILY_NOTIONAL_KRW_LIMIT)) {
    // 일일 자동 주문 notional은 M21 기본 예산을 넘기지 않아야 소액 pilot 경계가 유지된다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["daily_autonomous_notional_limit_krw"],
      message: "daily_autonomous_notional_limit_krw must not exceed 30000 for M22",
    });
  }

  if (maxOpenPosition.lt(maxOrder)) {
    // open position 상한이 단일 주문보다 작으면 reservation 이후 position exposure가 즉시 깨지므로 미리 닫는다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_open_position_notional_krw"],
      message: "max_open_position_notional_krw must be greater than or equal to max_order_krw",
    });
  }

  if (maxOpenPosition.gt(LIVE_AUTONOMOUS_OPEN_POSITION_NOTIONAL_KRW_LIMIT)) {
    // open position 상한이 일일 소액 예산을 넘으면 자동 누적 노출을 제한하려는 M22 목적이 깨진다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_open_position_notional_krw"],
      message: "max_open_position_notional_krw must not exceed 30000 for M22",
    });
  }

  if (maxWeeklyLoss.lt(maxDailyLoss)) {
    // 주간 손실 한도가 일간 손실 한도보다 작으면 같은 손실 event의 해석이 모호해져 risk guard 이전에 거부한다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_weekly_loss_krw"],
      message: "max_weekly_loss_krw must be greater than or equal to max_daily_loss_krw",
    });
  }
}

function validateIdentifierPolicy(prefix: string, maxLength: number, context: z.RefinementCtx): void {
  if (maxLength > LIVE_AUTONOMOUS_IDENTIFIER_MAX_LENGTH) {
    // Upbit 공식 한도는 64자지만 M22는 기존 운영 evidence와 source scan 편의를 위해 32자 보수 제한을 유지한다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identifier_max_length"],
      message: "identifier_max_length must not exceed 32 for M22",
    });
  }

  if (prefix.length + LIVE_AUTONOMOUS_IDENTIFIER_RANDOM_HEX_LENGTH > maxLength) {
    // 랜덤 hex 여유가 없으면 timestamp-only나 단순 증가값으로 후퇴할 위험이 있어 identifier 정책을 config 단계에서 닫는다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identifier_prefix"],
      message: "identifier_prefix leaves no room for 13 random bytes hex suffix",
    });
  }
}

function parseDecimal(value: string): Decimal {
  try {
    return parseFinancialDecimal(value);
  } catch {
    return new Decimal(Number.NaN);
  }
}
