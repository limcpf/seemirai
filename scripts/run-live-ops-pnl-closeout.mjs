#!/usr/bin/env node

import { runLiveOpsPnlCloseoutCli } from "./run-live-ops-pnl-closeout-support.mjs";

try {
  const exitCode = await runLiveOpsPnlCloseoutCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`live:ops PnL closeout 실패: ${message}\n`);
  process.exitCode = 1;
}
