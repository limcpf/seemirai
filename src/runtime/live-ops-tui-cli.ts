#!/usr/bin/env node

import { isDirectCliModule, writeCliFailure } from "./live-ops-cli/process.js";
import { loadLiveOpsSupportModule } from "./live-ops-cli/support-modules.js";
import { runLiveOpsTuiAppCore } from "./live-ops-app-core.js";

/**
 * production `live:ops:tui` dist entry를 실행한다.
 *
 * 호출 경계는 `package.json`의 `node dist/runtime/live-ops-tui-cli.js` script이며, 입력은 attach 대상과
 * config/env argv다. 출력은 app core가 support TUI renderer로 작성한 secret-safe text다. `--attach`
 * 없는 실행은 새 provider를 열어 정상 화면을 합성하면 안 되므로, fail-closed invariant는 app core가
 * support input load 이전에 보존한다.
 */
export async function runLiveOpsTuiCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const support = await loadLiveOpsSupportModule();
    const result = await runLiveOpsTuiAppCore({ support, argv, commandName: "live:ops:tui" });
    return result.exitCode;
  } catch (error) {
    return writeCliFailure("live:ops:tui", error);
  }
}

if (isDirectCliModule(import.meta.url)) {
  process.exitCode = await runLiveOpsTuiCli();
}
