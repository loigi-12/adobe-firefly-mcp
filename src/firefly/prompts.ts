export interface PromptParts {
  contentClass?: string;
  negativePrompt?: string;
  prompt: string;
  style?: string;
}

/**
 * Builds the text typed into Firefly's prompt box. Style and content class are
 * UI controls, not prompt text, so they are not appended. The result is a
 * single line because the prompt box does not take newlines.
 */
export function composePrompt(parts: PromptParts): string {
  const lines = [parts.prompt.trim()];

  if (parts.negativePrompt !== undefined && parts.negativePrompt.trim().length > 0) {
    lines.push(`Avoid: ${parts.negativePrompt.trim()}`);
  }

  return lines.join(" ").replace(/\s+/gu, " ").trim();
}

export function shortPromptLabel(prompt: string): string {
  return prompt.trim().split(/\s+/u).slice(0, 8).join(" ") || "firefly";
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
