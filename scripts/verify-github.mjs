import { access, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();

async function main() {
  const errors = [];

  await requireFile(".github/workflows/verify.yml", errors);
  await requireFile(".github/workflows/offline-release.yml", errors);
  await requireFile(".github/pull_request_template.md", errors);
  await requireFile(".github/ISSUE_TEMPLATE/feature.yml", errors);

  if (errors.length === 0) {
    const workflow = await readFile(toAbsolute(".github/workflows/verify.yml"), "utf8");
    const offlineReleaseWorkflow = await readFile(toAbsolute(".github/workflows/offline-release.yml"), "utf8");
    const prTemplate = await readFile(toAbsolute(".github/pull_request_template.md"), "utf8");
    const issueTemplate = await readFile(toAbsolute(".github/ISSUE_TEMPLATE/feature.yml"), "utf8");

    requireContains(workflow, "pull_request:", ".github/workflows/verify.yml", "pull_request trigger", errors);
    requireContains(workflow, "push:", ".github/workflows/verify.yml", "push trigger", errors);
    requireContains(workflow, "./scripts/verify", ".github/workflows/verify.yml", "./scripts/verify 실행", errors);

    requireContains(
      offlineReleaseWorkflow,
      "workflow_dispatch:",
      ".github/workflows/offline-release.yml",
      "workflow_dispatch trigger",
      errors,
    );
    requireContains(offlineReleaseWorkflow, "tags:", ".github/workflows/offline-release.yml", "tag push trigger", errors);
    requireContains(
      offlineReleaseWorkflow,
      "scripts/build-offline-release.mjs",
      ".github/workflows/offline-release.yml",
      "offline release build script 실행",
      errors,
    );
    requireContains(
      offlineReleaseWorkflow,
      "gh release",
      ".github/workflows/offline-release.yml",
      "GitHub Release asset 업로드",
      errors,
    );
    requireContains(
      offlineReleaseWorkflow,
      "actions/upload-artifact",
      ".github/workflows/offline-release.yml",
      "workflow artifact 업로드",
      errors,
    );

    for (const section of ["## 목적", "## 구현 범위", "## Definition of Done", "## 검증", "## 남은 리스크"]) {
      requireContains(prTemplate, section, ".github/pull_request_template.md", section, errors);
    }

    for (const field of [
      "id: goal",
      "id: background",
      "id: scope",
      "id: out_of_scope",
      "id: acceptance",
      "id: done",
      "id: tests",
      "id: docs",
      "id: subprs",
      "id: parallel",
    ]) {
      requireContains(issueTemplate, field, ".github/ISSUE_TEMPLATE/feature.yml", field, errors);
    }
  }

  if (errors.length > 0) {
    console.error("GitHub 운영 파일 검증에 실패했습니다.");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("GitHub 운영 파일 검증 성공: workflow, release workflow, PR template, issue form을 확인했습니다.");
}

async function requireFile(filePath, errors) {
  if (!(await exists(toAbsolute(filePath)))) {
    errors.push(`필수 GitHub 운영 파일이 없습니다: ${filePath}`);
  }
}

function requireContains(content, needle, filePath, label, errors) {
  if (!content.includes(needle)) {
    errors.push(`${filePath} 에 ${label} 항목이 없습니다.`);
  }
}

function toAbsolute(filePath) {
  return path.join(repoRoot, filePath);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

await main();
