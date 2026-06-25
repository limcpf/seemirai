#!/usr/bin/env node

import { isDirectCliModule, writeCliFailure } from "./live-ops-cli/process.js";
import { loadLiveOpsPnlCloseoutSupportModule } from "./live-ops-cli/support-modules.js";

/**
 * production `live:ops:pnl-closeout` dist entry를 실행한다.
 *
 * 호출 경계는 `package.json`의 `node dist/runtime/live-ops-pnl-closeout-cli.js` script이며, 입력은 closeout
 * argv다. 출력은 support runner가 계산한 exit code다. append-only PnL snapshot DB write와 secret-safe
 * summary invariant는 support module 책임이며, 이 entry는 실패를 성공으로 낮추지 않는다.
 */
export async function runLiveOpsPnlCloseoutCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const support = await loadLiveOpsPnlCloseoutSupportModule();
    return await support.runLiveOpsPnlCloseoutCli(argv);
  } catch (error) {
    return writeCliFailure("live:ops PnL closeout", error);
  }
}

if (isDirectCliModule(import.meta.url)) {
  process.exitCode = await runLiveOpsPnlCloseoutCli();
}
