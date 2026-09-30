import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { MimirConfig } from "./config.ts";

export function createForemanModel(config: MimirConfig): LanguageModel {
  const [provider, ...rest] = config.foreman.model.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) {
    throw new Error(`foreman.model must look like "provider/model", got "${config.foreman.model}"`);
  }
  switch (provider) {
    case "openai":
      if (!config.keys.openai) throw new Error("No OpenAI API key. Set OPENAI_API_KEY or run `mimir init`.");
      return createOpenAI({ apiKey: config.keys.openai })(modelId);
    case "anthropic":
      if (!config.keys.anthropic) {
        throw new Error("No Anthropic API key. Set ANTHROPIC_API_KEY or run `mimir init`.");
      }
      return createAnthropic({ apiKey: config.keys.anthropic })(modelId);
    default:
      throw new Error(`Unsupported foreman provider "${provider}". Use openai or anthropic.`);
  }
}
