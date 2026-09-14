import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkProductBoundaries } from "./check-product-boundaries.mjs";

const coreDependency = "https://github.com/zhuxice-ctrl/web_agents/archive/refs/tags/local-core-v1.1.0.tar.gz";

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function fixture(t, { version = "1.0.1" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tablellm-v1-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, "package.json", JSON.stringify({ name: "tablellm", version, scripts: {} }));
  await write(root, "products/roundtable/package.json", JSON.stringify({
    version,
    scripts: { test: "node --test", "test:compat": "node --test compat/*.test.mjs" },
    dependencies: { "@web-agents/local-core": coreDependency },
  }));
  await write(root, "products/roundtable/index.mjs", 'import "@web-agents/local-core/paths";');
  return root;
}

test("accepts the independent tablellm v1 layout", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await checkProductBoundaries({ repoRoot: root }), { ok: true, violations: [] });
});

test("rejects a vendored plugin product", async (t) => {
  const root = await fixture(t);
  await write(root, "products/plugin/package.json", "{}");
  await assert.rejects(() => checkProductBoundaries({ repoRoot: root }), /PRODUCT_BOUNDARY_VIOLATION/);
});

test("rejects a tracked local whitelist", async (t) => {
  const root = await fixture(t);
  await write(root, "config/allowed-directories.local.txt", "C:\\\\private");
  await assert.rejects(() => checkProductBoundaries({ repoRoot: root }), /PRODUCT_BOUNDARY_VIOLATION/);
});

test("rejects a non-v1 or mismatched product version", async (t) => {
  const root = await fixture(t, { version: "2.0.0" });
  await assert.rejects(() => checkProductBoundaries({ repoRoot: root }), /PRODUCT_BOUNDARY_VIOLATION/);

  await write(root, "package.json", JSON.stringify({ name: "tablellm", version: "1.0.1", scripts: {} }));
  await assert.rejects(() => checkProductBoundaries({ repoRoot: root }), /PRODUCT_BOUNDARY_VIOLATION/);
});
