import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  ExitIntention,
  ExitRule,
  ExitRuleContext,
  ExitRuleEvaluation,
  ExitStrategySignal,
  TimestampInput,
} from "../../domain/index.js";

// ---------------------------------------------------------------------------
// Exit rule factory 함수
// ---------------------------------------------------------------------------

/**
 * 손절 exit rule 옵션이다.
 */
export interface StopLossExitRuleOptions {
  /** 손절 threshold (bps). 양수로 입력하며 평가 시 음수로 변환한다. */
  stopLossBps: string;
}

/**
 * 익절 exit rule 옵션이다.
 */
export interface TakeProfitExitRuleOptions {
  /** 익절 threshold (bps) */
  takeProfitBps: string;
}

/**
 * trailing stop exit rule 옵션이다.
 */
export interface TrailingStopExitRuleOptions {
  /** trailing 간격 기본값 (bps). ExitTrailingState.trailBps가 우선한다. */
  defaultTrailBps: string;
}

// ---------------------------------------------------------------------------
// Factory implementations
// ---------------------------------------------------------------------------

/**
 * 손절 exit rule을 생성한다.
 *
 * unrealized PnL이 손절 threshold 이하이면(더 큰 손실이면) EXIT 의도로 TRIGGERED를 반환한다.
 * unrealized_pnl_bps feature가 없거나 유효하지 않으면 UNAVAILABLE을 반환해
 * trigger 미충족과 평가 불가를 trace에서 구분한다.
 */
export function createStopLossExitRule(options: StopLossExitRuleOptions): ExitRule {
  const stopLossBps = parseRuleDecimal(options.stopLossBps, "stop_loss_bps");

  return {
    id: "stop_loss_exit",
    evaluate: (context) => {
      const unrealized = parseDecimal(context.position.unrealizedPnlBps);

      // 결측 또는 invalid unrealizedPnlBps는 PASS가 아닌 UNAVAILABLE로 분리해
      // "trigger되지 않음"과 "평가 불가"를 blockedRules/trace에서 구분한다.
      if (unrealized === undefined) {
        return unavailable("stop_loss_exit", "stop_loss_unavailable", "미실현 손익 정보가 없어 손절 평가를 수행할 수 없습니다.");
      }

      const threshold = stopLossBps.negated();

      // unrealized PnL이 손절 threshold 이하이면(음수 방향으로 더 크면) trigger
      if (unrealized.lessThanOrEqualTo(threshold)) {
        return triggered(
          "stop_loss_exit",
          "stop_loss_triggered",
          "손절 기준에 도달했습니다.",
          "EXIT",
          {
            unrealized_pnl_bps: unrealized.toFixed(),
            stop_loss_bps: stopLossBps.toFixed(),
          },
        );
      }

      return pass("stop_loss_exit", "stop_loss_clear", "손절 기준에 도달하지 않았습니다.");
    },
  };
}

/**
 * 익절 exit rule을 생성한다.
 *
 * unrealized PnL이 익절 threshold 이상이면 EXIT 의도로 TRIGGERED를 반환한다.
 * unrealized_pnl_bps feature가 없거나 유효하지 않으면 UNAVAILABLE을 반환해
 * trigger 미충족과 평가 불가를 trace에서 구분한다.
 */
export function createTakeProfitExitRule(options: TakeProfitExitRuleOptions): ExitRule {
  const takeProfitBps = parseRuleDecimal(options.takeProfitBps, "take_profit_bps");

  return {
    id: "take_profit_exit",
    evaluate: (context) => {
      const unrealized = parseDecimal(context.position.unrealizedPnlBps);

      // 결측 또는 invalid unrealizedPnlBps는 PASS가 아닌 UNAVAILABLE로 분리해
      // "trigger되지 않음"과 "평가 불가"를 blockedRules/trace에서 구분한다.
      if (unrealized === undefined) {
        return unavailable("take_profit_exit", "take_profit_unavailable", "미실현 손익 정보가 없어 익절 평가를 수행할 수 없습니다.");
      }

      if (unrealized.greaterThanOrEqualTo(takeProfitBps)) {
        return triggered(
          "take_profit_exit",
          "take_profit_triggered",
          "익절 기준에 도달했습니다.",
          "EXIT",
          {
            unrealized_pnl_bps: unrealized.toFixed(),
            take_profit_bps: takeProfitBps.toFixed(),
          },
        );
      }

      return pass("take_profit_exit", "take_profit_clear", "익절 기준에 도달하지 않았습니다.");
    },
  };
}

