#!/usr/bin/env node
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultHomeDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m22-live-autonomous");

try {
  await main();
} catch (error) {
  process.stderr.write(`M22 운영 파일 준비 실패: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const homeDir = path.resolve(expandHome(options.dir ?? defaultHomeDir));
  if (isPathInside(repoRoot, homeDir) && !options.allowRepoDir) {
    throw new Error(
      `운영 env/key 파일은 저장소 내부에 만들지 않는다. 다른 --dir를 쓰거나 정말 필요한 경우 --allow-repo-dir를 명시하세요: ${homeDir}`,
    );
  }

  const paths = createManagedPaths(homeDir);
  const summary = await prepareLocalFiles(paths, options);
  printSummary(summary, options);
}

async function prepareLocalFiles(paths, options) {
  await ensureDirectory(paths.homeDir);
  await ensureDirectory(paths.artifactDir);
  await ensureDirectory(paths.evidenceDir);
  await ensureDirectory(paths.candidateDir);

  const configContent = await renderRuntimeConfig();
  const files = [
    {
      key: "env",
      path: paths.envPath,
      mode: 0o600,
      content: renderEnvFile(paths),
    },
    {
      key: "keys",
      path: paths.keysPath,
      mode: 0o600,
      content: renderKeysFile(),
    },
    {
      key: "config",
      path: paths.configPath,
      mode: 0o600,
      content: configContent,
    },
    {
      key: "readme",
      path: paths.readmePath,
      mode: 0o600,
      content: renderReadme(paths),
    },
    {
      key: "fixtureSmokeScript",
      path: paths.fixtureSmokeScriptPath,
      mode: 0o700,
      content: renderFixtureSmokeScript(paths),
    },
    {
      key: "run24hScript",
      path: paths.run24hScriptPath,
      mode: 0o700,
      content: renderRun24hScript(paths),
    },
    {
      key: "candidateFile",
      path: paths.candidateFilePath,
      mode: 0o600,
      content: renderCandidateFileTemplate(),
    },
    ...createEvidenceFiles(paths),
  ];

  const written = {};
  for (const file of files) {
    // 운영 secret이 들어갈 수 있는 파일은 기본적으로 덮어쓰지 않아 사람이 채운 값을 보존한다.
    written[file.key] = await writeManagedFile(file, { force: options.force });
  }

  return {
    status: "prepared",
    homeDir: paths.homeDir,
    artifactDir: paths.artifactDir,
    evidenceDir: paths.evidenceDir,
    files: written,
    nextSteps: [
      `${paths.keysPath}에 DB, Telegram, Upbit key 값을 채운다.`,
      `${paths.envPath}의 evidence id, readiness, live guard 값을 실제 확인 후 1 또는 file: 경로로 바꾼다.`,
      `${paths.fixtureSmokeScriptPath}로 no-live smoke를 먼저 실행한다.`,
      `${paths.run24hScriptPath}로 기본 M22 daemon을 runner 뒤에서 실행한다.`,
    ],
  };
}

async function writeManagedFile(file, options) {
  const existed = await fileExists(file.path);
  if (existed && !options.force) {
    await chmod(file.path, file.mode);
    return {
      path: file.path,
      status: "kept",
      mode: modeString(file.mode),
    };
  }

  await writeFile(file.path, file.content, { encoding: "utf8", mode: file.mode });
  await chmod(file.path, file.mode);
  return {
    path: file.path,
    status: existed ? "overwritten" : "created",
    mode: modeString(file.mode),
  };
}

async function renderRuntimeConfig() {
  const raw = await readFile(path.join(repoRoot, "config", "paper.json"), "utf8");
  const config = JSON.parse(raw);
  return `${JSON.stringify(createM22RuntimeConfig(config), null, 2)}\n`;
}

function createM22RuntimeConfig(baseConfig) {
  return {
    ...baseConfig,
    live_trading_enabled: false,
    withdrawal_enabled: false,
    cross_exchange_arbitrage_enabled: false,
    futures_enabled: false,
    leverage_enabled: false,
    market_order_enabled: false,
    entry_market_order_enabled: false,
    paper_no_key: true,
    live_autonomous: {
      mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
      enabled: true,
      allowed_markets: ["KRW-BTC"],
      max_order_krw: "10000",
      daily_autonomous_notional_limit_krw: "30000",
      max_open_position_notional_krw: "30000",
      max_daily_loss_krw: "10000",
      max_weekly_loss_krw: "30000",
      max_price_deviation_bps: "30",
      require_m21_week_gate_evidence: true,
      require_m20_inbound_readiness: true,
      require_reconcile_freshness: true,
      require_pnl_status_ready: true,
      require_decision_ledger_ready: true,
      require_exit_engine_ready: true,
      require_operator_arm_evidence_id: true,
      require_budget_evidence_id: true,
      require_key_scope_evidence_id: true,
      identifier_prefix: "m22a-",
      identifier_max_length: 32,
    },
    secrets: {},
  };
}

function renderEnvFile(paths) {
  return [
    "# M22 live autonomous pilot 운영 env",
    "# 이 파일은 저장소 밖에서만 사용한다. 부모 셸 env가 아니라 이 파일의 값을 운영 기준으로 삼는다.",
    "# 실제 값 확인 전까지 live guard와 readiness는 0으로 둔다.",
    `export SEEMIRAI_M22_HOME=${shellSingleQuote(paths.homeDir)}`,
    `export SEEMIRAI_M22_ARTIFACT_DIR=${shellSingleQuote(paths.artifactDir)}`,
    `export SEEMIRAI_M22_EVIDENCE_DIR=${shellSingleQuote(paths.evidenceDir)}`,
    'export SEEMIRAI_M22_PILOT_DURATION_MS="86400000"',
    "",
    "# live command 실행 허가. 실제 24시간 pilot 직전 1로 바꾼다.",
    'export SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT="0"',
    'export SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON="0"',
    "",
    "# evidence id는 저장소 밖 redacted evidence를 가리키는 안정 식별자다.",
    `# 예시: export SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID="file:${paths.evidenceDir}/operator-arm.md"`,
    'export SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID=""',
    `# 예시: export SEEMIRAI_M22_BUDGET_EVIDENCE_ID="file:${paths.evidenceDir}/budget.md"`,
    'export SEEMIRAI_M22_BUDGET_EVIDENCE_ID=""',
    `# 예시: export SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID="file:${paths.evidenceDir}/m21-week-gate.md"`,
    'export SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID=""',
    `# 예시: export SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID="file:${paths.evidenceDir}/upbit-key-scope.md"`,
    'export SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID=""',
    "",
    "# Upbit private/order side effect guard. M22 mode는 m22-live-autonomous.config.json이 담당한다.",
    'export SEEMIRAI_PILOT_PROFILE="PILOT_ORDER_SMOKE"',
    'export SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE="0"',
    'export SEEMIRAI_RUN_UPBIT_ORDER_SMOKE="0"',
    'export SEEMIRAI_UPBIT_POLICY_SYNC_MARKET="KRW-BTC"',
    'export SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET="KRW-BTC"',
    'export SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW="10000"',
    'export SEEMIRAI_UPBIT_KEY_SCOPE="자산조회,주문조회,주문하기"',
    "",
    "# daemon-local budget/PnL 시작값. 실제 reconcile/PnL snapshot 기준으로 채운다.",
    'export SEEMIRAI_M22_INITIAL_DAILY_AUTONOMOUS_NOTIONAL_USED_KRW="0"',
    'export SEEMIRAI_M22_INITIAL_OPEN_POSITION_NOTIONAL_KRW="0"',
    'export SEEMIRAI_M22_DAILY_REALIZED_LOSS_KRW="0"',
    'export SEEMIRAI_M22_WEEKLY_REALIZED_LOSS_KRW="0"',
    "",
    "# M20/M16/M17/M18/M19 readiness. 각 기능 상태를 실제 확인한 뒤 1로 바꾼다.",
    'export SEEMIRAI_M22_TELEGRAM_INBOUND_READY="0"',
    'export SEEMIRAI_M22_RECONCILE_FRESH="0"',
    'export SEEMIRAI_M22_PNL_STATUS_READY="0"',
    'export SEEMIRAI_M22_DECISION_LEDGER_READY="0"',
    'export SEEMIRAI_M22_EXIT_ENGINE_READY="0"',
    "",
    "# secret 파일의 값을 기준으로 실행해 이전 셸의 오래된 key override를 막는다.",
    "unset SEEMIRAI_DATABASE_URL",
    "unset SEEMIRAI_TELEGRAM_BOT_TOKEN",
    "unset SEEMIRAI_TELEGRAM_CHAT_ID",
    "unset TELEGRAM_BOT_TOKEN",
    "unset SEEMIRAI_UPBIT_ACCESS_KEY",
    "unset SEEMIRAI_UPBIT_SECRET_KEY",
    "unset UPBIT_ACCESS_KEY",
    "unset UPBIT_SECRET_KEY",
    "",
    'if [ -f "${SEEMIRAI_M22_HOME}/m22.keys.env" ]; then',
    '  . "${SEEMIRAI_M22_HOME}/m22.keys.env"',
    "fi",
    "",
  ].join("\n");
}

