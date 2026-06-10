import { createLiveAutonomousExitStatusSummary } from "./summary.js";
import type {
  LiveAutonomousExitRuntimePorts,
  LiveAutonomousExitRuntimeRequest,
  LiveAutonomousExitRuntimeResult,
} from "./types.js";

/**
 * M22 live autonomous exit orchestration service다.
 *
 * 이 서비스는 M22 guard와 M16 reconcile summary가 안전할 때만 주입된 M19 exit runner를 호출한다. guard 차단, reconcile mismatch,
 * exit engine 미준비 상태에서는 broker side effect가 가능한 runner를 호출하지 않고 safe summary만 반환하는 것이 invariant다.
 */
export class LiveAutonomousExitRuntime {
  private readonly runExit: LiveAutonomousExitRuntimePorts["runExit"];

  public constructor(ports: LiveAutonomousExitRuntimePorts) {
    this.runExit = ports.runExit;
  }

  /**
   * 최신 guard/reconcile 상태를 확인한 뒤 M19 exit runner를 실행한다.
   *
   * preflight summary가 `READY`가 아니면 runner를 호출하지 않는다. runner가 반환한 partial fill/cancel/requote 결과는 같은
   * safe summary 경계로 변환해 HTTP/Telegram/report가 내부 식별자 대신 한국어 조치 문구를 공유하게 한다.
   *
   * @param request guard/reconcile 상태와 M19 exit runner 입력
   * @returns runner 호출 여부와 safe summary
   */
  public async runExitIfSafe(request: LiveAutonomousExitRuntimeRequest): Promise<LiveAutonomousExitRuntimeResult> {
    const preflightSummary = createLiveAutonomousExitStatusSummary({
      enabled: request.enabled,
      runtimeReady: request.runtimeReady,
      exitEngineReady: request.exitEngineReady,
      observedAt: request.observedAt,
      reconcile: request.reconcile,
    });

    if (preflightSummary.statusCode !== "READY") {
      // reconcile mismatch나 guard 차단 상태에서는 청산 side effect도 상태 불일치를 키울 수 있어 runner 호출 전 닫는다.
      return {
        status: "SKIPPED",
        summary: preflightSummary,
      };
    }

    const exitResult = await this.runExit(request.exitInput);
    return {
      status: "EXECUTED",
      exitResult,
      summary: createLiveAutonomousExitStatusSummary({
        enabled: request.enabled,
        runtimeReady: request.runtimeReady,
        exitEngineReady: request.exitEngineReady,
        observedAt: request.observedAt,
        reconcile: request.reconcile,
        lastExitResult: exitResult,
      }),
    };
  }
}
