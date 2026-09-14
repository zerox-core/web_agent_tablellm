import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DEPENDENCY = "https://github.com/zhuxice-ctrl/web_agents/archive/refs/tags/local-core-v1.1.0.tar.gz";
const V1_RELEASE = /^1\.\d+\.\d+$/;
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const STATIC_IMPORT = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

async function walk(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (["node_modules", "data", ".runtime"].includes(entry.name)) continue;
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(item));
    else files.push(item);
  }
  return files;
}

export async function checkProductBoundaries({ repoRoot }) {
  const root = path.resolve(repoRoot);
  const violations = [];
  for (const relative of ["products/plugin", "packages/local-core", "config/allowed-directories.local.txt"]) {
    if (await exists(path.join(root, relative))) violations.push({ file: relative, rule: "foreign-vendored-or-local-state" });
  }

  const productRoot = path.join(root, "products/roundtable");
  for (const file of await walk(productRoot)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
    const source = await fs.readFile(file, "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1] || match[2];
      if (/products[\\/]plugin|@web-agents[\\/]plugin|packages[\\/]local-core/i.test(specifier)) {
        violations.push({ file, rule: "roundtable-imports-non-package-runtime", specifier });
      }
    }
  }

  const rootPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const productPackage = JSON.parse(await fs.readFile(path.join(productRoot, "package.json"), "utf8"));
  if (rootPackage.name !== "tablellm" || !V1_RELEASE.test(rootPackage.version || "")) {
    violations.push({ file: "package.json", rule: "invalid-product-version" });
  }
  if (!V1_RELEASE.test(productPackage.version || "") || productPackage.version !== rootPackage.version) {
    violations.push({ file: "products/roundtable/package.json", rule: "invalid-product-version" });
  }
  if (productPackage.dependencies?.["@web-agents/local-core"] !== CORE_DEPENDENCY) {
    violations.push({ file: "products/roundtable/package.json", rule: "unpinned-local-core" });
  }
  if (/plugin|test:core/i.test(JSON.stringify(rootPackage.scripts))) {
    violations.push({ file: "package.json", rule: "foreign-product-script" });
  }
  if (/test:compat/.test(productPackage.scripts?.test || "")) {
    violations.push({ file: "products/roundtable/package.json", rule: "compat-in-default-product-test" });
  }

  if (violations.length) {
    const error = new Error("PRODUCT_BOUNDARY_VIOLATION");
    error.violations = violations;
    throw error;
  }
  return { ok: true, violations: [] };
}

const currentFile = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === currentFile) {
  try {
    await checkProductBoundaries({ repoRoot: path.resolve(path.dirname(currentFile), "..") });
    console.log("tablellm v1 boundaries: OK");
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, violations: error.violations || [] }, null, 2));
    process.exitCode = 1;
  }
}
