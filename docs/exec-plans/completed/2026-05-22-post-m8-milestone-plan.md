# Post-M8 마일스톤 계획

- 상태: completed
- 작성일: 2026-05-22
- 완료일: 2026-06-03
- 목표: M8 이후 남은 PRD 요구사항, 운영 검증 공백, 기술 부채를 paper 운영과 v0.2 pilot 준비 순서로 재정렬한다.

## 기준 문서

- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- [`../../PRD.md`](../../PRD.md)
- [`../../FEATURE_REQUIREMENTS.md`](../../FEATURE_REQUIREMENTS.md)
- [`../../product-specs/upbit-krw-paper-trading-mvp.md`](../../product-specs/upbit-krw-paper-trading-mvp.md)
- [`../../RUNTIME_CONFIG.md`](../../RUNTIME_CONFIG.md)
- [`../../RELIABILITY.md`](../../RELIABILITY.md)
- [`../../SECURITY.md`](../../SECURITY.md)
- [`../completed/2026-05-13-mvp-development-plan.md`](../completed/2026-05-13-mvp-development-plan.md)
- [`../tech-debt-tracker.md`](../tech-debt-tracker.md)
- [`../../tech-debt/2026-05-20-large-typescript-module-boundaries.md`](../../tech-debt/2026-05-20-large-typescript-module-boundaries.md)

## 현재 판단

M0~M8-C는 완료 상태다. M8은 HTTP control, kill switch, Telegram outbound, cooldown, daily report, soak harness 구현이
mother PR로 merge됐고, M8-C에서 실제 24시간 public WebSocket soak, daily report evidence, 전체 검증 통과, 실거래 주문 API
0회 확인까지 닫았다. 24시간 soak는 public WebSocket 연결과 안전 guard 검증이며, 운영 DB 적재와 반복 daily report 운영은 M9
paper 운영 베타에서 별도 증거로 닫는다.

LLM 보조 정책은 M10에서 완료됐고, PRD와 기능 요구사항에는 phase 1.5 알트 수동 편입, v0.2 pilot 후보가 남아 있다. 이들은
paper 운영이 안정화되기 전에는 진행하지 않는다. 특히 Upbit account 연동, 자산 조회, 주문 조회, 주문 생성/취소는 MVP가 아니라
v0.2 pilot 범위다.

기술 부채는 두 축으로 나뉜다.

- TD-001: 전략 후보 생성 품질과 feature set 보강
- TD-002: 큰 TypeScript 단일 파일 책임 분리

## 우선순위 원칙

1. M8-C 운영 증거가 닫혔더라도 M9 반복 paper 운영 전에는 새 거래 범위나 private API 범위를 열지 않는다.
2. paper 운영 안정화 전에는 Upbit account 연동, 자산 조회, 주문 조회, 주문 생성/취소를 구현하지 않는다.
3. 전략 품질 개선은 paper/backtest 데이터와 리포트 근거가 쌓인 뒤 진행한다.
4. 무동작 리팩터링은 기능 변경 PR과 섞지 않는다.
5. phase 1.5 알트 편입은 전략 품질과 리스크/리포트 관측성이 개선된 뒤 수동 승인형으로만 연다.

## 마일스톤

### M8-C. MVP 완료 판정과 운영 증거 정리

상태: completed

목적:

- M8 구현을 완료 선언 가능한 상태로 닫고, MVP 완료 증거를 문서와 artifact로 남긴다.

범위:

- 로컬 의존성 설치 상태를 복구하고 `./scripts/verify`가 통과하는지 확인한다.
- `node scripts/soak-paper-24h.mjs --fixture-smoke`를 통과시킨다.
- 실제 24시간 public WebSocket soak를 `SEEMIRAI_RUN_SOAK=1`과 `--daily-report-generated`로 실행한다.
- raw soak log와 summary artifact는 저장소 밖에 남기고, 저장소에는 summary 경로와 핵심 결과만 기록한다.
- M8 checklist의 optional `/metrics`는 MVP 완료 필수에서 제외한다는 결정을 문서화한다.
- `README.md`, `QUALITY_SCORE.md`, PRD/기능 요구사항의 현재 단계 표현이 구현 상태와 맞는지 정리한다.
- 완료되면 기존 MVP 실행 계획을 completed로 이동할지 결정하고 인덱스와 context map을 갱신한다.