/**
 * trailing stop exit rule을 생성한다.
 *
 * ExitTrailingState snapshot이 없으면 추정하지 않고 UNAVAILABLE을 반환한다.
 * 현재가가 anchorPrice에서 trailBps 이상 하락했으면 EXIT 의도로 TRIGGERED를 반환한다.
 */
export function createTrailingStopExitRule(options: TrailingStopExitRuleOptions): ExitRule {
  const defaultTrailBps = parseRuleDecimal(options.defaultTrailBps, "default_trail_bps");

  return {
    id: "trailing_stop_exit",
    evaluate: (context) => {
      // trailing state snapshot이 없으면 임의 보정 없이 UNAVAILABLE로 닫는다.
      if (context.trailingState === undefined) {
        return unavailable(
          "trailing_stop_exit",
          "trailing_state_missing",
          "trailing stop 기준가 snapshot이 없어 평가할 수 없습니다. 임의 추정은 하지 않습니다.",
        );
      }

      const anchorPrice = parseDecimal(context.trailingState.anchorPrice);
      const currentPrice = parseDecimal(context.position.currentPrice);

      // trailBps: 명시적 미설정(빈 문자열)인 경우만 default를 사용한다.
      // invalid 값(예: "abc", "-100")은 조용히 default로 대체하지 않고 BLOCKED로 차단한다.
      const trailBpsRaw = context.trailingState.trailBps;
      let trailBps: Decimal;
      if (trailBpsRaw === "" || trailBpsRaw === undefined) {
        trailBps = defaultTrailBps;
      } else {
        const parsed = parseDecimal(trailBpsRaw);
        if (parsed === undefined || parsed.lessThanOrEqualTo(0)) {
          return blocked(
            "trailing_stop_exit",
            "trailing_trail_bps_invalid",
            "trailing stop의 trailBps가 유효하지 않습니다. 0보다 큰 숫자여야 합니다.",
          );
        }
        trailBps = parsed;
      }

      // anchorPrice와 currentPrice는 undefined이거나 finite positive가 아니면 차단한다.
      // anchorPrice가 0이면 하락률 계산 시 NaN/Infinity evidence가 생기므로 사전 차단한다.
      // decimal.js에서 isPositive()는 0도 true로 평가하므로 greaterThan(0)으로 엄격히 검증한다.
      if (
        anchorPrice === undefined ||
        !anchorPrice.isFinite() ||
        !anchorPrice.greaterThan(0)
      ) {
        return blocked(
          "trailing_stop_exit",
          "trailing_anchor_invalid",
          "trailing stop 기준가(anchorPrice)가 유효하지 않습니다. 유한한 양수여야 합니다.",
        );
      }

      if (
        currentPrice === undefined ||
        !currentPrice.isFinite() ||
        !currentPrice.greaterThan(0)
      ) {
        return blocked(
          "trailing_stop_exit",
          "trailing_price_invalid",
          "trailing stop 평가에 필요한 현재가(currentPrice)가 유효하지 않습니다. 유한한 양수여야 합니다.",
        );
      }

      const anchorObservedAt = new Date(context.trailingState.anchorObservedAt);
      // anchor 관측시각이 깨진 snapshot은 stale/corrupt trailing state일 수 있으므로 SELL 후보 생성을 차단한다.
      if (isNaN(anchorObservedAt.getTime())) {
        return blocked(
          "trailing_stop_exit",
          "trailing_anchor_observed_at_invalid",
          "trailing stop 기준가(anchorPrice)의 관측 시각이 유효하지 않습니다.",
        );
      }

      // anchorPrice 대비 현재가 하락 비율 (bps) 계산
      // 하락 = (anchor - current) / anchor * 10000
      const dropBps = anchorPrice
        .minus(currentPrice)
        .div(anchorPrice)
        .mul(10000);

      if (dropBps.greaterThanOrEqualTo(trailBps)) {
        return triggered(
          "trailing_stop_exit",
          "trailing_stop_triggered",
          "trailing stop 기준에 도달했습니다.",
          "EXIT",
          {
            anchor_price: anchorPrice.toFixed(),
            current_price: currentPrice.toFixed(),
            drop_bps: dropBps.toFixed(),
            trail_bps: trailBps.toFixed(),
            anchor_observed_at: anchorObservedAt.toISOString(),
          },
        );
      }

      return pass("trailing_stop_exit", "trailing_stop_clear", "trailing stop 기준에 도달하지 않았습니다.", {
        anchor_price: anchorPrice.toFixed(),
        current_price: currentPrice.toFixed(),
        drop_bps: dropBps.toFixed(),
        trail_bps: trailBps.toFixed(),
      });
    },
  };
}

