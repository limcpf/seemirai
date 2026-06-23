#!/usr/bin/env node
import {
  parseLiveOpsDaemonArgs,
  printLiveOpsDaemonHelp,
  runLiveOpsDaemon,
} from "./run-live-ops-daemon-support.mjs";

try {
  const options = parseLiveOpsDaemonArgs(process.argv.slice(2));
  if (options.help) {
    printLiveOpsDaemonHelp();
  } else {
    await runLiveOpsDaemon(options);
  }
} catch (error) {
  process.stderr.write(`live:ops:daemon 실패: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
