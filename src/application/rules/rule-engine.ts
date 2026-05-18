import type { Rule, RuleContext, RuleEvaluation, RuleEvaluationStatus } from "../../domain/index.js";

export type RuleEngineStatus = RuleEvaluationStatus;

export interface RuleEngineResult {
  status: RuleEngineStatus;
  passed: boolean;
  evaluations: readonly RuleEvaluation[];
  failedEvaluations: readonly RuleEvaluation[];
  warningEvaluations: readonly RuleEvaluation[];
}

/**
 * strategy별 rule 조합을 순서대로 평가하는 application-level rule engine이다.
 *
 * FAIL이 하나라도 있으면 전체 결과를 FAIL로, FAIL 없이 WARN만 있으면 WARN으로 집계한다.
 */
export class RuleEngine {
  /**
   * 전달받은 rule 목록을 같은 context로 평가하고 audit에 남길 수 있는 평가 목록을 반환한다.
   */
  public async evaluate(
    rules: readonly Rule[],
    context: RuleContext,
  ): Promise<RuleEngineResult> {
    const evaluations: RuleEvaluation[] = [];

    for (const rule of rules) {
      evaluations.push(await rule.evaluate(context));
    }

    return summarizeRuleEvaluations(evaluations);
  }
}

/**
 * 일회성 호출에서 `RuleEngine` 인스턴스 생성 없이 rule 조합을 평가하는 편의 함수다.
 */
export function evaluateRules(
  rules: readonly Rule[],
  context: RuleContext,
): Promise<RuleEngineResult> {
  return new RuleEngine().evaluate(rules, context);
}

/**
 * 개별 rule 평가 결과들을 전체 engine 결과로 접는다.
 */
export function summarizeRuleEvaluations(
  evaluations: readonly RuleEvaluation[],
): RuleEngineResult {
  const failedEvaluations = evaluations.filter((evaluation) => evaluation.status === "FAIL");
  const warningEvaluations = evaluations.filter((evaluation) => evaluation.status === "WARN");
  const status: RuleEngineStatus =
    failedEvaluations.length > 0 ? "FAIL" : warningEvaluations.length > 0 ? "WARN" : "PASS";

  return {
    status,
    passed: status === "PASS",
    evaluations,
    failedEvaluations,
    warningEvaluations,
  };
}
