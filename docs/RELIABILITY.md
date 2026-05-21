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
- `risk_ok`와 runtime persistence는 현재 주문 후보 식별자와 RiskGate `orderIntent` 식별자, 수량, 명목 금액, 지정가, 예상 손실 입력이 다르면 fail-closed한다. 금액과 예상 손실 문자열은 DB numeric scale 차이를 피하기 위해 Decimal로 정규화해 비교한다.
- runtime persistence는 DB/현재 후보에서 읽은 주문 의도와 top-level 예상 손실 입력을 별도 입력으로 받아 RiskGate context와 다시 대조한다.
- RiskGate가 주문 후보를 거부하면 주문 상태 전이는 `order_events`, 차단 원인은 `risk_events`, 사람이 추적할 판단 근거는 `audit_events`에 append-only로 남긴다.
- RiskGate runtime이 현재 주문 상태에서 `RISK_APPROVED` 또는 `RISK_REJECTED`로 전이할 수 없으면 승인 우회가 아니라 `risk_events`에 불법 상태 전이 원인을 남기고 fail-closed한다.
- RiskGate 증거 저장은 주문 전이, kill switch 전이, 리스크 원인, 감사 근거를 하나의 combined event store port로 넘기며, PostgreSQL 구현은 하나의 DB transaction으로 원자성을 보장한다.
- 허용된 주문 상태 전이는 `order_events` append와 같은 transaction에서 `orders.status`/`orders.updated_at` snapshot을 갱신하되, DB의 현재 상태가 event의 `fromState`와 같을 때만 전진시킨다. 거부된 전이는 event log에만 남긴다.
- 현재 kill switch action plan이 신규 주문 차단 또는 수동 검토를 요구하면 현재 RiskGate snapshot이 PASS여도 주문 상태를 `RISK_REJECTED`로 기록한다.
- kill switch 전이는 audit event뿐 아니라 `kill_switch_state` durable snapshot에도 같은 transaction으로 반영해 프로세스 재시작 후 차단 상태를 복구한다.
- `PAUSE_STRATEGY`는 해당 strategy 범위의 정지 action plan으로만 남기며 전역 kill switch로 승격하지 않는다.
- `STRATEGY_PAUSED` kill switch 상태는 strategy 평가 중지를 표현할 뿐 전역 신규 주문 차단으로 해석하지 않는다.
- strategy 연속 손실 snapshot의 `strategyId`는 주문 후보의 strategy id와 일치해야 하며, 다르면 수동 검토 필요 상태로 fail-closed한다.
- strategy 연속 손실 초과는 더 강한 전역 차단 action에 묻혀도 별도 strategy pause evidence로 남긴다.
- `HARD_STOP`은 kill switch를 더 강한 상태로만 전이시키며 pending paper order 취소 계획을 감사 이벤트로 남긴다.
- `HARD_STOP` action plan은 open position 자동 청산을 항상 금지한다. 실제 pending order cancel 호출은 M6
  `executeHardStopPendingPaperOrderCancels` 경계에서 `BrokerPort.cancelOrder`로만 수행하며, 실행 직전에도
  `autoLiquidateOpenPositions=false`를 재검증한다.
- HTTP control의 `POST /kill-switch`는 target state를 `NEW_ORDERS_BLOCKED`, `HARD_STOP`,
  `MANUAL_REVIEW_REQUIRED`, `NORMAL`으로 제한한다. `HARD_STOP -> NORMAL` 직접 복구는 거부하고, 허용/거부된 요청은
  모두 `audit_events`와 `risk_events`에 남긴다.
- HTTP control에서 허용된 kill switch 전이는 `kill_switch_state` snapshot, audit evidence, risk evidence,
  `HARD_STOP` pending cancel job을 하나의 DB transaction으로 저장한다. pending cancel job은 후속 실행 경계를 남길 뿐
  route handler 안에서 broker cancel side effect를 수행하지 않는다.
- P0 원인 mapping은 `db_write_failure`, idempotency 위반, fill/order accounting mismatch, risk 계산 불능,
  audit persistence failure, live order API 오사용을 `HARD_STOP`으로, stale/lag/freshness/data gap을
  `NEW_ORDERS_BLOCKED`로, 알림/리포트 반복 실패와 운영자 판단 필요 상태를 `MANUAL_REVIEW_REQUIRED`로 수렴시킨다.

