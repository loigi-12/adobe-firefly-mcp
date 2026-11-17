import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { runTextToImage } from "../firefly/generate.js";
import { jsonToolResult, type ToolDeps, withToolErrors } from "./shared.js";

const generateInputShape = {
  aspectRatio: z
    .string()
    .trim()
    .optional()
    .describe(
      'Optional aspect ratio, matched against the Aspect ratio menu: a ratio such as "4:3" or "9:16", or a full label such as "Landscape (4:3)".',
    ),
  contentClass: z
    .string()
    .trim()
    .optional()
    .describe('Optional Firefly content type/control label, such as "Photo" or "Art".'),
  count: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(4)
    .describe("Maximum number of generated images to save."),
  model: z
    .string()
    .trim()
    .optional()
    .describe(
      'Optional model, matched against the Model menu: for example "Nano Banana Pro" selects "Gemini 3 (Nano Banana Pro)". Use the full label to tell similar names apart.',
    ),
  negativePrompt: z.string().trim().optional().describe("Optional things to avoid."),
  outputDir: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional output directory. Relative paths resolve under the MCP data dir.",
    ),
  prompt: z.string().trim().min(1).describe("Image prompt to send to Adobe Firefly."),
  resolution: z
    .string()
    .trim()
    .optional()
    .describe(
      'Optional output resolution from the Resolution menu, such as "1K", "2K" or "4K". Set after the model, since the model changes the choices.',
    ),
  style: z
    .string()
    .trim()
    .optional()
    .describe("Optional visible Firefly style/control label to try to select."),
};

const generateInputSchema = z.object(generateInputShape);

export function registerGenerateTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "firefly_generate",
    {
      description:
        "Generate images in Adobe Firefly using the existing persistent browser session. Sets the model, aspect ratio and resolution when given, verifies the typed prompt, saves only the newly generated images, and stops early with Firefly's message if the generation fails. The result's `settings` field shows what was applied. Requires manual Adobe sign-in in the browser profile.",
      inputSchema: generateInputShape,
      title: "Adobe Firefly Generate",
    },
    async (input) =>
      withToolErrors(deps, "firefly_generate", async () => {
        const parsed = generateInputSchema.parse(input);
        const result = await runTextToImage(
          deps.browser,
          deps.config,
          deps.logger.child({ tool: "firefly_generate" }),
          parsed,
        );

        return jsonToolResult({
          ok: true,
          ...result,
        });
      }),
  );
}