제외 범위:

- 신규 runtime 기능
- Upbit private API/account 연동
- phase 1.5 알트 편입

완료 증거:

- 24시간 soak summary: `/home/lim/vaults/99_운영/seemirai-soak/m8-paper-soak-2026-05-22T01-20-26-828Z-60c4fb71-summary.json`
- 24시간 soak report: `/home/lim/vaults/99_운영/seemirai-soak/m8-paper-soak-2026-05-22T01-20-26-828Z-60c4fb71-report.md`
- raw event log: `/home/lim/vaults/99_운영/seemirai-soak/m8-paper-soak-2026-05-22T01-20-26-828Z-60c4fb71-events.jsonl`
- 실행 기간: `2026-05-22T01:20:26.828Z`부터 `2026-05-23T01:20:26.896Z`까지
- 관측 시간: `86,400,068ms`
- 핵심 수치: public WebSocket message `1,258,095`, trade message `288,844`, orderbook message `969,251`, live order API call `0`, crash `0`, unhandled rejection `0`, audit missing `0`, DB write failure `0`, notification failure `0`, daily report evidence `true`
- 현재 HEAD 검증: `corepack pnpm install --frozen-lockfile`, `node scripts/soak-paper-24h.mjs --fixture-smoke --json`, `./scripts/verify` 통과
- 커밋 기준: 24시간 soak artifact는 `b7959f680590`에서 생성됐고, 현재 M8-C 문서 정리 시점 HEAD에서는 fixture smoke와 전체 verify로 회귀 없음이 확인됐다.

결정:

- optional `/metrics`는 M8-C 신규 기능으로 구현하지 않고 MVP 완료 필수에서 제외한다. 운영 지표 endpoint가 필요하면 M9 이후 별도 issue에서 HTTP auth, 노출 범위, Prometheus 호환성을 함께 정의한다.

Acceptance Criteria:

- [x] `corepack pnpm install --frozen-lockfile` 후 `./scripts/verify`가 통과한다.
- [x] fixture smoke summary가 stale data 신규 주문 차단, audit 누락 0건, live order API 0회를 포함한다.
- [x] 실제 24시간 soak summary가 crash 0회, unhandled rejection 0회, live order API 0회, audit 누락 0건, stale data 차단,
      DB write failure 0건, notification failure 0건, daily report evidence를 포함한다.
- [x] M8 구현 완료와 MVP 운영 증거 상태가 실행 계획에 현재 상태로 반영된다.
- [x] PRD/기능 요구사항/README의 상태 표현이 실제 구현 단계와 충돌하지 않는다.

검증:

```sh
corepack pnpm install --frozen-lockfile
./scripts/verify
node scripts/soak-paper-24h.mjs --fixture-smoke
SEEMIRAI_RUN_SOAK=1 node scripts/soak-paper-24h.mjs --duration-ms 86400000 --daily-report-generated
```

### M9. Paper 운영 베타

상태: completed

목적:

- MVP 코어를 개발 검증이 아니라 반복 가능한 paper 운영 절차로 올린다.

범위:

- `PAPER_NO_KEY` market data, execution, HTTP control, Telegram, daily report를 한 운영 절차로 조립한다.
- DB migration, backup/restore smoke, daily report job, notification retry 후보를 운영자가 반복 실행할 수 있게 runbook을 작성한다.
- `report.daily` job 실행과 Telegram daily report 전송을 실제 운영 흐름으로 연결한다.
- paper 주문 제출, 부분체결, 전체체결, 취소/재호가, 리스크 차단을 Telegram outbound 매매 이벤트 알림으로 관측한다.
- P0/P1 notification retry contract를 jobs table 기반 worker로 닫는다.
- `/status`, `/readyz`, `/kill-switch` drill을 포함한 운영 점검 checklist를 만든다.
- public WebSocket soak와 별개로 paper decision runner를 실행해 feature, strategy evaluation, order intent, cost/risk gate,
  PaperBroker 제출/체결, 비용·슬리피지·체결률·차단 사유 metric을 같은 summary shape로 남긴다.
