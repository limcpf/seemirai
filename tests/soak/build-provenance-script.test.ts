import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repositoryRoot, "scripts", "build-provenance.mjs");

describe("build provenance script", () => {
  it("현재 source와 dist가 marker 이후 바뀌면 actual provenance 검증을 차단한다", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "seemirai-build-provenance-"));
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const root = ${JSON.stringify(home)};
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "scripts"), { recursive: true });
      await fs.mkdir(path.join(root, "dist", "runtime"), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\\n"),
        fs.writeFile(path.join(root, "package.json"), "{}\\n"),
        fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\\n"),
        fs.writeFile(path.join(root, "tsconfig.json"), "{}\\n"),
        fs.writeFile(path.join(root, "tsconfig.build.json"), "{}\\n"),
        fs.writeFile(path.join(root, "scripts", "build-provenance.mjs"), "// build contract\\n"),
        fs.writeFile(path.join(root, "dist", "runtime", "index.js"), "export const value = 1;\\n"),
      ]);
      const sourceCommitSha = "a".repeat(40);
      const record = await module.writeBuildProvenance({
        repositoryRoot: root,
        sourceCommitSha,
        clock: () => new Date("2026-07-14T00:00:00.000Z"),
      });
      const verify = (overrides = {}) => module.verifyCurrentBuildProvenance({
        repositoryRoot: root,
        expectedSourceCommitSha: sourceCommitSha,
        readCurrentGitHead: async () => sourceCommitSha,
        readCurrentGitStatus: async () => "",
        ...overrides,
      });
      const verified = await verify();
      await fs.writeFile(path.join(root, "dist", "runtime", "index.js"), "export const value = 2;\\n");
      let staleDistError;
      try { await verify(); } catch (error) { staleDistError = error.message; }
      let wrongShaError;
      try {
        await verify({ readCurrentGitHead: async () => "b".repeat(40) });
      } catch (error) { wrongShaError = error.message; }
      let dirtySourceError;
      try {
        await verify({ readCurrentGitStatus: async () => " M scripts/run-m23-production-day-closeout.mjs\\n" });
      } catch (error) { dirtySourceError = error.message; }
      let untrackedSourceError;
      try {
        await verify({ readCurrentGitStatus: async () => "?? src/untracked.ts\\n" });
      } catch (error) { untrackedSourceError = error.message; }
      process.stdout.write(JSON.stringify({
        record, verified, staleDistError, wrongShaError, dirtySourceError, untrackedSourceError,
      }));
    `);

    expect(output.record).toEqual(output.verified);
    expect(output.staleDistError).toContain("현재 dist");
    expect(output.wrongShaError).toContain("source SHA");
    expect(output.dirtySourceError).toContain("commit되지 않은 tracked/untracked 변경");
    expect(output.untrackedSourceError).toContain("commit되지 않은 tracked/untracked 변경");
  });

  it("build clean은 dist만 제거한다", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "seemirai-build-clean-"));
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const root = ${JSON.stringify(home)};
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "dist", "stale.js"), "stale\\n");
      await fs.writeFile(path.join(root, "src", "index.ts"), "source\\n");
      await module.cleanBuildOutput(root);
      const distExists = await fs.access(path.join(root, "dist")).then(() => true, () => false);
      const sourceExists = await fs.access(path.join(root, "src", "index.ts")).then(() => true, () => false);
      process.stdout.write(JSON.stringify({ distExists, sourceExists }));
    `);
    expect(output).toEqual({ distExists: false, sourceExists: true });
  });

  it("marker에 포함된 untracked source도 실제 Git clean 검증에서 거부한다", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "seemirai-build-untracked-"));
    await mkdir(path.join(home, "src"), { recursive: true });
    await mkdir(path.join(home, "scripts"), { recursive: true });
    await mkdir(path.join(home, "dist", "runtime"), { recursive: true });
    await Promise.all([
      writeFile(path.join(home, ".gitignore"), "dist/\n"),
      writeFile(path.join(home, "src", "index.ts"), "export const value = 1;\n"),
      writeFile(path.join(home, "package.json"), "{}\n"),
      writeFile(path.join(home, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      writeFile(path.join(home, "tsconfig.json"), "{}\n"),
      writeFile(path.join(home, "tsconfig.build.json"), "{}\n"),
      writeFile(path.join(home, "scripts", "build-provenance.mjs"), "// build contract\n"),
      writeFile(path.join(home, "dist", "runtime", "index.js"), "export const value = 1;\n"),
    ]);
    await execFileAsync("git", ["init", "--quiet"], { cwd: home });
    await execFileAsync("git", ["add", "."], { cwd: home });
    await execFileAsync("git", [
      "-c", "user.name=Codex Test", "-c", "user.email=codex-test@example.invalid",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: home });
    await writeFile(path.join(home, "src", "untracked.ts"), "export const untracked = true;\n");
    await runModuleExpression(`
      const record = await module.writeBuildProvenance({ repositoryRoot: ${JSON.stringify(home)} });
      process.stdout.write(JSON.stringify(record));
    `);
    const output = await runModuleExpression(`
      let message;
      try {
        await module.verifyCurrentBuildProvenance({
          repositoryRoot: ${JSON.stringify(home)},
          expectedSourceCommitSha: ${JSON.stringify((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: home })).stdout.trim())},
        });
      } catch (error) { message = error.message; }
      process.stdout.write(JSON.stringify({ message }));
    `);
    expect(output.message).toContain("commit되지 않은 tracked/untracked 변경");
  });
});

async function runModuleExpression(expression: string): Promise<any> {
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(scriptPath)}); ${expression}`,
    ],
    { cwd: repositoryRoot, env: process.env },
  );
  return JSON.parse(result.stdout);
}
