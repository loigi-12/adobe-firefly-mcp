import { describe, expect, it } from "vitest";

import { windowOptions } from "../src/browser.js";
import { loadConfig, readViewport } from "../src/config.js";

describe("readViewport", () => {
  it("defaults to a maximized window", () => {
    expect(loadConfig({}).viewport).toEqual({ mode: "maximized" });
    expect(readViewport({ FIREFLY_VIEWPORT: "maximized" }, "FIREFLY_VIEWPORT")).toEqual(
      {
        mode: "maximized",
      },
    );
  });

  it("reads an exact size", () => {
    expect(readViewport({ FIREFLY_VIEWPORT: "1920x1080" }, "FIREFLY_VIEWPORT")).toEqual(
      {
        height: 1080,
        mode: "fixed",
        width: 1920,
      },
    );
    expect(
      readViewport({ FIREFLY_VIEWPORT: " 2560 X 1440 " }, "FIREFLY_VIEWPORT"),
    ).toEqual({ height: 1440, mode: "fixed", width: 2560 });
  });

  it("falls back to maximized for anything unrecognised", () => {
    expect(readViewport({ FIREFLY_VIEWPORT: "huge" }, "FIREFLY_VIEWPORT")).toEqual({
      mode: "maximized",
    });
  });
});

describe("windowOptions", () => {
  it("maximizes a visible window and lets the page fill it", () => {
    expect(windowOptions({ mode: "maximized" }, false)).toEqual({
      args: ["--start-maximized"],
      viewport: null,
    });
  });

  it("uses 1920x1080 when headless, since there is no window to maximize", () => {
    expect(windowOptions({ mode: "maximized" }, true)).toEqual({
      args: ["--window-size=1920,1080"],
      viewport: { height: 1080, width: 1920 },
    });
  });

  it("uses the exact size when one is set", () => {
    expect(windowOptions({ height: 1080, mode: "fixed", width: 1920 }, false)).toEqual({
      args: ["--window-size=1920,1080"],
      viewport: { height: 1080, width: 1920 },
    });
  });
});
