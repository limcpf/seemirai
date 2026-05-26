import type { JsonRecord, RiskGateEvaluation } from "../../../domain/index.js";
import { parseFinancialDecimal } from "../../../shared/index.js";
import { fail } from "./evaluation-factory.js";
import type { DecimalRead } from "./types.js";

/**
 * 외부 snapshot의 decimal 문자열을 FinancialDecimal로 읽는다.
 *
 * 파싱 실패는 manual review evaluation으로 반환해 숫자 입력 손상이 주문 승인으로 이어지지 않게 하며, 함수 자체는 side effect가 없다.
 */
export function readDecimal(
  value: unknown,
  fieldName: string,
  error: { reasonCode: string; message: string; metadata?: JsonRecord },
): DecimalRead {
  try {
    return {
      value: parseFinancialDecimal(value),
    };
  } catch {
    return {
      value: undefined,
      evaluation: fail(error.reasonCode, error.message, "MANUAL_REVIEW_REQUIRED", {
        field_name: fieldName,
        ...(error.metadata ?? {}),
      }),
    };
  }
}

/**
 * 음수가 허용되지 않는 decimal 입력을 읽는다.
 *
 * 손실 한도 threshold, 포지션 bps, 예상 손실처럼 음수 값이 의미를 뒤집을 수 있는 입력을 fail-closed로 정규화한다.
 */
export function readNonNegativeDecimal(
  value: unknown,
  fieldName: string,
  error: { reasonCode: string; message: string; metadata?: JsonRecord },
): DecimalRead {
  const read = readDecimal(value, fieldName, error);
  if (read.value === undefined || read.evaluation !== undefined) {
    return read;
  }

  if (read.value.isNegative()) {
    return {
      value: undefined,
      evaluation: fail(error.reasonCode, error.message, "MANUAL_REVIEW_REQUIRED", {
        field_name: fieldName,
        ...(error.metadata ?? {}),
      }),
    };
  }

  return read;
}

/**
 * 0보다 커야 하는 decimal 입력을 읽는다.
 *
 * 계정 평가액, 주문 금액, limit 가격/수량은 0이면 한도 계산 분모나 주문 의미가 깨지므로 manual review로 차단한다.
 */
export function readPositiveDecimal(
  value: unknown,
  fieldName: string,
  error: { reasonCode: string; message: string; metadata?: JsonRecord },
): DecimalRead {
  const read = readNonNegativeDecimal(value, fieldName, error);
  if (read.value === undefined || read.evaluation !== undefined) {
    return read;
  }

  if (read.value.isZero()) {
    return {
      value: undefined,
      evaluation: fail(error.reasonCode, error.message, "MANUAL_REVIEW_REQUIRED", {
        field_name: fieldName,
        ...(error.metadata ?? {}),
      }),
    };
  }

  return read;
}

/**
 * decimal read 실패 evaluation을 누적 배열에 추가한다.
 *
 * 호출자는 value가 없는 read를 별도 계산에 사용하지 않고, 이 함수로 입력 손상 evidence만 결과에 반영한다.
 */
export function appendReadEvaluation(evaluations: RiskGateEvaluation[], read: DecimalRead): void {
  if (read.evaluation !== undefined) {
    evaluations.push(read.evaluation);
  }
}
