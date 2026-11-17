import path from "node:path";

import type { Locator, Page } from "playwright";

import type { BrowserManager } from "../browser.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { assertReadableImage } from "../utils/image.js";
import {
  ensureDirectory,
  resolveUserPath,
  timestampedBasename,
} from "../utils/filesystem.js";
import { downloadGeneratedImages, type DownloadedImage } from "./download.js";
import { composePrompt, escapeRegExp, shortPromptLabel } from "./prompts.js";
import { selectors } from "./selectors.js";
import { resolveLocator } from "./locatorResolver.js";
import { captureDiagnostics } from "./diagnostics.js";
import {
  FireflyAutomationError,
  collectVisibleImageFingerprints,
  dismissKnownDialogs,
  ensurePromptReady,
  waitForNewImages,
} from "./wait.js";

export interface TextToImageInput {
  aspectRatio?: string;
  contentClass?: string;
  count: number;
  model?: string;
  negativePrompt?: string;
  outputDir?: string;
  prompt: string;
  resolution?: string;
  style?: string;
}

/** Labels of the image-page settings that were applied, as Firefly shows them. */
export interface AppliedImageSettings {
  aspectRatio?: string;
  model?: string;
  resolution?: string;
}

export interface ImageWorkflowInput {
  aspectRatio?: string;
  count: number;
  imagePath: string;
  outputDir?: string;
  prompt?: string;
}

export interface FireflyRunResult {
  diagnostics: {
    generateClickScreenshots: GenerateClickScreenshots;
    pageDiagnostics?: Record<string, unknown>;
  };
  durationMs: number;
  files: DownloadedImage[];
  operation: string;
  pageUrl: string;
  profileDir: string;
  settings?: AppliedImageSettings;
  warnings: string[];
}

interface GenerateClickScreenshots {
  afterClick?: string;
  beforeClick?: string;
  failedClick?: string;
}

interface GenerateButtonState {
  boundingBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  editable: boolean | string;
  enabled: boolean | string;
  visible: boolean | string;
}

