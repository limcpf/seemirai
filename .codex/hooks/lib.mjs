import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const structuralPaths = new Set([
  ".codex/config.toml",
  ".codex/hooks.json",
  ".github/pull_request_template.md",
  ".github/workflows/verify.yml",
  "scripts/verify",
  "scripts/verify-doc-structure.mjs",
  "scripts/verify-github.mjs",
  "scripts/verify-hooks.mjs",
]);

export const lockfileNames = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
]);

export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = chunks.join("").trim();
  if (raw === "") {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function resolveRepoRoot(cwd) {
  const start = path.resolve(cwd ?? process.cwd());
  const gitRoot = runGit(start, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (gitRoot !== "") {
    return normalizeRepoPath(gitRoot);
  }

  let current = start;
  while (true) {
    if (
      existsSync(path.join(current, "AGENTS.md")) ||
      existsSync(path.join(current, "package.json")) ||
      existsSync(path.join(current, ".codex"))
    ) {
      return normalizeRepoPath(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return normalizeRepoPath(start);
    }

    current = parent;
  }
}

export function normalizeRepoPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function getCurrentBranch(repoRoot) {
  const result = runGit(repoRoot, ["branch", "--show-current"]);
  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
}

export function repoHasCommits(repoRoot) {
  return runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]).status === 0;
}

export function getRepoName(repoRoot) {
  return path.basename(repoRoot);
}

export function getDefaultWorktreeRoot(repoRoot) {
  return normalizeRepoPath(path.join(path.dirname(repoRoot), `${getRepoName(repoRoot)}-worktrees`));
}

export function findNearestAgentsPath(cwd, repoRoot) {
  let currentDir = normalizeRepoPath(path.resolve(cwd ?? repoRoot));
  const normalizedRoot = normalizeRepoPath(path.resolve(repoRoot));

  while (currentDir.startsWith(normalizedRoot)) {
    const candidate = path.join(currentDir, "AGENTS.md");
    if (existsSync(candidate)) {
      return normalizeRepoPath(candidate);
    }

    if (currentDir === normalizedRoot) {
      break;
    }

    currentDir = normalizeRepoPath(path.dirname(currentDir));
  }

  return normalizeRepoPath(path.join(normalizedRoot, "AGENTS.md"));
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

export function extractToolCommand(input) {
  const candidates = [
    input?.tool_input,
    input?.toolInput,
    input?.tool?.input,
    input?.input,
    input,
  ];

  for (const candidate of candidates) {
    const command = findToolCommand(unwrapJsonLikeValue(candidate));
    if (command !== null) {
      return command;
    }
  }

  return "";
}

export function isDangerousCommand(command) {
  return [
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+checkout\s+--\b/,
    /\bgit\s+clean\s+-[^\n;|&]*[fd]/,
    /\bgit\s+push\b[^\n;|&]*(--force|-f)(\s|$)/,
    /\bgh\s+pr\s+(merge|close)\b/,
    /\brm\s+-[^\n;|&]*r[^\n;|&]*f\b/,
    /\brm\s+-[^\n;|&]*f[^\n;|&]*r\b/,
    /\bsudo\s+rm\b/,
  ].some((pattern) => pattern.test(command));
}

export function isSecretAccessCommand(command) {
  const readsFile = /\b(cat|sed|awk|grep|rg|head|tail|less|more|vim|vi|nano|code)\b/.test(command);
  if (!readsFile) {
    return false;
  }

  return [
    /(^|[\s"'=])\.env($|[\s"'])/,
    /(^|[\s"'=])\.env\.[A-Za-z0-9_-]+($|[\s"'])/,
    /id_rsa/,
    /id_ed25519/,
    /credentials(\.json)?/,
    /secret(s)?\.(json|yaml|yml|toml|env)/,
    /\.(pem|p12|pfx|key)($|[\s"'])/,
  ].some((pattern) => pattern.test(command)) && !/\.env\.example/.test(command);
}

export function isMutatingCommand(command) {
  const trimmed = command.trim();
  if (trimmed === "") {
    return false;
  }

  return [
    /^apply_patch\b/,
    /\b(git\s+(add|commit|push|merge|rebase|cherry-pick|switch\s+-c|branch\s+-D|worktree\s+(add|remove)))\b/,
    /\b(gh\s+(issue|pr|api|release))\b/,
    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci)\b/,
    /\b(rm|mv|cp|mkdir|touch|chmod|chown)\b/,
    />{1,2}/,
    /\bsed\s+-i\b/,
    /\bperl\s+-pi\b/,
  ].some((pattern) => pattern.test(trimmed));
}

export function isVerifyCommand(command) {
  return [
    /(^|\s)(\.\/)?scripts\/verify(\s|$)/,
    /(^|\s)(\.\/)?scripts\/verify\s+(docs|hooks|github|all)(\s|$)/,
    /(^|\s)node\s+scripts\/verify-doc-structure\.mjs(\s|$)/,
    /(^|\s)node\s+scripts\/verify-hooks\.mjs(\s|$)/,
    /(^|\s)node\s+scripts\/verify-github\.mjs(\s|$)/,
  ].some((pattern) => pattern.test(command));
}

export function listRepoChanges(repoRoot) {
  const outputs = [
    runGit(repoRoot, ["diff", "--name-only", "--cached", "--"]).stdout,
    runGit(repoRoot, ["diff", "--name-only", "--"]).stdout,
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "--"]).stdout,
  ];

  const changedFiles = new Set();
  for (const output of outputs) {
    for (const line of output.split("\n")) {
      const trimmed = normalizeRepoPath(line.trim());
      if (trimmed !== "") {
        changedFiles.add(trimmed);
      }
    }
  }

  return [...changedFiles].sort((left, right) => left.localeCompare(right));
}

export function listStructuralChanges(repoRoot) {
  return listRepoChanges(repoRoot).filter((filePath) => isStructuralPath(filePath));
}

export function listLockfileChanges(repoRoot) {
  return listRepoChanges(repoRoot).filter((filePath) => lockfileNames.has(path.posix.basename(filePath)));
}

export function isStructuralPath(filePath) {
  if (filePath.endsWith(".md")) {
    return true;
  }

  if (structuralPaths.has(filePath)) {
    return true;
  }

  return (
    filePath.startsWith(".codex/hooks/") ||
    filePath.startsWith(".agents/skills/") ||
    filePath.startsWith(".github/ISSUE_TEMPLATE/")
  );
}

export function fingerprintFiles(files) {
  return JSON.stringify([...files].sort((left, right) => left.localeCompare(right)));
}

export async function readHookState(repoRoot, sessionId) {
  const statePath = getHookStatePath(repoRoot, sessionId);

  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      sessionId,
      verifiedFingerprint: null,
      lastVerifyCommand: null,
      lastVerifySucceededAt: null,
      structuralFiles: [],
      lockfiles: [],
      needsVerify: false,
    };
  }
}

export async function writeHookState(repoRoot, sessionId, state) {
  const statePath = getHookStatePath(repoRoot, sessionId);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function extractCommandExitCode(...toolResponses) {
  const payload = toolResponses.length === 1 ? toolResponses[0] : toolResponses;
  return findExitCode(unwrapJsonLikeValue(payload));
}

export function extractCommandStillRunning(...toolResponses) {
  const payload = toolResponses.length === 1 ? toolResponses[0] : toolResponses;
  return findRunningMarker(unwrapJsonLikeValue(payload));
}

export function runGit(repoRoot, args) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function getHookStatePath(repoRoot, sessionId) {
  const safeSessionId = String(sessionId).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(repoRoot, ".codex", "tmp", "hook-state", `${safeSessionId}.json`);
}

function unwrapJsonLikeValue(value) {
  let current = value;

  while (typeof current === "string") {
    const trimmed = current.trim();
    if (
      trimmed === "" ||
      (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\""))
    ) {
      break;
    }

    try {
      current = JSON.parse(trimmed);
    } catch {
      break;
    }
  }

  return current;
}

function findToolCommand(payload) {
  if (payload === null || payload === undefined) {
    return null;
  }

  if (typeof payload === "string") {
    return null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = findToolCommand(unwrapJsonLikeValue(item));
      if (nested !== null) {
        return nested;
      }
    }

    return null;
  }

  if (typeof payload !== "object") {
    return null;
  }

  for (const key of ["command", "cmd"]) {
    const value = payload[key];
    if (typeof value === "string") {
      return value;
    }
  }

  for (const value of Object.values(payload)) {
    const nested = findToolCommand(unwrapJsonLikeValue(value));
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function findRunningMarker(payload) {
  if (payload === null || payload === undefined) {
    return false;
  }

  if (typeof payload === "string") {
    return /\bProcess running with session ID\b/.test(payload);
  }

  if (Array.isArray(payload)) {
    return payload.some((item) => findRunningMarker(item));
  }

  if (typeof payload !== "object") {
    return false;
  }

  return Object.values(payload).some((value) => findRunningMarker(value));
}

function findExitCode(payload) {
  if (typeof payload === "number") {
    return payload;
  }

  if (payload === null || payload === undefined) {
    return null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = findExitCode(unwrapJsonLikeValue(item));
      if (nested !== null) {
        return nested;
      }
    }

    return null;
  }

  if (typeof payload === "string") {
    const match = payload.match(/\bProcess exited with code\s+(-?\d+)\b/);
    return match ? Number(match[1]) : null;
  }

  if (typeof payload !== "object") {
    return null;
  }

  for (const key of ["exit_code", "exitCode", "code", "status"]) {
    if (typeof payload[key] === "number") {
      return payload[key];
    }
  }

  for (const value of Object.values(payload)) {
    const nested = findExitCode(unwrapJsonLikeValue(value));
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}
