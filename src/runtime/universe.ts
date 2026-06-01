import type {
  MarketCode,
  Phase15AltApprovalEvidenceSnapshot,
  SafetyBufferMarketCategory,
  TimestampInput,
} from "../domain/index.js";
import type { RuntimeConfig } from "./config.js";

/**
 * runtime universe 해석 결과다.
 *
 * `allowedMarkets`는 policy mapper와 `universe_allowed` rule에 전달할 최종 후보 목록이고,
 * `phase15ApprovedAltMarkets`는 비용 모델이 TOP_ALT safety buffer를 적용할 때 쓰는 subset이다. 이 함수는 config와
 * 현재 시각만 읽는 순수 계산이며, 승인 evidence를 저장하거나 외부 API를 호출하지 않는다.
 */
export interface RuntimeUniverseResolution {
  allowedMarkets: readonly MarketCode[];
  phase1Markets: readonly MarketCode[];
  phase15ApprovedAltMarkets: readonly MarketCode[];
  phase15ExpiredAltMarkets: readonly MarketCode[];
  phase15RejectedAltMarkets: readonly MarketCode[];
  phase15Enabled: boolean;
  evidence: readonly Phase15AltApprovalEvidenceSnapshot[];
}

/**
 * `config.universe`를 runtime policy/rule/cost 경계에서 사용할 수 있는 market 목록으로 해석한다.
 *
 * phase 1.5가 꺼져 있으면 BTC/ETH phase 1만 반환한다. 켜져 있어도 만료된 승인이나 REJECT evidence가 있는 market은
 * 허용 목록에서 제외해 오래된 수동 승인으로 신규 진입이 열리지 않게 한다.
 */
export function resolveRuntimeUniverse(
  universe: RuntimeConfig["universe"],
  options: {
    observedAt: TimestampInput;
    evidence?: readonly Phase15AltApprovalEvidenceSnapshot[];
  },
): RuntimeUniverseResolution {
  const observedAtMs = toTimestampMs(options.observedAt);
  const evidence = options.evidence ?? [];
  const rejectedMarkets = new Set(
    evidence
      .filter((snapshot) => snapshot.action === "REJECT")
      .map((snapshot) => snapshot.market),
  );
  const phase15ApprovedAltMarkets: MarketCode[] = [];
  const phase15ExpiredAltMarkets: MarketCode[] = [];

  if (universe.phase_1_5.enabled) {
    for (const approval of universe.phase_1_5.manual_approvals) {
      const isExpired = approval.expires_at !== undefined && toTimestampMs(approval.expires_at) <= observedAtMs;

      if (isExpired) {
        phase15ExpiredAltMarkets.push(approval.market);
        continue;
      }

      if (rejectedMarkets.has(approval.market)) {
        continue;
      }

      if (!phase15ApprovedAltMarkets.includes(approval.market)) {
        phase15ApprovedAltMarkets.push(approval.market);
      }
    }
  }

  return {
    allowedMarkets: dedupeMarkets([...universe.phase_1, ...phase15ApprovedAltMarkets]),
    phase1Markets: [...universe.phase_1],
    phase15ApprovedAltMarkets,
    phase15ExpiredAltMarkets,
    phase15RejectedAltMarkets: [...rejectedMarkets],
    phase15Enabled: universe.phase_1_5.enabled,
    evidence,
  };
}

/**
 * runtime universe 해석 결과를 비용 모델의 safety buffer market category로 변환한다.
 *
 * phase 1 BTC/ETH는 비용 모델이 market code만으로 10 bps를 해석하므로 여기서는 TOP_ALT만 반환한다.
 */
export function resolveRuntimeSafetyBufferMarketCategory(
  market: MarketCode,
  resolution: Pick<RuntimeUniverseResolution, "phase15ApprovedAltMarkets">,
): SafetyBufferMarketCategory | undefined {
  return resolution.phase15ApprovedAltMarkets.includes(market) ? "TOP_ALT" : undefined;
}

function dedupeMarkets(markets: readonly MarketCode[]): readonly MarketCode[] {
  return [...new Set(markets)];
}

function toTimestampMs(input: TimestampInput): number {
  const timestamp = input instanceof Date ? input.getTime() : new Date(input).getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid runtime universe timestamp: ${String(input)}`);
  }

  return timestamp;
}
