import type { LiveOpsLegacyEnvViolation } from "./legacy-env.js";

/**
 * raw runtime mode/code를 운영자 첫 화면 문구로 낮춘다.
 *
 * 내부 code는 trace/debug에는 필요하지만 TUI/CLI 첫 줄에서 그대로 보이면 운영자가 실제 주문 가능 상태를 오해할 수 있다. 이 함수는
 * 문자열 변환만 수행하며 외부 side effect가 없다.
 */
export function formatLiveOpsModeForUser(input: { mode: string; paperNoKey: boolean }): string {
  if (input.paperNoKey || input.mode === "PAPER_NO_KEY" || input.mode === "PAPER_TRADING") {
    return "모의 운영: 실거래 키 없이 주문 API 호출이 차단된 상태";
  }

  if (input.mode === "LIVE_AUTONOMOUS_SMALL_BUDGET") {
    return "소액 실운영: 모든 readiness와 safety gate를 통과해야 주문 가능한 상태";
  }

  return "운영 상태 확인 필요: 알 수 없는 실행 모드";
}

/**
 * live ops startup 실패를 한국어 action message로 만든다.
 *
 * secret 값이나 raw config payload는 포함하지 않고, operator가 바로 고칠 수 있는 원인과 다음 조치만 반환한다.
 */
export function formatLiveOpsStartupFailureMessage(input: {
  legacyEnvViolations?: readonly LiveOpsLegacyEnvViolation[];
  validationErrors?: readonly string[];
}): string {
  const lines = [
    "production live ops를 시작하지 않았습니다.",
    "원인: 운영 config/env 계약을 통과하지 못했습니다.",
  ];

  if (input.legacyEnvViolations !== undefined && input.legacyEnvViolations.length > 0) {
    lines.push(`legacy milestone env 제거 필요: ${input.legacyEnvViolations.map((violation) => violation.envName).join(", ")}`);
  }

  if (input.validationErrors !== undefined && input.validationErrors.length > 0) {
    lines.push(`검증 오류: ${input.validationErrors.join("; ")}`);
  }

  lines.push("필요 조치: production JSON에는 정책만 두고, DB/Upbit/Telegram/TUI credential은 env 파일로만 주입하세요.");
  return lines.join("\n");
}