function renderKeysFile() {
  return [
    "# M22 live autonomous pilot secret env",
    "# chmod 600 유지. 이 파일의 값은 PR, 문서, artifact에 원문으로 남기지 않는다.",
    "",
    '# 예시: export SEEMIRAI_DATABASE_URL="postgres://seemirai:비밀번호@127.0.0.1:55432/seemirai"',
    'export SEEMIRAI_DATABASE_URL="${SEEMIRAI_DATABASE_URL:-}"',
    "",
    '# 예시: export SEEMIRAI_TELEGRAM_BOT_TOKEN="123456789:telegram-bot-token"',
    'export SEEMIRAI_TELEGRAM_BOT_TOKEN="${SEEMIRAI_TELEGRAM_BOT_TOKEN:-}"',
    '# 예시: export SEEMIRAI_TELEGRAM_CHAT_ID="123456789"',
    'export SEEMIRAI_TELEGRAM_CHAT_ID="${SEEMIRAI_TELEGRAM_CHAT_ID:-}"',
    "",
    '# 예시: export SEEMIRAI_UPBIT_ACCESS_KEY="upbit-access-key"',
    'export SEEMIRAI_UPBIT_ACCESS_KEY="${SEEMIRAI_UPBIT_ACCESS_KEY:-}"',
    '# 예시: export SEEMIRAI_UPBIT_SECRET_KEY="upbit-secret-key"',
    'export SEEMIRAI_UPBIT_SECRET_KEY="${SEEMIRAI_UPBIT_SECRET_KEY:-}"',
    "",
  ].join("\n");
}

