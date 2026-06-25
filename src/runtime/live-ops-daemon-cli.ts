#!/usr/bin/env node

import { isDirectCliModule, writeCliFailure } from "./live-ops-cli/process.js";
import { loadLiveOpsDaemonSupportModule } from "./live-ops-cli/support-modules.js";

/**
 * production `live:ops:daemon` dist entry를 실행한다.
 *
 * 호출 경계는 `package.json`의 `node dist/runtime/live-ops-daemon-cli.js` script이며, 입력은 daemon
 * argv다. 출력은 daemon support가 stdout/status file에 기록하는 loop summary와 process exit code다.
 * loop tick, backoff, startup Telegram retry, status file terminal 기록 invariant는 기존 support가
 * 유지하고, 이 entry는 help 분기와 runner 호출만 담당한다.
 */
export async function runLiveOpsDaemonCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const support = await loadLiveOpsDaemonSupportModule();
    const options = support.parseLiveOpsDaemonArgs(argv);
    if (options.help) {
      support.printLiveOpsDaemonHelp();
      return 0;
    }

    await support.runLiveOpsDaemon(options);
    return 0;
  } catch (error) {
    return writeCliFailure("live:ops:daemon", error);
  }
}

if (isDirectCliModule(import.meta.url)) {
  process.exitCode = await runLiveOpsDaemonCli();
}
