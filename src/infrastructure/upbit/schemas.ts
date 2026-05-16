import { z } from "zod";

const NumericStringSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "numeric string is required");
const UpbitMarketCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/u, "Upbit market code is required");

const UpbitMarketEventCautionSchema = z.union([
  z.boolean(),
  z.record(z.string(), z.boolean()),
]);

export const UpbitMarketEventSchema = z
  .object({
    warning: z.boolean(),
    caution: UpbitMarketEventCautionSchema,
  })
  .passthrough();

export const UpbitMarketSchema = z
  .object({
    market: UpbitMarketCodeSchema,
    korean_name: z.string().min(1),
    english_name: z.string().min(1),
    market_event: UpbitMarketEventSchema.optional(),
  })
  .passthrough();

export const UpbitMarketListResponseSchema = z.array(UpbitMarketSchema);

export const UpbitOrderbookInstrumentSchema = z
  .object({
    market: UpbitMarketCodeSchema,
    quote_currency: z.string().min(1),
    tick_size: NumericStringSchema,
    supported_levels: z.array(NumericStringSchema).min(1),
  })
  .passthrough();

export const UpbitOrderbookInstrumentsResponseSchema = z.array(UpbitOrderbookInstrumentSchema);

export type UpbitMarket = z.infer<typeof UpbitMarketSchema>;
export type UpbitMarketEvent = z.infer<typeof UpbitMarketEventSchema>;
export type UpbitOrderbookInstrument = z.infer<typeof UpbitOrderbookInstrumentSchema>;
