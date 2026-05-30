# 품질 점수판

기준일: `2026-05-23`

| 항목 | 점수 | 근거 | 다음 조치 |
| --- | --- | --- | --- |
| 문서 라우팅 | B+ | 루트 라우터, 문서 인덱스, context map, runbook, completed plan 경로가 실제 운영 문서와 연결된다. | 문서 이동 시 context map과 인덱스를 계속 함께 갱신한다. |
| 제품 요구사항 | B+ | PRD, 기능 요구사항, MVP 업무 명세가 Upbit KRW paper trading 범위와 비범위를 고정하며, M8-C 및 M9 #68 closeout 증거가 정합된다. | M9 #68 기반 calibration 후보 도출 이슈/PR을 발행해 M11 threshold 비교를 시작한다. |
| 설계 기록 | B | 런타임, DB, TypeScript 모듈 구조, 운영 가드레일 결정이 설계 문서와 실행 계획에 남아 있다. | M9 이후 runtime 조립 경계가 바뀌면 design-docs에 추가한다. |
| 실행 계획 운영 | B+ | M0~M8 MVP 계획의 완료 상태와 Post-M8 계획이 정합되며, M9 paper 운영 베타 closeout 증거가 반영되기 시작했다. | M11 calibration 제안과 phase 1.5/v0.2 전환 준비 이슈를 active plan에 누적한다. |
| 신뢰성 기준 | A- | 72시간(3일) M9 paper trading soak이 crash/unhandled rejection 0회, live order API 0회, daily report/evidence 연결을 모두 통과했다. | 운영 DB 적재와 notification/cooldown/drill 수동 검증은 issue 증거와 연계해 계속 보완한다. |
| 보안 기준 | B | PAPER_NO_KEY, Telegram inbound 부재, live order API disabled 경계가 M8-C soak summary와 source scan으로 확인됐다. | Upbit account/private API는 v0.2 pilot 권한 matrix 전까지 열지 않는다. |
| 자동 검증 | B+ | `./scripts/verify`가 docs/hooks/github/typecheck/test를 실행하고 M8-C에서 통과했다. | DB integration과 운영 drill은 명시 env 기반으로 별도 실행 기록을 남긴다. |

## 참고

- 점수는 저장소에 버전 관리된 근거만 기준으로 평가한다.
- 자세한 후속 작업은 [`exec-plans/tech-debt-tracker.md`](./exec-plans/tech-debt-tracker.md)에서 관리한다.
