import type { UpbitPrivateCancelOrderInput, UpbitPrivateCreateLimitOrderInput, UpbitPrivateGetOrderInput } from "../../infrastructure/upbit/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import {
  UPBIT_PILOT_IDENTIFIER_MAX_LENGTH,
  UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT,
} from "../pilot-config.js";
import type { PilotRuntimeConfig } from "../pilot-config.js";
import type { Decimal } from "decimal.js";

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