/**
 * 시간 기반 청산 exit rule을 생성한다.
 *
 * ExitTimeBasedConfig의 deadline이 현재 observedAt을 지났으면 EXIT 의도로 TRIGGERED를 반환한다.
 * ExitTimeBasedConfig가 없으면 PASS를 반환한다.
 */
export function createTimeBasedExitRule(): ExitRule {
  return {
    id: "time_based_exit",
    evaluate: (context) => {
      if (context.timeBasedConfig === undefined) {
        return pass("time_based_exit", "time_based_not_configured", "시간 기반 청산 설정이 없어 평가를 건너뜁니다.");
      }

      const deadline = parseDeadlineTimestamp(
        context.timeBasedConfig.deadline,
        context.timeBasedConfig.timezone,
      );
      const observedAt = new Date(context.observedAt);

      // 관측 시각이 유효하지 않으면 deadline 비교 자체가 불가능하므로 BLOCKED로 차단한다.
      if (isNaN(observedAt.getTime())) {
        return blocked(
          "time_based_exit",
          "time_based_observed_at_invalid",
          "시간 기반 청산 평가에 필요한 관측 시각이 유효하지 않습니다.",
        );
      }

      if (isNaN(deadline.getTime())) {
        return blocked(
          "time_based_exit",
          "time_based_deadline_invalid",
          "시간 기반 청산 deadline이 유효하지 않습니다.",
        );
      }

      if (observedAt >= deadline) {
        return triggered(
          "time_based_exit",
          "time_based_triggered",
          "시간 기반 청산 deadline이 지났습니다.",
          "EXIT",
          {
            deadline: context.timeBasedConfig.deadline,
            timezone: context.timeBasedConfig.timezone,
            observed_at: String(context.observedAt),
          },
        );
      }

      return pass("time_based_exit", "time_based_not_reached", "시간 기반 청산 deadline에 도달하지 않았습니다.");
    },
  };
}

/**
 * 전략 exit signal을 평가하는 exit rule을 생성한다.
 *
 * ExitStrategySignal이 있고 intention이 EXIT 또는 REDUCE면 해당 의도로 TRIGGERED를 반환한다.
 * signal이 없으면 PASS를 반환한다.
 */
