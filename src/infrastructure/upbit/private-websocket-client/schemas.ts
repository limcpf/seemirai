import { z } from "zod";

/* ============================================================
 * Private WebSocket payload schemas
 *
 * Upbit private WebSocket `myOrder`/`myAsset` 응답을 검증한다.
 * myOrder는 주문/체결/SMP 상태 변경 시점에만 전송되고,
 * myAsset은 자산 잔고 변경 시점에만 전송된다.
 *
 * sequence가 없으므로 gap 감지는 runtime worker가 개별적으로
 * 판단해야 한다.
 *
 * 주의: raw payload, Authorization/JWT, access key, secret key는
 * log/status/audit payload에 절대 저장하지 않는다.
 * ============================================================ */

/** Upbit private WebSocket 정밀 숫자 payload schema다.
 *
 * JSON number는 JSON.parse 시점에 원문 소수 자릿수를 잃을 수
 * 있으므로 schema 경계에서는 문자열만 허용한다. DEFAULT raw
 * JSON number는 parseUpbitPrivateWebSocketMessage가 lexeme을
 * 문자열로 보존한 뒤 이 schema에 전달한다.
 */
const UpbitPrivateWsNumericSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "numeric string is required");

/** Upbit private WebSocket market code schema다. */
const UpbitPrivateWsMarketCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/u, "Upbit market code is required");

/** Upbit private WebSocket stream type schema다. */
const UpbitPrivateWsStreamTypeSchema = z.enum(["SNAPSHOT", "REALTIME"]);

/** Upbit private WebSocket myOrder 주문 유형 schema다. */
const UpbitPrivateWsOrderTypeSchema = z.enum(["limit", "price", "market", "best"]);

/* ============================================================
 * myOrder raw payload schema
 *
 * Upbit 공식 문서 기준 필드를 포함하며, 알 수 없는 추가 필드는
 * .passthrough()로 보존한다. myOrder 이벤트는 주문 uuid, code,
 * ask_bid, state, 수량, 평균 체결가, 수수료, order_timestamp, timestamp,
 * stream_type을 포함한다.
 * ============================================================ */

/**
 * Upbit private WebSocket myOrder raw payload schema다.
 *
 * 이 schema는 raw JSON payload를 검증한다. numeric 값은
 * string contract로 변환해 정밀도를 보존한다.
 */
export const UpbitPrivateWebSocketMyOrderSchema = z
  .object({
    type: z.literal("myOrder"),
    uuid: z.string().min(1),
    code: UpbitPrivateWsMarketCodeSchema,
    ask_bid: z.enum(["ASK", "BID"]),
    state: z.enum(["wait", "watch", "trade", "done", "cancel", "prevented"]),
    price: UpbitPrivateWsNumericSchema,
    volume: UpbitPrivateWsNumericSchema,
    remaining_volume: UpbitPrivateWsNumericSchema,
    executed_volume: UpbitPrivateWsNumericSchema,
    avg_price: UpbitPrivateWsNumericSchema,
    paid_fee: UpbitPrivateWsNumericSchema,
    trade_fee: UpbitPrivateWsNumericSchema.optional(),
    prevented_volume: UpbitPrivateWsNumericSchema.optional(),
    prevented_locked: UpbitPrivateWsNumericSchema.optional(),
    identifier: z.string().min(1).optional(),
    order_type: UpbitPrivateWsOrderTypeSchema.optional(),
    fee_currency: z.string().min(1).optional(),
    trade_uuid: z.string().min(1).optional(),
    trade_timestamp: z.number().int().nonnegative().optional(),
    order_timestamp: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    stream_type: UpbitPrivateWsStreamTypeSchema,
  })
  .passthrough();

export type UpbitPrivateWebSocketMyOrder = z.infer<typeof UpbitPrivateWebSocketMyOrderSchema>;

/* ============================================================
 * myAsset raw payload schema
 *
 * 현재 잔고 화면 snapshot으로, currency별 balance/locked를
 * 문자열로 포함한다.
 * ============================================================ */

const UpbitPrivateWsAssetUnitSchema = z
  .object({
    currency: z.string().min(1),
    balance: UpbitPrivateWsNumericSchema,
    locked: UpbitPrivateWsNumericSchema,
  })
  .passthrough();

/**
 * Upbit private WebSocket myAsset raw payload schema다.
 *
 * `assets` 필드는 자산 목록이며, currency, balance, locked를 포함한다.
 * avg_buy_price 같은 추가 필드는 .passthrough()로 보존하되
 * 정규화에서는 사용하지 않는다.
 */
