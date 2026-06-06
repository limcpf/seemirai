import type {
  DecisionEvidenceItem,
  DecisionLedgerFrame,
} from "../../../application/decision-ledger.js";
import type { PaperDecisionLedgerWriterPort } from "../../../application/paper-decision-runner/types.js";
import type {
  AppendDecisionLedgerEvidenceResult,
  AppendDecisionLedgerFrameResult,
} from "./types.js";

/**
 * application runner writer port에 연결할 수 있는 decision ledger repository 최소 계약이다.
 *
 * infrastructure adapter는 DB repository의 `{ frame }`, `{ item }` 입력 shape와 durable record 반환 shape를
 * application port의 frame/evidence 중심 계약으로 변환한다. 이 타입은 read/write side effect를 직접 만들지 않고,
 * 주입된 repository 호출을 그대로 위임하는 경계만 고정한다.
 */
export interface DecisionLedgerWriterRepositoryPort {
  appendFrame(input: { readonly frame: DecisionLedgerFrame }): Promise<AppendDecisionLedgerFrameResult>;
  appendEvidenceItems(
    frameId: string,
    items: readonly { readonly item: DecisionEvidenceItem }[],
  ): Promise<AppendDecisionLedgerEvidenceResult>;
}

/**
 * Postgres decision ledger repository를 `PaperDecisionLedgerWriterPort`로 감싸는 adapter를 만든다.
 *
 * runner는 DB row나 repository wrapper shape를 알지 않고 durable frame id만 받는다. duplicate frame에서도
 * repository가 반환한 기존 durable id를 evidence FK로 사용해, 이전 실행에서 evidence만 실패한 경우를 복구한다.
 *
 * @param repository append-only decision ledger repository
 * @returns paper decision runner가 주입받을 application writer port
 */
export function createDecisionLedgerWriterPort(
  repository: DecisionLedgerWriterRepositoryPort,
): PaperDecisionLedgerWriterPort {
  return {
    async appendFrame(frame) {
      const result = await repository.appendFrame({ frame });
      return {
        inserted: result.inserted,
        durableFrameId: result.record.id,
      };
    },
    async appendEvidenceItems(durableFrameId, evidenceItems) {
      const result = await repository.appendEvidenceItems(
        durableFrameId,
        evidenceItems.map((item) => ({ item })),
      );
      return {
        inserted: result.inserted,
        skipped: result.skipped,
      };
    },
  };
}
