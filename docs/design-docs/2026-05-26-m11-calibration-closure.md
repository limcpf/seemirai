# M11 calibration closure와 #68 guard

- 상태: accepted
- 날짜: 2026-05-26
- M11 closeout 상태: completed
- 관련 문서:
  - [`./2026-05-25-feature-quality-calibration.md`](./2026-05-25-feature-quality-calibration.md)
  - [`../exec-plans/completed/2026-05-22-post-m8-milestone-plan.md`](../exec-plans/completed/2026-05-22-post-m8-milestone-plan.md)
  - [`../RUNTIME_CONFIG.md`](../RUNTIME_CONFIG.md)
  - [`../references/m9-paper-trading-soak-2026-05-25-e398a8ee.md`](../references/m9-paper-trading-soak-2026-05-25-e398a8ee.md)

## 배경

M11 Sub PR 1-4는 feature contract, 순수 계산기, backtest/paper parity, strategy integration과 discard audit을 구현했다.
Sub PR 5는 M9 #68 72시간 paper trading 관측 결과가 있으면 threshold 비교와 보수적 기본값 제안을 남기고, 결과가 없으면
운영 threshold 변경을 강행하지 않는 guard를 남기는 역할이다.

2026-05-30 기준, `#68`은 `issue-comment` 증거가 `passed`로 확인되어 closeout 판정을 확정했다.
따라서 이 문서는 72시간 관측 데이터 부재 guard에서, `#68 pass`로 업데이트된 calibration 후속 상태를 반영한 기록으로 갱신한다.

## 2026-05-30 검토한 증거

| 증거 | 판정 | 이유 |
| --- | --- | --- |
| GitHub issue #68 | 통과 | `validate-m9-paper-soak-evidence.mjs --issue-comment`로 `statusCode=passed` 판정을 재확인했다. |
| [`M9 #68 72시간 paper trading soak evidence`](../references/m9-paper-trading-soak-2026-05-25-e398a8ee.md) | 통과 | `status: passed`, 기간 `259,200,011ms`(요청 `259,200,000ms`)를 충족하고 `paperTradingPath`, `durationCompleted` 조건을 만족한다. |
| 같은 run의 day summary 3개 | 통과 | 내부 evidence에 Day 1/2/3 passed, paper 주문/체결 metric과 비용/슬리피지/체결률/차단 사유 metric을 반입했다. |
| 3일 비교 report | 통과 | 내부 evidence에서 Day 1/2/3를 같은 포맷으로 비교했다. 원천 비교 report는 vault에 추적 정보로 보존한다. |
| controlled decision fixture summary | 유지 | fixture smoke는 paper 주문/체결 경로 점검용 참고 증거로 활용한다. 72시간 run은 별도 운영 증거로 해석한다. |

## 결정

M11 Sub PR 5에서는 `config/paper.json`의 기본 운영 threshold를 변경하지 않는다. #68 완료 전에는 runner 실행 방식, artifact 경로,
daily report, Telegram outbound, notification retry, control drill, 3일 report 비교 포맷도 변경하지 않는다.

M11은 다음 범위를 완료한 것으로 닫는다.

- feature key, 단위, 시간 기준, 결측/fail-closed contract 고정
- 순수 feature calculator와 fixture 기반 검증
- backtest/paper feature parity 검증
- strategy variant required feature와 discard audit 확장
- threshold 비교에 필요한 cost/risk/hold/discard reason summary 경계 정리

`#68`은 완료 판정 상태이며, 실제 threshold 보정값 확정은 내부 반입 evidence와 #68 closeout 문구(댓글/운영 로그 참조) 후 별도
calibration PR 또는 issue에서 처리한다.

## 2026-05-31 #102 calibration closeout

Issue #102는 #68 내부 evidence와 원천 artifact를 기준으로 동일 run shape calibration report와 비활성 profile proposal을
생성하는 범위로 닫는다. #102 Sub PR 5까지 완료되었으므로 M11 자체는 completed로 닫지만, 이 closeout은 운영 기본값을
활성화하는 변경이 아니다. 다음 calibration approval PR에서 비교할 후보와 차단 사유를 고정하는 작업이다.

