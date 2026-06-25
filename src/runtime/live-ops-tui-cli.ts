#!/usr/bin/env node

import { isDirectCliModule, writeCliFailure } from "./live-ops-cli/process.js";
import { loadLiveOpsSupportModule } from "./live-ops-cli/support-modules.js";

/**
 * production `live:ops:tui` dist entry를 실행한다.
 *
 * 호출 경계는 `package.json`의 `node dist/runtime/live-ops-tui-cli.js` script이며, 입력은 attach 대상과
 * config/env argv다. 출력은 기존 TUI dashboard renderer의 secret-safe text다. `--attach` 없는 실행은
 * 새 provider를 열어 정상 화면을 합성하면 안 되므로, 기존 fail-closed invariant를 이 entry에서도 보존한다.
 */
export async function runLiveOpsTuiCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const support = await loadLiveOpsSupportModule();
    const options = support.parseArgs(argv);
    if (options.help) {
      support.printHelp("live:ops:tui");
      return 0;
    }
    if (options.attach === undefined) {
      // attach 전용 명령이 foreground boot처럼 보이면 운영자가 provider side effect 범위를 오판할 수 있으므로 즉시 차단한다.
      throw new Error("--attach <run-id|socket|status-source> 값이 필요합니다.");
    }

    const inputs = await support.loadLiveOpsCliInputs({ ...options, attachReadonly: true });
    const summary = support.renderLiveOpsSummary({
      ...options,
      ...inputs,
      tui: true,
    });
    support.printText(support.renderLiveOpsTuiDashboard(summary));
    return 0;
  } catch (error) {
    return writeCliFailure("live:ops:tui", error);
  }
}

if (isDirectCliModule(import.meta.url)) {
  process.exitCode = await runLiveOpsTuiCli();
}
