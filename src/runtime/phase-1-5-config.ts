import { z } from "zod";
import { parseFinancialDecimal } from "../shared/index.js";

const Phase15MarketCodeSchema = z.string().regex(/^KRW-[A-Z0-9]+$/u, "KRW market code is required");
const Phase15AltMarketCodeSchema = Phase15MarketCodeSchema.refine(
  (market) => market !== "KRW-BTC" && market !== "KRW-ETH",
  {
    message: "phase 1.5 alt market must not include KRW-BTC or KRW-ETH",
  },
);
const NonNegativeDecimalStringSchema = z.string().refine((value) => isValidNonNegativeDecimal(value), {
  message: "must be a non-negative decimal string",
});
const IsoTimestampStringSchema = z.string().datetime({ offset: true });
const PositiveIntegerSchema = z.number().int().positive();

/**
 * phase 1.5 알트 편입 조건 threshold schema다.
 *
 * config 로딩 경계에서 유동성/상장/스프레드/슬리피지/depth 기준을 Decimal-safe 값으로 검증해 evaluator가
 * 불명확한 threshold를 보정하지 않게 한다.
 */
export const Phase15AltEligibilityThresholdConfigSchema = z
  .object({
    min_listing_age_days: PositiveIntegerSchema.default(90),
    min_30d_avg_trade_value_krw: NonNegativeDecimalStringSchema.default("10000000000"),
    max_7d_spread_p95_bps: NonNegativeDecimalStringSchema.default("15"),
    max_expected_slippage_bps: NonNegativeDecimalStringSchema.default("20"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("100000000"),
  })
  .strict();

/**
 * operator가 승인한 phase 1.5 알트 market의 config schema다.
 *
 * 승인 목록은 수동으로만 채워지며, evidence id와 승인/만료 시각은 후속 audit/reporting이 같은 결정을 재현하는 연결점이다.
 */
export const Phase15ManualAltApprovalConfigSchema = z
  .object({
    market: Phase15AltMarketCodeSchema,
    approved_at: IsoTimestampStringSchema,
    approved_by: z.string().trim().min(1).optional(),
    evidence_id: z.string().trim().min(1).optional(),
    expires_at: IsoTimestampStringSchema.optional(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (approval.expires_at === undefined) {
      return;
    }

    // 만료가 승인보다 앞서면 stale 승인 상태가 config 로딩을 통과하므로 시작 단계에서 차단한다.
    if (new Date(approval.expires_at).getTime() <= new Date(approval.approved_at).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at"],
        message: "expires_at must be after approved_at",
      });
    }
  });

export const defaultPhase15AltUniverseConfig: {
  enabled: boolean;
  candidate_markets: string[];
  manual_approvals: Array<z.infer<typeof Phase15ManualAltApprovalConfigSchema>>;
  max_manual_approvals: 3;
  thresholds: z.input<typeof Phase15AltEligibilityThresholdConfigSchema>;
} = {
  enabled: false,
  candidate_markets: [],
  manual_approvals: [],
  max_manual_approvals: 3,
  thresholds: {
    min_listing_age_days: 90,
    min_30d_avg_trade_value_krw: "10000000000",
    max_7d_spread_p95_bps: "15",
    max_expected_slippage_bps: "20",
    min_depth_krw: "100000000",
  },
};

/**
 * `config/paper.json`의 `universe.phase_1_5` schema다.
 *
 * 기본값은 비활성/빈 승인 목록이므로 phase 1 BTC/ETH paper runtime 동작을 유지한다. 수동 승인 목록은 최대 3개와
 * 중복 금지 invariant를 config 로딩 시점에 검증한다.
 */
export const Phase15AltUniverseConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    candidate_markets: z.array(Phase15AltMarketCodeSchema).default([]),
    manual_approvals: z.array(Phase15ManualAltApprovalConfigSchema).max(3).default([]),
    max_manual_approvals: z.literal(3).default(3),
    thresholds: Phase15AltEligibilityThresholdConfigSchema.default(defaultPhase15AltUniverseConfig.thresholds),
  })
  .strict()
  .superRefine((config, context) => {
    addDuplicateMarketIssue("candidate_markets", config.candidate_markets, context);
    addDuplicateMarketIssue(
      "manual_approvals",
      config.manual_approvals.map((approval) => approval.market),
      context,
    );

    if (config.manual_approvals.length > config.max_manual_approvals) {
      // literal 3과 max(3)을 모두 유지해 schema 변경 시에도 승인 상한 초과가 조용히 통과하지 않게 한다.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manual_approvals"],
        message: "manual approvals must not exceed max_manual_approvals",
      });
    }
  })
  .default(defaultPhase15AltUniverseConfig);

export type Phase15AltEligibilityThresholdConfig = z.infer<typeof Phase15AltEligibilityThresholdConfigSchema>;
export type Phase15ManualAltApprovalRuntimeConfig = z.infer<typeof Phase15ManualAltApprovalConfigSchema>;
export type Phase15AltUniverseRuntimeConfig = z.infer<typeof Phase15AltUniverseConfigSchema>;

function isValidNonNegativeDecimal(value: string): boolean {
  try {
    // 유동성 threshold가 음수면 모든 후보를 통과시키는 설정 오류가 되므로 로딩 단계에서 차단한다.
    return !parseFinancialDecimal(value).isNegative();
  } catch {
    return false;
  }
}

function addDuplicateMarketIssue(
  path: string,
  markets: readonly string[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();

  for (const market of markets) {
    if (seen.has(market)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `${path} must not contain duplicate markets`,
      });
      return;
    }

    seen.add(market);
  }
}
