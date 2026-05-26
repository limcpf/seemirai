import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "build-offline-release.mjs");

describe("offline release bundle script", () => {
  it("builds the required offline bundle layout with wrapper entrypoints and checksum", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-offline-release-"));
    const packageName = "seemirai-offline-test";
    const untrackedFileName = "UNTRACKED_OFFLINE_RELEASE_SHOULD_NOT_COPY.tmp";
    const hasGitMetadata = await pathExists(path.join(process.cwd(), ".git"));
    if (hasGitMetadata) {
      await writeFile(path.join(process.cwd(), untrackedFileName), "do not package\n", "utf8");
    }
    try {
      const { stdout } = await execFileAsync("node", [
        scriptPath,
        "--output-dir",
        outputDir,
        "--package-name",
        packageName,
        "--skip-fetch",
        "--json",
      ]);
      const summary = JSON.parse(stdout) as {
        archivePath: string;
        checksumPath: string;
        archiveSha256: string;
        packageRoot: string;
      };

      await expect(stat(summary.archivePath)).resolves.toBeDefined();
      await expect(stat(summary.checksumPath)).resolves.toBeDefined();
      await expect(readFile(summary.checksumPath, "utf8")).resolves.toBe(
        `${summary.archiveSha256}  ${path.basename(summary.archivePath)}\n`,
      );
      expect(await sha256File(summary.archivePath)).toBe(summary.archiveSha256);

      const extractDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-offline-release-extract-"));
      await execFileAsync("tar", ["-xzf", summary.archivePath, "-C", extractDir]);
      const packageRoot = path.join(extractDir, packageName);
      const unixWrapper = await readFile(path.join(packageRoot, "workspace", "mvnw"), "utf8");
      const windowsWrapper = await readFile(path.join(packageRoot, "workspace", "mvnw.cmd"), "utf8");

      await expect(stat(path.join(packageRoot, "maven", "README.txt"))).resolves.toBeDefined();
      await expect(stat(path.join(packageRoot, "repository", "pnpm-store", ".keep"))).resolves.toBeDefined();
      await expect(stat(path.join(packageRoot, "workspace", "package.json"))).resolves.toBeDefined();
      await expect(stat(path.join(packageRoot, "workspace", ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(packageRoot, "workspace", ".env"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(packageRoot, "workspace", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
      if (hasGitMetadata) {
        await expect(stat(path.join(packageRoot, "workspace", untrackedFileName))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(unixWrapper).toContain("pnpm install --offline --frozen-lockfile");
      expect(unixWrapper).toContain('PNPM_STORE_DIR="$SCRIPT_DIR/../repository/pnpm-store"');
      expect(windowsWrapper).toContain("pnpm install --offline --frozen-lockfile");
      expect(windowsWrapper).toContain('PNPM_STORE_DIR=%SCRIPT_DIR%..\\repository\\pnpm-store');
    } finally {
      if (hasGitMetadata) {
        await rm(path.join(process.cwd(), untrackedFileName), { force: true });
      }
    }
  }, 20_000);

  it("rejects package names that can escape the staging directory", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-offline-release-invalid-name-"));

    await expect(
      execFileAsync("node", [
        scriptPath,
        "--output-dir",
        outputDir,
        "--package-name",
        "../bad",
        "--skip-fetch",
        "--json",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--package-name must contain only letters"),
    });
  });

  it("rejects package names that tar can parse as options", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-offline-release-option-name-"));

    await expect(
      execFileAsync("node", [
        scriptPath,
        "--output-dir",
        outputDir,
        "--package-name",
        "-bad",
        "--skip-fetch",
        "--json",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--package-name must not start with hyphen"),
    });
  });

  it("filters forbidden directory segments from git tracked release inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-offline-release-fake-index-"));
    const outputDir = path.join(tempDir, "release");
    const fakeIndexPath = path.join(tempDir, "index");
    const packageName = "seemirai-offline-forbidden-segment";
    const leakRelativePath = "offline-release-forbidden-fixture/node_modules/leak.txt";
    const leakPath = path.join(process.cwd(), leakRelativePath);

    await mkdir(path.dirname(leakPath), { recursive: true });
    await writeFile(leakPath, "must not be packaged\n", "utf8");

    try {
      const { stdout: hashStdout } = await execFileAsync("git", ["hash-object", "-w", leakPath], {
        cwd: process.cwd(),
      });
      await updateFakeIndex(
        fakeIndexPath,
        `100644 ${hashStdout.trim()} 0\t${leakRelativePath}\n`,
      );

      const { stdout } = await execFileAsync(
        "node",
        [scriptPath, "--output-dir", outputDir, "--package-name", packageName, "--skip-fetch", "--json"],
        { env: { ...process.env, GIT_INDEX_FILE: fakeIndexPath } },
      );
      const summary = JSON.parse(stdout) as { archivePath: string };
      const extractDir = path.join(tempDir, "extract");

      await mkdir(extractDir, { recursive: true });
      await execFileAsync("tar", ["-xzf", summary.archivePath, "-C", extractDir]);
      await expect(stat(path.join(extractDir, packageName, "workspace", leakRelativePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(path.join(process.cwd(), "offline-release-forbidden-fixture"), { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the git index contains unresolved conflict stages", async () => {
    if (!(await pathExists(path.join(process.cwd(), ".git")))) {
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-offline-release-conflict-index-"));
    const outputDir = path.join(tempDir, "release");
    const fakeIndexPath = path.join(tempDir, "index");
    const conflictFilePath = path.join(tempDir, "conflict.txt");

    await writeFile(conflictFilePath, "conflict side\n", "utf8");
    const { stdout: hashStdout } = await execFileAsync("git", ["hash-object", "-w", conflictFilePath], {
      cwd: process.cwd(),
    });
    await updateFakeIndex(fakeIndexPath, `100644 ${hashStdout.trim()} 1\tconflict.txt\n`);

    try {
      await expect(
        execFileAsync(
          "node",
          [scriptPath, "--output-dir", outputDir, "--package-name", "seemirai-offline-conflict", "--skip-fetch", "--json"],
          { env: { ...process.env, GIT_INDEX_FILE: fakeIndexPath } },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("unresolved Git conflict stage 1"),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function updateFakeIndex(fakeIndexPath: string, indexInfo: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["update-index", "--index-info"], {
      cwd: process.cwd(),
      env: { ...process.env, GIT_INDEX_FILE: fakeIndexPath },
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];

    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git update-index --index-info exited with code ${code}: ${Buffer.concat(stderrChunks)}`));
    });
    child.stdin.end(indexInfo);
  });
}
