import { Decimal } from "decimal.js";
import type {
  JsonRecord,
  MarketCode,
  OrderIntent,
  PositionRiskSnapshot,
  RiskGateContext,
  RiskGateEvaluation,
} from "../../../domain/index.js";
import { readNonNegativeDecimal } from "./decimal-read.js";
import { fail, pass, withThresholdSnapshot } from "./evaluation-factory.js";
import type { DecimalRead, MarketExposure, ParsedThresholds } from "./types.js";

/**
 * 현재 포지션과 주문 후보 반영 후의 시장별 예상 노출을 기준으로 포지션 한도를 평가한다.
 *
 * 이미 초과한 비대상 시장도 신규 주문으로 숨길 수 없도록 모든 보유 시장을 평가하고, SELL은 실제 보유 노출까지만
 * 차감해 총 노출 한도 우회를 막는다.
 */
export function evaluatePositionExposureLimits(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  orderNotionalBps: Decimal,
): RiskGateEvaluation[] {
  const positionReads = context.positions.map((position) => readPositionBps(position));
  const invalidPositionEvaluations = positionReads.flatMap((read) =>
    read.evaluation === undefined ? [] : [read.evaluation],
  );
  if (invalidPositionEvaluations.length > 0) {
    // 포지션 snapshot이 깨지면 예상 노출을 신뢰할 수 없으므로 한도 평가 대신 수동 검토로 보낸다.
    return invalidPositionEvaluations.map((evaluation) =>
      withThresholdSnapshot(evaluation, context.thresholdSnapshot),
    );
  }

  const targetMarket = context.orderIntent.market;
  const currentExposureByMarket = createCurrentExposureByMarket(positionReads);
  const currentTargetExposureBps = currentExposureByMarket.get(targetMarket) ?? new Decimal(0);
  const candidateExposureDeltaBps = calculateCandidateExposureDeltaBps(
    context.orderIntent.side,
    orderNotionalBps,
    currentTargetExposureBps,
  );
  const projectedTargetExposureBps = clampAtZero(currentTargetExposureBps.plus(candidateExposureDeltaBps));
  const projectedExposures = createProjectedExposures(
    currentExposureByMarket,
    targetMarket,
    projectedTargetExposureBps,
  );

  return [
    ...evaluateBtcEthExposureLimit(context, thresholds, projectedExposures, {
      targetMarket,
      currentTargetExposureBps,
      candidateExposureDeltaBps,
      projectedTargetExposureBps,
    }),
    ...evaluateAltExposureLimits(context, thresholds, projectedExposures, {
      targetMarket,
      currentTargetExposureBps,
      candidateExposureDeltaBps,
      projectedTargetExposureBps,
    }),
  ];
}

/**
 * BTC/ETH 단일 포지션 한도를 모든 예상 시장 노출에 대해 평가한다.
 *
 * target market만 보지 않고 기존 BTC/ETH 보유분도 함께 검사해, 초과 상태에서 다른 시장 주문으로 우회하지 못하게 한다.
 */
function evaluateBtcEthExposureLimit(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  projectedExposures: readonly MarketExposure[],
  target: {
    targetMarket: MarketCode;
    currentTargetExposureBps: Decimal;
    candidateExposureDeltaBps: Decimal;
    projectedTargetExposureBps: Decimal;
  },
): RiskGateEvaluation[] {
  const breaches = projectedExposures.filter(
    (exposure) =>
      isBtcOrEthMarket(exposure.market) &&
      exposure.bpsOfEquity.greaterThan(thresholds.btcEthMaxPositionBpsOfEquity),
  );

  if (breaches.length > 0) {
    // 비대상 BTC/ETH라도 이미 한도를 넘으면 신규 주문을 차단해 복구 우선 순위를 유지한다.
    return [
      withThresholdSnapshot(
        fail("btc_eth_position_limit_exceeded", "BTC/ETH position exposure exceeds the configured limit", "BLOCK_NEW_ORDER", {
          target_market: target.targetMarket,
          current_target_position_bps_of_equity: target.currentTargetExposureBps.toFixed(),
          candidate_exposure_delta_bps_of_equity: target.candidateExposureDeltaBps.toFixed(),
          projected_target_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
          threshold_bps: thresholds.btcEthMaxPositionBpsOfEquity.toFixed(),
          breached_markets: toExposureMetadata(breaches),
        }),
        context.thresholdSnapshot,
      ),
    ];
  }

  if (!isBtcOrEthMarket(target.targetMarket)) {
    return [];
  }

  return [
    withThresholdSnapshot(
      pass("btc_eth_position_limit_clear", "BTC/ETH position exposure is within the configured limit", {
        market: target.targetMarket,
        projected_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
        threshold_bps: thresholds.btcEthMaxPositionBpsOfEquity.toFixed(),
      }),
      context.thresholdSnapshot,
    ),
  ];
}