function renderCandidateFileTemplate() {
  return [
    "# M22 live autonomous candidate JSONL",
    "# 빈 파일이면 daemon은 주문을 만들지 않고 heartbeat만 남긴다.",
    "# 실제 후보는 아래 예시처럼 한 줄 JSON으로 append한다. #으로 시작하는 줄은 무시한다.",
    '# {"candidateId":"m22-test-001","market":"KRW-BTC","side":"BUY","orderType":"LIMIT","postOnly":true,"requestedPrice":"100000000","requestedQuantity":"0.0001","requestedNotional":"10000","referencePrice":"100000000","reason":"operator-approved-test"}',
    "",
  ].join("\n");
}

function createEvidenceFiles(paths) {
  return [
    {
      key: "operatorArmEvidence",
      path: path.join(paths.evidenceDir, "operator-arm.md"),
      mode: 0o600,
      content: renderEvidenceTemplate({
        title: "M22 operator arm evidence",
        lines: [
          "운영자: lim",
          "승인 시각: <KST ISO8601>",
          "승인 범위: KRW-BTC M22 24시간 제한적 완전 자동매매 pilot",
          "확인: live guard, budget, key scope, readiness, kill switch 복구 경로를 확인했다.",
        ],
      }),
    },
    {
      key: "budgetEvidence",
      path: path.join(paths.evidenceDir, "budget.md"),
      mode: 0o600,
      content: renderEvidenceTemplate({
        title: "M22 budget evidence",
        lines: [
          "1회 주문 상한: 10000 KRW",
          "일일 자동 주문 notional 상한: 30000 KRW",
          "open position notional 상한: 30000 KRW",
          "일간 손실 상한: 10000 KRW",
          "주간 손실 상한: 30000 KRW",
          "예산 출처/계정: <채우기>",
        ],
      }),
    },
    {
      key: "m21WeekGateEvidence",
      path: path.join(paths.evidenceDir, "m21-week-gate.md"),
      mode: 0o600,
      content: renderEvidenceTemplate({
        title: "M22 M21 week gate evidence",
        lines: [
          "M21 1주 운영 결과 근거 경로: <채우기>",
          "수동 승인 pilot 중 unresolved incident: <없음 또는 링크>",
          "자동매매로 승격 가능한 이유: <채우기>",
        ],
      }),
    },
    {
      key: "upbitKeyScopeEvidence",
      path: path.join(paths.evidenceDir, "upbit-key-scope.md"),
      mode: 0o600,
      content: renderEvidenceTemplate({
        title: "M22 Upbit key scope evidence",
        lines: [
          "허용 권한: 자산조회, 주문조회, 주문하기",
          "금지 권한 확인: 출금/입출금 자동화, 선물, 레버리지, 마진 없음",
          "IP 제한/보관 위치: <채우기>",
          "검증 시각: <KST ISO8601>",
        ],
      }),
    },
  ];
}