- 3일 동안 프로세스를 켜두고 public orderbook 또는 fixture 입력으로 PaperBroker 제출/체결 decision cycle을 반복하는
  paper trading soak runner를 제공한다.
- 24시간 1회가 아니라 3일 연속 paper report를 비교해 비용, 슬리피지, 체결률, 차단 사유가 누적 관측되는지 확인한다.

제외 범위:

- Upbit account/private API 연동
- 실거래 주문
- 신규 전략 확장
- phase 1.5 알트 편입

Acceptance Criteria:

- [x] 운영자가 문서만 보고 DB 준비, migration, paper runtime 시작, control endpoint 확인, 종료를 재현할 수 있다.
- [x] daily report가 수동/스케줄 실행 모두에서 같은 report date idempotency key를 사용한다.
- [x] paper 매매 이벤트가 P1 즉시, P2 cooldown, P3 요약 전용 정책에 따라 Telegram 알림 후보로 변환된다.
- [x] notification retry 실패가 묵살되지 않고 jobs table 기반 재시도 또는 manual review 상태로 수렴한다.
- [x] kill switch drill에서 신규 주문 차단, pending paper order cancel plan, Telegram 알림 evidence가 같은 correlation id로 추적된다.
- [x] controlled fixture에서 paper decision runner가 최소 1회 paper 주문 제출/체결 경로를 통과하고, 주문 0건 frame은
      hold/discard/cost/risk reason count로 설명된다.
- [x] 3일 paper trading soak runner가 `SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1` guard 아래에서 PaperBroker 주문/체결 cycle을
      반복하고 day별 summary를 남긴다.
- [x] 3일 연속 paper report가 같은 포맷으로 비교 가능하다.

예상 sub PR:

| 순서 | 목표 | 병렬성 |
| --- | --- | --- |
| 1 | paper 운영 runbook과 local env/secret 주입 절차 | 독립 |
| 2 | daily report job 실행 경계와 scheduler/수동 runner | 순차 |
| 3 | paper 매매 이벤트 Telegram 알림 mapper/formatter/cooldown | 순차 |
| 4 | P0/P1 notification retry worker | 순차 |
| 5 | `/readyz`/`/status`/`/kill-switch` 운영 drill 자동 검증과 3일 report 비교 도구 | 순차 |

2026-05-27 기준 issue #87 관측성 보강 sub PR 결과:

| 순서 | PR | 목표 | 상태 |
| --- | --- | --- | --- |
| 1 | #88 | M9 artifact discovery/parser와 실시간 상태 CLI | merged |
| 2 | #89 | #68 evidence validator와 Markdown comment generator | merged |
| 3 | #91 | `/status` durable paper/alert/daily report 운영 정보 | merged |
| 4 | #94 | M9 runbook과 runtime/reliability 문서 정리 | merged |
| 5 | #99 | mother PR 검증 결과와 #68 연동 사용법 closeout | merged |

Mother PR #100은 병합 완료 상태로 종료되었으며, #68 closeout 판정은 아래 기록으로 확정한다.

### #68 closeout (2026-05-30)

- `issue-comment` 검증 결과: `passed`
- 내부 evidence: [`../../references/m9-paper-trading-soak-2026-05-25-e398a8ee.md`](../../references/m9-paper-trading-soak-2026-05-25-e398a8ee.md)
- aggregate summary/report 원천 artifact는 내부 evidence의 `Source artifacts`에 추적 정보로 보존한다.
- day summary: Day 1/2/3 모두 passed
- day report: Day 1/2/3 모두 생성
- 3일 비교 report 내용은 내부 evidence의 `Day comparison`에 반입했다.
- `liveOrderApiCalls=0`, `crash=0`, `unhandledRejection=0`, `daily report evidence` 충족
- `SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1` guard 하에서 3일 연속 운영 확인
- issue #68 closeout 댓글: https://github.com/limcpf/seemirai/issues/68#issuecomment-4583232258
- 필요 조치: `node scripts/validate-m9-paper-soak-evidence.mjs --artifact-dir /home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak --issue-comment` 출력으로 closeout 판정 근거가 일치함을 재확인한다.