/**
 * 알트 단일 포지션과 전체 알트 노출 한도를 모든 예상 시장 노출에 대해 평가한다.
 *
 * 전체 알트 합산은 target SELL을 실제 보유분까지만 차감한 예상 노출을 사용해 과도한 SELL notional로 한도를 우회하지
 * 못하게 한다.
 */
function evaluateAltExposureLimits(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  projectedExposures: readonly MarketExposure[],
  target: {
    targetMarket: MarketCode;
    currentTargetExposureBps: Decimal;
    candidateExposureDeltaBps: Decimal;
    projectedTargetExposureBps: Decimal;
  },
): RiskGateEvaluation[] {
  const evaluations: RiskGateEvaluation[] = [];
  const singleAltBreaches = projectedExposures.filter(
    (exposure) =>
      isAltMarket(exposure.market) &&
      exposure.bpsOfEquity.greaterThan(thresholds.altMaxPositionBpsOfEquity),
  );
  const projectedTotalAltExposureBps = projectedExposures.reduce(
    (sum, exposure) => (isAltMarket(exposure.market) ? sum.plus(exposure.bpsOfEquity) : sum),
    new Decimal(0),
  );

  if (singleAltBreaches.length > 0) {
    // 알트 단일 초과는 target 여부와 무관하게 전체 신규 주문 차단 조건으로 취급한다.
    evaluations.push(
      withThresholdSnapshot(
        fail("single_alt_position_limit_exceeded", "Single alt position exposure exceeds the configured limit", "BLOCK_NEW_ORDER", {
          target_market: target.targetMarket,
          current_target_position_bps_of_equity: target.currentTargetExposureBps.toFixed(),
          candidate_exposure_delta_bps_of_equity: target.candidateExposureDeltaBps.toFixed(),
          projected_target_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
          threshold_bps: thresholds.altMaxPositionBpsOfEquity.toFixed(),
          breached_markets: toExposureMetadata(singleAltBreaches),
        }),
        context.thresholdSnapshot,
      ),
    );
  } else if (isAltMarket(target.targetMarket)) {
    evaluations.push(
      withThresholdSnapshot(
        pass("single_alt_position_limit_clear", "Single alt position exposure is within the configured limit", {
          market: target.targetMarket,
          projected_position_bps_of_equity: target.projectedTargetExposureBps.toFixed(),
          threshold_bps: thresholds.altMaxPositionBpsOfEquity.toFixed(),
        }),
        context.thresholdSnapshot,
      ),
    );
  }

  evaluations.push(
    withThresholdSnapshot(
      projectedTotalAltExposureBps.greaterThan(thresholds.totalAltMaxPositionBpsOfEquity)
        ? fail("total_alt_position_limit_exceeded", "Total alt position exposure exceeds the configured limit", "BLOCK_NEW_ORDER", {
            target_market: target.targetMarket,
            projected_total_alt_position_bps_of_equity: projectedTotalAltExposureBps.toFixed(),
            threshold_bps: thresholds.totalAltMaxPositionBpsOfEquity.toFixed(),
          })
        : pass("total_alt_position_limit_clear", "Total alt position exposure is within the configured limit", {
            target_market: target.targetMarket,
            projected_total_alt_position_bps_of_equity: projectedTotalAltExposureBps.toFixed(),
            threshold_bps: thresholds.totalAltMaxPositionBpsOfEquity.toFixed(),
          }),
      context.thresholdSnapshot,
    ),
  );

  return evaluations;
}

