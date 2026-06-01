import type { PilotKeyScope, PilotProfileId } from "../../domain/index.js";

export const PILOT_PROFILES = ["PILOT_READ_ONLY", "PILOT_POLICY_SYNC", "PILOT_ORDER_SMOKE"] as const satisfies readonly PilotProfileId[];
export const ALLOWED_KEY_SCOPES = ["자산조회", "주문조회", "주문하기"] as const satisfies readonly PilotKeyScope[];
export const FORBIDDEN_KEY_SCOPES = [
  "출금조회",
  "출금하기",
  "입금조회",
  "입금하기",
  "선물",
  "레버리지",
] as const;

export const UPBIT_PILOT_IDENTIFIER_MAX_LENGTH = 32;
export const UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT = 5_000;
export const UPBIT_PILOT_ORDER_SMOKE_MAX_KRW_LIMIT = 50_000;

/**
 * v0.2 pilot runner가 인식하는 실행 profile 식별자다.
 *
 * env 입력과 후속 private API wrapper 사이의 호출 경계에서 사용하며, 기본 `PAPER_NO_KEY` runtime과 pilot side effect 범위를
 * 분리하는 invariant를 유지한다. 이 type 자체는 외부 side effect를 만들지 않는다.
 */
export type PilotRuntimeProfile = PilotProfileId;

/**
 * M14 pilot에서 허용되는 Upbit key 권한 이름이다.
 *
 * 운영자가 PC 웹에서 확인한 scope evidence를 코드 guard가 비교할 수 있는 값으로 제한한다. 출금/입출금/레버리지 scope는 이
 * union에 포함하지 않아 profile 조립 전에 fail-closed 되며, 외부 side effect는 없다.
 */
export type PilotUpbitKeyScope = PilotKeyScope;

/**
 * pilot profile이 비활성인 기본 상태를 표현한다.
 *
 * 호출 경계는 runtime 조립 또는 smoke test bootstrap이며, 기본 `PAPER_NO_KEY` 실행이 env 없이 private API 경로로
 * 이동하지 않는 invariant를 유지한다. 외부 side effect는 없고 env 해석 결과만 담는다.
 */
export interface DisabledPilotRuntimeConfig {
  enabled: false;
  privateSmokeEnabled: false;
  orderSmokeEnabled: false;
}

/**
 * 명시 guard를 모두 통과한 pilot profile 입력을 표현한다.
 *
 * 호출자는 이 값이 있을 때만 후속 private API client를 조립할 수 있다. access/secret key 원문을 포함하므로 로그, audit,
 * status 응답에 직접 전달하면 안 되며, 이 모듈은 검증만 수행하고 외부 API 호출 side effect를 만들지 않는다.
 */
export interface EnabledPilotRuntimeConfig {
  enabled: true;
  profile: PilotRuntimeProfile;
  privateSmokeEnabled: true;
  orderSmokeEnabled: boolean;
  upbitAccessKey: string;
  upbitSecretKey: string;
  keyScopes: readonly PilotUpbitKeyScope[];
  keyScopeEvidenceId: string;
  policySyncMarket?: string;
  orderSmokeMarket?: string;
  orderSmokeMaxKrw?: string;
  lookupOrderUuid?: string;
  lookupOrderIdentifier?: string;
}

/**
 * pilot runtime env 해석 결과의 public contract다.
 *
 * 호출자는 `enabled=false`이면 private API client를 만들지 않고, `enabled=true`이면 이미 env guard와 권한 evidence 검증을
 * 통과한 입력만 후속 wrapper에 넘긴다. 이 contract는 secret 원문을 포함할 수 있으므로 로그/status에 직접 노출하지 않는
 * invariant를 유지해야 하며, 자체 외부 side effect는 없다.
 */
export type PilotRuntimeConfig = DisabledPilotRuntimeConfig | EnabledPilotRuntimeConfig;

/**
 * pilot runtime env가 안전 profile로 수렴하지 못했을 때 던지는 오류다.
 *
 * violations는 운영자가 수정할 수 있는 한국어 원인 목록이며, guard 누락이나 금지 권한처럼 private/order side effect를
 * 만들기 전에 차단해야 하는 조건만 담는다. 외부 side effect는 없다.
 */
export class UnsafePilotRuntimeConfigError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`안전하지 않은 pilot runtime 설정: ${violations.join(", ")}`);
    this.name = "UnsafePilotRuntimeConfigError";
    this.violations = violations;
  }
}
