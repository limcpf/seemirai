import { defineConfig } from "vitest/config";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    // DB integration suite는 하나의 PostgreSQL schema를 공유하므로 파일 병렬 실행 시 cleanup transaction이 서로 간섭한다.
    fileParallelism: !runDbIntegration,
  },
});
