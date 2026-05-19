# 신뢰성 기준

## 목적

Codex-native 운영은 Codex, Git, GitHub, shell command, 문서 상태를 연결한다. 이 문서는 반복 실행, 실패 복구, 중복 처리, 관측 가능성을 일관되게 적용하기 위한 기준이다.

## 기본 규칙

- 외부 side effect 전후로 현재 상태를 문서, GitHub issue/PR, commit message 중 적절한 위치에 남긴다.
- 재시도 가능 작업은 중복 실행 시 부작용이 없는지 먼저 판단한다.
- 모든 loop는 종료 조건과 최대 반복 기준을 가진다.
- command 실행 결과는 cwd, exit code, 핵심 stdout/stderr, duration을 요약할 수 있어야 한다.
- Codex sub-agent 작업은 파일 소유권과 DnD가 분명해야 한다.
- 상태 전이나 운영 규칙이 바뀌면 `docs/FEATURE_REQUIREMENTS.md` 또는 설계 문서를 함께 갱신한다.

## Idempotency 기준

- 같은 issue number와 repo는 같은 active 작업 흐름으로 수렴해야 한다.
- 이미 생성된 branch, worktree, PR은 검증 후 재사용하거나 명시적으로 정리한다.
- 같은 review comment/thread는 중복 처리하지 않는다.
- 같은 commit SHA는 같은 phase의 결과로 한 번만 기록한다.

## 복구 기준

- 중단 후 재개 시 `AGENTS.md`, `docs/README.md`, issue/PR 본문, 현재 branch, `git status`를 먼저 확인한다.
- dirty worktree가 발견되면 다음 단계로 넘어가지 않고 commit, cleanup, blocked 중 하나로 수렴시킨다.
- push 후 PR 생성 전 중단된 작업은 remote branch head를 확인한 뒤 PR 생성 또는 기존 PR 연결을 수행한다.
- merge conflict 중 중단된 작업은 conflict marker 상태를 다시 읽고 conflict resolution phase로 재개한다.
- Codex thread resume 실패 시 새 thread를 시작하려면 git clean 상태와 마지막 artifact 기반 prompt 재구성이 가능해야 한다.

## 관측 가능성 기준

- 장시간 작업 요약에는 issue, branch, worktree, PR URL, 검증 명령, 남은 리스크가 있어야 한다.
- 실패한 검증 로그는 다음 Codex prompt에 전달 가능한 수준으로 요약한다.
- review finding은 어떤 commit으로 처리됐는지 추적 가능해야 한다.

## RiskGate append-only 기준

- `risk_ok`는 현재 `riskGateContext`를 평가한 실제 RiskGate 승인 결과가 있을 때만 PASS가 될 수 있다.
- `risk_ok`와 runtime persistence는 현재 주문 후보 식별자와 RiskGate `orderIntent` 식별자가 다르면 fail-closed한다.
- RiskGate가 주문 후보를 거부하면 주문 상태 전이는 `order_events`, 차단 원인은 `risk_events`, 사람이 추적할 판단 근거는 `audit_events`에 append-only로 남긴다.
- RiskGate 증거 저장은 주문 전이, kill switch 전이, 리스크 원인, 감사 근거를 하나의 combined event store port로 넘겨 DB transaction 또는 outbox 구현이 원자성을 보장할 수 있게 한다.
- 현재 kill switch action plan이 신규 주문 차단 또는 수동 검토를 요구하면 현재 RiskGate snapshot이 PASS여도 주문 상태를 `RISK_REJECTED`로 기록한다.
- `PAUSE_STRATEGY`는 해당 strategy 범위의 정지 action plan으로만 남기며 전역 kill switch로 승격하지 않는다.
- `HARD_STOP`은 kill switch를 더 강한 상태로만 전이시키며 pending paper order 취소 계획을 감사 이벤트로 남긴다.
- `HARD_STOP` action plan은 open position 자동 청산을 항상 금지한다. 실제 pending order cancel 호출은 M6 ExecutionEngine/PaperBroker 경계에서만 수행한다.

## 검증 규칙

- 자동 테스트가 없으면 수동 검증 절차라도 남긴다.
- 검증 수단이 전혀 없으면 그 공백을 `QUALITY_SCORE.md` 또는 기술 부채 문서에 등록한다.
