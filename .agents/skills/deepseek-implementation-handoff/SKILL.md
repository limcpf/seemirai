---
name: deepseek-implementation-handoff
description: Milestone 또는 issue 작업을 DeepSeek, Reasonix, Aider 같은 구현 에이전트에게 넘기기 위해 적정 볼륨의 구현 단위로 나누고, 상세 handoff Markdown, 선택 JSON contract, 실행 명령을 작성할 때 사용한다.
---

# deepseek-implementation-handoff

Codex가 설계자 역할을 하고 DeepSeek/Reasonix/Aider 같은 구현 에이전트가 구현자 역할을 맡을 때, 구현자가 그대로 따라갈 수 있는 상세 handoff 문서를 작성하는 workflow다. 특정 저장소나 특정 issue에 종속되지 않고, 현재 저장소의 문서와 코드 구조를 읽어 단일 handoff가 충분한지 또는 2~3개의 응집도 있는 구현 단위로 나눌지 판단한다.

## 사용 조건

- 사용자가 milestone 또는 issue 구현을 DeepSeek, Reasonix, Aider 같은 구현 에이전트에 맡기려 한다.
- Codex는 구현하지 않고 설계, 범위 통제, acceptance criteria, 검증 기준을 작성해야 한다.
- 구현자가 다음 milestone, 다음 issue, 비목표를 앞질러 만들지 않도록 구체적인 guardrail이 필요하다.
- 작업이 크거나 위험해서 구현 에이전트 실행 효율 기준으로 적정 구현 단위 분할이 필요할 수 있다.
- markdown handoff와 machine-readable JSON contract를 함께 남기고 싶다.

## 산출물 위치

저장소의 기존 문서 구조를 우선한다. 일반적인 기본 산출물은 다음 위치에 둔다.

```text
docs/exec-plans/active/YYYY-MM-DD-<work-id>-<slug>.md
```

선택 산출물은 JSON contract가 필요할 때만 둔다.

```text
docs/generated/YYYY-MM-DD-<work-id>-<slug>.contract.json
```

템플릿과 스키마는 다음 경로를 사용한다.

- Markdown template: `references/deepseek-handoff-template.md`
- JSON contract schema: 저장소에 있으면 `docs/generated/deepseek-handoff.schema.json`, 없으면 이 skill의 `references/deepseek-handoff.schema.json`

## workflow

1. 입력 문서와 현재 코드 구조를 읽는다.
   - 먼저 저장소 라우터 문서(`AGENTS.md`, 가까운 `AGENTS.md`, `docs/README.md`, context map)가 있으면 따른다.
   - PRD, requirements, architecture, development docs, plans, references, rules가 있으면 읽는다.
   - 위 문서가 없으면 README, package manifest, source tree, test/build scripts, 기존 issue/plan 문서로 판단한다.
2. 작업 목표와 non-goals를 먼저 고정한다.
   - 목표는 한 문장으로 쓴다.
   - 다음 milestone/issue, 자동 commit, PR 생성, secret 노출, 불필요한 dependency, 비요청 기능을 명시적으로 금지한다.
3. 단일 handoff 가능 여부를 먼저 판단한다.
   - 하나의 runtime 흐름을 이루는 작업은 가능하면 한 단위로 묶는다.
   - 예: schema + prompt + adapter + core + command integration은 보통 한 reviewer runtime 단위다.
   - dependency/lockfile, 작은 CLI option, 단일 환경 변수 추가만 별도 handoff로 떼는 것은 기본적으로 과분할이다.
4. 분할이 필요하면 구현 에이전트가 한 번에 처리하기 좋은 응집도 있는 단위로 묶는다.
   - 일반적으로 2~3개 단위로 제한한다.
   - 서로 다른 adapter, 독립 모듈, 독립 UI surface, 별도 검증 책임처럼 파일 소유권과 위험이 분리되면 나눌 수 있다.
   - 구현 완료 후 smoke, 문서 closeout, migration verification은 마지막 별도 단위로 둘 수 있다.
   - 4개 이상으로 나누려면 왜 합치면 안 되는지 orchestration 또는 각 handoff에 명확히 남긴다.
5. 각 단위에 대해 `goal`, `owns`, `excludes`, `dependencies`, `parallel 가능 여부`, `verification`, `handoff command`를 작성한다.
   - 한 단위의 출력이 다른 단위의 입력이면 순차 의존성을 명시한다.
   - 병렬 가능성은 파일 소유권, 공통 타입/schema/lockfile 충돌, 선행 산출물 의존성 기준으로 판단한다.
