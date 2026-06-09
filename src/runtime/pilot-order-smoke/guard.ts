import type { UpbitPrivateCancelOrderInput, UpbitPrivateCreateLimitOrderInput, UpbitPrivateGetOrderInput } from "../../infrastructure/upbit/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import {
  UPBIT_PILOT_IDENTIFIER_MAX_LENGTH,
  UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT,
} from "../pilot-config.js";
import type { PilotRuntimeConfig } from "../pilot-config.js";
import type { Decimal } from "decimal.js";

import type { M19ExitPilotGuardConfigResult } from "../pilot-config/types.js";

/**
 * pilot order smoke가 허용하는 단일 지정가 주문 의도다.
 *
 * 이 입력은 실제 Upbit 주문 생성 직전 runtime guard에서만 사용한다. M14 invariant에 따라 KRW 현물 매수, `limit`,
 * `post_only`, smoke run 고유 identifier만 허용하며, 타입 자체는 외부 API 호출 side effect를 만들지 않는다.
 */
export interface PilotOrderSmokeLimitOrderIntent {
  market: string;
  side: "bid";
  volume: string;
  price: string;
  identifier: string;
  timeInForce: "post_only";
}

/**
 * pilot order smoke request plan 생성 입력이다.
 *
 * `pilotConfig`는 env guard를 통과한 runtime 설정이고, `intent`는 운영자가 확정한 첫 smoke 주문 의도다. 이 입력은 순수
 * 검증 경계에만 쓰이며, 거래소 호출은 반환된 plan을 Upbit private client에 명시적으로 전달할 때만 발생한다.
 */
export interface CreatePilotOrderSmokeRequestPlanInput {
  pilotConfig: PilotRuntimeConfig;
  intent: PilotOrderSmokeLimitOrderIntent;
}

/**
 * pilot order smoke가 거래소 client에 넘길 수 있는 request plan이다.
 *
 * create/cancel/lookup 입력은 모두 같은 `identifier`를 공유해야 한다. 이 plan은 아직 실행되지 않은 명령 묶음이며,
 * 외부 side effect를 만들지 않는다.
 */
export interface PilotOrderSmokeRequestPlan {
  createOrder: UpbitPrivateCreateLimitOrderInput;
  cancelOrder: UpbitPrivateCancelOrderInput;
  lookupOrder: UpbitPrivateGetOrderInput;
  notionalKrw: string;
}

/**
 * pilot order smoke 요청이 안전 invariant를 만족하지 못했을 때 던지는 오류다.
 *
 * violations는 운영자가 수정할 수 있는 한국어 원인 목록이며, 이 오류가 발생하면 `POST /v1/orders` 또는 `DELETE /v1/order`
 * 같은 실계좌 side effect를 호출하면 안 된다.
 */
export class UnsafePilotOrderSmokeRequestError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`안전하지 않은 pilot order smoke 요청: ${violations.join(", ")}`);
    this.name = "UnsafePilotOrderSmokeRequestError";
    this.violations = violations;
  }
}

/**
 * pilot order smoke 의도를 Upbit private client 입력으로 변환한다.
 *
 * profile/guard/scope, KRW market, `bid` 지정가, `post_only`, identifier 길이, 5,000 KRW 이상과 env 상한 이하 금액을 모두
 * 확인한다. 반환값을 만들 때까지는 fetch/DB/audit side effect가 없으며, 위반 시 거래소 호출 전에 fail-closed 한다.
 */
export function createPilotOrderSmokeRequestPlan(
  input: CreatePilotOrderSmokeRequestPlanInput,
): PilotOrderSmokeRequestPlan {
  const violations: string[] = [];
  validatePilotOrderSmokeConfig(input.pilotConfig, violations);
  validatePilotOrderSmokeIntent(input, violations);

  if (violations.length > 0) {
    throw new UnsafePilotOrderSmokeRequestError(violations);
  }

  const notionalKrw = calculateOrderNotionalKrw(input.intent.price, input.intent.volume).toFixed();

  return {
    createOrder: {
      market: input.intent.market,
      side: input.intent.side,
      volume: input.intent.volume,
      price: input.intent.price,
      identifier: input.intent.identifier,
      timeInForce: input.intent.timeInForce,
    },
    cancelOrder: {
      identifier: input.intent.identifier,
    },
    lookupOrder: {
      identifier: input.intent.identifier,
    },
    notionalKrw,
  };
}

