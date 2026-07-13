# 진행 중 실행 계획

장시간 작업이나 중단 후 재개가 필요한 작업의 실행 계획을 이 디렉터리에 둔다.

파일명 권장 형식:

```text
YYYY-MM-DD-topic.md
```

각 계획은 목표, 범위, 단계, 검증 방법, 결정 로그, 남은 이슈를 포함한다.

## 활성 계획

- [`2026-07-14-issue-267-production-baseline-m23-actual-closeout.md`](./2026-07-14-issue-267-production-baseline-m23-actual-closeout.md): Issue #267 production successor 배포, source/migration provenance, restart/backup 검증, M23 actual 7일 closeout 실행 계획.
- [`2026-06-15-issue-206-live-ops-real-arm.md`](./2026-06-15-issue-206-live-ops-real-arm.md): Issue #206 production `live:ops` 실거래 arm, 실제 provider 조립, 소액 주문 submit/cancel cleanup evidence와 24/7 자동 매수/매도 loop 실행 계획.
- [`2026-06-30-issue-258-live-ops-observability-quality.md`](./2026-06-30-issue-258-live-ops-observability-quality.md): Issue #258 Post-M23 Live Ops 운영 관측성, DB-backed 전략 feature 품질, calibration, daemon hardening, audit/tax evidence 실행 계획.
- [`2026-06-14-issue-196-live-ops-one-click-app.md`](./2026-06-14-issue-196-live-ops-one-click-app.md): Issue #196 Live Ops 원클릭 앱과 TUI 필수 운영 콘솔을 production 경로로 만들기 위한 8개 sub PR 실행 계획.
- [`2026-06-12-m23-m24-live-ops-and-scaled-canary.md`](./2026-06-12-m23-m24-live-ops-and-scaled-canary.md): M23 구현과 production 16일 이상 연속 실행은 확인됐고, actual daily report/decision/restart/backup artifact closeout과 M24 전략 확장/예산 확대 gate를 계속 추적하는 실행 계획.
- [`2026-06-07-issue-165-m19-subpr-orchestration.md`](./2026-06-07-issue-165-m19-subpr-orchestration.md): Issue #165 M19 자동 매도와 포지션 축소 sub PR orchestration.
- [`2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md`](./2026-06-07-issue-165-subpr-01-contracts-rules-deepseek-handoff.md): Issue #165 Sub PR 01 exit contract와 rule 구현 handoff.
- [`2026-06-07-issue-165-subpr-02-evidence-runtime-deepseek-handoff.md`](./2026-06-07-issue-165-subpr-02-evidence-runtime-deepseek-handoff.md): Issue #165 Sub PR 02 evidence/runtime integration handoff.
- [`2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md`](./2026-06-07-issue-165-subpr-03-verification-closeout-deepseek-handoff.md): Issue #165 Sub PR 03 verification, guarded pilot, closeout handoff. ✅ **Sub PR 03 구현 완료 → closeout은 [`../completed/2026-06-07-issue-165-m19-subpr-03-verification-closeout.md`](../completed/2026-06-07-issue-165-m19-subpr-03-verification-closeout.md)에 기록됨**

완료된 Issue #159 M18 판단 이유 ledger 작업은 [`../completed/2026-06-06-issue-159-m18-decision-ledger-closeout.md`](../completed/2026-06-06-issue-159-m18-decision-ledger-closeout.md)에서 확인한다.
