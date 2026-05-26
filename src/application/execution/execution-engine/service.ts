import type { BrokerOrder, OrderSubmission } from "../../../domain/index.js";
import { compareOrderIntentEvidence, createOrderIntentEvidence, readSubmissionExpectedLossBps } from "./evidence-fingerprint.js";
import { createExecutionSafetyConfig } from "./safety-config.js";
import { validateExecutionSubmission } from "./validation.js";
import type {
  ExecutionEngineOptions,
  ExecutionEnginePorts,
  ExecutionOrderIntentEvidence,
  ExecutionSafetyConfig,
  ExecutionSubmitOrderResult,
} from "./types.js";
import type { BrokerPort } from "../../ports/index.js";

/**
 * 같은 Node.js process 안에서 동시에 들어온 동일 idempotency key 요청을 추적하는 임시 guard다.
 *
 * 이 Map은 durable 중복 방지가 아니라 in-flight side effect 억제용이다. 성공한 key를 계속 보관하면 장시간 runtime에서
 * 메모리가 증가하므로, broker promise가 settle되면 반드시 제거한다.
 */
interface InFlightExecutionSubmission {
  fingerprint: ExecutionOrderIntentEvidence;
  brokerSubmission: Promise<BrokerOrder>;
}

/**
 * CostModel과 RiskGate를 통과한 주문 후보만 BrokerPort로 넘기는 application service다.
 *
 * 이 계층은 Strategy, Upbit REST client, DB 구현체를 알지 않는다. 후속 sub PR에서 PaperBroker와 persistence가
 * 붙더라도 실행 순서 `CostModel -> RiskGate -> ExecutionEngine -> BrokerPort`를 유지하기 위한 마지막 guard다.
 * validate 단계는 순수 검증으로 끝내고, 모든 증거가 현재 후보와 일치한 뒤에만 `BrokerPort.submitOrder`라는 외부
 * side effect를 호출한다.
 */
export class ExecutionEngine {
  private readonly broker: BrokerPort;
  private readonly safetyConfig: ExecutionSafetyConfig;
  private readonly inFlightByIdempotencyKey = new Map<string, InFlightExecutionSubmission>();

  public constructor(ports: ExecutionEnginePorts, options: ExecutionEngineOptions = {}) {
    this.broker = ports.broker;
    this.safetyConfig = createExecutionSafetyConfig(options.safetyConfig);
  }

  /**
   * 주문 제출 요청을 검증하고, 통과한 요청만 broker에 전달한다.
   *
   * 반환값은 broker 호출 여부까지 포함하는 execution boundary의 단일 결과다. 검증 실패는 `REJECTED`, 같은
   * in-flight 주문의 재진입은 `DUPLICATE_SUPPRESSED`, 실제 broker port 호출 성공은 `SUBMITTED`로 표현한다.
   */
  public async submitOrder(submission: OrderSubmission): Promise<ExecutionSubmitOrderResult> {
    // broker side effect를 만들기 전에 모든 runtime toggle, 비용 증거, RiskGate 증거를 먼저 fail-closed로 검증한다.
    const validation = validateExecutionSubmission(submission, this.safetyConfig);
    if (!validation.valid) {
      return {
        status: "REJECTED",
        submission,
        rejection: validation.rejection,
      };
    }

    const currentFingerprint = createOrderIntentEvidence(
      submission.intent,
      readSubmissionExpectedLossBps(submission),
    );
    const existingSubmission = this.inFlightByIdempotencyKey.get(submission.intent.idempotencyKey);
    if (existingSubmission !== undefined) {
      const mismatches = compareOrderIntentEvidence(existingSubmission.fingerprint, currentFingerprint);
      if (Object.keys(mismatches).length > 0) {
        // 같은 idempotency key가 다른 후보에 재사용되면 생성 버그로 보고 기존 broker 결과를 돌려주지 않는다.
        return {
          status: "REJECTED",
          submission,
          rejection: {
            reasonCode: "idempotency_key_collision",
            message: "In-flight idempotency key was reused for a different order fingerprint",
            metadata: {
              idempotency_key: submission.intent.idempotencyKey,
              mismatches,
            },
          },
        };
      }

      // 같은 후보가 동시에 재제출된 경우에는 기존 broker promise를 공유해 submit side effect를 한 번으로 제한한다.
      return {
        status: "DUPLICATE_SUPPRESSED",
        submission,
        brokerOrder: await existingSubmission.brokerSubmission,
      };
    }

    // 같은 process 안에서 동일 idempotency key가 동시에 들어와도 broker side effect는 한 번만 실행한다.
    const brokerSubmission = this.broker.submitOrder(submission);
    this.inFlightByIdempotencyKey.set(submission.intent.idempotencyKey, {
      fingerprint: currentFingerprint,
      brokerSubmission,
    });

    try {
      return {
        status: "SUBMITTED",
        submission,
        brokerOrder: await brokerSubmission,
      };
    } finally {
      // durable 중복 방지는 DB 경계에서 맡기고, application guard는 in-flight 요청만 보관한다.
      this.inFlightByIdempotencyKey.delete(submission.intent.idempotencyKey);
    }
  }
}
