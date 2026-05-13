import path from "node:path";

import {
  findNearestAgentsPath,
  getCurrentBranch,
  getDefaultWorktreeRoot,
  readHookInput,
  resolveRepoRoot,
} from "./lib.mjs";

const input = await readHookInput();
const sessionCwd = input.cwd ?? process.cwd();
const repoRoot = resolveRepoRoot(sessionCwd);
const currentBranch = getCurrentBranch(repoRoot) || "(no git branch)";
const rootAgentsPath = path.join(repoRoot, "AGENTS.md").replaceAll("\\", "/");
const nearestAgentsPath = findNearestAgentsPath(sessionCwd, repoRoot);
const contextMapPath = path.join(repoRoot, "docs", "generated", "context-map.json").replaceAll("\\", "/");
const worktreeRoot = getDefaultWorktreeRoot(repoRoot);

const checklist = [
  "세션 시작 체크리스트:",
  `1. 루트 라우터 확인: ${rootAgentsPath}`,
  `2. 현재 작업 경로 기준 가장 가까운 AGENTS 확인: ${nearestAgentsPath}`,
  `3. 문서 구조 작업이면 기계용 목차 확인: ${contextMapPath}`,
  "4. 작업 전에 계획을 먼저 세우고, 문서/구조/hook 변경 후에는 ./scripts/verify 를 통과시킨다.",
  `5. 현재 branch: ${currentBranch}`,
];

if (currentBranch === "main") {
  checklist.push(`6. main 에서는 구현 작업을 직접 하지 말고 ${worktreeRoot} 아래 worktree 사용을 우선한다.`);
}

process.stdout.write(`${checklist.join("\n")}\n`);