export const UpbitPrivateWebSocketMyAssetSchema = z
  .object({
    type: z.literal("myAsset"),
    asset_uuid: z.string().min(1).optional(),
    assets: z.array(UpbitPrivateWsAssetUnitSchema).min(0),
    asset_timestamp: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    stream_type: UpbitPrivateWsStreamTypeSchema,
  })
  .passthrough();

export type UpbitPrivateWebSocketMyAsset = z.infer<typeof UpbitPrivateWebSocketMyAssetSchema>;

/* ============================================================
 * Private WebSocket union schema
 * ============================================================ */

/** Private WebSocket에서 수신 가능한 모든 payload schema union이다. */
export const UpbitPrivateWebSocketPayloadSchema = z.union([
  UpbitPrivateWebSocketMyOrderSchema,
  UpbitPrivateWebSocketMyAssetSchema,
]);

export type UpbitPrivateWebSocketPayload = z.infer<typeof UpbitPrivateWebSocketPayloadSchema>;

/** Upbit private WebSocket ping 응답 status message schema다. */
export const UpbitPrivateWebSocketStatusMessageSchema = z
  .object({
    status: z.literal("UP"),
  })
  .passthrough();

export type UpbitPrivateWebSocketStatusMessage = z.infer<
  typeof UpbitPrivateWebSocketStatusMessageSchema
>;

/** Upbit private WebSocket provider error envelope schema다. */
export const UpbitPrivateWebSocketProviderErrorMessageSchema = z
  .object({
    error: z
      .object({
        name: z.string().min(1),
        message: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type UpbitPrivateWebSocketProviderErrorMessage = z.infer<
  typeof UpbitPrivateWebSocketProviderErrorMessageSchema
>;

/** JSON_LIST format에서 수신되는 payload 배열 schema다. */
export const UpbitPrivateWebSocketJsonListPayloadSchema = z.array(
  UpbitPrivateWebSocketPayloadSchema,
);

/** DEFAULT 단일 객체와 JSON_LIST 배열을 모두 받는 raw message schema다. */
export const UpbitPrivateWebSocketMessageSchema = z.union([
  UpbitPrivateWebSocketPayloadSchema,
  UpbitPrivateWebSocketJsonListPayloadSchema,
  UpbitPrivateWebSocketStatusMessageSchema,
  UpbitPrivateWebSocketProviderErrorMessageSchema,
]);

export type UpbitPrivateWebSocketMessage = z.infer<typeof UpbitPrivateWebSocketMessageSchema>;

/**
 * Upbit private WebSocket raw JSON 문자열을 schema contract로 파싱한다.
 *
 * DEFAULT format은 balance/price/volume 같은 필드를 JSON number로
 * 보낼 수 있다. JSON.parse 후에는 숫자 원문을 복구할 수 없으므로,
 * 정밀 필드의 number lexeme만 먼저 문자열로 감싼 뒤 schema를
 * 적용한다. raw payload는 caller가 즉시 정규화하고 저장/로그에는
 * redacted event 또는 gap evidence만 남기는 invariant를 유지한다.
 */
export function parseUpbitPrivateWebSocketMessage(rawMessage: string): UpbitPrivateWebSocketMessage {
  if (rawMessage.trim().length === 0) {
    throw new Error("Upbit private WebSocket message is required");
  }

  const parsed = JSON.parse(stringifyPrivateNumericLexemes(rawMessage)) as unknown;

  return UpbitPrivateWebSocketMessageSchema.parse(parsed);
}

const PRIVATE_NUMERIC_JSON_FIELDS = new Set([
  "price",
  "volume",
  "remaining_volume",
  "executed_volume",
  "avg_price",
  "paid_fee",
  "trade_fee",
  "prevented_volume",
  "prevented_locked",
  "balance",
  "locked",
]);

function stringifyPrivateNumericLexemes(rawMessage: string): string {
  return rawMessage.replace(
    /"(?<field>[A-Za-z_]+)"\s*:\s*(?<value>(?:0|[1-9]\d*)(?:\.\d+)?)(?=\s*[,}\]])/gu,
    (match: string, ...args: unknown[]): string => {
      const groups = args.at(-1) as { field?: string; value?: string } | undefined;
      const field = groups?.field;
      const value = groups?.value;

      if (field === undefined || value === undefined || !PRIVATE_NUMERIC_JSON_FIELDS.has(field)) {
        return match;
      }

      // 정밀 수량/금액 필드만 JSON.parse 전에 문자열화해 double 반올림을 막는다.
      return `"${field}":"${value}"`;
    },
  );
}