issue #68 closeout 댓글 본문은 아래 명령으로 재생성 가능하다.

```sh
node scripts/validate-m9-paper-soak-evidence.mjs \
  --artifact-dir /home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak \
  --issue-comment
```

검증:

```sh
corepack pnpm typecheck
corepack pnpm test
node scripts/run-m9-paper-decision-runner.mjs --fixture-smoke --json
node scripts/run-m9-paper-trading-soak.mjs --fixture-smoke --json --daily-report-generated --days 3 --cycles-per-day 1 --max-cycles 3
./scripts/verify
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration
```

### M10. LLM 리스크 보조 경계

상태: completed

목적:

- PRD의 LLM 요구사항을 주문 허용이 아니라 공지/정책/시장경보 기반 차단·설명 보조로만 구현한다.

범위:

- LLM 입력 source를 `exchange_notice`, `developer_changelog`, `market_event`로 제한하는 contract를 정의한다.
- 결과 타입을 `notice_summary`, `notice_risk_classification`, `event_explanation`, `daily_report_draft`로 제한한다.
- `BUY`, `SELL`, `INCREASE_POSITION` 같은 금지 action은 schema에서 거부한다.
- LLM 결과가 RiskGate로 들어갈 때는 `BLOCK_NEW_ENTRY`, `CANCEL_PENDING`, `PAUSE_STRATEGY`, `ALERT_ONLY` 같은 차단/주의 신호만 허용한다.
- LLM 입출력 audit 저장과 secret redaction 경계를 고정한다.
- daily report draft는 deterministic report를 대체하지 않고 보조 텍스트로만 취급한다.

제외 범위:

- LLM 기반 매수/매도 추천
- 목표가, 포지션 크기, 주문 허용 판단
- 비공식 뉴스/SNS 기반 자동 주문

Acceptance Criteria:

- [x] LLM output schema가 금지 action을 거부한다.
- [x] LLM-only context는 전략 후보를 생성하지 않는다.
- [x] LLM 결과가 주문 허용 신호로 변환되지 않는다.
- [x] LLM 입력과 출력은 민감정보 없이 audit 가능하게 저장된다.
- [x] deterministic daily report가 실패하지 않아도 LLM draft 실패는 독립적으로 격리된다.
- [x] Codex OAuth provider smoke는 env gate 뒤에 있어 기본 검증과 CI가 외부 LLM 호출을 만들지 않는다.

예상 sub PR:

| 순서 | 목표 | 상태 |
| --- | --- | --- |
| 1 | LLM contract/schema와 금지 action 테스트 | PR #60 merged |
| 2 | provider port, `noop`, `codex_oauth`, provider fail-closed, gated smoke | PR #61 merged |
| 3 | audit persistence와 redaction | PR #62 merged |
| 4 | notice/market event risk classification mapper와 RiskGate 안전 신호 | PR #63 merged |
| 5 | daily report draft 보조 경계 | PR #64 merged |
| 6 | M10 문서/검증 정합성, M9 보호 경계 재확인 | PR #65 merged / #66 mother merged |

M10 Verification sub PR은 M9 #51이 소유한 paper runtime, daily report runner, Telegram 매매 알림, notification retry,
control drill, 3일 report 비교 구현을 변경하지 않는다. M10 문서 갱신은 LLM provider, secret redaction, fail-closed, gated smoke
경계에 한정한다.

M10 전체는 #66 병합으로 완료됐다. verification closeout 근거는 `issue-59/06-verification`의 `d0f792d`이며, 해당 sub PR은
LLM risk assistant contract/provider/audit/RiskGate mapper/daily report draft 단위 검증과 문서 정합성만 닫고 M9 paper runtime
보호 경계는 변경하지 않았다.

### M11. 전략/피처 품질 보강

상태: completed

목적:

- TD-001을 처리해 전략 후보 생성의 설명력과 backtest/paper 보정 가능성을 높인다.

범위:

- candle momentum, realized volatility, volume spike, depth slope, depth 변화율, VWAP 이탈, 체결 방향 누적 imbalance,
  market regime, 시간대별 유동성 filter, cost-adjusted expected return feature를 정의한다.
