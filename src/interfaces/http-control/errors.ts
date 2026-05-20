import type { FastifyRequest } from "fastify";

/**
 * 모든 HTTP control 오류 응답의 외부 노출 모양을 고정한다.
 */
export function createErrorResponse(input: { correlationId: string; code: string; message: string }) {
  return {
    status: "error",
    correlationId: input.correlationId,
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

/**
 * route 간 공통 correlation id를 읽는다.
 */
export function getCorrelationId(request: FastifyRequest): string {
  const header = request.headers["x-correlation-id"];
  if (typeof header === "string" && header.trim() !== "") {
    return header;
  }
  return request.id;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function getErrorStatusCode(error: unknown): number {
  const statusCode = readNumericProperty(error, "statusCode") ?? readNumericProperty(error, "status");
  if (statusCode === undefined || statusCode < 400) {
    return 500;
  }

  return statusCode;
}

function readNumericProperty(error: unknown, property: "status" | "statusCode"): number | undefined {
  if (typeof error !== "object" || error === null || !(property in error)) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[property];
  return typeof value === "number" ? value : undefined;
}
