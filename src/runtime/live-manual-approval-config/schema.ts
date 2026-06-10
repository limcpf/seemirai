import { Decimal } from "decimal.js";
import { z } from "zod";
import { LIVE_ARMED_MANUAL_APPROVAL_MODE } from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";

const MarketCodeSchema = z.string().regex(/^KRW-[A-Z0-9]+$/u, "KRW market code is required");
const PositiveDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "must be a non-negative decimal string")
  .refine((value) => parseDecimal(value).gt(0), "must be greater than 0");
const NonNegativeDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "must be a non-negative decimal string");

export const liveManualApprovalDefaultAllowedMarkets = ["KRW-BTC", "KRW-ETH", "KRW-ETC"] as const;

/**
 * M21 수동 승인 live pilot 기본 설정이다.
 *
 * 기본값은 비활성이고, 후속 proposal/approval runtime은 이 설정만으로 broker를 조립하지 않는다. 허용 market과 예산은 보수적
 * 시작값이며 운영자는 config/env 경계에서 더 좁게 줄일 수 있어야 한다.
 */
export const defaultLiveManualApprovalConfig: {
  mode: typeof LIVE_ARMED_MANUAL_APPROVAL_MODE;
  enabled: boolean;
  allowed_markets: string[];
  max_order_krw: string;
  daily_approved_notional_limit_krw: string;
  proposal_ttl_seconds: number;
  max_price_deviation_bps: string;
  require_reconcile_freshness: boolean;
  require_m20_inbound_enabled: boolean;
} = {
  mode: LIVE_ARMED_MANUAL_APPROVAL_MODE,
  enabled: false,
  allowed_markets: [...liveManualApprovalDefaultAllowedMarkets],
  max_order_krw: "10000",
  daily_approved_notional_limit_krw: "30000",
  proposal_ttl_seconds: 300,
  max_price_deviation_bps: "30",
  require_reconcile_freshness: true,
  require_m20_inbound_enabled: true,
};

/**
 * M21 수동 승인 live pilot runtime config schema다.
 *
 * shape와 범위 오류는 load 단계에서 거부하고, enabled 여부와 M20 inbound/reconcile readiness 같은 runtime 상태는 별도 guard에서
 * fail-closed 한다. 이 schema 자체는 외부 API 호출이나 broker 조립 side effect를 만들지 않는다.
 */
export const LiveManualApprovalConfigSchema = z
  .object({
    mode: z.literal(LIVE_ARMED_MANUAL_APPROVAL_MODE).default(LIVE_ARMED_MANUAL_APPROVAL_MODE),
    enabled: z.boolean().default(false),
    allowed_markets: z.array(MarketCodeSchema).min(1).default([...liveManualApprovalDefaultAllowedMarkets]),
    max_order_krw: PositiveDecimalStringSchema.default(defaultLiveManualApprovalConfig.max_order_krw),
    daily_approved_notional_limit_krw: PositiveDecimalStringSchema.default(
      defaultLiveManualApprovalConfig.daily_approved_notional_limit_krw,
    ),
    proposal_ttl_seconds: z.number().int().positive().default(defaultLiveManualApprovalConfig.proposal_ttl_seconds),
    max_price_deviation_bps: NonNegativeDecimalStringSchema.default(
      defaultLiveManualApprovalConfig.max_price_deviation_bps,
    ),
    require_reconcile_freshness: z.boolean().default(defaultLiveManualApprovalConfig.require_reconcile_freshness),
    require_m20_inbound_enabled: z.boolean().default(defaultLiveManualApprovalConfig.require_m20_inbound_enabled),
  })
  .default(defaultLiveManualApprovalConfig)
  .superRefine((config, context) => {
    validateUniqueMarkets(config.allowed_markets, context);
    validateOrderBudget(config.max_order_krw, config.daily_approved_notional_limit_krw, context);
  });

/**
 * M21 수동 승인 live pilot runtime 설정이다.
 *
 * 이 값은 proposal 생성/승인/제출 runtime이 읽는 입력일 뿐이며, `enabled=true`라도 `assertLiveManualApprovalRuntimeReady`가
 * M20 inbound와 reconcile freshness를 다시 확인하기 전에는 broker 호출을 허용하지 않는 invariant를 유지한다.
 */
export type LiveManualApprovalRuntimeConfig = z.infer<typeof LiveManualApprovalConfigSchema>;

function validateUniqueMarkets(markets: readonly string[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const market of markets) {
    if (seen.has(market)) {
      // 중복 allowlist는 예산/리스크 계산을 모호하게 만들어 approval runtime 진입 전에 닫는다.
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

function validateOrderBudget(
  maxOrderKrw: string,
  dailyApprovedNotionalLimitKrw: string,
  context: z.RefinementCtx,
): void {
  const maxOrder = parseDecimal(maxOrderKrw);
  const dailyLimit = parseDecimal(dailyApprovedNotionalLimitKrw);

  if (maxOrder.lt(5_000)) {
    // Upbit KRW 현물 최소 주문금액보다 낮은 proposal은 승인되어도 제출 직전에 실패하므로 설정 단계에서 차단한다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_order_krw"],
      message: "max_order_krw must be at least 5000",
    });
  }

  if (dailyLimit.lt(maxOrder)) {
    // 일일 승인 예산이 1회 주문 상한보다 작으면 첫 승인부터 항상 실패하므로 운영 설정 오류로 본다.
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["daily_approved_notional_limit_krw"],
      message: "daily_approved_notional_limit_krw must be greater than or equal to max_order_krw",
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
