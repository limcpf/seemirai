import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonRecord } from "../../src/domain/index.js";

const DEFAULT_UPBIT_SMOKE_ARTIFACT_DIR = path.join(process.cwd(), "test-results", "upbit-smoke");
const RAW_AUTHORIZATION_HEADER_PATTERN = /bearer\s+[A-Za-z0-9._-]+/iu;
const RAW_AUTHORIZATION_FIELD_PATTERN = /"authorization"\s*:/iu;
const RAW_JWT_FIELD_PATTERN = /"jwt"\s*:/iu;

/**
 * Upbit smoke artifact 저장 입력이다.
 *
 * 통합 테스트 runner만 호출하며, 저장 전 artifact 안에 raw Upbit credential이나 raw Authorization/JWT 필드가 없는지
 * 검사한다. 파일 write side effect는 `test-results/` 또는 운영자가 지정한 저장소 밖 디렉터리로 제한한다.
 */
export interface WriteUpbitSmokeArtifactInput {
  filePrefix: string;
  artifact: JsonRecord;
  env?: NodeJS.ProcessEnv;
}

/**
 * Upbit smoke artifact를 secret-safe JSON 파일로 저장한다.
 *
 * 기본 저장 경로는 gitignore 대상인 `test-results/upbit-smoke`이며, 실제 운영 smoke는
 * `SEEMIRAI_UPBIT_SMOKE_ARTIFACT_DIR`로 저장소 밖 경로를 지정할 수 있다. 저장 전 redaction 검사를 통과하지 못하면 파일을
 * 쓰지 않아 raw secret이 disk artifact로 남지 않는 invariant를 유지한다.
 */
export async function writeUpbitSmokeArtifact(input: WriteUpbitSmokeArtifactInput): Promise<string> {
  assertUpbitSmokeArtifactHasNoSecretText(input.artifact, input.env ?? process.env);

  const artifactDir = resolveUpbitSmokeArtifactDir(input.env ?? process.env);
  await mkdir(artifactDir, { recursive: true });

  const filePath = path.join(
    artifactDir,
    `${sanitizeFilePrefix(input.filePrefix)}-${toArtifactTimestamp()}-${randomUUID()}.json`,
  );
  await writeFile(filePath, `${JSON.stringify(input.artifact, null, 2)}\n`, "utf8");

  return filePath;
}

/**
 * Upbit smoke artifact의 raw secret 포함 여부를 검사한다.
 *
 * 이 함수는 저장 전후 검증과 단위 테스트에서 공유한다. env의 access/secret key 값, raw Bearer header, Authorization/JWT
 * top-level field를 artifact에 남기지 않는 것이 목적이며, 안전한 권한 evidence id나 한국어 안내 문구는 차단하지 않는다.
 */
export function assertUpbitSmokeArtifactHasNoSecretText(
  artifact: JsonRecord,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const serialized = JSON.stringify(artifact);
  for (const envKey of ["SEEMIRAI_UPBIT_ACCESS_KEY", "SEEMIRAI_UPBIT_SECRET_KEY"]) {
    const value = env[envKey]?.trim();
    if (value !== undefined && value.length >= 8 && serialized.includes(value)) {
      throw new Error(`Upbit smoke artifact에 ${envKey} 원문이 포함되어 저장을 중단했습니다`);
    }
  }

  if (RAW_AUTHORIZATION_HEADER_PATTERN.test(serialized) || RAW_AUTHORIZATION_FIELD_PATTERN.test(serialized)) {
    throw new Error("Upbit smoke artifact에 raw Authorization header가 포함되어 저장을 중단했습니다");
  }

  if (RAW_JWT_FIELD_PATTERN.test(serialized)) {
    throw new Error("Upbit smoke artifact에 raw JWT field가 포함되어 저장을 중단했습니다");
  }
}

function resolveUpbitSmokeArtifactDir(env: NodeJS.ProcessEnv): string {
  const configuredDir = env.SEEMIRAI_UPBIT_SMOKE_ARTIFACT_DIR?.trim();
  return path.resolve(
    configuredDir === undefined || configuredDir.length === 0 ? DEFAULT_UPBIT_SMOKE_ARTIFACT_DIR : configuredDir,
  );
}

function sanitizeFilePrefix(filePrefix: string): string {
  return filePrefix.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
}

function toArtifactTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}
