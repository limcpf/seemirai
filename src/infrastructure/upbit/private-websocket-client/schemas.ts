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

/** Upbit private WebSocket 숫자 payload schema다.
 *
 * WebSocket은 문자열 또는 number로 numeric 값을 전달할 수 있다.
 * mapper는 두 입력을 모두 문자열로 정규화해 정밀도를 보존한다.
 */
const UpbitPrivateWsNumericSchema = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "numeric string is required"),
]);

/** Upbit private WebSocket market code schema다. */
const UpbitPrivateWsMarketCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/u, "Upbit market code is required");

/** Upbit private WebSocket stream type schema다. */
const UpbitPrivateWsStreamTypeSchema = z.enum(["SNAPSHOT", "REALTIME"]);

/* ============================================================
 * myOrder raw payload schema
 *
 * Upbit 공식 문서 기준 필드를 포함하며, 알 수 없는 추가 필드는
 * .passthrough()로 보존한다. myOrder 이벤트는 주문 uuid, code,
 * ask_bid, state, 수량, 체결가, 수수료, order_timestamp, timestamp,
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
    trade_price: UpbitPrivateWsNumericSchema,
    paid_fee: UpbitPrivateWsNumericSchema,
    fee_currency: z.string().min(1).optional(),
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