6. 과분할 점검을 수행한다.
   - 이 단위가 독립적으로 리뷰/검증 가능한가?
   - 이 단위가 너무 작아 handoff 비용이 구현 비용보다 큰가?
   - 인접 단위와 같은 실행 흐름에 속하지 않는가?
   - 4개 이상이면 왜 합치면 안 되는가?
7. 구현 설계를 behavior 중심으로 작성한다.
   - 파일명만 나열하지 말고 실행 흐름, 데이터 흐름, 실패 흐름, 사용자-facing 출력까지 적는다.
   - 단, 함수명과 내부 타입은 꼭 필요한 경우만 고정한다.
8. 아키텍처 경계와 입력/출력 contract를 적는다.
   - CLI 인자와 옵션, 생성 파일, stdout/stderr, exit code, artifact naming, schema/prompt/adapter/core 책임을 적는다.
9. edge case, failure mode, acceptance criteria, verification을 쓴다.
   - 구현자가 완료 판정을 스스로 할 수 있어야 한다.
   - 검증 명령과 기대 결과를 포함한다.
   - acceptance criteria마다 사용자 관측면, 예상 수정 파일, 필수 테스트, 완료로 보지 않는 shortcut을 trace matrix로 연결한다.
   - status, report, CLI, HTTP, Telegram처럼 사용자-facing surface가 있으면 실제 route/formatter/provider wiring과 surface 테스트를 요구한다.
   - 같은 타입이더라도 의미가 다른 데이터(current source vs historical source, empty vs unavailable, 0 vs unknown)는 semantic contract로 분리한다.
10. 각 handoff에는 구현 에이전트용 실행 명령을 반드시 포함한다.
    - Reasonix/DeepSeek/Aider에게 넘길 명령을 포함한다.
    - 가능하면 `--budget`, `--transcript`, handoff 문서 경로, 범위 제한, commit 금지를 포함한다.
    - 비밀 값, API key, token 원문은 쓰지 않는다.
11. 필요한 경우 orchestration 문서를 작성한다.
    - 전체 분할, 순서, 병렬 가능성, 명령 목록, 4개 이상 분할 사유를 한눈에 보이게 한다.
    - sub PR/worktree 분할은 필수가 아니라 수단이다. 저장소 운영 규칙이 요구하거나 리뷰 가능성을 실제로 높일 때만 권장한다.
12. 구현 완료 전 03 구현 hygiene 자기검열을 요구한다.
    - Reasonix native skill인 `.reasonix/skills/implementation-hygiene-self-check.md`가 있으면 마지막에 사용하게 한다.
    - 가능하면 `bun scripts/check-implementation-hygiene.mjs --contract <contract-json-path>`를 실행하게 한다.
    - hard fail은 수정하고, warning은 수정 여부와 이유를 한국어로 보고하게 한다.

## 분할 판단 기준

- 단일 handoff 권장:
  - 같은 runtime 흐름 안에서 순차로 이어지는 변경이다.
  - 공통 타입/schema/lockfile을 함께 만져야 한다.
  - 분리하면 선행 산출물 대기나 재작업이 더 커진다.
  - 단위가 dependency 추가, 작은 CLI option, 단일 env var 같은 얇은 plumbing뿐이다.
- 분할 가능:
  - 서로 다른 adapter, 독립 모듈, 독립 UI surface처럼 파일 소유권과 검증 책임이 분리된다.
  - 한 단위가 실패해도 다른 단위의 설계와 검증이 독립적이다.
  - smoke, 문서 closeout, migration verification처럼 구현 후 검증 책임이 별도다.
- 병렬 가능:
  - 같은 파일, 공통 타입/schema, lockfile, generated index를 동시에 수정하지 않는다.
  - 한 단위의 산출물이 다른 단위의 입력이 아니다.
  - 검증 명령과 fixture가 충돌하지 않는다.
- 4개 이상 분할:
  - 기본적으로 피한다.
  - 피할 수 없으면 각 단위가 독립 리뷰/검증 가능한 이유와 합치면 안 되는 이유를 문서화한다.

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

