import {
  extractCommandExitCode,
  extractCommandStillRunning,
  extractToolCommand,
  fingerprintFiles,
  isVerifyCommand,
  listLockfileChanges,
  listStructuralChanges,
  readHookInput,
  readHookState,
  resolveRepoRoot,
  writeHookState,
} from "./lib.mjs";

const input = await readHookInput();
const repoRoot = resolveRepoRoot(input.cwd ?? process.cwd());
const sessionId = input.session_id ?? "default";
const state = await readHookState(repoRoot, sessionId);
const structuralFiles = listStructuralChanges(repoRoot);
const lockfiles = listLockfileChanges(repoRoot);
const currentFingerprint = fingerprintFiles([...structuralFiles, ...lockfiles]);
const command = extractToolCommand(input);
const toolResponseCandidates = [
  input.tool_response,
  input.toolResponse,
  input.tool_output,
  input.toolOutput,
  input.response,
  input.result,
  input,
];
const verifyExitCode = extractCommandExitCode(...toolResponseCandidates);
const verifyStillRunning = extractCommandStillRunning(...toolResponseCandidates);
const verifySucceeded = isVerifyCommand(command) && !verifyStillRunning && verifyExitCode === 0;

if (verifySucceeded) {
  state.verifiedFingerprint = currentFingerprint;
  state.lastVerifyCommand = command;
  state.lastVerifySucceededAt = new Date().toISOString();
}

state.structuralFiles = structuralFiles;
state.lockfiles = lockfiles;
state.currentFingerprint = currentFingerprint;
state.needsVerify = structuralFiles.length + lockfiles.length > 0 && state.verifiedFingerprint !== currentFingerprint;

await writeHookState(repoRoot, sessionId, state);
