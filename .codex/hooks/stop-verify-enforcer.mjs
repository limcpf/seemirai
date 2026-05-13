import {
  fingerprintFiles,
  getCurrentBranch,
  listLockfileChanges,
  listRepoChanges,
  listStructuralChanges,
  printJson,
  readHookInput,
  readHookState,
  repoHasCommits,
  resolveRepoRoot,
} from "./lib.mjs";

const input = await readHookInput();
const repoRoot = resolveRepoRoot(input.cwd ?? process.cwd());
const sessionId = input.session_id ?? "default";
const state = await readHookState(repoRoot, sessionId);
const currentBranch = getCurrentBranch(repoRoot);
const structuralFiles = listStructuralChanges(repoRoot);
const lockfiles = listLockfileChanges(repoRoot);
const currentFingerprint = fingerprintFiles([...structuralFiles, ...lockfiles]);
const verifySatisfied =
  structuralFiles.length + lockfiles.length === 0 || state.verifiedFingerprint === currentFingerprint;

if (!verifySatisfied) {
  const files = [...structuralFiles, ...lockfiles].slice(0, 20).join("\n- ");
  const reason = [
    "문서/skill/hook/GitHub 템플릿/lockfile 변경이 검증되지 않았습니다.",
    "마무리 전에 ./scripts/verify 를 실행하고 결과를 반영하세요.",
    files === "" ? "" : `변경 파일:\n- ${files}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (input.stop_hook_active) {
    printJson({ continue: true, systemMessage: reason });
    process.exit(0);
  }

  printJson({ decision: "block", reason });
  process.exit(0);
}

if (currentBranch === "main" && repoHasCommits(repoRoot) && listRepoChanges(repoRoot).length > 0) {
  const reason = "main 브랜치에 변경이 남아 있습니다. 작업 branch/worktree 사용 여부를 확인하고 최종 요약에 명시하세요.";
  if (input.stop_hook_active) {
    printJson({ continue: true, systemMessage: reason });
    process.exit(0);
  }

  printJson({ decision: "block", reason });
  process.exit(0);
}
