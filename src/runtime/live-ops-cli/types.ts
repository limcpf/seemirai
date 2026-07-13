import type { LiveOpsRuntimeAdapterPort } from "../live-ops-runtime-adapter.js";

/**
 * production Live Ops CLI가 기존 `.mjs` support shim과 주고받는 최소 option 계약이다.
 *
 * 호출 경계는 `dist/runtime/*-cli.js` entry에서 시작해 repository-local `scripts/*-support.mjs`
 * compatibility module로 이어진다. 입력은 CLI argv를 support parser가 해석한 결과이며,
 * 출력은 각 support renderer 또는 runner가 stdout/status file에 남기는 사용자-facing 요약이다.
 * 이 타입은 Sub PR 01에서 build 산출물 entry만 고정하기 위한 얇은 경계이므로, core lifecycle
 * invariant와 side effect 의미는 기존 support module이 유지해야 한다.
 */
export type LiveOpsCliOptions = Record<string, unknown> & {
  help?: boolean;
  tui?: boolean;
  fixtureSmoke?: boolean;
  attach?: string;
  attachReadonly?: boolean;
  runtimeProvenance?: LiveOpsRuntimeProvenance;
};

/**
 * production daemon이 startup부터 각 tick까지 동일하게 유지해야 하는 실행 provenance다.
 *
 * source commit은 실제 daemon worktree HEAD를, config/env fingerprint는 검증을 통과한 입력 파일 원문을,
 * migration version은 provider/broker 경계를 열기 전 확인한 DB schema를 식별한다. 호출자는 이 값을
 * startup artifact와 latest status에 동일하게 보존해야 하며, tick 중 하나라도 달라지면 외부 provider나
 * broker side effect 전에 실행을 중단해야 한다. 값 자체에는 secret이나 DB 연결 문자열을 포함하지 않는다.
 */
export interface LiveOpsRuntimeProvenance {
  sourceCommitSha: string;
  configFingerprint: string;
  envFingerprint: string;
  expectedMigrationVersion: number;
  appliedMigrationVersion: number;
}

/**
 * production Live Ops daemon entry와 repository-local support module 사이의 실행 option 계약이다.
 *
 * parser는 fixture/help 외 실행에 source SHA와 repository 밖 startup artifact 경로가 반드시 존재하도록
 * 보장한다. runner는 시작 시 immutable artifact를 기록한 뒤 같은 provenance를 각 tick에 전달하고,
 * status 파일에는 secret 없이 최신 상태를 덮어쓴다. 이 타입은 경로와 실행 정책만 전달하며 파일 기록,
 * DB readiness 확인, provider/broker 호출 같은 외부 side effect는 daemon support가 소유한다.
 */
export type LiveOpsDaemonOptions = LiveOpsCliOptions & {
  sourceCommitSha?: string;
  startupArtifactFilePath?: string;
  statusFilePath?: string;
};

/**
 * `run-live-ops-support.mjs`에서 TypeScript dist entry가 호출하는 public compatibility surface다.
 *
 * support module은 config/env 해석, summary 생성, TUI 렌더링, readiness 판단의 기존 side effect를
 * 보존한다. dist entry는 parser와 renderer의 순서만 결정하며, provider 원본 payload나 secret을
 * 새로 만들거나 출력하지 않는 invariant를 유지해야 한다.
 */
export interface LiveOpsSupportModule {
  parseArgs(argv: readonly string[]): LiveOpsCliOptions;
  loadLiveOpsCliInputs(options: LiveOpsCliOptions): Promise<Record<string, unknown>>;
  createLiveOpsRuntimeAdapter?(): LiveOpsRuntimeAdapterPort;
  renderLiveOpsSummary(input: Record<string, unknown>): unknown;
  renderLiveOpsTuiDashboard(summary: unknown): string;
  assertLiveOpsCliSummaryReady(summary: unknown, options: { fixtureSmoke?: boolean }): void;
  printHelp(commandName: string): void;
  printJson(summary: unknown): void;
  printText(text: string): void;
}

/**
 * `run-live-ops-daemon-support.mjs`에서 dist daemon entry가 호출하는 반복 실행 compatibility surface다.
 *
 * daemon support는 loop tick, status file write, Telegram startup retry 같은 운영 side effect를
 * 소유한다. dist entry는 help 분기와 runner 호출만 담당하며, 반복 정책과 실패 복구 invariant를
 * 변경하지 않는다.
 */
export interface LiveOpsDaemonSupportModule {
  parseLiveOpsDaemonArgs(argv: readonly string[]): LiveOpsDaemonOptions;
  printLiveOpsDaemonHelp(): void;
  runLiveOpsDaemon(options: LiveOpsDaemonOptions): Promise<unknown>;
}

/**
 * `run-live-ops-pnl-closeout-support.mjs`에서 dist PnL closeout entry가 호출하는 compatibility surface다.
 *
 * PnL closeout support는 DB read/write와 append-only snapshot 판단을 소유한다. dist entry는 argv를
 * 전달하고 exit code만 보존해야 하며, 실패를 성공으로 낮추거나 secret-safe summary 계약을 바꾸면 안 된다.
 */
export interface LiveOpsPnlCloseoutSupportModule {
  runLiveOpsPnlCloseoutCli(argv: readonly string[]): Promise<number>;
}
