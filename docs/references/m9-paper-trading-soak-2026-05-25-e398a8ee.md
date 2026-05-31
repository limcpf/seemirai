# M9 #68 72시간 paper trading soak evidence

- 확인일: 2026-05-31
- 대상 issue: #68 `[Ops] M9 72시간 paper trading 관측`
- run prefix: `m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee`
- 판정: passed

이 문서는 저장소 밖 vault에 생성된 M9 paper trading soak 산출물을 issue와 설계 문서에서 안정적으로 참조할 수 있게 반입한
요약 evidence다. 원천 JSON과 raw event log는 실행 산출물이며 용량과 재생성 성격 때문에 저장소에 커밋하지 않는다.

## Source artifacts

원천 artifact는 아래 경로에 보관한다.

- aggregate summary: `/home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak/m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee-summary.json`
- aggregate report: `/home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak/m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee-report.md`
- day reports: `/home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak/m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee-day-{1,2,3}-report.md`
- day summaries: `/home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak/m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee-day-{1,2,3}-summary.json`
- 3일 비교 report: `/home/lim/vaults/99_운영/seemirai-m9-paper/m9-3day-trading-soak-comparison.md`
- raw event log: `/home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak/m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee-events.jsonl`

## Aggregate result

| 항목 | 값 |
| --- | --- |
| status | `passed` |
| input | `upbit_public_websocket_paper_trading_loop` |
| startedAt | `2026-05-25T11:01:10.044Z` |
| finishedAt | `2026-05-28T11:01:10.055Z` |
| durationMsObserved | `259200011` |
| durationMsRequested | `259200000` |
| git branch | `main` |
| git commit | `587ec3c88500` |
| paperTradingCycles | `4319` |
| strategyEvaluationCount | `17276` |
| orderCandidateCount | `12957` |
| orderIntentCount | `12957` |
| paperOrderSubmittedCount | `2130` |
| paperFillCount | `2130` |
| fillRate | `1` |
| liveOrderApiCalls | `0` |
| crash/unhandled rejection | `0 / 0` |

## Cost, slippage, and blocking

| 항목 | 값 |
| --- | --- |
| costSummary.evaluatedCount | `12957` |
| costSummary.allowedCount | `8638` |
| costSummary.rejectedCount | `4319` |
| averageCostBps | `13` |
| averageRequiredReturnBps | `23` |
| averageMarginBps | `-1.333333333333` |
| slippageSummary.observedFillCount | `2130` |
| averageSlippageBps | `0` |
| holdReasonCounts | `{"fixture_waiting_for_signal":4319}` |
| discardReasonCounts | `{}` |
| costRejectedCount | `4319` |
| riskRejectedCount | `6508` |
| blockingReasonCounts | `{"cost:cost_margin_insufficient":4319,"hold:fixture_waiting_for_signal":4319,"risk:expected_loss_limit_exceeded":4319,"risk:order_notional_limit_exceeded":4378}` |

`averageMarginBps`가 음수이므로 #68 이후 threshold calibration은 후보 수를 늘리기 위한 완화보다 비용 안전마진, 거래대금 spike,
유동성 점수, spread 상한, cost-adjusted margin 하한을 보수적으로 검토해야 한다.

## Day comparison

| 일차 | 기간 | status | cycles | submitted/fill | fillRate | cost evaluated | averageMarginBps | riskRejectedCount | 주요 차단 사유 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Day 1 | `2026-05-25T11:01:10.044Z` - `2026-05-26T11:01:10.044Z` | passed | `1439` | `664 / 664` | `1` | `4317` | `-1.333333333333` | `2214` | `cost:cost_margin_insufficient=1439`, `hold:fixture_waiting_for_signal=1439`, `risk:expected_loss_limit_exceeded=1439`, `risk:order_notional_limit_exceeded=1550` |
| Day 2 | `2026-05-26T11:01:10.044Z` - `2026-05-27T11:01:10.044Z` | passed | `1440` | `668 / 668` | `1` | `4320` | `-1.333333333333` | `2212` | `cost:cost_margin_insufficient=1440`, `hold:fixture_waiting_for_signal=1440`, `risk:expected_loss_limit_exceeded=1440`, `risk:order_notional_limit_exceeded=1544` |
| Day 3 | `2026-05-27T11:01:10.044Z` - `2026-05-28T11:01:10.044Z` | passed | `1440` | `798 / 798` | `1` | `4320` | `-1.333333333333` | `2082` | `cost:cost_margin_insufficient=1440`, `hold:fixture_waiting_for_signal=1440`, `risk:expected_loss_limit_exceeded=1440`, `risk:order_notional_limit_exceeded=1284` |

## Validation command

아래 명령으로 원천 artifact와 이 문서의 closeout 판단을 재검증한다.

```sh
node scripts/validate-m9-paper-soak-evidence.mjs \
  --artifact-dir /home/lim/vaults/99_운영/seemirai-m9-paper/trading-soak \
  --comparison-report /home/lim/vaults/99_운영/seemirai-m9-paper/m9-3day-trading-soak-comparison.md \
  --issue-comment
```

2026-05-31 재검증 결과는 `statusCode=passed`, aggregate/day summary/report/comparison/live order API 0/crash 0/daily report evidence
모두 통과다.

## Follow-up use

- M11 threshold calibration issue와 PR은 이 문서를 내부 evidence 기준으로 참조한다.
- 원천 artifact 경로는 추적 정보로만 사용하고, issue 본문과 설계 문서의 primary evidence는 이 문서로 둔다.
- raw event log를 분석해야 하는 경우에만 vault 원천 경로를 직접 사용한다.