function renderEvidenceTemplate(input) {
  return [`# ${input.title}`, "", ...input.lines.map((line) => `- ${line}`), ""].join("\n");
}

function renderReadme(paths) {
  return `# M22 운영 파일

이 디렉터리는 M22 제한적 완전 자동매매 24시간 pilot을 실행하기 위한 로컬 운영 파일이다. secret 원문은 저장소에 커밋하지 않는다.

## 파일

- \`m22.env\`: live guard, evidence id, readiness flag
- \`m22.keys.env\`: DB, Telegram, Upbit secret
- \`m22-live-autonomous.config.json\`: 저장소 밖 M22 live_autonomous enabled config
- \`evidence/*.md\`: runner가 참조할 redacted evidence template
- \`candidates/m22-candidates.jsonl\`: daemon이 읽는 명시 주문 후보 JSONL. 빈 파일이면 주문하지 않는다.
- \`run-fixture-smoke.sh\`: no-live runner smoke
- \`run-24h-pilot.sh\`: 기본 M22 daemon을 runner 뒤에서 실행하는 wrapper
- \`artifacts/\`: summary, report, process log, event log 저장 위치

## 채울 값

1. \`${paths.keysPath}\`에 \`SEEMIRAI_DATABASE_URL\`, \`SEEMIRAI_TELEGRAM_BOT_TOKEN\`, \`SEEMIRAI_UPBIT_ACCESS_KEY\`, \`SEEMIRAI_UPBIT_SECRET_KEY\`를 채운다.
2. \`${paths.evidenceDir}\` 아래 4개 evidence 파일의 \`<채우기>\` 항목을 실제 근거로 바꾼다.
3. \`${paths.envPath}\`에서 evidence id를 \`file:${paths.evidenceDir}/...\` 형태로 채운다.
4. private/order smoke와 M20/M16/M17/M18/M19 readiness가 실제 통과한 뒤에만 관련 flag를 \`1\`로 바꾼다.
5. 실제 24시간 pilot 직전에만 \`SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1\`과 \`SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON=1\`로 바꾼다.

## 실행

\`\`\`sh
cd ${repoRoot}
. ${shellSingleQuote(paths.envPath)}
${shellSingleQuote(paths.fixtureSmokeScriptPath)}
\`\`\`

실제 24시간 pilot은 기본 M22 daemon을 runner 뒤에서 실행한다. 후보 파일이 비어 있으면 주문하지 않고 heartbeat만 남긴다.

\`\`\`sh
${shellSingleQuote(paths.run24hScriptPath)}
\`\`\`

별도 daemon을 직접 지정해야 할 때만 첫 번째 인자로 command를 넣는다.

\`\`\`sh
${shellSingleQuote(paths.run24hScriptPath)} node /opt/seemirai/live-autonomous-daemon.mjs --config ${shellSingleQuote(paths.configPath)}
\`\`\`
`;
}

