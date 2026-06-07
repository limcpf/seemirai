# Issue #159 M18 판단 이유 Ledger와 설명 API Closeout

## 완료 일시

2026-06-06

## 상태

**완료** — 4개 sub PR이 순차로 검증 완료됨

## Sub PR 완료 요약

| Sub PR | 이름 | 상태 | 핵심 산출물 |
|--------|------|------|------------|
| 01 | M18 Plan & Contract | 완료 | `DecisionLedgerFrame`, `DecisionEvidenceItem`, `WhySummary` type contract, `DecisionCategory`, `EvidenceKind`, `SummaryStatus` 상수 |
| 02 | Ledger Foundation & Persistence | 완료 | `migrations/000013_decision_ledger.sql`, `PostgresDecisionLedgerRepository`, append-only DB persistence, idempotency |
| 03 | Producer & Status Why Summary | 완료 | `buildDecisionLedgerFromRunnerResult`, `/status.why` HTTP route, `createDatabaseWhySummaryProvider` |
| 04 | LLM Boundary, Verification & Closeout | 완료 | `generateLlmSummary`, fail-closed order-like output 차단, noop provider 기반 검증 |

## Sub PR 04 핵심 산출물

### `src/application/decision-ledger/llm-summary.ts`

LLM 보조 summary 생성 모듈. 결정론적 ledger evidence를 읽어 LLM provider로 한국어 설명 초안을 생성하며, 다음 invariant를 보존한다:

1. **LLM은 보조 계층이다**: 결정론적 `/status.why` summary는 LLM 없이 독립적으로 동작한다.
2. **Fail-closed**: LLM provider timeout, invalid JSON, output size 초과, provider 장애는 `EXPLANATION_FAILURE` evidence로만 기록된다.
3. **Order-like output 차단**: LLM 출력에 매수/매도 추천, 목표가, 포지션 크기, 수익 보장 표현이 포함되면 `EXPLANATION_FAILURE`로 차단된다.
4. **외부 호출 없이 검증 가능**: 기본 `noop` provider fixture로 모든 경로 검증.

### Provider 경계

- 기존 `src/application/llm-risk-assistant/contracts.ts`의 `LlmRiskAssistantProviderPort`를 재사용한다.
- 새 provider dependency를 추가하지 않는다.
- `noop` provider로 외부 API 호출 없이 모든 테스트 통과.

### Tests

- `tests/unit/decision-ledger-llm-summary.test.ts`: 27개 테스트
  - 성공 경로 (2): EXPLANATION_SUMMARY evidence 생성
  - Fail-closed provider 실패 (4): timeout, provider_error, invalid_json, provider throw
  - Order-like output 차단 (9): 매수 추천, 매도 추천, 조사형 매수/매도 권장, 목표가, 조사/서술형 목표가, 포지션 크기, 금액 지정, 대문자 자산 단위 수량 지정, 수익 보장
  - Output 길이 검증 (3): 너무 짧음, 공백만, provider 성공 응답 byte cap 초과
  - 결정론적 독립성 (2): LLM 실패가 결정론적 info를 변경하지 않음
  - Prompt 구성 (3): frame/evidence 정보 포함, LLM 설명 evidence 재투입 차단, provider content 한도 초과 시 미호출 fail-closed
  - Evidence fingerprint (2): 성공/실패 fingerprint format
  - Category invariant (2): EXPLANATION_SUMMARY→HOLD, EXPLANATION_FAILURE→EXPLANATION_FAILED

## Verification Results

```text
✅ corepack pnpm typecheck — 통과
✅ corepack pnpm test (targeted) — 145 passed, 1 skipped
   - tests/unit/decision-ledger.test.ts: 46 passed
   - tests/unit/decision-ledger-persistence.test.ts: 16 passed
   - tests/unit/decision-ledger-llm-summary.test.ts: 27 passed
   - tests/unit/http-control.test.ts: 38 passed
   - tests/unit/llm-risk-assistant-contract.test.ts: 6 passed
   - tests/unit/llm-risk-assistant-provider.test.ts: 12 passed, 1 skipped
```

## Architecture Compliance

- ✅ LLM은 직접 매수/매도 판단에 사용하지 않음
- ✅ LLM output을 RiskGate approval 또는 Broker submission 입력으로 사용하지 않음
- ✅ 외부 LLM 기본 CI 호출 없음 (noop fixture)
- ✅ Telegram inbound 없음
- ✅ M19 exit engine 없음
- ✅ 실거래 주문 API 호출 없음
- ✅ 새 dependency 추가 없음
- ✅ 기존 migration 수정 없음

## Decision Ledger 의존 방향 (최종)

```text
domain/shared
  └── application/decision-ledger (type contract, category, frame-builder, user-facing, why-summary, llm-summary)
        ├── interfaces/http-control (summary provider contract)
        └── application/llm-risk-assistant (provider port 재사용)
              └── infrastructure/db/decision-ledger (repository, status-provider)
                    └── runtime (조립)
```

`application`은 `infrastructure`를 import하지 않는다. `interfaces/http-control`은 summary provider contract만 알고 DB row를 직접 해석하지 않는다.

## Closeout Actions

- [x] `docs/exec-plans/completed/2026-06-06-issue-159-m18-decision-ledger-closeout.md` 작성
- [x] `docs/exec-plans/active/README.md` 갱신
- [x] `docs/generated/context-map.json` 갱신
- [x] `src/application/decision-ledger.ts` public entry 갱신
- [x] `src/application/decision-ledger/llm-summary.ts` 작성
- [x] `tests/unit/decision-ledger-llm-summary.test.ts` 작성
- [x] typecheck 통과
- [x] targeted tests 통과

## 잔여 이슈

- M19 자동 매도/exit engine: 별도 issue 예정
- M20 Telegram 양방향 운영 및 `/why` command: 별도 issue 예정
- 실제 LLM provider (codex_oauth) smoke: env guard + 별도 검증 절차 필요
- 전체 decision ledger integration test (DB + runner + status): `tests/integration/` 하위 별도 검증
