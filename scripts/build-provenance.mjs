#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildOutputDirectoryName = "dist";
const buildProvenanceFileName = "build-provenance.json";
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;
const sourceInputs = [
  "src",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
  "scripts/build-provenance.mjs",
];

if (isDirectExecution()) {
  try {
    const operation = process.argv[2];
    if (operation === "--clean") {
      await cleanBuildOutput(repositoryRoot);
    } else if (operation === "--write") {
      await writeBuildProvenance({ repositoryRoot });
    } else {
      throw new Error("--clean 또는 --write 작업이 필요합니다.");
    }
  } catch (error) {
    process.stderr.write(`build provenance 처리 실패: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * TypeScript build 전에 이전 dist를 제거해 삭제된 source의 stale JavaScript가 운영 import에 남지 않게 한다.
 *
 * repository의 `dist`만 제거하며 source나 저장소 밖 경로에는 side effect를 만들지 않는다.
 */
export async function cleanBuildOutput(root) {
  await rm(path.join(root, buildOutputDirectoryName), { recursive: true, force: true });
}

/**
 * 현재 source와 방금 생성된 dist의 fingerprint를 build marker로 기록한다.
 *
 * marker는 build 완료 뒤에만 생성한다. 운영 runner는 Git HEAD/clean 상태와 marker의 source/dist fingerprint를 다시 계산해
 * 현재 closeout script와 실제 import할 JavaScript가 같은 검증된 checkout에서 준비됐다는 invariant를 확인한다.
 */
export async function writeBuildProvenance({
  repositoryRoot: root,
  sourceCommitSha,
  clock = () => new Date(),
}) {
  const resolvedSourceCommitSha = sourceCommitSha ?? await readGitHead(root);
  if (!sourceShaPattern.test(resolvedSourceCommitSha)) {
    throw new Error("build source commit SHA가 40자리 lowercase hex가 아닙니다.");
  }
  const record = {
    schemaVersion: 1,
    kind: "seemirai_typescript_build",
    sourceCommitSha: resolvedSourceCommitSha,
    sourceTreeFingerprint: await fingerprintSourceTree(root),
    distTreeFingerprint: await fingerprintDistTree(root),
    generatedAt: clock().toISOString(),
  };
  const distDirectory = path.join(root, buildOutputDirectoryName);
  const markerPath = path.join(distDirectory, buildProvenanceFileName);
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await mkdir(distDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  await rename(temporaryPath, markerPath);
  return record;
}

/**
 * 운영 closeout checkout과 dist build marker가 명시 SHA 및 현재 파일 내용과 같은지 검증한다.
 *
 * Git과 파일을 read-only로 조회한다. tracked/untracked source가 dirty이거나 marker 이후 source/dist가 바뀌면 provider/DB 경계를 열기 전에
 * 실패하며, 검증된 secret-free provenance만 반환한다.
 */
export async function verifyCurrentBuildProvenance({
  repositoryRoot: root,
  expectedSourceCommitSha,
  readCurrentGitHead = readGitHead,
  readCurrentGitStatus = readGitStatus,
}) {
  let record;
  try {
    record = JSON.parse(await readFile(path.join(root, buildOutputDirectoryName, buildProvenanceFileName), "utf8"));
  } catch {
    throw new Error("dist build provenance marker를 읽을 수 없습니다. clean build를 먼저 실행해야 합니다.");
  }
  const [actualSourceCommitSha, repositoryStatus, sourceTreeFingerprint, distTreeFingerprint] = await Promise.all([
    readCurrentGitHead(root),
    readCurrentGitStatus(root),
    fingerprintSourceTree(root),
    fingerprintDistTree(root),
  ]);
  assertBuildProvenanceRecord({
    record,
    expectedSourceCommitSha,
    actualSourceCommitSha,
    repositoryStatus,
    sourceTreeFingerprint,
    distTreeFingerprint,
  });
  return record;
}

/** 현재 관측값과 build marker의 불변식을 비교한다. 외부 side effect는 없다. */
export function assertBuildProvenanceRecord({
  record,
  expectedSourceCommitSha,
  actualSourceCommitSha,
  repositoryStatus,
  sourceTreeFingerprint,
  distTreeFingerprint,
}) {
  if (!sourceShaPattern.test(String(expectedSourceCommitSha))) {
    throw new Error("closeout source commit SHA가 40자리 lowercase hex가 아닙니다.");
  }
  if (record?.schemaVersion !== 1
    || record.kind !== "seemirai_typescript_build"
    || !sourceShaPattern.test(String(record.sourceCommitSha))
    || !fingerprintPattern.test(String(record.sourceTreeFingerprint))
    || !fingerprintPattern.test(String(record.distTreeFingerprint))
    || Number.isNaN(Date.parse(record.generatedAt))) {
    throw new Error("dist build provenance marker 형식이 올바르지 않습니다.");
  }
  if (actualSourceCommitSha !== expectedSourceCommitSha || record.sourceCommitSha !== expectedSourceCommitSha) {
    throw new Error("현재 closeout checkout 또는 dist build source SHA가 기대값과 다릅니다.");
  }
  if (repositoryStatus.trim().length > 0) {
    // untracked build 입력도 commit으로 재현할 수 없으므로 어떤 checkout 변경도 actual closeout에서 허용하지 않는다.
    throw new Error("현재 closeout checkout에 commit되지 않은 tracked/untracked 변경이 있습니다.");
  }
  if (record.sourceTreeFingerprint !== sourceTreeFingerprint) {
    throw new Error("현재 closeout source가 dist build 시점과 다릅니다.");
  }
  if (record.distTreeFingerprint !== distTreeFingerprint) {
    throw new Error("현재 dist가 검증된 clean build 산출물과 다릅니다.");
  }
}

/** build 입력 전체를 경로와 byte 순서까지 포함한 fingerprint로 낮춘다. */
export async function fingerprintSourceTree(root) {
  const files = [];
  for (const input of sourceInputs) {
    files.push(...await collectFiles(root, input));
  }
  return fingerprintFiles(root, files);
}

/** marker 자신을 제외한 dist 전체를 경로와 byte 순서까지 포함한 fingerprint로 낮춘다. */
export async function fingerprintDistTree(root) {
  const files = (await collectFiles(root, buildOutputDirectoryName))
    .filter((file) => file !== `${buildOutputDirectoryName}/${buildProvenanceFileName}`
      && !file.startsWith(`${buildOutputDirectoryName}/${buildProvenanceFileName}.`));
  if (files.length === 0) {
    throw new Error("fingerprint할 dist build 산출물이 없습니다.");
  }
  return fingerprintFiles(root, files);
}

async function collectFiles(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const fileStat = await lstat(absolutePath);
  if (fileStat.isSymbolicLink()) {
    throw new Error(`build provenance 입력에 symbolic link를 사용할 수 없습니다: ${relativePath}`);
  }
  if (fileStat.isFile()) {
    return [normalizeRelativePath(relativePath)];
  }
  if (!fileStat.isDirectory()) {
    throw new Error(`build provenance 입력이 일반 파일 또는 디렉터리가 아닙니다: ${relativePath}`);
  }
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => collectFiles(root, path.join(relativePath, entry.name))));
  return nested.flat();
}

async function fingerprintFiles(root, files) {
  const hash = createHash("sha256");
  for (const relativePath of [...new Set(files)].sort()) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(path.join(root, relativePath)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readGitHead(root) {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.stdout.trim().toLowerCase();
}

async function readGitStatus(root) {
  const result = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout;
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isDirectExecution() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}
