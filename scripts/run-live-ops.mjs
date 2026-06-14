#!/usr/bin/env node
import {
  loadLiveOpsCliInputs,
  parseArgs,
  printHelp,
  printJson,
  printText,
  renderLiveOpsSummary,
  renderLiveOpsTuiDashboard,
} from "./run-live-ops-support.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp("live:ops");
  } else {
    const inputs = await loadLiveOpsCliInputs(options);
    const summary = renderLiveOpsSummary({ ...options, ...inputs });
    if (options.tui) {
      printText(renderLiveOpsTuiDashboard(summary));
    } else {
      printJson(summary);
    }

    if (!options.fixtureSmoke && !options.tui) {
      process.stdout.write("DB readiness를 통과했습니다. provider/TUI lifecycle은 후속 sub PR에서 연결됩니다.\n");
    }
  }
} catch (error) {
  process.stderr.write(`live:ops 실패: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
