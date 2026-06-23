#!/usr/bin/env node
import {
  loadLiveOpsCliInputs,
  parseArgs,
  assertLiveOpsCliSummaryReady,
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
    assertLiveOpsCliSummaryReady(summary, { fixtureSmoke: options.fixtureSmoke });

    if (!options.fixtureSmoke && !options.tui) {
      process.stdout.write("DB readiness와 Upbit public market data provider boot를 통과했습니다. TUI lifecycle은 별도 명령으로 확인하세요.\n");
    }
  }
} catch (error) {
  process.stderr.write(`live:ops 실패: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