function validatePilotOrderSmokeConfig(config: PilotRuntimeConfig, violations: string[]): void {
  if (!config.enabled) {
    // API key 없는 기본 runtime은 실주문 wrapper로 승격하지 않도록 profile 단계에서 닫는다.
    violations.push("PILOT_ORDER_SMOKE profile이 필요합니다");
    return;
  }

  if (config.profile !== "PILOT_ORDER_SMOKE") {
    violations.push("PILOT_ORDER_SMOKE profile이 필요합니다");
  }

  if (!config.privateSmokeEnabled || !config.orderSmokeEnabled) {
    // 주문 생성/취소는 private read guard와 order smoke guard가 동시에 켜져야만 실행 계획으로 변환한다.
    violations.push("SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1 과 SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1 이 필요합니다");
  }

  if (!config.keyScopes.includes("주문하기")) {
    // 주문하기 scope가 없으면 거래소가 거부하기 전에 local guard에서 수동 권한 증거를 다시 요구한다.
    violations.push("Upbit key scope에 주문하기 권한이 필요합니다");
  }
}

function validatePilotOrderSmokeIntent(input: CreatePilotOrderSmokeRequestPlanInput, violations: string[]): void {
  const config = input.pilotConfig;
  const intent = input.intent;

  if (!intent.market.startsWith("KRW-")) {
    violations.push("order smoke market은 KRW- 로 시작하는 현물 market이어야 합니다");
  }

  if (config.enabled && config.orderSmokeMarket !== undefined && intent.market !== config.orderSmokeMarket) {
    // env에 승인된 smoke market과 요청 market이 다르면 의도치 않은 종목 주문을 막기 위해 닫는다.
    violations.push("order smoke market은 SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET 과 같아야 합니다");
  }

  if (intent.side !== "bid") {
    violations.push("order smoke는 지정가 매수(side=bid)만 허용합니다");
  }

  if (intent.timeInForce !== "post_only") {
    // 첫 실주문 smoke는 maker-only 지정가 경계만 확인하고 즉시 체결 가능한 taker 주문은 열지 않는다.
    violations.push("order smoke는 time_in_force=post_only 지정가만 허용합니다");
  }

  if (intent.identifier.length === 0 || intent.identifier.length > UPBIT_PILOT_IDENTIFIER_MAX_LENGTH) {
    // 같은 smoke run의 생성/조회/취소를 연결하려면 Upbit identifier 길이 제한을 local에서 먼저 지켜야 한다.
    violations.push(`order smoke identifier는 1자 이상 ${UPBIT_PILOT_IDENTIFIER_MAX_LENGTH}자 이하여야 합니다`);
  }

  validateOrderSmokeBudget(input, violations);
}

function validateOrderSmokeBudget(input: CreatePilotOrderSmokeRequestPlanInput, violations: string[]): void {
  const notional = parsePositiveDecimalProduct(input.intent.price, input.intent.volume, violations);
  if (notional === undefined) {
    return;
  }

  const maxKrw = readOrderSmokeMaxKrw(input.pilotConfig, violations);
  if (notional.lessThan(UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT)) {
    violations.push(`order smoke 주문 총액은 ${UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT} KRW 이상이어야 합니다`);
  }

  if (maxKrw !== undefined && notional.greaterThan(maxKrw)) {
    // 운영자가 승인한 소액 상한을 넘으면 주문 생성 side effect 전에 닫는다.
    violations.push("order smoke 주문 총액은 SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 이하여야 합니다");
  }
}

function parsePositiveDecimalProduct(
  price: string,
  volume: string,
  violations: string[],
): Decimal | undefined {
  try {
    const parsedPrice = parseFinancialDecimal(price);
    const parsedVolume = parseFinancialDecimal(volume);
    if (!parsedPrice.isPositive() || !parsedVolume.isPositive()) {
      violations.push("order smoke price와 volume은 양수 decimal 문자열이어야 합니다");
      return undefined;
    }

    return parsedPrice.mul(parsedVolume);
  } catch {
    violations.push("order smoke price와 volume은 decimal 문자열이어야 합니다");
    return undefined;
  }
}

function calculateOrderNotionalKrw(price: string, volume: string): Decimal {
  return parseFinancialDecimal(price).mul(parseFinancialDecimal(volume));
}

function readOrderSmokeMaxKrw(config: PilotRuntimeConfig, violations: string[]): Decimal | undefined {
  if (!config.enabled || config.orderSmokeMaxKrw === undefined) {
    violations.push("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 가 필요합니다");
    return undefined;
  }

  try {
    const maxKrw = parseFinancialDecimal(config.orderSmokeMaxKrw);
    if (!maxKrw.isPositive()) {
      violations.push("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 는 양수 KRW 금액이어야 합니다");
      return undefined;
    }

    return maxKrw;
  } catch {
    violations.push("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 는 decimal 문자열이어야 합니다");
    return undefined;
  }
}

