# M<N> <Milestone Name> Implementation Handoff

## Goal

Write one precise paragraph that defines what this milestone must achieve.

Example:

M1 builds the first executable Symphony CLI skeleton. It must create `sym run <issue-file>`, create a unique `.runs/<run-id>/` directory, copy the input issue file to `.runs/<run-id>/issue.md`, and print enough information for a human to continue. It must not call Codex, Reasonix, Aider, OpenRouter, or any model API.


## Mandatory Implementation Rules

The implementer must follow these rules throughout the task.

### 한국어 출력 규칙

- 주석 및 결과물은 모두 한국어로 표시한다.
- 사용자-facing CLI 메시지, 에러 메시지, 구현 요약, report back은 한국어로 작성한다.
- 코드 식별자, package script 이름, 외부 API 필드명처럼 관례적으로 영어가 필요한 항목은 영어를 유지할 수 있다.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.
- The test: Every changed line should trace directly to the user's request.

## Read First

The implementer must read these files before editing:

- `AGENTS.md`
- `docs/PRD.md`
- `docs/FEATURE_REQUIREMENTS.md`
- `docs/PLANS.md`
- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`
- `.ai/rules.md`

If any instruction conflicts, follow this priority:

1. This handoff document
2. `AGENTS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/FEATURE_REQUIREMENTS.md`
5. `docs/PLANS.md`

## Current State

Describe the current repository state relevant to this milestone.

For M1, expected state before implementation:

- Project docs and verification scripts exist.
- No Bun package manifest exists yet unless already added by a previous task.
- `.runs/` is ignored and must remain local-only.
- M0 found that external model integrations are not yet fully verified, so M1 must avoid AI calls entirely.

## Scope

List exactly what the implementer may add or modify.

For M1, allowed changes should include:

- Add Bun + TypeScript project manifest and compiler config.
- Add Commander-based CLI entrypoint.
- Add `run` command.
- Add run context creation.
- Add run id generation using `YYYY-MM-DD-NNN`.
- Add `.runs/<run-id>/` directory creation.
- Copy the input issue file to `.runs/<run-id>/issue.md`.
- Print run id and run directory path.
- Add minimal package scripts needed by `./scripts/verify-project`.

## Non-goals

List what must not be implemented in this milestone.

For M1, forbid:

- Codex planner integration.
- Reasonix or Aider implementation integration.
- OpenRouter reviewer integration.
- Test runner implementation beyond package-level verification scripts.
- Report writer.
- Retry loop.
- Git commit automation.
- GitHub PR creation.
- Worktree support.
- SQLite or any database.
- Docker sandbox.
- MCP integration.
- Multi-agent or parallel execution.

## Architecture Direction

Describe the intended structure without over-locking internal code.

For M1, use this structure unless there is a strong reason not to:

```text
package.json
tsconfig.json
src/
  cli.ts
  commands/
    run.ts
  core/
    run-context.ts
```

Layer responsibilities:

- `src/cli.ts`: process argv, register Commander program, wire subcommands.
- `src/commands/run.ts`: implement CLI command behavior and user-facing errors.
- `src/core/run-context.ts`: resolve repo root, create run id, create run directory, copy issue artifact.

Do not create adapter, prompt, reviewer, schema, or report writer files during M1 unless the handoff explicitly says so.

## Dependency Direction

Use these dependencies only if needed:

- Runtime: Bun
- Language: TypeScript
- CLI framework: Commander
- File system: `node:fs/promises`
- Path handling: `node:path`

Avoid adding these in M1:

- `openai`
- `zod`
- `execa`
- `simple-git`
- any test framework unless needed for a minimal smoke test

Rationale:

M1 should establish CLI and artifact-store shape. External process execution, review schemas, and model API clients belong to later milestones.

## CLI Contract

Command:

```sh
sym run <issue-file>
```

Development invocation may be:

```sh
bun run sym run issue.md
```

Required behavior:

1. Resolve `<issue-file>` relative to the current working directory unless it is absolute.
2. Fail with a clear non-zero error if the issue file does not exist.
3. Fail with a clear non-zero error if the issue path is a directory.
4. Create `.runs/` at the repository root.
5. Create a unique run directory with format `YYYY-MM-DD-NNN`.
6. Copy the input issue file to `.runs/<run-id>/issue.md`.
7. Print the run id and run directory path.
8. Do not modify the input issue file.
9. Do not commit changes.

Output example:

```text
Created run 2026-05-31-001
Run directory: .runs/2026-05-31-001
Issue artifact: .runs/2026-05-31-001/issue.md
```

## Run ID Contract

Run id format:

```text
YYYY-MM-DD-NNN
```

Rules:

- Date uses local system date.
- `NNN` starts at `001` for the first run on a date.
- If `.runs/YYYY-MM-DD-001` exists, create `002`, then `003`, and so on.
- Do not overwrite an existing run directory.
- If `.runs/` does not exist, create it.

## Artifact Contract

M1 must create only this artifact:

```text
.runs/<run-id>/issue.md
```

M1 must not create:

```text
plan.md
implementation.log
diff.patch
test.log
review.json
report.md
```

Those belong to later milestones.

## Error Handling

Implement clear user-facing errors for:

- Missing issue file argument.
- Issue file path does not exist.
- Issue path is a directory.
- Cannot create `.runs/`.
- Cannot copy issue file.

Error output should be concise and actionable.

Example:

```text
Error: issue file not found: missing.md
```

## Package Scripts

Add package scripts that work with the existing verification wrapper.

Recommended scripts:

```json
{
  "scripts": {
    "sym": "bun src/cli.ts",
    "verify": "bun run typecheck",
    "typecheck": "tsc --noEmit"
  }
}
```

If TypeScript compiler setup requires adjustment, keep it minimal and explain the reason in the implementation summary.

## Acceptance Criteria

- [ ] `bun install` succeeds.
- [ ] `bun run sym --help` shows the CLI help.
- [ ] `bun run sym run issue.md` creates `.runs/<run-id>/issue.md`.
- [ ] Running the command twice on the same day creates two different run directories.
- [ ] Missing issue file exits non-zero with a clear error.
- [ ] Directory input exits non-zero with a clear error.
- [ ] M1 does not create `plan.md`, `implementation.log`, `test.log`, `review.json`, or `report.md`.
- [ ] `./scripts/verify` passes.

## Manual Smoke Scenario

Use this smoke scenario after implementation:

```sh
cat > /private/tmp/symphony-m1-issue.md <<'MD'
# Issue

Create a tiny M1 smoke run.
MD

bun run sym run /private/tmp/symphony-m1-issue.md
bun run sym run /private/tmp/symphony-m1-issue.md
./scripts/verify
```

Expected result:

- Two run directories are created under `.runs/`.
- Each contains `issue.md`.
- Verification passes.

## Report Back

After implementation, report these items:

- Files changed.
- Commands run.
- Verification result.
- Example run id generated.
- Whether any acceptance criterion is incomplete.
- Any deviation from this handoff and why.

## Handoff Command

Use this command shape for Reasonix/DeepSeek:

```sh
npx --yes reasonix run \
  --budget 0.50 \
  --transcript .runs/m1-reasonix.transcript.jsonl \
  "Read docs/exec-plans/active/YYYY-MM-DD-m1-cli-skeleton.md and implement M1 exactly. Do not implement M2 or later. Do not commit."
```