export async function runTextToImage(
  browser: BrowserManager,
  config: AppConfig,
  logger: Logger,
  input: TextToImageInput,
): Promise<FireflyRunResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const page = await openFireflyPage(browser, config.urls.textToImage, config);

  await ensurePromptReady(page, config);
  // Let a restored session (previous results, draft prompt) finish loading so
  // old images are not mistaken for new ones and settings are not overwritten.
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
  await dismissKnownDialogs(page, config);

  // Settings first: changing the model can reset aspect ratio and resolution.
  const settings = await applyImageSettings(page, input, logger);
  warnings.push(...settings.warnings);

  const prompt = composePrompt(input);
  try {
    await typePrompt(page, config, prompt, logger);
  } catch (err) {
    await captureDiagnostics(page, "image-prompt-fill-fail");
    throw new FireflyAutomationError(
      `Could not enter the Firefly prompt. Set FIREFLY_SELECTOR_PROMPT_INPUT if the UI changed. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  warnings.push(
    ...(await applyOptionalControls(page, input, { skipAspectRatio: true })),
  );
  await page.waitForTimeout(500);

  const before = await collectVisibleImageFingerprints(page);
  const errorsBefore = await readFireflyErrors(page);
  const generateClickScreenshots = await clickGenerate(page, config, logger);
  try {
    await waitForGeneratedImages(
      page,
      before,
      config.generationTimeoutMs,
      input.count,
      errorsBefore,
    );
  } catch (err) {
    await captureDiagnostics(page, "image-generation-failed");
    if (err instanceof FireflyAutomationError) {
      err.message = `${err.message} Settings applied: ${JSON.stringify(settings.applied)}. After-click screenshot: ${generateClickScreenshots.afterClick ?? "none"}`;
    }
    throw err;
  }

  const outputDir = resolveOutputDir(config, input.outputDir);
  const basename = timestampedBasename(`firefly-${shortPromptLabel(input.prompt)}`);
  const files = await downloadGeneratedImages(page, config, logger, {
    basename,
    beforeFingerprints: before,
    maxFiles: input.count,
    outputDir,
    preferVisible: true,
  });

  if (files.length === 0) {
    await captureDiagnostics(page, "image-no-files");
    throw new FireflyAutomationError(
      "Firefly generated images, but no downloadable images could be saved. Try setting FIREFLY_SELECTOR_DOWNLOAD_BUTTON.",
    );
  }

  return {
    diagnostics: {
      generateClickScreenshots,
    },
    durationMs: Date.now() - startedAt,
    files,
    operation: "firefly_generate",
    settings: settings.applied,
    pageUrl: page.url(),
    profileDir: config.profileDir,
    warnings,
  };
}

export async function runImageWorkflow(
  browser: BrowserManager,
  config: AppConfig,
  logger: Logger,
  operation: "firefly_expand" | "firefly_remove_background" | "firefly_variations",
  url: string,
  input: ImageWorkflowInput,
): Promise<FireflyRunResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const imagePath = await assertReadableImage(resolveUserPath(input.imagePath));
  const page = await openFireflyPage(browser, url, config);

  await dismissKnownDialogs(page, config);
  await uploadImage(page, config, imagePath);

  if (input.prompt !== undefined && input.prompt.trim().length > 0) {
    try {
      const promptLoc = await resolveLocator(page, selectors.image.prompt, {
        timeout: 5000,
        log: (msg) => logger.debug(msg),
      });
      await promptLoc.locator.fill(input.prompt.trim());
      logger.info("Prompt filled", { selector: promptLoc.candidate.name });
    } catch {
      warnings.push("Prompt was provided, but no optional prompt input was found.");
    }
  }

  warnings.push(...(await applyOptionalControls(page, input)));

  const before = await collectVisibleImageFingerprints(page);
  const generateClickScreenshots = await clickGenerate(page, config, logger);
  await waitForNewImages(page, before, config.generationTimeoutMs);

  const outputDir = resolveOutputDir(config, input.outputDir);
  const basename = timestampedBasename(
    `${operation.replace(/^firefly_/u, "firefly-")}-${path.basename(imagePath, path.extname(imagePath))}`,
  );
  const files = await downloadGeneratedImages(page, config, logger, {
    basename,
    beforeFingerprints: before,
    maxFiles: input.count,
    outputDir,
  });

  if (files.length === 0) {
    await captureDiagnostics(page, "image-workflow-no-files");
    throw new FireflyAutomationError(
      "Firefly completed the workflow, but no downloadable images could be saved.",
    );
  }

  return {
    diagnostics: {
      generateClickScreenshots,
    },
    durationMs: Date.now() - startedAt,
    files,
    operation,
    pageUrl: page.url(),
    profileDir: config.profileDir,
    warnings,
  };
}

async function openFireflyPage(
  browser: BrowserManager,
  url: string,
  config: AppConfig,
): Promise<Page> {
  const page = await browser.getPage(url);
  await page.waitForLoadState("domcontentloaded", {
    timeout: config.navigationTimeoutMs,
  });
  return page;
}

async function clickGenerate(
  page: Page,
  config: AppConfig,
  logger: Logger,
): Promise<GenerateClickScreenshots> {
  logger.info("Waiting for Generate button");

  let button: { candidate: { name: string }; locator: Locator };
  const imagePageButton = page.locator(IMAGE_GENERATE_BUTTON).first();
  if (await imagePageButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    button = {
      candidate: { name: "image page generate button" },
      locator: imagePageButton,
    };
  } else {
    try {
      button = await resolveLocator(page, selectors.image.generate, {
        timeout: config.operationTimeoutMs,
        log: (msg) => logger.debug(msg),
      });
    } catch (err) {
      await captureDiagnostics(page, "image-generate-not-found");
      throw new FireflyAutomationError(
        `Could not find Firefly's generate/action button. Set FIREFLY_SELECTOR_GENERATE_BUTTON if the UI changed. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info("Generate button found", { selector: button.candidate.name });

  const state = await getGenerateButtonState(button.locator);
  if (state.enabled !== true) {
    logger.warn("Generate button attached but not enabled", { state });
  } else {
    logger.debug("Generate button state", { state });
  }

  const beforeClick = await saveGenerateClickScreenshot(page, config, logger, "before");

  logger.info("Clicking Generate", { state });
  try {
    await button.locator.click({ timeout: config.operationTimeoutMs });
  } catch (error) {
    logger.error("Generate click failed", { error, state });
    const failedClick = await saveGenerateClickScreenshot(
      page,
      config,
      logger,
      "failed",
    );
    await captureDiagnostics(page, "image-generate-click-fail");
    throw new FireflyAutomationError(
      [
        "Failed to click the Firefly Generate button.",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        beforeClick !== undefined
          ? `Before-click screenshot: ${beforeClick}`
          : undefined,
        failedClick !== undefined
          ? `Failed-click screenshot: ${failedClick}`
          : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" "),
    );
  }

  logger.info("Generate clicked");
  const afterClick = await saveGenerateClickScreenshot(page, config, logger, "after");
  return { afterClick, beforeClick };
}

async function getGenerateButtonState(locator: Locator): Promise<GenerateButtonState> {
  const [visible, enabled, editable, boundingBox] = await Promise.all([
    locator.isVisible({ timeout: 500 }).catch((error: unknown) => stateError(error)),
    locator.isEnabled({ timeout: 500 }).catch((error: unknown) => stateError(error)),
    locator.isEditable({ timeout: 500 }).catch((error: unknown) => stateError(error)),
    locator.boundingBox({ timeout: 500 }).catch(() => null),
  ]);

  return { boundingBox, editable, enabled, visible };
}

async function saveGenerateClickScreenshot(
  page: Page,
  config: AppConfig,
  logger: Logger,
  phase: "after" | "before" | "failed",
): Promise<string | undefined> {
  await ensureDirectory(config.downloadsDir);
  const screenshotPath = path.join(
    config.downloadsDir,
    `${timestampedBasename(`firefly-generate-click-${phase}`)}.png`,
  );

  try {
    await page.screenshot({ fullPage: false, path: screenshotPath });
    logger.info(`Saved ${phase} Generate click screenshot`, { screenshotPath });
    return screenshotPath;
  } catch (error) {
    logger.error(`Failed to save ${phase} Generate click screenshot`, { error });
    return undefined;
  }
}

function stateError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

async function uploadImage(
  page: Page,
  config: AppConfig,
  imagePath: string,
): Promise<void> {
  const directInput = page.locator('input[type="file"]').first();
  const directInputCount = await directInput.count().catch(() => 0);

  if (directInputCount > 0) {
    await directInput.setInputFiles(imagePath);
    await page.waitForTimeout(1_000);
    return;
  }

  try {
    const uploadLoc = await resolveLocator(page, selectors.shared.upload, {
      timeout: config.operationTimeoutMs,
      log: () => {},
    });
    const fileChooserPromise = page.waitForEvent("filechooser", {
      timeout: config.operationTimeoutMs,
    });
    await uploadLoc.locator.click({ timeout: config.operationTimeoutMs });
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(imagePath);
    await page.waitForTimeout(1_000);
  } catch (err) {
    throw new FireflyAutomationError(
      `Could not find an upload control. Set FIREFLY_SELECTOR_UPLOAD_BUTTON if the UI changed. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function applyOptionalControls(
  page: Page,
  input: {
    aspectRatio?: string;
    contentClass?: string;
    style?: string;
  },
  options: { skipAspectRatio?: boolean } = {},
): Promise<string[]> {
  const warnings: string[] = [];

  for (const [label, value] of [
    // On the text-to-image page aspect ratio is set by applyImageSettings.
    ["aspect ratio", options.skipAspectRatio === true ? undefined : input.aspectRatio],
    ["style", input.style],
    ["content class", input.contentClass],
  ] as const) {
    if (value === undefined || value.trim().length === 0) {
      continue;
    }

    const clicked = await clickTextOption(page, value);
    if (!clicked) {
      warnings.push(
        `Requested ${label} "${value}", but no matching visible Firefly control was found.`,
      );
    }
  }

  return warnings;
}

async function clickTextOption(page: Page, value: string): Promise<boolean> {
  const pattern = new RegExp(escapeRegExp(value.trim()), "iu");
  const candidates = [
    page.getByRole("button", { name: pattern }).first(),
    page.getByRole("option", { name: pattern }).first(),
    page.getByText(pattern).first(),
  ];

  for (const locator of candidates) {
    const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) {
      continue;
    }

    await locator.click({ timeout: 2_000 }).catch(() => undefined);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Image page controls (firefly.adobe.com/generate/image). Model, Aspect ratio
// and Resolution are Spectrum <sp-picker> elements with stable ids; Playwright
// CSS selectors pierce their open shadow roots.
// ---------------------------------------------------------------------------

const IMAGE_GENERATE_BUTTON = 'sp-button[data-testid="generate-image-generate-button"]';
const IMAGE_PROMPT_BOX = 'div[role="textbox"][aria-label="Prompt"]';

type ImageSettingKey = keyof AppliedImageSettings;

// Order matters: the model changes which ratios and resolutions exist.
const IMAGE_PICKERS: readonly { id: string; key: ImageSettingKey; label: string }[] = [
  { id: "model", key: "model", label: "model" },
  { id: "size", key: "aspectRatio", label: "aspect ratio" },
  { id: "output-resolution", key: "resolution", label: "resolution" },
];

interface PickerItem {
  disabled: boolean;
  text: string;
  value: string;
}

interface PickerState {
  items: PickerItem[];
  value: string;
}

type PickerResult = { ok: true; text: string } | { ok: false; reason: string };

async function applyImageSettings(
  page: Page,
  input: Pick<TextToImageInput, ImageSettingKey>,
  logger: Logger,
): Promise<{ applied: AppliedImageSettings; warnings: string[] }> {
  const warnings: string[] = [];
  const applied: AppliedImageSettings = {};

  for (const picker of IMAGE_PICKERS) {
    const wanted = input[picker.key];
    if (wanted === undefined || wanted.trim().length === 0) {
      continue;
    }

    const result = await selectPickerOption(page, picker.id, wanted.trim(), logger);
    if (result.ok) {
      applied[picker.key] = result.text;
      logger.info(`Set ${picker.label}`, { applied: result.text, wanted });
    } else {
      warnings.push(
        `Requested ${picker.label} "${wanted}", but it could not be set: ${result.reason}`,
      );
    }

    await page.waitForTimeout(600);
  }

  return { applied, warnings };
}

async function readPicker(picker: Locator): Promise<PickerState> {
  return picker.evaluate((el) => {
    const host = el as HTMLElement & { value?: string };
    return {
      items: Array.from(host.querySelectorAll("sp-menu-item")).map((item) => {
        const menuItem = item as HTMLElement & { disabled?: boolean; value?: string };
        return {
          disabled: Boolean(menuItem.disabled),
          text: (menuItem.textContent ?? "").replace(/\s+/g, " ").trim(),
          value: menuItem.value ?? menuItem.getAttribute("value") ?? "",
        };
      }),
      value: host.value ?? "",
    };
  });
}

/** Exact label or value first; otherwise the shortest label containing the text. */
export function matchPickerItem(
  items: readonly PickerItem[],
  wanted: string,
): PickerItem | undefined {
  const want = wanted.toLowerCase().replace(/\s+/gu, " ").trim();
  const usable = items.filter((item) => !item.disabled);
  const exact = usable.find(
    (item) => item.text.toLowerCase() === want || item.value.toLowerCase() === want,
  );
  if (exact !== undefined) {
    return exact;
  }

  // "4:3" -> "Landscape (4:3)", "Nano Banana Pro" -> "Gemini 3 (Nano Banana Pro)".
  return usable
    .filter((item) => item.text.toLowerCase().includes(want))
    .sort((a, b) => a.text.length - b.text.length)[0];
}

async function selectPickerOption(
  page: Page,
  pickerId: string,
  wanted: string,
  logger: Logger,
): Promise<PickerResult> {
  const picker = page.locator(`sp-picker#${pickerId}`).first();
  if (!(await picker.isVisible({ timeout: 8_000 }).catch(() => false))) {
    return { ok: false, reason: `the "${pickerId}" control is not on the page` };
  }

  let state = await readPicker(picker);
  const match = matchPickerItem(state.items, wanted);
  if (match === undefined) {
    return {
      ok: false,
      reason: `no option matches. Available: ${state.items.map((item) => item.text).join(", ")}`,
    };
  }

  if (state.value === match.value) {
    return { ok: true, text: match.text };
  }

  // 1. Real mouse clicks: open the picker, click the visible menu item.
  try {
    await picker.click({ timeout: 5_000 });
    const option = page
      .locator("sp-menu-item")
      .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(match.text)}\\s*$`, "u") })
      .locator("visible=true")
      .first();
    await option.waitFor({ state: "visible", timeout: 4_000 });
    await option.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    await option.click({ timeout: 4_000 });
  } catch (error) {
    logger.debug("Picker click path failed, trying value fallback", {
      error: String(error),
      pickerId,
    });
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  await page.waitForTimeout(400);
  state = await readPicker(picker);
  if (state.value === match.value) {
    return { ok: true, text: match.text };
  }

  // 2. Fallback: set the value the way the picker does and announce the change.
  await picker.evaluate((el, value) => {
    (el as HTMLElement & { value?: string }).value = value;
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }, match.value);
  await page.waitForTimeout(400);
  state = await readPicker(picker);
  if (state.value === match.value) {
    return { ok: true, text: match.text };
  }

  const current = state.items.find((item) => item.value === state.value);
  return {
    ok: false,
    reason: `the control still shows "${current?.text ?? state.value}"`,
  };
}

async function typePrompt(
  page: Page,
  config: AppConfig,
  prompt: string,
  logger: Logger,
): Promise<void> {
  let box = page.locator(IMAGE_PROMPT_BOX).first();
  if (!(await box.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const resolved = await resolveLocator(page, selectors.image.prompt, {
      timeout: config.operationTimeoutMs,
      log: (msg) => logger.debug(msg),
    });
    box = resolved.locator;
  }

  const want = prompt.replace(/\s+/gu, " ").trim();
  const readBox = (): Promise<string> =>
    box.evaluate((el) => {
      const raw =
        el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
          ? el.value
          : (el as HTMLElement).innerText;
      return raw.replace(/\s+/g, " ").trim();
    });

  // Firefly ignores programmatic fill() on this editor (the previous prompt is
  // submitted instead), so type it the way a person would and check it took.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await box.click({ timeout: 5_000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText(want);
    await page.waitForTimeout(600);

    const got = await readBox();
    if (got === want) {
      logger.info("Prompt entered and verified", { length: want.length });
      return;
    }

    logger.warn("Prompt text did not match after typing", {
      attempt,
      expected: want.length,
      got: got.length,
    });
  }

  throw new Error("The prompt box did not keep the typed text.");
}

// Messages Firefly shows in place of results when a generation fails.
const FIREFLY_ERROR_PATTERN =
  "something went wrong|please try again later|couldn.t generate|could not generate|unable to generate|generation failed|violates|content (policy|guidelines)|not allowed|out of credits|not enough credits|insufficient credits";

export interface FireflyErrorScan {
  count: number;
  messages: string[];
}

/** Visible Firefly error messages, searched through shadow roots. */
export async function readFireflyErrors(page: Page): Promise<FireflyErrorScan> {
  return page
    .evaluate((source) => {
      const pattern = new RegExp(source, "i");
      const messages: string[] = [];
      const walk = (root: Document | ShadowRoot): void => {
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if (el.shadowRoot) {
            walk(el.shadowRoot);
          }

          // Only count the element that holds the text itself, not its ancestors.
          const own = Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (own.length === 0 || own.length > 300 || !pattern.test(own)) {
            continue;
          }

          if (el.closest('[role="textbox"], textarea, input')) {
            continue; // the prompt box can contain any words
          }

          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) {
            continue;
          }

          messages.push(own);
        }
      };

      walk(document);
      return { count: messages.length, messages };
    }, FIREFLY_ERROR_PATTERN)
    .catch(() => ({ count: 0, messages: [] }));
}

/**
 * Waits for new result images, checking every second for a Firefly error so a
 * failed generation stops in seconds instead of running to the timeout.
 */
async function waitForGeneratedImages(
  page: Page,
  before: Set<string>,
  timeoutMs: number,
  expected: number,
  errorsBefore: FireflyErrorScan,
): Promise<void> {
  const failIfFireflyError = async (): Promise<void> => {
    const errors = await readFireflyErrors(page);
    if (errors.count > errorsBefore.count) {
      const fresh = [...new Set(errors.messages)].join(" / ");
      throw new FireflyAutomationError(
        `Firefly reported an error instead of images: "${fresh}". Nothing was downloaded.`,
      );
    }
  };

  const countNew = async (): Promise<number> => {
    const after = await collectVisibleImageFingerprints(page);
    return Array.from(after).filter((fingerprint) => !before.has(fingerprint)).length;
  };

  const firstDeadline = Date.now() + timeoutMs;
  for (;;) {
    await failIfFireflyError();
    if ((await countNew()) > 0) {
      break;
    }

    if (Date.now() > firstDeadline) {
      throw new FireflyAutomationError(
        "Timed out waiting for Firefly to render generated images.",
      );
    }

    await page.waitForTimeout(1_000);
  }

  // Results render one tile at a time; wait until all are in or the count holds steady.
  const deadline = Date.now() + 60_000;
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() <= deadline) {
    const count = await countNew();
    if (count >= expected) {
      return;
    }

    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 8_000) {
      return;
    }

    await page.waitForTimeout(1_000);
  }
}

function resolveOutputDir(config: AppConfig, outputDir: string | undefined): string {
  return outputDir === undefined
    ? config.downloadsDir
    : path.resolve(
        path.isAbsolute(outputDir) ? outputDir : path.join(config.dataDir, outputDir),
      );
}