- 각 feature의 입력 범위, 시간 기준, 부호 의미, 결측 처리, paper/backtest 재사용 방식을 설계 문서에 고정한다.
- 전략 threshold를 paper report와 backtest report에서 비교 가능한 config로 노출한다.
- 전략별 discard reason과 cost/risk 차단 사유가 리포트에서 충분히 분해되는지 확인한다.

제외 범위:

- 신규 거래소
- 실거래 주문
- Transformer 또는 대형 모델 기반 필수 alpha model

Acceptance Criteria:

- [x] feature 정의 문서가 추가되고 context map에 등록된다.
- [x] feature 계산 실패나 입력 부족은 주문 후보 중지가 된다.
- [x] 같은 fixture에서 backtest와 paper feature 값이 일치한다.
- [x] 전략별 threshold 변경 전후 리포트가 비용 반영 기준으로 비교 가능하다. #102에서 #68 evidence 기반 비활성 proposal을
      생성했으며, 실제 기본값 활성화는 별도 calibration approval PR에서 수행한다.

예상 sub PR:

| 순서 | 목표 | 상태 |
| --- | --- | --- |
| 1 | feature 정의 design doc과 runtime config contract | PR #71 merged |
| 2 | 순수 feature calculator와 fixture tests | PR #72 merged |
| 3 | backtest/paper fixture feature parity 검증 | PR #73 merged |
| 4 | strategy variant 입력 확장과 discard audit 보강 | PR #74 merged |
| 5 | M9 #68 관측 데이터 기반 calibration report 또는 보수적 제안/후속 issue 후보 정리 | #102 Sub PR 5까지 완료, calibration report/proposal closeout |

현재 운영 상태:

- GitHub issue: #70
- mother branch: `issue-70-mother`
- Sub PR 1-4: #71, #72, #73, #74 merged
- M11 calibration closeout issue: #102
- #102 Sub PR 1-4: #103, #104, #105, #106 merged
- #102 Sub PR 5: #68 closeout(pass) 원천 artifact 재검증, calibration report, 비활성 profile proposal, 문서 closeout 완료
- M11은 #102 Sub PR 5까지 완료되어 닫힌다. 다만 `config/paper.json` 기본 threshold는 변경하지 않았고, activation은 별도
  calibration approval PR에서 동일 run shape 전후 비교를 붙여 판단한다.
- M9 #68 운영 관측 중에는 paper runner, daily report, Telegram, retry, control drill, 3일 비교 포맷과 기본 운영 threshold를 변경하지 않는다.
- 2026-05-30 기준 #68은 `passed`이며 [`../../references/m9-paper-trading-soak-2026-05-25-e398a8ee.md`](../../references/m9-paper-trading-soak-2026-05-25-e398a8ee.md)에 반입한 3일 run evidence와 비교 지표를 기준으로 threshold 비교 후보 산정이 가능하다.
- 2026-05-31 기준 #102 report는 `/home/lim/vaults/99_운영/seemirai-m9-paper/m11-threshold-calibration-report.md`에 생성됐다.
  평균 margin은 `-1.333333333333`이므로 공격적 threshold 완화는 차단하고, 기본 `config/paper.json` 활성화 변경 없이
  `/home/lim/vaults/99_운영/seemirai-m9-paper/m11-threshold-calibration-profile-proposal.json`에 비활성 보수 후보만 남긴다.

### M12. 큰 TypeScript 모듈 책임 분리

상태: completed

목적:

- TD-002를 무동작 리팩터링으로 처리해 이후 전략/운영/pilot 변경의 리뷰 비용을 낮춘다.

범위:

- 기능 변경 없이 public entry와 same-basename directory 구조로 책임을 분리한다.
- 각 PR은 기존 테스트 통과를 완료 조건으로 둔다.
- 상태 전이, fail-closed, DB side effect 경계의 한국어 JSDoc과 핵심 분기 주석을 유지하거나 보강한다.

처리 순서:

1. `src/infrastructure/db/execution-persistence.ts`
2. `src/infrastructure/paper/paper-broker.ts`
3. `src/application/risk/risk-gate-runtime.ts`
4. `src/application/risk/risk-gate.ts`
5. `src/application/execution/execution-engine.ts`
6. `src/application/strategies/strategy-variants.ts`
7. `src/application/backtest/backtest-orchestrator.ts`