function renderFixtureSmokeScript(paths) {
  return `#!/bin/sh
set -eu

REPO_ROOT=${shellSingleQuote(repoRoot)}
M22_HOME=${shellSingleQuote(paths.homeDir)}

# 운영 파일의 경로/scope 값을 기준으로 실행해 이전 셸의 override가 artifact나 key preflight를 흔들지 못하게 한다.
unset SEEMIRAI_M22_ARTIFACT_DIR
unset SEEMIRAI_M22_EVIDENCE_DIR
unset SEEMIRAI_UPBIT_KEY_SCOPE
unset SEEMIRAI_DATABASE_URL
unset SEEMIRAI_TELEGRAM_BOT_TOKEN
unset SEEMIRAI_TELEGRAM_CHAT_ID
unset TELEGRAM_BOT_TOKEN
unset SEEMIRAI_UPBIT_ACCESS_KEY
unset SEEMIRAI_UPBIT_SECRET_KEY
unset UPBIT_ACCESS_KEY
unset UPBIT_SECRET_KEY

. "$M22_HOME/m22.env"

exec node "$REPO_ROOT/scripts/run-m22-live-autonomous-pilot.mjs" \\
  --fixture-smoke \\
  --json \\
  --artifact-dir "$SEEMIRAI_M22_ARTIFACT_DIR"
`;
}

function renderRun24hScript(paths) {
  return `#!/bin/sh
set -eu

REPO_ROOT=${shellSingleQuote(repoRoot)}
M22_HOME=${shellSingleQuote(paths.homeDir)}
systemd_segment_guard="\${SEEMIRAI_M23_SYSTEMD_SEGMENT:-}"
systemd_segment_env="\${SEEMIRAI_M23_SEGMENT_ENV:-}"
systemd_pilot_guard="\${SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT:-}"
systemd_daemon_guard="\${SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON:-}"

# 운영 파일의 경로/scope 값을 기준으로 실행해 이전 셸의 override가 artifact나 key preflight를 흔들지 못하게 한다.
unset SEEMIRAI_M22_ARTIFACT_DIR
unset SEEMIRAI_M22_EVIDENCE_DIR
unset SEEMIRAI_UPBIT_KEY_SCOPE
unset SEEMIRAI_DATABASE_URL
unset SEEMIRAI_TELEGRAM_BOT_TOKEN
unset SEEMIRAI_TELEGRAM_CHAT_ID
unset TELEGRAM_BOT_TOKEN
unset SEEMIRAI_UPBIT_ACCESS_KEY
unset SEEMIRAI_UPBIT_SECRET_KEY
unset UPBIT_ACCESS_KEY
unset UPBIT_SECRET_KEY

. "$M22_HOME/m22.env"

# systemd segment에서는 unit의 명시 guard와 segment handoff env가 m22.env 기본 0값에 묻히면 live segment가 fail-closed로만 종료된다.
if [ "$systemd_segment_guard" = "1" ]; then
  export SEEMIRAI_M23_SYSTEMD_SEGMENT="1"
  export SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT="\${systemd_pilot_guard:-1}"
  export SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON="\${systemd_daemon_guard:-1}"
  if [ -n "$systemd_segment_env" ]; then
    . "$systemd_segment_env"
  fi
fi

if [ "$#" -eq 0 ]; then
  candidate_file="\${SEEMIRAI_M23_SEGMENT_CANDIDATE_FILE:-$M22_HOME/candidates/m22-candidates.jsonl}"
  candidate_start="\${SEEMIRAI_M23_SEGMENT_CANDIDATE_START:-end}"
  pilot_command="node"
  set -- \\
    "$REPO_ROOT/scripts/run-m22-live-autonomous-daemon.mjs" \\
    --config "$M22_HOME/m22-live-autonomous.config.json" \\
    --candidate-file "$candidate_file" \\
    --candidate-start "$candidate_start"
else
  pilot_command="$1"
  shift
fi

exec node "$REPO_ROOT/scripts/run-m22-live-autonomous-pilot.mjs" \\
  --config "$M22_HOME/m22-live-autonomous.config.json" \\
  --duration-ms "$SEEMIRAI_M22_PILOT_DURATION_MS" \\
  --artifact-dir "$SEEMIRAI_M22_ARTIFACT_DIR" \\
  --require-daily-report \\
  --pilot-command "$pilot_command" \\
  -- "$@"
`;
}