| 항목 | 결과 |
| --- | --- |
| #68 evidence 재검증 | `validate-m9-paper-soak-evidence.mjs --issue-comment` 통과 |
| calibration report | `/home/lim/vaults/99_운영/seemirai-m9-paper/m11-threshold-calibration-report.md` |
| 비활성 profile proposal | `/home/lim/vaults/99_운영/seemirai-m9-paper/m11-threshold-calibration-profile-proposal.json` |
| paper 주문/체결 | `2130 / 2130`, `fillRate=1` |
| 비용 요약 | `evaluated=12957`, `allowed=8638`, `rejected=4319`, `averageMarginBps=-1.333333333333` |
| 차단 사유 | cost `4319`, risk `8697`, hold `4319`, discard `0` |
| 실거래 주문 API | `liveOrderApiCalls=0` |
| 기본 profile 활성화 | 보류, `config/paper.json` 기본 threshold 변경 없음 |

판정은 다음과 같다.

- 평균 margin이 음수이므로 후보 수를 늘리는 공격적 threshold 완화는 `blocked`로 유지한다.
- 보수 후보는 spread 상한 하향, volume spike 하한 상향, session liquidity score 하한 상향, cost-adjusted margin 하한 상향
  방향으로만 proposal에 남긴다.
- `cost_safety_buffer_bps`는 현재 `strategyParameters`에 직접 대응 key가 없으므로 자동 patch가 아니라 수동 설계 검토 항목으로
  남긴다.
- proposal은 `active=false`, `activationRequired=true`, `defaultConfigMutation=false`를 유지해야 하며, 적용은 동일 run shape
  비교 report를 붙인 별도 calibration approval PR에서만 검토한다.

## 비교 기준

#68 완료 후 threshold 변경 전후 report는 동일 run shape로 아래 항목을 비교해야 한다.

- `costSummary.evaluatedCount`, `allowedCount`, `rejectedCount`
- `averageCostBps`, `averageRequiredReturnBps`, `averageMarginBps`
- `slippageSummary.observedFillCount`, `averageSlippageBps`, `minSlippageBps`, `maxSlippageBps`
- `holdReasonCounts`, `discardReasonCounts`, `costRejectedCount`, `riskRejectedCount`
- `blockingReasonCounts`
- `paperOrderSubmittedCount`, `paperFillCount`, `fillRate`
- feature failure와 unavailable reason 분포
- `liveOrderApiCalls` 0 유지 여부

이 비교 항목이 채워지기 전에는 값이 좋아 보이는 fixture 결과만으로 운영 기본값을 공격적으로 바꾸지 않는다.

## 보수적 제안

#68 완료 후에도 paper 주문 또는 체결이 0건이면 alpha threshold를 조정하기 전에 cost/risk 차단 원인을 먼저 분리한다. 특히
`risk:order_notional_mismatch`, `risk:expected_loss_limit_exceeded`, `cost:cost_margin_insufficient`가 반복되면 전략 임계값보다
주문 금액, 손실 한도, 비용 안전마진 설정의 상호작용을 먼저 점검한다.

3일 비교에서 비용 차감 후 margin이 지속적으로 음수이면 threshold를 낮춰 후보를 늘리는 방향보다, 거래대금 spike, 유동성 점수,
spread 상한, cost-adjusted margin 하한을 보수적으로 유지하거나 높이는 방향만 별도 PR에서 검토한다.

## 후속 처리

1. #68 완료 시 issue #68 댓글에 72시간 summary, day summary 3개, 3일 비교 report 경로와 pass/fail 결론을 남긴다.
2. #102에서 비활성 profile proposal이 생성됐으므로 별도 calibration approval PR에서 동일 run shape 전후 비교를 붙이고
   activation 여부를 판단한다.
3. #68이 실패로 닫혔다면 실패 원인을 M9 운영 보강 이슈로 분리하고 M11 threshold 변경은 계속 보류한다.
4. M12의 무동작 TypeScript 모듈 분리는 #75 merge 뒤 진행할 수 있다. M12는 M9 운영 인증이나 threshold 보정값을 요구하지 않는다.

## Acceptance mapping

| #70 M11 기준 | 판정 |
| --- | --- |
| feature 정의 문서가 추가되고 context map에 등록된다. | Sub PR 1과 이 문서로 충족 |
| feature 계산 실패나 입력 부족은 주문 후보 중지가 된다. | Sub PR 2와 Sub PR 4의 fail-closed guard로 충족 |
| 같은 fixture에서 backtest와 paper feature 값이 일치한다. | Sub PR 3의 parity fixture로 충족 |
| 전략별 threshold 변경 전후 리포트가 비용 반영 기준으로 비교 가능하다. | #102 Sub PR 5에서 비활성 proposal과 비교 경계는 준비 완료, 실제 기본값 activation은 별도 calibration approval PR로 보류 |