제외 범위:

- 새 기능 구현
- DB schema 변경
- runtime behavior 변경

완료 증거:

- GitHub issue: #77
- Mother PR: #85 merged
- Sub PR: #78 `execution-persistence`, #79 `paper-broker`, #80 `risk-gate-runtime`, #81 `risk-gate`, #82 `execution-engine`,
  #83 `strategy-variants`, #84 `backtest-orchestrator` merged
- 현재 `main` 기준 검증: `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` 통과
- 테스트 결과: 47 files passed, 7 skipped / 457 passed, 45 skipped

Acceptance Criteria:

- [x] 기존 public import 경로가 유지되거나 migration 경로가 명시된다.
- [x] 각 리팩터링 PR은 동작 변경 없이 관련 테스트가 통과한다.
- [x] 책임 없는 `utils.ts`가 아니라 validation, policy, mapper, repository, service처럼 변경 이유가 드러나는 파일명으로 분리한다.

### M13. Phase 1.5 알트 수동 편입

목적:

- MVP core와 paper 운영이 안정화된 뒤 최대 3개 알트 수동 편입을 열 수 있게 한다.

선행 조건:

- M8-C 완료
- M9 paper 운영 베타 최소 3일 이상
- M11 feature/strategy calibration의 최소 기준 확정

범위:

- 상장 후 90일 이상, `warning=false`, `caution=false`, 거래대금, 스프레드 p95, 예상 슬리피지, depth 기준을 모두 만족하는 후보만 수동 승인한다.
- 알트 safety buffer 20 bps, 단일 알트 5%, 전체 알트 15% 한도를 적용한다.
- 수동 승인 목록, 승인 시각, 근거 snapshot, 만료/철회 규칙을 audit 가능하게 남긴다.

제외 범위:

- 자동 신규 상장 편입
- 저유동성 알트
- 시장가 신규 진입
- 실거래

Acceptance Criteria:

- [ ] 알트 후보가 조건을 모두 통과하지 못하면 universe에 들어가지 않는다.
- [ ] 수동 승인/철회 evidence가 audit log와 설정 변경 기록에 남는다.
- [ ] 알트 편입 후에도 live order API 0회가 유지된다.

### M14. v0.2 Pilot 준비

상태: completed

목적:

- paper 운영에서 확인한 경계만 바탕으로 Upbit account/private API와 소액 실거래 후보를 별도 문서와 별도 runtime profile로 준비한다.

선행 조건:

- M8-C 완료
- M9 paper 운영 베타 안정화
- v0.2 pilot product spec 작성
- 사용자의 명시 승인

범위:

- API key 권한 matrix를 작성한다. 출금 권한은 금지한다.
- read-only 자산 조회, 주문 조회, 주문 가능 정보 조회를 실거래 주문 생성과 분리한다.
- `PAPER_NO_KEY`와 별도인 pilot profile을 정의하고, 기본 config가 pilot으로 전환되지 않도록 fail-closed guard를 유지한다.
- private API rate limit, 인증 실패, 잔고/포지션 불일치, 주문 idempotency 정책을 별도 acceptance criteria로 둔다.
- 소액 주문 생성/취소는 별도 승인 전까지 구현하지 않는다.

제외 범위:

- 출금/입출금 자동화
- 거래소 간 차익거래
- 선물/레버리지
- 타인 계정
- 자동 pilot 승격

Acceptance Criteria:

- [x] v0.2 pilot PRD 또는 product spec이 MVP 문서와 분리된다.
- [x] 출금 권한 없는 API key만 허용한다는 보안 기준이 문서와 config guard에 반영된다.
- [x] read-only account integration이 실거래 주문 생성 경로를 열지 않는다.
- [x] live order API 호출은 명시 승인된 pilot profile과 별도 테스트에서만 허용된다.

완료 증거:

- GitHub issue: #124 closed
- Final PR: #132 merged
- 완료 실행 계획: [`2026-06-01-issue-124-m14-v0-2-pilot.md`](./2026-06-01-issue-124-m14-v0-2-pilot.md)
- 실제 private/order smoke는 운영자 secret과 명시 guard가 없으면 실행하지 않는 경계를 유지한다.