export function createStrategyExitSignalRule(): ExitRule {
  return {
    id: "strategy_exit_signal",
    evaluate: (context) => {
      if (context.strategyExitSignal === undefined) {
        return pass(
          "strategy_exit_signal",
          "strategy_exit_no_signal",
          "전략 exit signal이 없어 평가를 건너뜁니다.",
        );
      }

      const signal = context.strategyExitSignal;

      // 다른 exchange/market/strategy scope의 signal을 현재 포지션 exit로 승격하면 잘못된 SELL 후보가 만들어진다.
      if (!matchesCurrentSignalScope(signal, context)) {
        return blocked(
          "strategy_exit_signal",
          "strategy_exit_scope_mismatch",
          "전략 exit signal의 scope가 현재 포지션과 일치하지 않아 청산 판단을 차단합니다.",
          {
            signal_exchange_id: signal.exchangeId,
            context_exchange_id: context.exchangeId,
            signal_market: signal.market,
            context_market: context.market,
            signal_strategy_id: signal.strategyId,
            context_strategy_id: context.strategyId,
            position_strategy_id: context.position.strategyId ?? "",
          },
        );
      }

      return triggered(
        "strategy_exit_signal",
        signal.reasonCode,
        signal.reason,
        signal.intention,
        {
          signal_exchange_id: signal.exchangeId,
          signal_market: signal.market,
          signal_strategy_id: signal.strategyId,
          signal_intention: signal.intention,
          signal_observed_at: String(signal.observedAt),
        },
      );
    },
  };
}

/**
 * 리스크 기반 축소 exit rule을 생성한다.
 *
 * ExitRiskReductionSignal이 있으면 REDUCE 또는 EXIT 의도로 TRIGGERED를 반환한다.
 * signal이 없으면 PASS를 반환한다.
 *
 * 수량 축소 비율(reductionRatio)은 ExitSizing 단계에서 position scope 검증과 함께 적용된다.
 */
export function createRiskReductionExitRule(): ExitRule {
  return {
    id: "risk_reduction_exit",
    evaluate: (context) => {
      if (context.riskReductionSignal === undefined) {
        return pass(
          "risk_reduction_exit",
          "risk_reduction_no_signal",
          "리스크 축소 신호가 없어 평가를 건너뜁니다.",
        );
      }

      const signal = context.riskReductionSignal;
      const reductionRatio = parseDecimal(signal.reductionRatio);

      // risk signal이 잘못된 축소 비율을 들고 오면 후속 sizing이 invalid SELL 수량을 만들 수 있어 여기서 차단한다.
      if (
        reductionRatio === undefined ||
        reductionRatio.lessThanOrEqualTo(0) ||
        reductionRatio.greaterThan(1)
      ) {
        return blocked(
          "risk_reduction_exit",
          "risk_reduction_ratio_invalid",
          "리스크 축소 신호의 reductionRatio가 유효하지 않습니다. 0보다 크고 1 이하인 숫자여야 합니다.",
          {
            reduction_ratio: signal.reductionRatio,
          },
        );
      }

      if (!matchesReductionRatioWithIntention(reductionRatio, signal.intention)) {
        return blocked(
          "risk_reduction_exit",
          "risk_reduction_ratio_intention_mismatch",
          "리스크 축소 신호의 intention과 reductionRatio가 일치하지 않아 청산 판단을 차단합니다.",
          {
            reduction_ratio: reductionRatio.toFixed(),
            signal_intention: signal.intention,
          },
        );
      }

      return triggered(
        "risk_reduction_exit",
        signal.reasonCode,
        signal.reason,
        signal.intention,
        {
          reduction_ratio: reductionRatio.toFixed(),
          signal_intention: signal.intention,
          signal_observed_at: String(signal.observedAt),
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 기본 exit rule set factory
// ---------------------------------------------------------------------------

export interface DefaultExitRulesOptions {
  stopLossBps: string;
  takeProfitBps: string;
  defaultTrailBps: string;
}

/**
 * Sub PR 01 기본 exit rule 조합을 생성한다.
 *
 * 손절, 익절, trailing stop, 시간 기반 청산, 전략 exit signal, 리스크 기반 축소 규칙을
 * 모두 포함한다.
 */
export function createDefaultExitRules(options: DefaultExitRulesOptions): readonly ExitRule[] {
  return [
    createStopLossExitRule({ stopLossBps: options.stopLossBps }),
    createTakeProfitExitRule({ takeProfitBps: options.takeProfitBps }),
    createTrailingStopExitRule({ defaultTrailBps: options.defaultTrailBps }),
    createTimeBasedExitRule(),
    createStrategyExitSignalRule(),
    createRiskReductionExitRule(),
  ];
}

// ---------------------------------------------------------------------------
// 내부 helper
// ---------------------------------------------------------------------------

function parseRuleDecimal(value: string, fieldName: string): Decimal {
  const decimal = parseFinancialDecimal(value);

  if (decimal.lessThanOrEqualTo(0)) {
    throw new Error(`${fieldName} must be greater than zero`);
  }

  return decimal;
}

function parseDecimal(value: string): Decimal | undefined {
  try {
    return parseFinancialDecimal(value);
  } catch {
    return undefined;
  }
}

function parseDeadlineTimestamp(
  value: TimestampInput,
  timezone: "UTC" | "KST",
): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return new Date(NaN);
  }

  if (hasExplicitTimezone(trimmed)) {
    return new Date(trimmed);
  }

  const wallClock = parseWallClockIsoTimestamp(trimmed);
  if (wallClock === undefined) {
    return new Date(NaN);
  }

  const timezoneOffsetMinutes = timezone === "KST" ? 9 * 60 : 0;
  return new Date(wallClock.utcMilliseconds - timezoneOffsetMinutes * 60_000);
}

function hasExplicitTimezone(value: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
}

function parseWallClockIsoTimestamp(value: string): { utcMilliseconds: number } | undefined {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?)?$/,
  );
  if (match === null) {
    return undefined;
  }

  const [
    ,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw = "0",
    minuteRaw = "0",
    secondRaw = "0",
    fractionRaw = "",
  ] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = fractionRaw === "" ? 0 : Number(fractionRaw.padEnd(3, "0").slice(0, 3));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return undefined;
  }

  const utcMilliseconds = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const probe = new Date(utcMilliseconds);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second ||
    probe.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }

  return { utcMilliseconds };
}

