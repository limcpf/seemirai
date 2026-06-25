import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  LiveOpsDaemonSupportModule,
  LiveOpsPnlCloseoutSupportModule,
  LiveOpsSupportModule,
} from "./types.js";

/**
 * dist CLI entry가 repository-local support shim을 동적으로 불러오는 경계다.
 *
 * 입력은 repository root 기준 `scripts/` 아래 파일명이고, 출력은 호출자가 기대하는 support module이다.
 * `process.cwd()`를 기준으로 삼아 `node dist/runtime/*-cli.js` 실행 계약을 고정하며, 이 함수 자체는
 * import 외 side effect를 만들지 않는다. 후속 sub PR에서 core가 TypeScript로 이동하면 이 shim 의존은
 * entry 내부에서 제거되어야 한다.
 */
async function importRepoScriptModule<TModule extends object>(scriptName: string): Promise<TModule> {
  const scriptUrl = pathToFileURL(resolve(process.cwd(), "scripts", scriptName)).href;
  // dist entry가 build 산출물이어도 기존 운영 의미는 support shim이 소유하므로 dynamic import 경계를 좁혀 둔다.
  return (await import(scriptUrl)) as TModule;
}

/**
 * `live:ops`와 `live:ops:tui` dist entry가 공유하는 support module을 로드한다.
 *
 * 반환 module은 기존 CLI parser/renderer contract를 그대로 노출해야 하며, dist entry는 load 순서를
 * 바꾸지 않는다. 외부 side effect는 ESM import evaluation에 한정된다.
 */
export async function loadLiveOpsSupportModule(): Promise<LiveOpsSupportModule> {
  return importRepoScriptModule<LiveOpsSupportModule>("run-live-ops-support.mjs");
}

/**
 * `live:ops:daemon` dist entry의 반복 실행 support module을 로드한다.
 *
 * daemon loop와 status file 기록은 support module 책임으로 남겨 두며, 이 loader는 빌드 산출물 실행
 * 계약과 legacy shim 경계를 연결하는 역할만 한다.
 */
export async function loadLiveOpsDaemonSupportModule(): Promise<LiveOpsDaemonSupportModule> {
  return importRepoScriptModule<LiveOpsDaemonSupportModule>("run-live-ops-daemon-support.mjs");
}

/**
 * `live:ops:pnl-closeout` dist entry의 DB snapshot closeout support module을 로드한다.
 *
 * DB write와 PnL 계산 invariant는 support module이 유지해야 하며, loader는 module URL 해석 외
 * side effect를 만들지 않는다.
 */
export async function loadLiveOpsPnlCloseoutSupportModule(): Promise<LiveOpsPnlCloseoutSupportModule> {
  return importRepoScriptModule<LiveOpsPnlCloseoutSupportModule>("run-live-ops-pnl-closeout-support.mjs");
}
