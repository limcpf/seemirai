# 진행 중 실행 계획

장시간 작업이나 중단 후 재개가 필요한 작업의 실행 계획을 이 디렉터리에 둔다.

파일명 권장 형식:

```text
YYYY-MM-DD-topic.md
```

각 계획은 목표, 범위, 단계, 검증 방법, 결정 로그, 남은 이슈를 포함한다.

## 활성 계획

- [`2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md`](./2026-06-06-issue-159-m18-decision-ledger-reasonix-handoff.md): Issue #159 M18 판단 이유 ledger와 설명 API Reasonix 구현 handoff. 4개 순차 sub PR의 범위, guardrail, acceptance criteria trace matrix, 검증 명령을 고정한다.
- [`2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.md`](./2026-06-06-issue-159-subpr-03-review-fix-deepseek-handoff.md): Issue #159 Sub PR 03 Producer & Status Why Summary 리뷰 finding 수정 DeepSeek handoff. runner ledger write, producer frame/fingerprint, `/status.why` unavailable semantics, HTTP/runner 테스트 완료 기준을 고정한다.
- [`2026-06-06-issue-159-subpr-03-codex-review-repair-deepseek-handoff.md`](./2026-06-06-issue-159-subpr-03-codex-review-repair-deepseek-handoff.md): Issue #159 Sub PR 03 Codex review repair DeepSeek handoff. durable DB frame id writer, frame/strategy producer correctness, `/status.why` DB failure semantics, typecheck/unit/verify 완료 기준을 고정한다.
