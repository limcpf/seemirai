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
  phase15PendingAltMarkets: readonly MarketCode[];
  phase15BlockedAltMarkets: readonly MarketCode[];
  phase15MissingEvidenceAltMarkets: readonly MarketCode[];
  phase15Enabled: boolean;
  evidence: readonly Phase15AltApprovalEvidenceSnapshot[];
}

/**
 * `config.universe`를 runtime policy/rule/cost 경계에서 사용할 수 있는 market 목록으로 해석한다.
 *
 * phase 1.5가 꺼져 있으면 BTC/ETH phase 1만 반환한다. 켜져 있어도 아직 시작되지 않은 승인, 만료된 승인,
 * 승인 이후의 APPROVE evidence가 없거나 차단 evidence가 있는 market은 허용 목록에서 제외해 config diff만으로
 * 신규 진입이 열리지 않게 한다.
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
  const phase15ApprovedAltMarkets: MarketCode[] = [];
  const phase15ExpiredAltMarkets: MarketCode[] = [];
  const phase15PendingAltMarkets: MarketCode[] = [];
  const phase15BlockedAltMarkets: MarketCode[] = [];
  const phase15MissingEvidenceAltMarkets: MarketCode[] = [];

  if (universe.phase_1_5.enabled) {
    for (const approval of universe.phase_1_5.manual_approvals) {
      const approvedAtMs = toTimestampMs(approval.approved_at);
      const isExpired = approval.expires_at !== undefined && toTimestampMs(approval.expires_at) <= observedAtMs;

      if (approvedAtMs > observedAtMs) {
        phase15PendingAltMarkets.push(approval.market);
        continue;
      }

      if (isExpired) {
        phase15ExpiredAltMarkets.push(approval.market);
        continue;
      }

      const latestEvidence = findLatestEvidenceAfterApproval(approval.market, approvedAtMs, observedAtMs, evidence);

      if (latestEvidence === undefined || !matchesManualApprovalEvidence(approval.evidence_id, latestEvidence)) {
        // 수동 config만으로 알트가 열리면 eligibility/audit 누락을 우회하므로 승인 evidence가 없으면 닫아 둔다.
        phase15MissingEvidenceAltMarkets.push(approval.market);
        continue;
      }

      if (isBlockingEvidenceAction(latestEvidence.action)) {
        phase15BlockedAltMarkets.push(approval.market);
        continue;
      }

      if (!isApprovingEvidence(latestEvidence)) {
        // APPROVE가 아니거나 조건 snapshot이 통과하지 않은 evidence는 신규 진입 근거로 쓰지 않는다.
        phase15MissingEvidenceAltMarkets.push(approval.market);
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
    phase15PendingAltMarkets,
    phase15BlockedAltMarkets,
    phase15MissingEvidenceAltMarkets,
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

function findLatestEvidenceAfterApproval(
  market: MarketCode,
  approvedAtMs: number,
  observedAtMs: number,
  evidence: readonly Phase15AltApprovalEvidenceSnapshot[],
): Phase15AltApprovalEvidenceSnapshot | undefined {
  return evidence
    .filter((snapshot) => snapshot.market === market)
    .map((snapshot) => ({
      snapshot,
      observedAtMs: toTimestampMs(snapshot.observedAt),
    }))
    .filter(({ observedAtMs: evidenceObservedAtMs }) => {
      // 승인 이전 또는 미래 evidence는 현재 수동 승인 상태를 덮어쓰면 안 된다.
      return evidenceObservedAtMs >= approvedAtMs && evidenceObservedAtMs <= observedAtMs;
    })
    .sort((left, right) => right.observedAtMs - left.observedAtMs)[0]?.snapshot;
}

function isBlockingEvidenceAction(action: Phase15AltApprovalEvidenceSnapshot["action"]): boolean {
  return action === "REJECT" || action === "REVOKE" || action === "EXPIRE";
}

function isApprovingEvidence(evidence: Phase15AltApprovalEvidenceSnapshot): boolean {
  return evidence.action === "APPROVE" && evidence.conditions.every((condition) => condition.passed);
}

function matchesManualApprovalEvidence(
  manualApprovalEvidenceId: string | undefined,
  evidence: Phase15AltApprovalEvidenceSnapshot,
): boolean {
  return manualApprovalEvidenceId === undefined || evidence.evidenceId === manualApprovalEvidenceId;
}

function toTimestampMs(input: TimestampInput): number {
  const timestamp = input instanceof Date ? input.getTime() : new Date(input).getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid runtime universe timestamp: ${String(input)}`);
  }

  return timestamp;
}
