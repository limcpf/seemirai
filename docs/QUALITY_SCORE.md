# 품질 점수판

기준일: `2026-05-12`

| 항목 | 점수 | 근거 | 다음 조치 |
| --- | --- | --- | --- |
| 문서 라우팅 | B | 루트 라우터, 문서 인덱스, context map, 검증 스크립트를 갖췄다. | 실제 프로젝트 적용 후 누락 문서를 보강한다. |
| 제품 요구사항 | C | PRD와 기능 요구사항 템플릿은 있으나 프로젝트별 내용은 아직 채워야 한다. | `prd-writer`로 실제 요구사항을 작성한다. |
| 설계 기록 | B- | Codex-native 운영 결정과 문서 운영 원칙을 기록했다. | 프로젝트별 구조 결정이 생기면 design-docs에 추가한다. |
| 실행 계획 운영 | B- | active/completed 계획 폴더와 규약이 있다. | 큰 작업은 active plan으로 추적한다. |
| 신뢰성 기준 | B- | 재개, idempotency, review drain 기준을 문서화했다. | 실제 end-to-end 운영 결과를 completed plan으로 남긴다. |
| 보안 기준 | B- | secret, 외부 입력, shell command, dependency 기준을 정의했다. | 프로젝트별 secret 경계를 추가한다. |
| 자동 검증 | B | 문서 구조와 hook 설정 검증이 있다. | 코드가 생기면 lint/typecheck/test/build를 `verify`에 연결한다. |

## 참고

- 점수는 저장소에 버전 관리된 근거만 기준으로 평가한다.
- 자세한 후속 작업은 [`exec-plans/tech-debt-tracker.md`](./exec-plans/tech-debt-tracker.md)에서 관리한다.