### M15-M24. Upbit 실거래 자율 운용 로드맵

상세 제품 명세: [`../../product-specs/upbit-live-autonomous-trading.md`](../../product-specs/upbit-live-autonomous-trading.md)

M15 상태: completed. issue #135의 완료 기록은 [`2026-06-02-issue-135-m15-upbit-live-broker.md`](./2026-06-02-issue-135-m15-upbit-live-broker.md)를 기준으로 한다.

M16 상태: completed. issue #143의 완료 기록은 [`2026-06-02-issue-143-m16-live-reconcile.md`](./2026-06-02-issue-143-m16-live-reconcile.md)를 기준으로 한다. Sub PR 01-08이 mother branch로 merge됐고, 08 closeout에서 전체 검증(typecheck, 903 tests, verify docs/hooks/github) 통과, DB integration 48 tests 통과, Upbit read-only REST/private WebSocket live reconcile smoke 통과, live order API 0회 확인을 완료했다. closeout 보강으로 `finish-readiness-audit`는 PR 생성 전 readiness 감사 기준에 맞게 정리했고, PR 미생성 자체는 PASS/FAIL/PARTIAL 판정에서 제외한다. read-only reconcile runtime, private WebSocket myOrder/myAsset, REST snapshot bootstrap, mismatch fail-closed를 포함한다. M17 PnL 회계, M18 판단 이유 ledger, M19 exit engine, M20 Telegram inbound, M21 수동 승인, M22 autonomous trading은 M16 범위 밖이다.

목적:

- 운영자 본인 계정의 Upbit KRW 현물에서 24시간 시장을 감시하고, 비용·리스크·유동성 조건을 통과한 경우에만 자동 매수/자동 매도를 수행한다.
- 운영자가 Telegram으로 언제든 보유, 현금, 미체결 주문, realized/unrealized PnL, 최근 판단 이유를 조회할 수 있게 한다.
- 수익 보장이 아니라 손실 제한, 상태 복구, 설명 가능성, 실거래 side effect 통제를 완료 기준으로 둔다.

선행 조건:

- M14 v0.2 pilot private API와 소액 주문 smoke guard 완료
- `PAPER_NO_KEY` 기본 runtime의 live order API 0회 유지
- 출금 권한 없는 owner-operated API key 경계 유지
- 실거래 자동화에 대한 운영자 명시 승인

마일스톤:

| 단계 | 목표 | 다음 단계 진입 조건 |
| --- | --- | --- |
| M15 | `UpbitLiveBroker` 실구현 | `BrokerPort` 기반 submit/cancel/get/list/balance 구현, idempotency와 rate limit 테스트, 기본 runtime live API 0회 |
| M16 | 실계좌 상태 reconcile | REST snapshot bootstrap + private WebSocket myOrder/myAsset 변경 추적, append-only reconcile tables, mismatch fail-closed, closed order 7일 이하 구간 조회, PnL 계산 금지, read-only 권한(자산조회/주문조회)만 요구 |
| M17 | PnL/포지션 회계 | realized/unrealized PnL, fee/spread/slippage 비용 분해, Telegram/status용 safe summary |
| M18 | 판단 이유 ledger와 설명 API | 매수, 매도, 보유, 현금 보유 이유를 deterministic evidence로 조회 가능 |
| M19 | 자동 매도와 포지션 축소 | 손절, 익절, trailing stop, 시간 기반 청산, 전략 exit signal의 paper/live pilot 검증 |
| M20 | Telegram 양방향 운영 | owner chat allowlist, 조회/control 명령 분리, inbound command audit, 보안/신뢰성 문서 갱신 |
| M21 | 수동 승인 live pilot | 자동 후보 생성 후 운영자 승인 주문만 제출, 승인 없는 주문 0건 |
| M22 | 제한적 완전 자동매매 | 소액 budget에서 자동 매수/매도 24시간 pilot, risk gate 우회 주문 0건, reconcile mismatch 0건 |
| M23 | 24/7 운영 안정화 | 7일 연속 live small-budget 리포트, 재시작 복구, 알림 retry, 장애 drill |
| M24 | 전략 확장과 예산 확대 | paper/live shadow 비교, 전략별 손익 분해, 운영자 승인 기반 예산 확대 |

