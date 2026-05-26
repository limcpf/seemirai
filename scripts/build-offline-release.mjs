#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDir = path.join(repoRoot, ".local", "releases");
const forbiddenDirectoryNames = new Set([
  ".git",
  ".local",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);
const forbiddenFileNames = new Set([".DS_Store"]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const packageName = validatePackageName(options.packageName ?? `seemirai-offline-${packageJson.version}`);
  const outputDir = path.resolve(options.outputDir ?? defaultOutputDir);
  const stagingRoot = path.join(outputDir, ".staging");
  const packageRoot = path.join(stagingRoot, packageName);
  const archivePath = path.join(outputDir, `${packageName}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  const workspaceDir = path.join(packageRoot, "workspace");
  const repositoryDir = path.join(packageRoot, "repository");
  const pnpmStoreDir = path.join(repositoryDir, "pnpm-store");

  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(pnpmStoreDir, { recursive: true });
  await mkdir(path.join(packageRoot, "maven"), { recursive: true });
  await copyReleaseWorkspace(workspaceDir, { outputDir, stagingRoot, packageRoot });
  await writeOfflineEntrypoints(packageRoot);

  if (options.skipFetch) {
    await writeFile(path.join(pnpmStoreDir, ".keep"), "test-only empty offline cache\n", "utf8");
  } else {
    await run("corepack", ["pnpm", "fetch", "--frozen-lockfile", "--store-dir", pnpmStoreDir], {
      cwd: workspaceDir,
      stdoutToStderr: options.json,
    });
    await rm(path.join(workspaceDir, "node_modules"), { recursive: true, force: true });
  }

  await assertNoForbiddenReleaseFiles(packageRoot);
  await rm(archivePath, { force: true });
  await rm(checksumPath, { force: true });
  await run("tar", ["-czf", archivePath, "-C", stagingRoot, packageName], { cwd: repoRoot });
  const archiveSha256 = await sha256File(archivePath);
  await writeFile(checksumPath, `${archiveSha256}  ${path.basename(archivePath)}\n`, "utf8");

  const summary = {
    packageName,
    packageRoot,
    archivePath,
    checksumPath,
    archiveSha256,
    workspaceDir,
    repositoryDir,
    pnpmStoreDir,
    skippedFetch: options.skipFetch,
  };

  if (options.json) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(`offline release archive: ${archivePath}`);
    console.log(`checksum: ${checksumPath}`);
  }
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output-dir") {
      options.outputDir = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--package-name") {
      options.packageName = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--skip-fetch") {
      options.skipFetch = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requireValue(args, index, arg) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function validatePackageName(packageName) {
  if (!/^[A-Za-z0-9._-]+$/u.test(packageName)) {
    throw new Error("--package-name must contain only letters, numbers, dot, underscore, and hyphen");
  }
  if (packageName === "." || packageName === ".." || packageName.includes("..")) {
    throw new Error("--package-name must not contain path traversal segments");
  }
  return packageName;
}

async function copyReleaseWorkspace(targetDir, excludedRoots) {
  await mkdir(targetDir, { recursive: true });
  const trackedFiles = (await hasGitMetadata())
    ? await collectGitTrackedFiles()
    : await collectWorkspaceFilesFromDisk(repoRoot, excludedRoots);

  for (const relativePath of trackedFiles) {
    const sourcePath = path.join(repoRoot, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyWorkspaceEntry(sourcePath, targetPath);
  }
}

async function hasGitMetadata() {
  try {
    await access(path.join(repoRoot, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function collectGitTrackedFiles() {
  const trackedFilesOutput = await runCapture("git", ["ls-files", "--stage", "-z"], { cwd: repoRoot });
  return trackedFilesOutput
    .split("\0")
    .filter((entry) => entry !== "")
    .map(toGitTrackedFile)
    .filter((entry) => entry !== undefined)
    .filter(({ relativePath }) => !shouldExcludeRelativePath(relativePath))
    .map(({ relativePath }) => relativePath);
}

function toGitTrackedFile(entry) {
  const tabIndex = entry.indexOf("\t");
  if (tabIndex < 0) {
    return undefined;
  }

  const metadata = entry.slice(0, tabIndex);
  const [mode] = metadata.split(" ");
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    return undefined;
  }

  return { relativePath: entry.slice(tabIndex + 1) };
}

async function collectWorkspaceFilesFromDisk(currentDir, excludedRoots) {
  const collected = [];
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(repoRoot, sourcePath).split(path.sep).join("/");

    if (shouldExcludeSourcePath(sourcePath, relativePath, excludedRoots)) {
      continue;
    }

    if (entry.isDirectory()) {
      collected.push(...(await collectWorkspaceFilesFromDisk(sourcePath, excludedRoots)));
      continue;
    }

    if (entry.isFile()) {
      collected.push(relativePath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      collected.push(relativePath);
    }
  }

  return collected.sort((left, right) => left.localeCompare(right));
}

function shouldExcludeSourcePath(sourcePath, relativePath, excludedRoots) {
  return (
    shouldExcludeRelativePath(relativePath) ||
    isSameOrInside(sourcePath, excludedRoots.outputDir) ||
    isSameOrInside(sourcePath, excludedRoots.stagingRoot) ||
    isSameOrInside(sourcePath, excludedRoots.packageRoot)
  );
}

function isSameOrInside(candidatePath, parentPath) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function shouldExcludeRelativePath(relativePath) {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const baseName = path.basename(normalizedPath);
  if (forbiddenDirectoryNames.has(baseName) || forbiddenFileNames.has(baseName)) {
    return true;
  }

  if (baseName === ".env" || (baseName.startsWith(".env.") && baseName !== ".env.example")) {
    return true;
  }

  return normalizedPath === ".codex/tmp" || normalizedPath.startsWith(".codex/tmp/");
}

async function writeOfflineEntrypoints(packageRoot) {
  const workspaceDir = path.join(packageRoot, "workspace");
  await writeFile(
    path.join(packageRoot, "maven", "README.txt"),
    [
      "Seemirai 폐쇄망 번들의 호환 디렉터리입니다.",
      "이 프로젝트는 Node/pnpm 기반이며, 운영자 편의를 위한 Maven-style wrapper 진입점은 workspace/에 둡니다.",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(workspaceDir, "mvnw"),
    [
      "#!/usr/bin/env sh",
      "set -eu",
      'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      'PNPM_STORE_DIR="$SCRIPT_DIR/../repository/pnpm-store"',
      'cd "$SCRIPT_DIR"',
      'corepack pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE_DIR"',
      "corepack pnpm typecheck",
      "corepack pnpm test",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path.join(workspaceDir, "mvnw"), 0o755);

  await writeFile(
    path.join(workspaceDir, "mvnw.cmd"),
    [
      "@echo off",
      "setlocal",
      'set "SCRIPT_DIR=%~dp0"',
      'set "PNPM_STORE_DIR=%SCRIPT_DIR%..\\repository\\pnpm-store"',
      'pushd "%SCRIPT_DIR%" || exit /b 1',
      'corepack pnpm install --offline --frozen-lockfile --store-dir "%PNPM_STORE_DIR%"',
      "if errorlevel 1 exit /b %errorlevel%",
      "corepack pnpm typecheck",
      "if errorlevel 1 exit /b %errorlevel%",
      "corepack pnpm test",
      "if errorlevel 1 exit /b %errorlevel%",
      "popd",
      "endlocal",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

async function assertNoForbiddenReleaseFiles(rootDir) {
  const forbidden = [];
  await walk(rootDir, async (filePath) => {
    const baseName = path.basename(filePath);
    if (baseName === ".env" || (baseName.startsWith(".env.") && baseName !== ".env.example")) {
      forbidden.push(path.relative(rootDir, filePath));
    }
  });

  if (forbidden.length > 0) {
    throw new Error(`Forbidden secret-like files in offline release: ${forbidden.join(", ")}`);
  }
}

async function copyWorkspaceEntry(sourcePath, targetPath) {
  let sourceStat;
  try {
    sourceStat = await lstat(sourcePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (sourceStat.isSymbolicLink()) {
    await symlink(await readlink(sourcePath), targetPath);
    return;
  }

  if (sourceStat.isFile()) {
    await copyFile(sourcePath, targetPath);
  }
}

async function walk(dir, onFile) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, onFile);
      continue;
    }
    if (entry.isFile()) {
      await onFile(entryPath);
    }
  }
}

async function sha256File(filePath) {
  await access(filePath);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdoutToStderr ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    child.stdout?.pipe(process.stderr);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function runCapture(command, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString("utf8"));
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}: ${Buffer.concat(stderrChunks)}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
