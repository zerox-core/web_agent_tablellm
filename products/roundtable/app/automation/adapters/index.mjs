import { ChatGptAdapter } from "./chatgpt.mjs";
import { DeepSeekAdapter } from "./deepseek.mjs";
import { DoubaoAdapter } from "./doubao.mjs";
import { DoubaoCnAdapter } from "./doubao-cn.mjs";
import { KimiAdapter } from "./kimi.mjs";
import { GlmAdapter } from "./glm.mjs";
import { GeminiAdapter } from "./gemini.mjs";

export function createProviderAdapters({ urlOverrides = {} } = {}) {
  return new Map([
    ["chatgpt", new ChatGptAdapter({ url: urlOverrides.chatgpt })],
    ["deepseek", new DeepSeekAdapter({ url: urlOverrides.deepseek })],
    ["doubao", new DoubaoAdapter({ url: urlOverrides.doubao })],
    ["doubao-cn", new DoubaoCnAdapter({ url: urlOverrides["doubao-cn"] })],
    ["kimi", new KimiAdapter({ url: urlOverrides.kimi })],
    ["glm", new GlmAdapter({ url: urlOverrides.glm })],
    ["gemini", new GeminiAdapter({ url: urlOverrides.gemini })],
  ]);
}

export { BaseProviderAdapter } from "./base-adapter.mjs";
export { ChatGptAdapter } from "./chatgpt.mjs";
export { DeepSeekAdapter } from "./deepseek.mjs";
export { DoubaoAdapter } from "./doubao.mjs";
export { DoubaoCnAdapter } from "./doubao-cn.mjs";
export { KimiAdapter } from "./kimi.mjs";
export { GlmAdapter } from "./glm.mjs";
export { GeminiAdapter } from "./gemini.mjs";
