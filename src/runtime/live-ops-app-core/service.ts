import { createLiveOpsAppCoreBootPlan } from "./boot-plan.js";
import type {
  LiveOpsAppCoreRenderMode,
  LiveOpsAppCoreRunResult,
  LiveOpsForegroundAppCoreInput,
  LiveOpsTuiAppCoreInput,
} from "./types.js";

/**
 * foreground `live:ops` lifecycle을 TypeScript app core 계약으로 실행한다.
 *
 * 호출 경계는 dist CLI entry이며, 입력은 support shim과 원본 argv다. 출력은 process exit code,
 * 렌더링 mode, summary, boot plan evidence다. config/env validation부터 Telegram/status까지의
 * 실제 side effect는 아직 support shim이 소유하고, app core는 parser/input/renderer/readiness 순서와
 * TUI 출력 분기를 고정한다.
 */
export async function runLiveOpsForegroundAppCore(input: LiveOpsForegroundAppCoreInput): Promise<LiveOpsAppCoreRunResult> {
  const options = input.support.parseArgs(input.argv);
  if (options.help === true) {
    // help는 운영 provider lifecycle을 시작하지 않는 정보 출력이므로 readiness 단계와 분리한다.
    input.support.printHelp(input.commandName);
    return createRunResult({
      commandName: input.commandName,
      renderMode: "text",
      lifecycleExecuted: false,
      options,
      summary: null,
    });
  }

  const inputs = await input.support.loadLiveOpsCliInputs(options);
  const summary = input.support.renderLiveOpsSummary({ ...options, ...inputs });
  const renderMode: LiveOpsAppCoreRenderMode = options.tui === true ? "text" : "json";
  if (renderMode === "text") {
    input.support.printText(input.support.renderLiveOpsTuiDashboard(summary));
  } else {
    input.support.printJson(summary);
  }

  const readinessOptions: { fixtureSmoke?: boolean } = {};
  if (options.fixtureSmoke !== undefined) {
    readinessOptions.fixtureSmoke = options.fixtureSmoke;
  }
  // summary 출력 뒤 readiness를 유지해 기존 CLI의 fixture smoke 출력/실패 순서를 바꾸지 않는다.
  input.support.assertLiveOpsCliSummaryReady(summary, readinessOptions);

  return createRunResult({
    commandName: input.commandName,
    renderMode,
    lifecycleExecuted: true,
    options,
    summary,
  });
}

/**
 * attach 전용 `live:ops:tui` lifecycle을 TypeScript app core 계약으로 실행한다.
 *
 * 호출 경계는 dist TUI CLI entry이며, 입력은 support shim과 attach argv다. 출력은 text dashboard
 * summary와 boot plan evidence다. attach가 없으면 provider/broker side effect 전에 fail-closed 하고,
 * 정상 경로에서는 attachReadonly를 강제해 기존 foreground runtime을 새로 열지 않는 invariant를 유지한다.
 */
export async function runLiveOpsTuiAppCore(input: LiveOpsTuiAppCoreInput): Promise<LiveOpsAppCoreRunResult> {
  const options = input.support.parseArgs(input.argv);
  if (options.help === true) {
    // TUI help 역시 읽기 전용 설명 출력이므로 attach guard와 support input load 전에 종료한다.
    input.support.printHelp(input.commandName);
    return createRunResult({
      commandName: input.commandName,
      renderMode: "text",
      lifecycleExecuted: false,
      options,
      summary: null,
    });
  }
  if (options.attach === undefined) {
    // attach 전용 명령이 foreground boot처럼 보이면 운영자가 provider side effect 범위를 오판할 수 있으므로 즉시 차단한다.
    throw new Error("--attach <run-id|socket|status-source> 값이 필요합니다.");
  }

  const inputs = await input.support.loadLiveOpsCliInputs({ ...options, attachReadonly: true });
  const summary = input.support.renderLiveOpsSummary({
    ...options,
    ...inputs,
    tui: true,
  });
  input.support.printText(input.support.renderLiveOpsTuiDashboard(summary));

  return createRunResult({
    commandName: input.commandName,
    renderMode: "text",
    lifecycleExecuted: true,
    options: { ...options, attachReadonly: true },
    summary,
  });
}

/**
 * app core 실행 결과와 boot plan evidence를 한 객체로 묶는다.
 *
 * 호출 경계는 foreground/TUI service 내부이며, 입력은 이미 실행된 lifecycle의 summary와 CLI options다.
 * 출력은 CLI가 exit code와 compatibility 메시지를 보존할 때 쓰는 결과 계약이다. boot plan 생성 외
 * 외부 side effect는 없고, lifecycleExecuted=false인 help 경로를 readiness 성공으로 오해하지 않는
 * invariant를 유지한다.
 */
function createRunResult(input: {
  commandName: string;
  renderMode: LiveOpsAppCoreRenderMode;
  lifecycleExecuted: boolean;
  options: LiveOpsAppCoreRunResult["options"];
  summary: unknown;
}): LiveOpsAppCoreRunResult {
  const bootPlan = createLiveOpsAppCoreBootPlan({
    commandName: input.commandName,
    renderMode: input.renderMode,
  });
  return {
    exitCode: 0,
    commandName: input.commandName,
    renderMode: input.renderMode,
    lifecycleExecuted: input.lifecycleExecuted,
    options: input.options,
    summary: input.summary,
    bootPlan,
  };
}
