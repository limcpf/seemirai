#!/usr/bin/env node

import { isDirectCliModule, writeCliFailure } from "./live-ops-cli/process.js";
import { loadLiveOpsSupportModule } from "./live-ops-cli/support-modules.js";
import { runLiveOpsForegroundAppCore } from "./live-ops-app-core.js";

/**
 * production `live:ops` dist entry를 실행한다.
 *
 * 호출 경계는 `package.json`의 `node dist/runtime/live-ops-cli.js` script이며, 입력은 사용자가 넘긴
 * argv다. 출력은 app core가 support renderer로 작성한 JSON 또는 TUI text와 process exit code다.
 * config/env validation, DB/provider readiness, summary redaction invariant는 app core boot plan과
 * compatibility support가 함께 유지하고, 이 entry는 support 로드와 compatibility 완료 문구만 담당한다.
 */
export async function runLiveOpsCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const support = await loadLiveOpsSupportModule();
    const result = await runLiveOpsForegroundAppCore({ support, argv, commandName: "live:ops" });

    if (result.lifecycleExecuted && !result.options.fixtureSmoke && !result.options.tui) {
      process.stdout.write("DB readiness와 Upbit public market data provider boot를 통과했습니다. TUI lifecycle은 별도 명령으로 확인하세요.\n");
    }
    return result.exitCode;
  } catch (error) {
    return writeCliFailure("live:ops", error);
  }
}

if (isDirectCliModule(import.meta.url)) {
  process.exitCode = await runLiveOpsCli();
}
