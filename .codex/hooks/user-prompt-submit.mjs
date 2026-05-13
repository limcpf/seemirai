import path from "node:path";

import {
  getCurrentBranch,
  getDefaultWorktreeRoot,
  readHookInput,
  resolveRepoRoot,
  shellQuote,
} from "./lib.mjs";

const input = await readHookInput();
const prompt = String(input.prompt ?? "");
const sessionCwd = input.cwd ?? process.cwd();
const repoRoot = resolveRepoRoot(sessionCwd);
const currentBranch = getCurrentBranch(repoRoot);

const shouldRemind = [
  /docs?/i,
  /agents\.md/i,
  /architecture/i,
  /context-map/i,
  /manifest/i,
  /verify/i,
  /hook/i,
  /skill/i,
  /github/i,
  /issue/i,
  /pr/i,
  /문서/,
  /구조/,
  /설계/,
  /계획/,
  /인덱스/,
  /훅/,
  /스킬/,
].some((pattern) => pattern.test(prompt));

if (!shouldRemind && currentBranch !== "main") {
  process.exit(0);
}

const docsReadmePath = path.join(repoRoot, "docs", "README.md").replaceAll("\\", "/");
const contextMapPath = path.join(repoRoot, "docs", "generated", "context-map.json").replaceAll("\\", "/");
const messages = [
  "작업 리마인드:",
  `- 먼저 ${docsReadmePath} 와 ${contextMapPath} 로 읽을 문서를 좁힌다.`,
  "- 라우팅 대상 문서나 skill을 추가/이동하면 관련 index/README 와 context-map.json 을 함께 갱신한다.",
  "- 문서/skill/hook/GitHub 템플릿 변경 후에는 ./scripts/verify 를 실행한다.",
];

if (currentBranch === "main") {
  const worktreeRoot = getDefaultWorktreeRoot(repoRoot);
  messages.push(
    "- 현재 branch 가 main 이다. 구현/수정 작업은 별도 branch 와 worktree 를 우선한다.",
    `- 예: git worktree add -b <branch-name> ${shellQuote(`${worktreeRoot}/<worktree-name>`)} main`,
  );
}

process.stdout.write(`${messages.join("\n")}\n`);