/**
 * M19 guarded buy smoke가 별도 운영자 승인 evidence를 가졌는지 검증한다.
 *
 * M19 invariant: 신규 진입 포지션을 만드는 guarded buy smoke는 `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID`가
 * 없으면 API 호출 전에 fail-closed 한다. 이 가드는 주문 side effect를 만들지 않는 순수 검증 경계다.
 *
 * `loadM19ExitPilotGuardConfigFromEnv`의 반환값을 그대로 받으며, disabled config는 SKIPPED,
 * approval evidence 누락은 FAILED_CLOSED, 승인 통과 시 PASSED를 반환한다.
 */
export function validateM19GuardedBuySmokeGuard(
  m19Guard: M19ExitPilotGuardConfigResult,
  side: "bid" | "ask",
): M19GuardedBuySmokeValidation {
  if (!m19Guard.enabled) {
    // M19 guard가 없으면 신규 buy smoke 경로 자체를 열지 않고 skip evidence를 남긴다.
    return {
      result: "SKIPPED",
      reason: "M19 guard 비활성",
      message:
        "M19 exit pilot guard가 꺼져 있어 guarded buy smoke 경로를 열지 않는다. paper fixture로만 exit 검증을 수행한다.",
      action:
        "신규 buy smoke가 필요한 경우 SEEMIRAI_RUN_M19_EXIT_PILOT=1, position source, 소액 한도, operator evidence id를 설정한다.",
      sideEffectPossible: false,
    };
  }

  if (side === "ask") {
    // M19 exit pilot은 매도/축소 경로가 기본이다. 매도는 기존 보유 포지션을 줄이는 쪽이므로 guarded buy 승인 없이 허용한다.
    // 단, 실제 포지션 존재 여부와 소액 한도는 smoke runner에서 추가 검증한다.
    return {
      result: "PASSED",
      reason: "exit_side_allowed",
      message: "M19 exit pilot guard 매도/축소 경로가 열려 있다.",
      action:
        "실행 전 기존 보유 포지션 존재 여부, 소액 한도, exit rule 조건을 확인한다.",
      sideEffectPossible: true,
    };
  }

  if (!m19Guard.guardedBuySmokeEnabled) {
    // guarded buy smoke가 명시적으로 꺼져 있으면 buy 경로를 열지 않는다.
    return {
      result: "SKIPPED",
      reason: "guarded_buy_not_enabled",
      message:
        "M19 guarded buy smoke가 꺼져 있어 신규 buy smoke 경로를 열지 않는다. 기존 포지션 exit 또는 paper fixture 검증을 우선한다.",
      action:
        "신규 buy smoke가 필요한 경우 SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1 과 SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID 를 설정한다.",
      sideEffectPossible: false,
    };
  }

  if (m19Guard.guardedBuyApprovalEvidenceId === undefined) {
    // guarded buy smoke가 켜졌지만 approval evidence가 없으면 API 호출 전에 fail-closed 한다.
    return {
      result: "FAILED_CLOSED",
      reason: "guarded_buy_approval_missing",
      message:
        "M19 guarded buy smoke가 켜졌지만 SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID 가 없어 fail-closed 됐다.",
      action:
        "운영자가 Upbit PC 웹에서 키 권한을 재확인하고 redacted evidence id를 제공한 뒤 다시 실행한다.",
      sideEffectPossible: false,
    };
  }

  return {
    result: "PASSED",
    reason: "guarded_buy_approved",
    message: "M19 guarded buy smoke 승인 evidence가 확인됐다.",
    action:
      "실행 전 소액 한도, identifier, redacted artifact 조건을 다시 확인한다.",
    sideEffectPossible: true,
  };
}

/**
 * M19 guarded buy smoke validation 결과다.
 *
 * `result`가 `SKIPPED`이면 실주문 side effect를 시도하지 않고 skip evidence를 남긴다.
 * `FAILED_CLOSED`이면 approved 조건 미충족으로 API 호출 전에 차단한다.
 * `PASSED`인 경우에만 `sideEffectPossible=true`이며 smoke runner가 추가 검증 후 주문할 수 있다.
 */
export interface M19GuardedBuySmokeValidation {
  result: "SKIPPED" | "FAILED_CLOSED" | "PASSED";
  reason: string;
  message: string;
  action: string;
  sideEffectPossible: boolean;
}
