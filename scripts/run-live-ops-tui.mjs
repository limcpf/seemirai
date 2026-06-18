#!/usr/bin/env node
import {
  loadLiveOpsCliInputs,
  parseArgs,
  printHelp,
  printText,
  renderLiveOpsSummary,
  renderLiveOpsTuiDashboard,
} from "./run-live-ops-support.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp("live:ops:tui");
  } else if (options.attach === undefined) {
    throw new Error("--attach <run-id|socket|status-source> 값이 필요합니다.");
  } else {
    const inputs = await loadLiveOpsCliInputs({ ...options, attachReadonly: true });
    const summary = renderLiveOpsSummary({
      ...options,
      ...inputs,
      tui: true,
    });
    printText(renderLiveOpsTuiDashboard(summary));
  }
} catch (error) {
  process.stderr.write(`live:ops:tui 실패: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
