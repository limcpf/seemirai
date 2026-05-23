# 품질 점수판

기준일: `2026-05-23`

| 항목 | 점수 | 근거 | 다음 조치 |
| --- | --- | --- | --- |
| 문서 라우팅 | B+ | 루트 라우터, 문서 인덱스, context map, runbook, completed plan 경로가 실제 운영 문서와 연결된다. | 문서 이동 시 context map과 인덱스를 계속 함께 갱신한다. |
| 제품 요구사항 | B | PRD, 기능 요구사항, MVP 업무 명세가 Upbit KRW paper trading 범위와 비범위를 고정했고 M8-C 증거와 충돌하지 않는다. | M9 paper 운영 결과로 v0.2 pilot 전환 기준을 별도 문서화한다. |
| 설계 기록 | B | 런타임, DB, TypeScript 모듈 구조, 운영 가드레일 결정이 설계 문서와 실행 계획에 남아 있다. | M9 이후 runtime 조립 경계가 바뀌면 design-docs에 추가한다. |
| 실행 계획 운영 | B+ | M0~M8 MVP 개발 계획을 completed로 이동할 수 있는 상태이며, Post-M8 계획은 M9 이후 작업을 추적한다. | M9 운영 베타 결과와 3일 report 비교를 active plan에 누적한다. |
| 신뢰성 기준 | B | 24시간 public WebSocket soak가 crash 0회, live order API 0회, audit 누락 0건으로 통과했고 fixture smoke와 전체 verify가 통과했다. | 실제 DB 적재와 반복 운영 신뢰성은 M9에서 별도 증거로 닫는다. |
| 보안 기준 | B | PAPER_NO_KEY, Telegram inbound 부재, live order API disabled 경계가 M8-C soak summary와 source scan으로 확인됐다. | Upbit account/private API는 v0.2 pilot 권한 matrix 전까지 열지 않는다. |
| 자동 검증 | B+ | `./scripts/verify`가 docs/hooks/github/typecheck/test를 실행하고 M8-C에서 통과했다. | DB integration과 운영 drill은 명시 env 기반으로 별도 실행 기록을 남긴다. |

## 참고

- 점수는 저장소에 버전 관리된 근거만 기준으로 평가한다.
- 자세한 후속 작업은 [`exec-plans/tech-debt-tracker.md`](./exec-plans/tech-debt-tracker.md)에서 관리한다.
