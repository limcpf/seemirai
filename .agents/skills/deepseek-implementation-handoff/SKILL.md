---
name: deepseek-implementation-handoff
description: Symphony CLI milestone or issue work를 DeepSeek, Reasonix, Aider 같은 구현 에이전트에게 넘기기 위한 상세 구현 handoff Markdown과 선택 JSON contract를 작성할 때 사용한다.
---

# deepseek-implementation-handoff

Symphony CLI에서 Codex가 설계자 역할을 하고 DeepSeek/Reasonix가 구현자 역할을 맡을 때, 구현자가 그대로 따라갈 수 있는 상세 handoff 문서를 작성하는 workflow다.

## 사용 조건

- 사용자가 milestone 또는 issue 구현을 DeepSeek, Reasonix, Aider 같은 구현 에이전트에 맡기려 한다.
- Codex는 구현하지 않고 설계, 범위 통제, acceptance criteria, 검증 기준을 작성해야 한다.
- 구현자가 M2 이상의 기능을 앞질러 만들거나 비목표를 침범하지 않도록 구체적인 guardrail이 필요하다.
- markdown handoff와 machine-readable JSON contract를 함께 남기고 싶다.

## 산출물 위치

기본 산출물은 milestone 단위로 둔다.

```text
docs/exec-plans/active/YYYY-MM-DD-m<번호>-<slug>.md
```

선택 산출물은 JSON contract가 필요할 때만 둔다.

```text
docs/generated/YYYY-MM-DD-m<번호>-<slug>.contract.json
```

템플릿과 스키마는 이 skill의 references를 사용한다.

- Markdown template: `references/deepseek-handoff-template.md`
- JSON contract schema: `references/deepseek-handoff.schema.json`

## workflow

1. 입력 문서를 읽는다.
   - `AGENTS.md`
   - `docs/PRD.md`
   - `docs/FEATURE_REQUIREMENTS.md`
   - `docs/PLANS.md`
   - `docs/ARCHITECTURE.md`
   - `docs/DEVELOPMENT.md`
   - `.ai/rules.md`
   - 해당 milestone과 관련된 `docs/references/*`
2. milestone의 목적을 한 문장으로 고정한다.
   - 예: `M1은 AI 호출 없이 sym run <issue-file>의 실행 골격과 artifact store 규칙만 만든다.`
3. scope와 non-goals를 먼저 쓴다.
   - DeepSeek가 앞질러 구현하지 못하게 M2 이후 기능을 명시적으로 금지한다.
   - 외부 AI 호출, OpenRouter 호출, retry, commit, PR 생성, worktree 격리 등은 milestone에 없으면 금지한다.
4. 구현 설계를 behavior 중심으로 작성한다.
   - 파일명만 나열하지 말고 실행 흐름, 데이터 흐름, 실패 흐름, 사용자-facing 출력까지 적는다.
   - 단, 함수명과 내부 타입은 꼭 필요한 경우만 고정한다.
5. 아키텍처 경계를 적는다.
   - CLI, command, core, adapter, schema, prompt 중 어느 layer가 책임지는지 쓴다.
   - milestone에서 아직 필요 없는 layer는 만들지 말라고 적는다.
6. 입력/출력 contract를 적는다.
   - CLI 인자와 옵션
   - 생성 파일
   - stdout/stderr 기대 형태
   - exit code 의미
   - artifact naming 규칙
7. edge case와 failure mode를 적는다.
   - missing input
   - path resolution
   - duplicate run id
   - permission error
   - gitignore 산출물
   - package script 검증과의 연결
8. acceptance criteria를 체크박스로 쓴다.
   - 구현자가 완료 판정을 스스로 할 수 있어야 한다.
   - 검증 명령과 기대 결과를 포함한다.
9. implementation constraints를 쓴다.
   - 사용할 runtime/library
   - 추가하면 안 되는 dependency
   - 수정하면 안 되는 문서 또는 기능
   - commit 금지 여부
10. handoff command를 마지막에 쓴다.
   - Reasonix/DeepSeek에게 넘길 명령을 포함한다.
   - `--budget`, `--transcript`, milestone 문서 경로를 포함한다.


## Mandatory Implementation Rules

모든 DeepSeek/Reasonix 구현 handoff에는 아래 규칙을 반드시 포함한다. 구현 에이전트는 이 규칙을 사용자의 명시 지시보다 낮고, 일반 코드 스타일 취향보다 높은 실행 규칙으로 취급해야 한다.

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

## Markdown handoff 작성 규칙

- 제목은 `M<번호> <이름> Implementation Handoff` 형식을 사용한다.
- `Goal`, `Mandatory Implementation Rules`, `Read First`, `Current State`, `Scope`, `Non-goals`, `Architecture Direction`, `Dependency Direction`, `Contracts`, `Edge Cases`, `Acceptance Criteria`, `Verification`, `Report Back` 섹션을 반드시 포함한다.
- `Scope`보다 `Non-goals`를 짧게 쓰지 않는다. 구현 에이전트는 금지 범위를 명확히 알아야 한다.
- DeepSeek에게 요구하는 말투는 명령형으로 쓴다.
- 비밀 값, API key, token 원문은 쓰지 않는다.
- 구현자가 판단해야 할 여지를 줄이되, 코드 내부 구현 세부사항을 과하게 잠그지는 않는다.

## JSON contract 작성 규칙

JSON contract는 구현 에이전트 또는 후속 검수자가 milestone 의도를 기계적으로 읽기 위한 파일이다. 필요할 때만 생성한다.

필수 top-level 필드:

- `version`
- `milestone`
- `title`
- `status`
- `handoffMarkdownPath`
- `goal`
- `readFirst`
- `allowedChanges`
- `forbiddenChanges`
- `expectedArtifacts`
- `commands`
- `acceptanceCriteria`
- `verification`
- `reportBack`
- `risks`

상세 schema는 `references/deepseek-handoff.schema.json`을 따른다.

## 좋은 handoff 기준

- DeepSeek가 M2 이후 기능을 만들지 않는다.
- 구현자가 어떤 파일을 만들어야 하는지 안다.
- 구현자가 어떤 파일을 만들면 안 되는지 안다.
- 실패 시 어떤 상태로 보고해야 하는지 안다.
- 사람이 `report back`만 보고 다음 행동을 결정할 수 있다.
- `./scripts/verify` 또는 milestone별 검증 명령이 명확하다.

## 최종 요약에 포함할 것

- 생성한 handoff markdown 경로
- 생성한 JSON contract 경로 또는 생략 이유
- 해당 milestone의 핵심 scope
- 구현 에이전트에게 넘길 명령
- 검증 명령
- 남은 open question