function readPositionBps(position: PositionRiskSnapshot): DecimalRead & { market: MarketCode } {
  const metadata: JsonRecord = {
    market: position.market,
  };
  assignIfDefined(metadata, "strategy_id", position.strategyId);
  const read = readNonNegativeDecimal(position.notionalBpsOfEquity, "position.notional_bps_of_equity", {
    reasonCode: "position_notional_bps_invalid",
    message: "Position notional bps must be a non-negative decimal string",
    metadata,
  });

  return {
    ...read,
    market: position.market,
  };
}

/**
 * position snapshot을 시장별 bps 맵으로 합산한다.
 *
 * 같은 market의 여러 전략 포지션이 들어와도 RiskGate 포지션 한도는 market 단위 exposure로 평가한다.
 */
function createCurrentExposureByMarket(
  positionReads: readonly (DecimalRead & { market: MarketCode })[],
): ReadonlyMap<MarketCode, Decimal> {
  const exposures = new Map<MarketCode, Decimal>();

  for (const position of positionReads) {
    if (position.value === undefined) {
      continue;
    }

    exposures.set(position.market, (exposures.get(position.market) ?? new Decimal(0)).plus(position.value));
  }

  return exposures;
}

/**
 * 주문 방향과 현재 target 노출을 기준으로 예상 노출 변화량을 계산한다.
 *
 * BUY는 주문 금액 전체를 더하고, SELL은 현재 보유분보다 더 많이 줄였다고 보지 않는다.
 */
function calculateCandidateExposureDeltaBps(
  side: OrderIntent["side"],
  orderNotionalBps: Decimal,
  currentTargetExposureBps: Decimal,
): Decimal {
  if (side === "BUY") {
    return orderNotionalBps;
  }

  // SELL 주문 금액이 보유분을 초과해도 실제 포지션 감소분은 현재 target 노출로 제한한다.
  return Decimal.min(orderNotionalBps, currentTargetExposureBps).negated();
}

/**
 * 현재 노출 맵에 target 시장의 예상 노출을 반영해 평가용 배열로 변환한다.
 *
 * target이 신규 시장이거나 전량 SELL로 0이 되더라도 pass/fail metadata가 같은 기준을 쓰도록 target 항목은 유지한다.
 */
function createProjectedExposures(
  currentExposureByMarket: ReadonlyMap<MarketCode, Decimal>,
  targetMarket: MarketCode,
  projectedTargetExposureBps: Decimal,
): MarketExposure[] {
  const projectedExposureByMarket = new Map(currentExposureByMarket);

  projectedExposureByMarket.set(targetMarket, projectedTargetExposureBps);

  return [...projectedExposureByMarket.entries()].map(([market, bpsOfEquity]) => ({
    market,
    bpsOfEquity,
  }));
}

function toExposureMetadata(exposures: readonly MarketExposure[]): JsonRecord[] {
  return exposures.map((exposure) => ({
    market: exposure.market,
    bps_of_equity: exposure.bpsOfEquity.toFixed(),
  }));
}

function clampAtZero(value: Decimal): Decimal {
  return value.isNegative() ? new Decimal(0) : value;
}

function isBtcOrEthMarket(market: MarketCode): boolean {
  const baseAsset = getBaseAsset(market);
  return baseAsset === "BTC" || baseAsset === "ETH";
}

function isAltMarket(market: MarketCode): boolean {
  return !isBtcOrEthMarket(market);
}

function getBaseAsset(market: MarketCode): string {
  return market.split("-").at(-1)?.toUpperCase() ?? market.toUpperCase();
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