- 제목은 저장소 관례를 따른다. 관례가 없으면 `<work-id> <이름> Implementation Handoff` 형식을 사용한다.
- 단일 handoff에는 `Goal`, `Split Decision`, `Unit Metadata`, `Mandatory Implementation Rules`, `Read First`, `Current State`, `Scope`, `Non-goals`, `Architecture Direction`, `Dependency Direction`, `Contracts`, `Edge Cases`, `Acceptance Criteria`, `Verification`, `Final Hygiene Self-Check`, `Report Back`, `Handoff Command` 섹션을 포함한다.
- 사용자-facing surface나 integration 변경이 있으면 `Acceptance Criteria Trace Matrix`, `Forbidden Completion Shortcuts`, `User-Facing Surface Checklist`, `Semantic Contracts` 섹션도 포함한다.
- 분할 orchestration 문서에는 전체 목표, 분할 판단, 단위 목록, 순서, 병렬 가능성, 단위별 명령, 4개 이상 분할 사유를 포함한다.
- `Scope`보다 `Non-goals`를 짧게 쓰지 않는다. 구현 에이전트는 금지 범위를 명확히 알아야 한다.
- DeepSeek에게 요구하는 말투는 명령형으로 쓴다.
- 비밀 값, API key, token 원문은 쓰지 않는다.
- 구현자가 판단해야 할 여지를 줄이되, 코드 내부 구현 세부사항을 과하게 잠그지는 않는다.

## Unit Metadata 작성 규칙

각 구현 단위에는 아래 항목을 짧게 쓴다.

- `Goal`: 이 단위가 완료해야 하는 동작
- `Owns`: 주로 수정할 파일/모듈/문서
- `Excludes`: 만들면 안 되는 기능, 파일, 다음 단위 범위
- `Dependencies`: 선행 handoff, 필요한 산출물, base branch/worktree 조건
- `Parallel`: 병렬 가능 여부와 이유
- `Verification`: 이 단위 완료를 판정할 명령과 기대 결과
- `Handoff command`: 구현 에이전트 실행 명령

## Integration 완료판정 Guardrail

구현 에이전트가 "코드는 만들었지만 실제 사용자 표면에 연결하지 않은" 상태를 완료로 보고하지 않도록, integration 성격의 handoff에는 아래 항목을 요구한다.

### Acceptance Criteria Trace Matrix

각 acceptance criteria는 아래 표 형태로 추적한다.

```text
| AC | 사용자 관측면 | 예상 수정 파일 | 필수 테스트 | 완료로 보지 않는 경우 |
| --- | --- | --- | --- | --- |
| /status에 PnL 노출 | GET /status JSON | src/interfaces/http-control/* | tests/unit/http-control.test.ts | provider export만 한 경우 |
```

### Forbidden Completion Shortcuts

작업 성격에 맞게 아래 금지 항목을 포함한다.

- 새 provider/function/type을 만들거나 export한 것만으로 integration 완료라고 보고하지 않는다.
- 새 함수 직접 호출 테스트만으로 HTTP, CLI, Telegram, daily report 같은 사용자 표면 검증을 대체하지 않는다.
- 기존 formatter가 있다는 이유만으로 report/status integration 완료라고 주장하지 않는다.
- handoff 문서나 필수 기준 문서를 읽을 수 없으면 추론 구현하지 말고 중단 보고한다.

### User-Facing Surface Checklist

사용자 표면이 있는 작업은 route/provider wiring, response schema 또는 formatter shape, 한국어 label/message/action, trace/debug 분리, 실제 surface 호출 테스트를 모두 확인한다.

### Semantic Contracts

같은 TypeScript 타입이라도 업무 의미가 다른 값은 별도 입력/출력 또는 명확한 필드로 분리하게 한다.

- current source와 historical source를 같은 배열/필드로 섞지 않는다.
- empty/not found와 read failure/unavailable을 같은 null 응답으로 합치지 않는다.
- 실제 0과 unknown/unavailable을 구분한다.
- raw provider payload, secret, Authorization header는 trace에도 원문으로 남기지 않는다.

## Final Hygiene Self-Check 작성 규칙

모든 Reasonix 구현 handoff에는 구현 에이전트가 마지막에 실행할 03 자기검열 절차를 포함한다.

권장 문구:

```text
구현을 마치기 전에 `.reasonix/skills/implementation-hygiene-self-check.md`를 읽고 03 구현 hygiene 자기검열을 수행한다.

가능하면 아래 명령을 실행한다.

bun scripts/check-implementation-hygiene.mjs --contract <contract-json-path>

hard fail이 있으면 수정한다.
warning은 실제 문제인지 재검토하고, 수정하지 않으면 이유를 한국어로 보고한다.
최종 보고에는 hard fail, warning, 수정한 항목, 수정하지 않은 항목과 이유를 포함한다.
```

Final Hygiene Self-Check 뒤에는 acceptance criteria trace matrix를 다시 채우고, 각 AC가 어떤 테스트와 사용자 표면으로 검증됐는지 보고하게 한다.

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
- `acceptanceCriteriaTrace`
- `verification`
- `reportBack`
- `risks`

상세 schema는 저장소에 `docs/generated/deepseek-handoff.schema.json`이 있으면 그 파일을 따르고, 없으면 이 skill의 `references/deepseek-handoff.schema.json`을 따른다.

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
