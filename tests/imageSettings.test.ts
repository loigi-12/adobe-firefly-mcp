import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { matchPickerItem } from "../src/firefly/generate.js";
import { composePrompt } from "../src/firefly/prompts.js";

const item = (text: string, value = text, disabled = false) => ({
  disabled,
  text,
  value,
});

// Option labels as shown on firefly.adobe.com/generate/image (Nov 2026).
const models = [
  item("Firefly Image 5", "adobe:firefly:colligo:image5"),
  item("Gemini 3.1 (Nano Banana 2)", "google:firefly:colligo:gemini-3.1"),
  item("Gemini Nano Banana 2.1", "google:firefly:colligo:nano-banana-2.1"),
  item("Gemini 3 (Nano Banana Pro)", "google:firefly:colligo:nano-banana-pro"),
];
const ratios = [
  item("Auto", '{"height":-1,"width":-1}'),
  item("Landscape (4:3)", '{"height":896,"width":1200}'),
  item("Portrait (3:4)", '{"height":1200,"width":896}'),
  item("Vertical (9:16)", '{"height":1376,"width":768}'),
];
const resolutions = [item("512"), item("1K"), item("2K"), item("4K")];

describe("matchPickerItem", () => {
  it("matches a full label exactly", () => {
    expect(matchPickerItem(models, "Gemini 3 (Nano Banana Pro)")?.value).toBe(
      "google:firefly:colligo:nano-banana-pro",
    );
  });

  it("matches a short name inside a label, ignoring case", () => {
    expect(matchPickerItem(models, "nano banana pro")?.text).toBe(
      "Gemini 3 (Nano Banana Pro)",
    );
  });

  it("matches an aspect ratio by its ratio alone", () => {
    expect(matchPickerItem(ratios, "4:3")?.text).toBe("Landscape (4:3)");
    expect(matchPickerItem(ratios, "9:16")?.text).toBe("Vertical (9:16)");
  });

  it("matches a resolution exactly", () => {
    expect(matchPickerItem(resolutions, "2K")?.text).toBe("2K");
  });

  it("prefers an exact match over a longer label that contains it", () => {
    const items = [item("Pro Max"), item("Pro")];
    expect(matchPickerItem(items, "Pro")?.text).toBe("Pro");
  });

  it("skips disabled options and returns undefined when nothing matches", () => {
    expect(matchPickerItem([item("2K", "2K", true)], "2K")).toBeUndefined();
    expect(matchPickerItem(resolutions, "8K")).toBeUndefined();
  });
});

describe("composePrompt", () => {
  it("returns a single line without style or content type text", () => {
    expect(
      composePrompt({
        contentClass: "Photo",
        prompt: "A man\nin a kitchen,   smiling",
        style: "Cinematic",
      }),
    ).toBe("A man in a kitchen, smiling");
  });

  it("appends the negative prompt on the same line", () => {
    expect(composePrompt({ negativePrompt: "text", prompt: "A tin" })).toBe(
      "A tin Avoid: text",
    );
  });
});

describe("text-to-image URL", () => {
  it("defaults to the generate/image page", () => {
    expect(loadConfig({}).urls.textToImage).toBe(
      "https://firefly.adobe.com/generate/image",
    );
  });
});