## Alert delivery 신뢰성 기준

- alert fingerprint는 환경, 실행 모드, severity, alert type, market, strategy, reason code를 모두 포함한다.
- severity가 fingerprint에 포함되므로 낮은 등급 알림의 cooldown은 P0 escalation을 막지 않는다.
- P0/P1 cooldown은 `alert_cooldowns` PostgreSQL row로 보존해 프로세스 재시작 후에도 중복 Telegram 전송을 억제한다.
- Telegram message는 내부 enum/code를 첫 줄에 그대로 노출하지 않고 한국어 사용자 문구로 상태, 원인, 영향, 필요 조치를
  먼저 보여준다. `fingerprint`, correlation id, audit/risk event id는 복구 추적을 위해 하단 `추적 정보` 섹션에 보존한다.
- P0/P1 provider 호출 전에는 `delivery_reserved_until`을 atomic하게 잡아 같은 fingerprint의 동시 요청을 직렬화한다.
- provider 실패나 notifier 예외가 발생하면 `delivery_reserved_until`을 즉시 해제해 같은 fingerprint의 실제 재시도와 추가 실패
  evidence가 reservation 만료까지 막히지 않게 한다.
- reservation 거부 직후 최신 state에 cooldown/lease 차단 사유가 없으면, 다른 요청의 release와 경합한 것으로 보고 한 번
  재예약한다. 재예약도 실패하면 예외 대신 `alert_reservation_race` skip evidence를 남겨 알림 처리 루프를 중단하지 않는다.
- P2/P3 cooldown은 M8 Sub PR 3 범위에서 process memory로 제한한다. 재시작 후 낮은 등급 알림이 다시 전송될 수 있는 점은
  의도한 trade-off이며, durable 저장소 확장은 후속 요구가 있을 때 별도 변경으로 다룬다.
- cooldown hit는 provider 호출 없이 `last_skipped_at`과 `ALERT_COOLDOWN` audit event를 남긴다.
- provider 전송 성공만 `last_sent_at`을 갱신하고 `NOTIFICATION_DELIVERY` audit event를 남긴다. `last_sent_at`은 alert 발생
  시각이 아니라 provider 전송 완료 시각 기준이며, out-of-order update가 들어와도 뒤로 가지 않는다.
- notifier adapter가 예외를 던져도 alert dispatch는 `notification_provider_exception` 실패 결과로 정규화해 audit,
  retry 후보, failure threshold 평가를 같은 경로로 수행한다.
- P0/P1 provider failure는 `notification_retry` job 후보를 만들지만, 이 단계에서 jobs table insert나 worker 실행을 직접
  수행하지 않는다.
- provider 실패가 연속 3회이거나 첫 실패 이후 10분 이상 지속되면 kill switch mapping에서 `MANUAL_REVIEW_REQUIRED` 후보로
  쓰는 reason code를 반환한다.
- runtime kill switch alert dispatch는 같은 `alertDispatch` 옵션 객체에 최신 failure state를 저장해 provider 실패 누적을
  호출 간 유지한다.
- fingerprint 세그먼트 안의 `:`는 join 구분자와 충돌하지 않도록 `%3a`로 escape한다. 서로 다른 market/strategy/reason 조합이
  같은 cooldown row를 공유해 오억제되는 상황을 막기 위한 규칙이다.
- Telegram 설정이 있는 runtime kill switch control provider는 accepted 전이를 DB transaction commit 이후 alert dispatch로
  연결한다. Telegram side effect는 kill switch durable update transaction 안에 넣지 않는다.
- post-commit alert dispatch가 cooldown/audit/provider 경계에서 실패해도 이미 commit된 kill switch 전이를 5xx로 바꾸지 않고,
  결과 객체에 `alert_dispatch_failed` reason code만 기록한다.

## 검증 규칙

- 자동 테스트가 없으면 수동 검증 절차라도 남긴다.
- 검증 수단이 전혀 없으면 그 공백을 `QUALITY_SCORE.md` 또는 기술 부채 문서에 등록한다.
