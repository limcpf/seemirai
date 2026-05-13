import { access, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const requiredEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

async function main() {
  const errors = [];
  const hooksJsonPath = toAbsolute(".codex/hooks.json");
  const configPath = toAbsolute(".codex/config.toml");
  const hooksJson = JSON.parse(await readFile(hooksJsonPath, "utf8"));
  const config = await readFile(configPath, "utf8");

  for (const eventName of requiredEvents) {
    if (!Array.isArray(hooksJson.hooks?.[eventName]) || hooksJson.hooks[eventName].length === 0) {
      errors.push(`hooks.json 에 ${eventName} hook 이 없습니다.`);
    }
  }

  if (!/^\s*hooks\s*=\s*true\s*(?:#.*)?$/m.test(config)) {
    errors.push(".codex/config.toml 에 hooks = true 설정이 없습니다.");
  }

  if (/^\s*codex_hooks\s*=/.test(config)) {
    errors.push(".codex/config.toml 에 deprecated codex_hooks 설정이 남아 있습니다. hooks = true 를 사용하세요.");
  }

  const commands = collectHookCommands(hooksJson);
  for (const command of commands) {
    const hookPaths = extractHookScriptPaths(command);
    if (hookPaths.length === 0) {
      errors.push(`hook command 에 .codex/hooks 스크립트 경로가 없습니다: ${command}`);
      continue;
    }

    for (const hookPath of hookPaths) {
      if (!(await exists(toAbsolute(hookPath)))) {
        errors.push(`hook command 대상 파일이 존재하지 않습니다: ${hookPath}`);
      }
    }
  }

  const mjsFiles = await collectFiles(".codex/hooks", ".mjs");
  for (const filePath of [
    ...mjsFiles,
    "scripts/verify-doc-structure.mjs",
    "scripts/verify-github.mjs",
    "scripts/verify-hooks.mjs",
  ]) {
    const result = spawnSync("node", ["--check", filePath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      errors.push(`${filePath} 문법 검증 실패: ${result.stderr.trim()}`);
    }
  }

  for (const shellPath of [".codex/hooks/pre-tool-use.sh", ".codex/hooks/post-tool-use.sh", "scripts/verify"]) {
    if (!(await exists(toAbsolute(shellPath)))) {
      errors.push(`shell hook wrapper 가 없습니다: ${shellPath}`);
      continue;
    }

    const result = spawnSync("sh", ["-n", shellPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      errors.push(`${shellPath} shell 문법 검증 실패: ${result.stderr.trim()}`);
    }
  }

  if (errors.length > 0) {
    console.error("hook 검증에 실패했습니다.");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`hook 검증 성공: 이벤트 ${requiredEvents.length}개, command ${commands.length}개, mjs ${mjsFiles.length + 2}개를 확인했습니다.`);
}

function collectHookCommands(payload) {
  const commands = [];

  function visit(value) {
    if (value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (typeof value.command === "string") {
      commands.push(value.command);
    }

    for (const nested of Object.values(value)) {
      visit(nested);
    }
  }

  visit(payload);
  return commands;
}

function extractHookScriptPaths(command) {
  const paths = [];
  const pattern = /\.codex\/hooks\/([A-Za-z0-9._-]+\.(?:mjs|sh))/g;
  for (const match of command.matchAll(pattern)) {
    paths.push(`.codex/hooks/${match[1]}`);
  }

  return paths;
}

async function collectFiles(startRelPath, extension) {
  const absolutePath = toAbsolute(startRelPath);
  const dirents = await readdir(absolutePath, { withFileTypes: true });
  const collected = [];

  for (const dirent of dirents) {
    const childPath = path.posix.join(startRelPath, dirent.name);
    if (dirent.isDirectory()) {
      collected.push(...(await collectFiles(childPath, extension)));
      continue;
    }

    if (dirent.isFile() && childPath.endsWith(extension)) {
      collected.push(childPath);
    }
  }

  return collected.sort((left, right) => left.localeCompare(right));
}

function toAbsolute(filePath) {
  return path.join(repoRoot, filePath);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

await main();
