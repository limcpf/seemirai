import type {
  ExitDecision,
  ExitDecisionKind,
  ExitRule,
  ExitRuleContext,
  ExitRuleEvaluation,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";

/**
 * exit rule engine의 집계 결과를 담는 중간 표현이다.
 *
 * RuleEngineResult와 같은 역할을 exit 전용으로 수행한다.
 */
export interface ExitRuleEngineResult {
  /** 모든 rule 평가 결과 */
  evaluations: readonly ExitRuleEvaluation[];
  /** trigger된 rule 평가만 필터링 */
  triggeredRules: readonly ExitRuleEvaluation[];
  /** blocked 또는 unavailable rule 평가만 필터링 */
  blockedRules: readonly ExitRuleEvaluation[];
}

/**
 * 여러 exit rule을 순서대로 평가하고 최종 ExitDecision으로 집계한다.
 *
 * exit rule은 broker, DB, Upbit client를 호출하지 않고 ExitRuleContext만 평가한다.
 * 집계 규칙:
 * - BLOCKED가 하나라도 있으면 최종 결정은 BLOCK.
 * - TRIGGERED + EXIT 의도가 하나라도 있으면 최종 결정은 EXIT.
 * - TRIGGERED + REDUCE 의도만 있으면 최종 결정은 REDUCE.
 * - 그 외는 HOLD.
 */
export class ExitRuleEngine {
  /**
   * 전달받은 exit rule 목록을 같은 context로 평가하고 최종 ExitDecision을 반환한다.
   */
  public async evaluate(
    rules: readonly ExitRule[],
    context: ExitRuleContext,
  ): Promise<ExitDecision> {
    const evaluations: ExitRuleEvaluation[] = [];

    for (const rule of rules) {
      evaluations.push(await rule.evaluate(context));
    }

    return this.summarize(evaluations, context);
  }

  /**
   * 개별 rule 평가 결과들을 최종 ExitDecision으로 집계한다.
   */
  public summarize(
    evaluations: readonly ExitRuleEvaluation[],
    context: ExitRuleContext,
  ): ExitDecision {
    const positionScopeBlock = evaluateExitPositionScope(context);
    const scopedEvaluations =
      positionScopeBlock === undefined ? evaluations : [...evaluations, positionScopeBlock];

    const triggeredRules = scopedEvaluations.filter(isTriggeredEvaluation);
    const blockedRules = scopedEvaluations.filter(
      (evaluation) =>
        evaluation.status === "BLOCKED" || evaluation.status === "UNAVAILABLE",
    );

    const kind = resolveExitDecision(triggeredRules);

    // BLOCKED가 하나라도 있으면 exit 자체를 차단한다 — 추정이나 완화로 넘기지 않는다.
    const blockedExists = scopedEvaluations.some(
      (evaluation) => evaluation.status === "BLOCKED",
    );
    const finalKind: ExitDecisionKind = blockedExists ? "BLOCK" : kind;

    const { reasonCode, userMessage } = buildExitReason(finalKind, triggeredRules, blockedRules);

    return {
      kind: finalKind,
      ruleEvaluations: scopedEvaluations,
      triggeredRules,
      blockedRules,
      reasonCode,
      userMessage,
      observedAt: context.observedAt,
    };
  }
}

/**
 * 일회성 호출을 위한 편의 함수다.
 */
export function evaluateExitRules(
  rules: readonly ExitRule[],
  context: ExitRuleContext,
): Promise<ExitDecision> {
  return new ExitRuleEngine().evaluate(rules, context);
}

// ---------------------------------------------------------------------------
// 내부 helper
// ---------------------------------------------------------------------------

/**
 * trigger된 rule 목록에서 최종 ExitDecisionKind를 결정한다.
 *
 * EXIT 의도가 하나라도 있으면 EXIT, REDUCE 의도만 있으면 REDUCE, 아니면 HOLD.
 */
function resolveExitDecision(
  triggeredRules: readonly ExitRuleEvaluation[],
): ExitDecisionKind {
  if (triggeredRules.length === 0) {
    return "HOLD";
  }

  const hasExit = triggeredRules.some(
    (evaluation) => evaluation.exitIntention === "EXIT",
  );
  if (hasExit) {
    return "EXIT";
  }

  const hasReduce = triggeredRules.some(
    (evaluation) => evaluation.exitIntention === "REDUCE",
  );
  if (hasReduce) {
    return "REDUCE";
  }

  return "HOLD";
}

/**
 * ExitDecision의 reasonCode와 userMessage를 생성한다.
 *
 * reasonCode는 내부 식별자, userMessage는 한국어 상태·원인·영향·필요 조치를 포함한다.
 */
function buildExitReason(
  kind: ExitDecisionKind,
  triggeredRules: readonly ExitRuleEvaluation[],
  blockedRules: readonly ExitRuleEvaluation[],
): { reasonCode: string; userMessage: string } {
  switch (kind) {
    case "BLOCK": {
      const blockLabels = formatRuleLabels(blockedRules);
      return {
        reasonCode: "exit_blocked",
        userMessage: `청산 판단이 차단되었습니다. 차단 원인: ${blockLabels}. 거래소 정책, 시장 상태 또는 필수 입력을 확인하세요.`,
      };
    }
    case "EXIT": {
      const exitLabels = formatRuleLabels(
        triggeredRules.filter((r) => r.exitIntention === "EXIT"),
      );
      return {
        reasonCode: "exit_triggered",
        userMessage: `포지션 전체 청산 조건이 충족되었습니다. 원인: ${exitLabels}. 후속 실행 단계에서 청산 주문 후보로 변환됩니다.`,
      };
    }
    case "REDUCE": {
      const reduceLabels = formatRuleLabels(
        triggeredRules.filter((r) => r.exitIntention === "REDUCE"),
      );
      return {
        reasonCode: "reduce_triggered",
        userMessage: `포지션 일부 축소 조건이 충족되었습니다. 원인: ${reduceLabels}. 후속 실행 단계에서 축소 주문 후보로 변환됩니다.`,
      };
    }
    case "HOLD":
    default:
      return {
        reasonCode: "exit_hold",
        userMessage: "청산 조건이 충족되지 않아 현재 포지션을 유지합니다.",
      };
  }
}

/**
 * 사용자-facing 메시지에서 내부 rule id 대신 안정적인 한국어 판단 항목명을 사용한다.
 *
 * raw rule id는 ExitRuleEvaluation에 trace로 보존하고, 첫 화면 메시지에는 노출하지 않는다.
 */
const EXIT_RULE_USER_LABELS: Readonly<Record<string, string>> = {
  exit_position_scope: "보유 포지션 수량",
  stop_loss_exit: "손절 기준",
  take_profit_exit: "익절 기준",
  trailing_stop_exit: "추적 손절 기준",
  time_based_exit: "시간 기반 청산 기준",
  strategy_exit_signal: "전략 청산 신호",
  risk_reduction_exit: "리스크 축소 신호",
};

function formatRuleLabels(evaluations: readonly ExitRuleEvaluation[]): string {
  const labels = [
    ...new Set(
      evaluations.map(
        (evaluation) =>
          EXIT_RULE_USER_LABELS[evaluation.ruleId] ?? "확인 필요 청산 판단 항목",
      ),
    ),
  ];

  return labels.length > 0 ? labels.join(", ") : "확인 필요 청산 판단 항목";
}

function isTriggeredEvaluation(
  evaluation: ExitRuleEvaluation,
): evaluation is Extract<ExitRuleEvaluation, { status: "TRIGGERED" }> {
  return evaluation.status === "TRIGGERED";
}

function evaluateExitPositionScope(context: ExitRuleContext): ExitRuleEvaluation | undefined {
  if (
    context.position.exchangeId !== context.exchangeId ||
    context.position.market !== context.market
  ) {
    return blockedPositionScope(
      "exit_position_scope_mismatch",
      "포지션 snapshot의 거래소 또는 마켓 scope가 현재 청산 context와 일치하지 않아 청산 주문 후보 생성을 차단합니다.",
      context,
    );
  }

  const contextStrategyId = context.strategyId.trim();
  const positionStrategyId = context.position.strategyId?.trim();
  if (
    contextStrategyId !== "" &&
    positionStrategyId !== undefined &&
    positionStrategyId !== "" &&
    contextStrategyId !== positionStrategyId
  ) {
    return blockedPositionScope(
      "exit_position_scope_mismatch",
      "포지션 snapshot의 전략 scope가 현재 청산 context와 일치하지 않아 청산 주문 후보 생성을 차단합니다.",
      context,
    );
  }

  try {
    const quantity = parseFinancialDecimal(context.position.quantity);
    if (quantity.greaterThan(0)) {
      return undefined;
    }
    return blockedPositionScope(
      "exit_no_position",
      "청산할 open position 수량이 없어 청산 주문 후보 생성을 차단합니다.",
      context,
    );
  } catch {
    return blockedPositionScope(
      "exit_position_quantity_invalid",
      "open position 수량을 파싱할 수 없어 청산 주문 후보 생성을 차단합니다.",
      context,
    );
  }
}

function blockedPositionScope(
  reasonCode: string,
  message: string,
  context: ExitRuleContext,
): ExitRuleEvaluation {
  return {
    ruleId: "exit_position_scope",
    status: "BLOCKED",
    reasonCode,
    message,
    metadata: {
      context_exchange_id: context.exchangeId,
      context_market: context.market,
      context_strategy_id: context.strategyId,
      position_exchange_id: context.position.exchangeId,
      position_market: context.position.market,
      position_strategy_id: context.position.strategyId ?? "",
      position_quantity: context.position.quantity,
    },
  };
}
