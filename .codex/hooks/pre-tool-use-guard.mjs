import {
  extractToolCommand,
  getCurrentBranch,
  isDangerousCommand,
  isMutatingCommand,
  isSecretAccessCommand,
  printJson,
  readHookInput,
  repoHasCommits,
  resolveRepoRoot,
} from "./lib.mjs";

const input = await readHookInput();
const command = extractToolCommand(input);
const repoRoot = resolveRepoRoot(input.cwd ?? process.cwd());
const currentBranch = getCurrentBranch(repoRoot);

if (isDangerousCommand(command)) {
  printJson({
    decision: "block",
    reason:
      "위험 명령이 감지되었습니다. destructive git/rm/force-push/PR merge 명령은 명시적 승인과 안전 조건 확인 후 수동으로 실행하세요.",
  });
  process.exit(0);
}

if (isSecretAccessCommand(command)) {
  printJson({
    decision: "block",
    reason:
      "secret 파일 접근이 감지되었습니다. .env, private key, credential 파일 원문은 Codex prompt나 로그에 노출하지 않습니다.",
  });
  process.exit(0);
}

if (currentBranch === "main" && repoHasCommits(repoRoot) && isMutatingCommand(command)) {
  printJson({
    decision: "block",
    reason:
      "main 브랜치에서 mutating Bash 명령을 실행하지 않습니다. 별도 branch/worktree를 만든 뒤 작업하세요.",
  });
  process.exit(0);
}
