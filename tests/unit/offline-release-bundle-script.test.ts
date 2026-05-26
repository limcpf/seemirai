import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