function createManagedPaths(homeDir) {
  return {
    homeDir,
    artifactDir: path.join(homeDir, "artifacts"),
    evidenceDir: path.join(homeDir, "evidence"),
    candidateDir: path.join(homeDir, "candidates"),
    candidateFilePath: path.join(homeDir, "candidates", "m22-candidates.jsonl"),
    envPath: path.join(homeDir, "m22.env"),
    keysPath: path.join(homeDir, "m22.keys.env"),
    configPath: path.join(homeDir, "m22-live-autonomous.config.json"),
    readmePath: path.join(homeDir, "README.md"),
    fixtureSmokeScriptPath: path.join(homeDir, "run-fixture-smoke.sh"),
    run24hScriptPath: path.join(homeDir, "run-24h-pilot.sh"),
  };
}

async function ensureDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await chmod(dirPath, 0o700);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    dir: undefined,
    force: false,
    allowRepoDir: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dir":
        options.dir = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--force":
        options.force = true;
        break;
      case "--allow-repo-dir":
        options.allowRepoDir = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }

  return options;
}

function readRequiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} 값이 필요하다.`);
  }
  return value;
}

function expandHome(input) {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function modeString(mode) {
  return `0${mode.toString(8)}`;
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(`M22 운영 파일 준비 완료: ${summary.homeDir}\n`);
  process.stdout.write(`- env: ${summary.files.env.path} (${summary.files.env.status})\n`);
  process.stdout.write(`- key: ${summary.files.keys.path} (${summary.files.keys.status})\n`);
  process.stdout.write(`- config: ${summary.files.config.path} (${summary.files.config.status})\n`);
  process.stdout.write(`- no-live smoke: ${summary.files.fixtureSmokeScript.path}\n`);
  process.stdout.write(`- 24h wrapper: ${summary.files.run24hScript.path}\n`);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/prepare-m22-live-autonomous-local-files.mjs [options]

M22 제한적 완전 자동매매 pilot에 필요한 저장소 밖 env/key/config/evidence/script 템플릿을 만든다.

Options:
  --dir <path>          생성 위치. 기본값은 ~/vaults/99_운영/seemirai-m22-live-autonomous.
  --force               기존 템플릿 파일을 덮어쓴다. secret 값을 지울 수 있으므로 주의한다.
  --allow-repo-dir      저장소 내부 경로 생성을 허용한다. 기본은 실수 방지를 위해 차단한다.
  --json                결과를 JSON으로 출력한다.
  --help                도움말을 출력한다.
`);
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
