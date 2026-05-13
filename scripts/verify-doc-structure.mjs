import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const allowedKinds = new Set([
  "router",
  "policy",
  "index",
  "design-doc",
  "product-spec",
  "exec-plan",
  "reference",
  "generated",
  "skill",
]);
const excludedDirs = new Set([
  ".git",
  ".local",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);
const requiredIndexFiles = [
  "docs/design-docs/index.md",
  "docs/product-specs/index.md",
  "docs/references/README.md",
  "docs/generated/README.md",
  "docs/exec-plans/active/README.md",
  "docs/exec-plans/completed/README.md",
  "docs/tech-debt/README.md",
];
const indexedDirectories = [
  {
    indexPath: "docs/design-docs/index.md",
    dir: "docs/design-docs",
    ignoredBaseNames: new Set(["index.md"]),
  },
  {
    indexPath: "docs/exec-plans/active/README.md",
    dir: "docs/exec-plans/active",
    ignoredBaseNames: new Set(["README.md"]),
  },
  {
    indexPath: "docs/exec-plans/completed/README.md",
    dir: "docs/exec-plans/completed",
    ignoredBaseNames: new Set(["README.md"]),
  },
  {
    indexPath: "docs/product-specs/index.md",
    dir: "docs/product-specs",
    ignoredBaseNames: new Set(["index.md"]),
  },
  {
    indexPath: "docs/references/README.md",
    dir: "docs/references",
    ignoredBaseNames: new Set(["README.md"]),
  },
];
const specialIndexReferences = [
  {
    indexPath: "docs/generated/README.md",
    requiredReferences: ["./context-map.json"],
  },
];

async function main() {
  const errors = [];
  let checkedLinkCount = 0;
  const manifestPath = toAbsolute("docs/generated/context-map.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestEntries = Array.isArray(manifest.documents) ? manifest.documents : [];

  validateManifest(manifest, manifestEntries, errors);

  const manifestPathSet = new Set();
  const roleKeys = new Set();
  for (const entry of manifestEntries) {
    const normalizedPath = normalizeRepoPath(entry.path);
    manifestPathSet.add(normalizedPath);

    if (!allowedKinds.has(entry.kind)) {
      errors.push(`허용되지 않은 kind 가 있습니다: ${normalizedPath} -> ${entry.kind}`);
    }

    if (!Array.isArray(entry.read_when) || entry.read_when.length === 0) {
      errors.push(`read_when 이 비어 있습니다: ${normalizedPath}`);
    }

    if (typeof entry.role !== "string" || entry.role.trim() === "") {
      errors.push(`role 이 비어 있습니다: ${normalizedPath}`);
    }

    if (typeof entry.owner_scope !== "string" || entry.owner_scope.trim() === "") {
      errors.push(`owner_scope 가 비어 있습니다: ${normalizedPath}`);
    } else if (!matchesOwnerScope(normalizedPath, entry.owner_scope)) {
      errors.push(`owner_scope 가 path 와 맞지 않습니다: ${normalizedPath} -> ${entry.owner_scope}`);
    }

    const roleKey = `${entry.owner_scope}::${entry.role}`;
    if (roleKeys.has(roleKey)) {
      errors.push(`같은 owner_scope 에 동일한 role 이 중복되었습니다: ${roleKey}`);
    }
    roleKeys.add(roleKey);
  }

  const docsFiles = await collectFiles("docs");
  const nonMarkdownOutsideGenerated = docsFiles.filter(
    (filePath) => !filePath.endsWith(".md") && !filePath.startsWith("docs/generated/"),
  );
  for (const filePath of nonMarkdownOutsideGenerated) {
    errors.push(`docs/generated 밖에 Markdown 이 아닌 파일이 있습니다: ${filePath}`);
  }

  const requiredDocs = new Set([
    ...(await collectRootDocs(".")),
    ...(await collectSkillDocs(".agents/skills")),
    ".github/pull_request_template.md",
    ...docsFiles.filter((filePath) => filePath.endsWith(".md")),
  ]);

  for (const filePath of requiredDocs) {
    if (!manifestPathSet.has(filePath)) {
      errors.push(`매니페스트에 등록되지 않은 문서가 있습니다: ${filePath}`);
    }
  }

  for (const entry of manifestEntries) {
    if (!(await exists(toAbsolute(entry.path)))) {
      errors.push(`매니페스트가 가리키는 파일이 존재하지 않습니다: ${entry.path}`);
    }
  }

  for (const filePath of requiredIndexFiles) {
    if (!(await exists(toAbsolute(filePath)))) {
      errors.push(`필수 인덱스 문서가 없습니다: ${filePath}`);
    }
  }

  for (const { indexPath, dir, ignoredBaseNames } of indexedDirectories) {
    const content = await readFile(toAbsolute(indexPath), "utf8");
    const siblings = (await collectImmediateFiles(dir)).filter((filePath) => {
      const baseName = path.posix.basename(filePath);
      return !ignoredBaseNames.has(baseName);
    });

    for (const siblingPath of siblings) {
      const relativeName = `./${path.posix.basename(siblingPath)}`;
      if (!content.includes(relativeName)) {
        errors.push(`${indexPath} 에 ${relativeName} 링크가 없습니다.`);
      }
    }
  }

  for (const { indexPath, requiredReferences } of specialIndexReferences) {
    const content = await readFile(toAbsolute(indexPath), "utf8");
    for (const reference of requiredReferences) {
      if (!content.includes(reference)) {
        errors.push(`${indexPath} 에 ${reference} 링크가 없습니다.`);
      }
    }
  }

  for (const filePath of requiredDocs) {
    const content = await readFile(toAbsolute(filePath), "utf8");
    for (const linkTarget of extractMarkdownLinks(content)) {
      if (shouldSkipLink(linkTarget)) {
        continue;
      }

      const resolvedPath = resolveRepoLink(filePath, linkTarget);
      if (resolvedPath === null) {
        errors.push(`${filePath} 의 링크가 저장소 밖을 가리킵니다: ${linkTarget}`);
        continue;
      }

      checkedLinkCount += 1;
      if (!(await exists(toAbsolute(resolvedPath)))) {
        errors.push(`${filePath} 의 링크 대상이 존재하지 않습니다: ${linkTarget}`);
        continue;
      }

      if (path.posix.basename(filePath) === "AGENTS.md" && !manifestPathSet.has(resolvedPath)) {
        errors.push(`${filePath} 의 링크 대상이 매니페스트에 등록되지 않았습니다: ${resolvedPath}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("문서 구조 검증에 실패했습니다.");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `문서 구조 검증 성공: 문서 ${requiredDocs.size}개, 매니페스트 ${manifestEntries.length}개, 링크 ${checkedLinkCount}개를 확인했습니다.`,
  );
}

function validateManifest(manifest, entries, errors) {
  if (manifest.version !== 1) {
    errors.push("context-map.json 의 version 은 1 이어야 합니다.");
  }

  if (!Array.isArray(entries)) {
    errors.push("context-map.json 의 documents 는 배열이어야 합니다.");
    return;
  }

  const seenPaths = new Set();
  for (const entry of entries) {
    const normalizedPath = normalizeRepoPath(entry.path);
    if (seenPaths.has(normalizedPath)) {
      errors.push(`context-map.json 에 중복 path 가 있습니다: ${normalizedPath}`);
    }
    seenPaths.add(normalizedPath);
  }
}

async function collectFiles(startRelPath) {
  if (!(await exists(toAbsolute(startRelPath)))) {
    return [];
  }

  const absolutePath = toAbsolute(startRelPath);
  const dirents = await readdir(absolutePath, { withFileTypes: true });
  const collected = [];

  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      if (excludedDirs.has(dirent.name)) {
        continue;
      }

      const childPath = path.posix.join(startRelPath, dirent.name);
      collected.push(...(await collectFiles(childPath)));
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    collected.push(normalizeRepoPath(path.posix.join(startRelPath, dirent.name)));
  }

  return collected.sort((left, right) => left.localeCompare(right));
}

async function collectImmediateFiles(startRelPath) {
  const absolutePath = toAbsolute(startRelPath);
  const dirents = await readdir(absolutePath, { withFileTypes: true });

  return dirents
    .filter((dirent) => dirent.isFile())
    .map((dirent) => normalizeRepoPath(path.posix.join(startRelPath, dirent.name)))
    .sort((left, right) => left.localeCompare(right));
}

async function collectRootDocs(startRelPath) {
  const files = await collectFiles(startRelPath);
  const rootDocNames = new Set(["AGENTS.md", "ARCHITECTURE.md"]);
  return files.filter((filePath) => {
    const baseName = path.posix.basename(filePath);
    return !filePath.includes("/") && rootDocNames.has(baseName);
  });
}

async function collectSkillDocs(startRelPath) {
  const files = await collectFiles(startRelPath);
  return files.filter((filePath) => path.posix.basename(filePath) === "SKILL.md");
}

function extractMarkdownLinks(content) {
  const matches = [];
  const pattern = /\[[^\]]*]\(([^)]+)\)/g;

  for (const match of content.matchAll(pattern)) {
    let target = match[1].trim();
    const titleStart = target.search(/\s+"/);
    if (titleStart >= 0) {
      target = target.slice(0, titleStart);
    }

    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }

    matches.push(target);
  }

  return matches;
}

function shouldSkipLink(target) {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("tel:")
  );
}

function resolveRepoLink(sourceFile, linkTarget) {
  const [rawPath] = linkTarget.split("#", 1);
  if (!rawPath) {
    return normalizeRepoPath(sourceFile);
  }

  const resolvedAbsolutePath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(path.dirname(toAbsolute(sourceFile)), rawPath);

  if (!isInsideRepo(resolvedAbsolutePath)) {
    return null;
  }

  return normalizeRepoPath(path.relative(repoRoot, resolvedAbsolutePath));
}

function matchesOwnerScope(filePath, ownerScope) {
  if (ownerScope === "root") {
    return !filePath.includes("/");
  }

  return filePath === ownerScope || filePath.startsWith(`${ownerScope}/`);
}

function normalizeRepoPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function toAbsolute(filePath) {
  return path.join(repoRoot, normalizeRepoPath(filePath));
}

function isInsideRepo(absolutePath) {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
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