핵심 비범위:

- 수익 보장
- 투자 자문
- 출금 API와 입출금 자동화
- 선물, 레버리지, 마진
- 타인 계정 또는 신호 판매
- LLM 직접 매수/매도 판단
- 신규 진입 시장가 주문 기본 허용
- 장애 상황의 무조건 자동 시장가 청산

Acceptance Criteria:

- [ ] M15 이전에는 실거래 자동 주문 루프를 만들지 않는다.
- [ ] M20 이전에는 Telegram inbound command를 만들지 않는다. 현재 outbound-only 보안 기준을 바꾸려면 `SECURITY.md`, `RUNTIME_CONFIG.md`, `RELIABILITY.md`를 함께 갱신한다.
- [ ] M22 이전에는 운영자 승인 없는 자동 실거래 주문을 허용하지 않는다.
- [ ] M22 진입 시점에는 live broker, reconcile, PnL, decision ledger, exit engine, Telegram status가 모두 검증되어야 한다.
- [ ] 각 단계는 기본 `PAPER_NO_KEY` runtime의 live order API 0회 회귀 검증을 포함한다.
- [ ] 각 live 단계는 소액 budget, 명시 guard, redacted artifact, audit/risk evidence를 남긴다.

## 권장 issue 순서

1. M8-C MVP 완료 판정
2. M9 Paper 운영 베타
3. M10 LLM 리스크 보조 경계
4. M12 큰 TypeScript 모듈 책임 분리 1~2차
5. M11 전략/피처 품질 보강
6. M12 큰 TypeScript 모듈 책임 분리 잔여
7. M13 Phase 1.5 알트 수동 편입
8. M14 v0.2 Pilot 준비
9. M15 `UpbitLiveBroker` 실구현
10. M16 실계좌 상태 reconcile
11. M17 PnL/포지션 회계
12. M18 판단 이유 ledger와 설명 API
13. M19 자동 매도와 포지션 축소
14. M20 Telegram 양방향 운영
15. M21 수동 승인 live pilot
16. M22 제한적 완전 자동매매
17. M23 24/7 운영 안정화
18. M24 전략 확장과 예산 확대

M10과 M12 일부는 M9와 병렬로 검토할 수 있지만, M9의 운영 증거를 흔드는 파일과 겹치면 순차 진행한다. M13과 M14는 paper
운영 안정화 전에는 시작하지 않는다. M15 이후는 M14 guard를 전제로 하되, M22 전까지 운영자 승인 없는 실거래 자동 주문을 열지 않는다.

## Open Questions

- v0.2 pilot에서 read-only account integration을 먼저 열지, 주문 조회까지 함께 열지 결정해야 한다.
- 첫 `LIVE_AUTONOMOUS_SMALL_BUDGET` 대상 market을 BTC 단일로 할지 BTC/ETH로 할지 결정해야 한다.
- 첫 live autonomous 총 예산과 1회 주문 한도를 운영자가 별도 승인해야 한다.
- 초기 exit rule 조합을 손절/익절/시간 기반으로 시작할지 trailing stop까지 포함할지 결정해야 한다.
- Telegram inbound는 webhook과 polling 중 하나를 선택해야 한다.
- 배포 위치와 고정 IP, Upbit API key allowlist 운영 방식을 결정해야 한다.

### 완료된 판단

- paper 운영 안정화 기준은 `3일(72시간)`로 확정했고, closeout은 `#68` 검증 결과로 반영한다.
- “알아서 매수하고 알아서 매도”는 M22에서 제한적으로 허용하며, M15-M21은 이를 가능하게 하는 안전 기반으로 분리한다.

결정된 항목:

- optional `/metrics`는 MVP 완료 조건에서 제외한다. 운영 관측성 endpoint가 필요하면 M9 이후 별도 issue로 다룬다.

## 완료 기준

- [x] 이 계획을 기준으로 M8-C 이후 issue 초안을 만들 수 있다.
- [x] 새 마일스톤 문서가 completed plan 인덱스와 context map에 등록된다.
- [x] `./scripts/verify docs`가 통과한다.
