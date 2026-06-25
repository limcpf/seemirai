import { pathToFileURL } from "node:url";

/**
 * ESM entry가 직접 실행된 경우와 test/import로 로드된 경우를 구분한다.
 *
 * 입력은 현재 module URL과 process argv이며, 출력은 CLI side effect를 시작해도 되는지 여부다.
 * 이 경계는 unit test가 entry function을 import할 때 process exit code를 오염시키지 않는 invariant를
 * 유지하고, 파일 시스템이나 네트워크 side effect를 만들지 않는다.
 */
export function isDirectCliModule(moduleUrl: string, argv: NodeJS.Process["argv"] = process.argv): boolean {
  const entryPath = argv[1];
  if (entryPath === undefined) {
    return false;
  }

  return moduleUrl === pathToFileURL(entryPath).href;
}

/**
 * CLI 실패를 사용자가 읽을 수 있는 한국어 prefix와 함께 stderr에 기록한다.
 *
 * 입력은 command label과 unknown error이고, 출력은 process exit code로 사용할 실패 코드다. 이 함수는
 * stderr write 외 side effect를 만들지 않으며, 내부 error 객체를 raw payload로 직렬화하지 않는
 * secret-safe 출력 invariant를 유지한다.
 */
export function writeCliFailure(commandName: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  // 실패 원문 전체를 JSON으로 노출하지 않고 message만 출력해 secret-like payload 확산을 막는다.
  process.stderr.write(`${commandName} 실패: ${message}\n`);
  return 1;
}
