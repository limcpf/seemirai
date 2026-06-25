#!/usr/bin/env node

import { isDirectCliModule, writeCliFailure } from "./live-ops-cli/process.js";
import { loadLiveOpsSupportModule } from "./live-ops-cli/support-modules.js";

/**
 * production `live:ops` dist entry를 실행한다.
 *
 * 호출 경계는 `package.json`의 `node dist/runtime/live-ops-cli.js` script이며, 입력은 사용자가 넘긴
 * argv다. 출력은 기존 support renderer가 stdout에 쓰는 JSON 또는 TUI text와 process exit code다.
 * config/env validation, DB/provider readiness, summary redaction invariant는 compatibility support가
 * 유지하고, 이 entry는 help/summary/readiness 순서를 바꾸지 않는다.
 */
export async function runLiveOpsCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const support = await loadLiveOpsSupportModule();
    const options = support.parseArgs(argv);
    if (options.help) {
      support.printHelp("live:ops");
      return 0;
    }

    const inputs = await support.loadLiveOpsCliInputs(options);
    const summary = support.renderLiveOpsSummary({ ...options, ...inputs });
    if (options.tui) {
      support.printText(support.renderLiveOpsTuiDashboard(summary));
    } else {
      support.printJson(summary);
    }
    const readinessOptions = options.fixtureSmoke === undefined ? {} : { fixtureSmoke: options.fixtureSmoke };
    support.assertLiveOpsCliSummaryReady(summary, readinessOptions);

    if (!options.fixtureSmoke && !options.tui) {
      process.stdout.write("DB readiness와 Upbit public market data provider boot를 통과했습니다. TUI lifecycle은 별도 명령으로 확인하세요.\n");
    }
    return 0;
  } catch (error) {
    return writeCliFailure("live:ops", error);
  }
}

if (isDirectCliModule(import.meta.url)) {
  process.exitCode = await runLiveOpsCli();
}