function matchesCurrentSignalScope(signal: ExitStrategySignal, context: ExitRuleContext): boolean {
  if (signal.exchangeId !== context.exchangeId || signal.market !== context.market) {
    return false;
  }

  const normalizedSignalStrategyId = signal.strategyId.trim();
  if (normalizedSignalStrategyId === "") {
    return false;
  }

  const contextStrategyId = context.strategyId.trim();
  if (contextStrategyId !== "" && normalizedSignalStrategyId !== contextStrategyId) {
    return false;
  }

  const positionStrategyId = context.position.strategyId?.trim();
  if (
    positionStrategyId !== undefined &&
    positionStrategyId !== "" &&
    normalizedSignalStrategyId !== positionStrategyId
  ) {
    return false;
  }

  return contextStrategyId !== "" || (positionStrategyId !== undefined && positionStrategyId !== "");
}

function matchesReductionRatioWithIntention(
  reductionRatio: Decimal,
  intention: ExitIntention,
): boolean {
  if (intention === "EXIT") {
    return reductionRatio.equals(1);
  }

  return reductionRatio.lessThan(1);
}

function pass(
  ruleId: string,
  reasonCode: string,
  message: string,
  metadata?: Record<string, unknown>,
): ExitRuleEvaluation {
  return {
    ruleId,
    status: "PASS",
    reasonCode,
    message,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function triggered(
  ruleId: string,
  reasonCode: string,
  message: string,
  exitIntention: ExitIntention,
  metadata?: Record<string, unknown>,
): ExitRuleEvaluation {
  return {
    ruleId,
    status: "TRIGGERED",
    reasonCode,
    message,
    exitIntention,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function blocked(
  ruleId: string,
  reasonCode: string,
  message: string,
  metadata?: Record<string, unknown>,
): ExitRuleEvaluation {
  return {
    ruleId,
    status: "BLOCKED",
    reasonCode,
    message,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function unavailable(
  ruleId: string,
  reasonCode: string,
  message: string,
  metadata?: Record<string, unknown>,
): ExitRuleEvaluation {
  return {
    ruleId,
    status: "UNAVAILABLE",
    reasonCode,
    message,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
