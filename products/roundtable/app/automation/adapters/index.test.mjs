import assert from "node:assert/strict";
import test from "node:test";

import { createProviderAdapters, KimiAdapter, GlmAdapter } from "./index.mjs";
import { PROVIDERS } from "../../core/providers.mjs";

const SELECTOR_KEYS = ["inputSelectors", "submitSelectors", "responseSelectors", "busySelectors", "loginSelectors"];

test("adapter registry covers every mvp provider", () => {
  const adapters = createProviderAdapters();
  const mvpIds = PROVIDERS.filter((provider) => provider.automation === "mvp").map((provider) => provider.id);
  assert.deepEqual(mvpIds.sort(), ["chatgpt", "deepseek", "doubao", "glm", "kimi"]);
  for (const providerId of mvpIds) {
    assert.ok(adapters.has(providerId), `missing adapter for ${providerId}`);
  }
});

test("kimi adapter ships the agent URL with the entry-method query", () => {
  const kimi = createProviderAdapters().get("kimi");
  assert.ok(kimi instanceof KimiAdapter);
  assert.equal(kimi.url, "https://www.kimi.com/agent?chat_enter_method=change_model");
  for (const key of SELECTOR_KEYS) {
    assert.ok(Array.isArray(kimi[key]) && kimi[key].length > 0, `${key} must be a non-empty array`);
  }
});

test("glm adapter ships the chat.z.ai URL", () => {
  const glm = createProviderAdapters().get("glm");
  assert.ok(glm instanceof GlmAdapter);
  assert.equal(glm.url, "https://chat.z.ai/");
  for (const key of SELECTOR_KEYS) {
    assert.ok(Array.isArray(glm[key]) && glm[key].length > 0, `${key} must be a non-empty array`);
  }
});

test("kimi and glm adapter URLs respect urlOverrides", () => {
  const adapters = createProviderAdapters({
    urlOverrides: {
      kimi: "https://kimi.example.invalid/agent",
      glm: "https://glm.example.invalid/",
    },
  });
  assert.equal(adapters.get("kimi").url, "https://kimi.example.invalid/agent");
  assert.equal(adapters.get("glm").url, "https://glm.example.invalid/");
});
