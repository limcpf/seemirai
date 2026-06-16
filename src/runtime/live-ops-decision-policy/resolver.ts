import type {
  JsonRecord,
  Strategy,
} from "../../domain/index.js";
import {
  LIVE_OPS_CLEANUP_PROBE_DECISION_POLICY_ID,
  loadLiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsConfig,
} from "../live-ops-config.js";
import {
  LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
  createLiveOpsCleanupProbeStrategy,
} from "./cleanup-probe.js";

/**
 * live ops decision policy resolver 입력 계약이다.
 *
 * 책임:
 * - production JSON config를 strategy runtime 조립 경계로 전달한다.
 * - caller가 이미 검증한 config와 unknown JSON input을 같은 함수로 처리할 수 있게 한다.
 *
 * side effect:
 * - 없음. resolver는 config parsing과 strategy 객체 생성만 수행한다.
 */
export interface ResolveLiveOpsDecisionPolicyInput {
  readonly config: LiveOpsConfig | unknown;
  readonly trace?: JsonRecord;
}

/**
 * decision policy 조립 결과에 남기는 secret-safe evidence다.
 *
 * 책임:
 * - TUI/JSON/status가 어떤 policy가 어떤 strategy 목록으로 조립됐는지 secret 없이 보여준다.
 * - runtime이 임의 파일 경로나 동적 plugin을 실행하지 않았음을 추적 정보로 남긴다.
 */
export interface LiveOpsDecisionPolicyEvidence {
  readonly policyId: string;
  readonly strategyIds: readonly string[];
  readonly dynamicCodeLoading: false;
  readonly message: string;
  readonly trace: JsonRecord;
}

/**
 * live ops decision policy resolver의 최종 조립 결과다.
 *
 * 책임:
 * - analysis/decision pipeline이 실행할 `Strategy[]`와 해당 조립 evidence를 함께 반환한다.
 * - 정책 선택과 strategy 실행을 분리해 config schema, TUI, 테스트가 같은 allowlist를 검증하게 한다.
 *
 * invariant:
 * - `strategies`는 정적 allowlist에서 만든 구현체만 포함한다.
 * - resolver는 DB write, broker 호출, Upbit 호출, Telegram 전송 side effect를 만들지 않는다.
 */
export interface LiveOpsDecisionPolicyResolution {
  readonly policyId: string;
  readonly strategies: readonly Strategy[];
  readonly evidence: LiveOpsDecisionPolicyEvidence;
}

/**
 * production live ops JSON의 decision policy를 검증된 strategy 구현체로 조립한다.
 *
 * @param input production live ops config 또는 unknown JSON
 * @returns 정적 allowlist policy id와 strategy 목록
 */
export function resolveLiveOpsDecisionPolicy(
  input: ResolveLiveOpsDecisionPolicyInput,
): LiveOpsDecisionPolicyResolution {
  const config = loadLiveOpsConfig(input.config);
  const policy = config.analysis.decision_policy;

  if (policy.id === LIVE_OPS_CLEANUP_PROBE_DECISION_POLICY_ID) {
    const strategy = createLiveOpsCleanupProbeStrategy({
      maxNotionalKrw: policy.cleanup_probe.max_notional_krw,
      tickSizeKrw: policy.cleanup_probe.tick_size_krw,
      priceOffsetTicks: policy.cleanup_probe.price_offset_ticks,
      quantityScale: policy.cleanup_probe.quantity_scale,
      expectedLossBpsOfEquity: policy.cleanup_probe.expected_loss_bps_of_equity,
    });

    return {
      policyId: policy.id,
      strategies: [strategy],
      evidence: {
        policyId: policy.id,
        strategyIds: [LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID],
        dynamicCodeLoading: false,
        message: "cleanup probe decision policy를 정적 strategy로 조립했습니다.",
        trace: {
          source: "live_ops_decision_policy_resolver",
          dynamicCodeLoading: false,
          ...(input.trace ?? {}),
        },
      },
    };
  }

  // schema allowlist가 깨진 경우에도 임의 strategy 실행으로 넘어가지 않고 닫는다.
  throw new Error(`UnsupportedLiveOpsDecisionPolicy:${String(policy.id)}`);
}
