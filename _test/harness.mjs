// Shared minimal harness for the dsh-tool-notion tests.
//
// It rebuilds the plugin's `apply` against the REAL @deepseek-ai/dsh-tools, so
// schema normalization (`required` hoisting, `additionalProperties`, enum
// retention) is exercised for real rather than against a hand-written stub.
//
// `apply(ctx, config)` receives an already schema-resolved config, so this
// context runs the caller's options through the real `Config` first and fills
// every missing key with its default. Passing a partial object straight through
// would silently register zero tools.
//
// The module-level internals are re-exported too. The interesting parts of this
// plugin — the inline scanner, the run merger, the block validator — are pure
// functions, and testing them through a tool call would mean wrapping every
// assertion in JSON plumbing for no gain.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, basename, dirname, extname } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

// The import lines are stripped and re-bound as `new Function` parameters, and
// the export statements are dropped because the builders below re-export.
//
// The export regex must span lines: this plugin writes its internals as a
// multi-line `export { … };` block, and a single-line pattern would leave the
// bare `export` keyword behind — which `new Function` rejects outright.
const body = source
	.replace(/^import .*$/gm, "")
	.replace(/^export \{[\s\S]*?\};$/gm, "");

const INTERNALS = [
	"parseNotionId", "textRun", "plainText", "payloadOf", "richTextOf",
	"runToMarkdown", "richTextToMarkdown", "parseInline", "mergeRuns",
	"annotateLines", "markdownToBlocks", "indentLevel", "blocksToMarkdown",
	"flattenBlocks", "validateBlocks", "toNotionBlock", "depthOf",
	"calloutEmoji", "calloutLabel", "findClosing",
	"ANNOTATIONS", "MARKDOWN_BLOCKS", "HEADING_LEVELS", "INLINE_MARKERS",
	"KNOWN_LANGUAGES", "CALLOUT_EMOJI", "EMOJI_CALLOUT"
];

const build = new Function(
	"z", "defineTool", "readFile", "writeFile", "mkdir",
	"join", "resolve", "basename", "dirname", "extname",
	`${body}\nreturn { Config, apply, inject, name, ${INTERNALS.join(", ")} };`
);

/** The plugin's real exports plus its internals, for white-box assertions. */
export const plugin = build(
	z, defineTool, readFile, writeFile, mkdir,
	join, resolve, basename, dirname, extname
);

/**
 * Build a minimal cordis-like context that records registered tools.
 *
 * `apply` is *not* called automatically — tests call it explicitly, so a
 * registration toggle can be asserted before and after.
 *
 * @param {object} [options] - partial plugin config; missing keys take defaults.
 * @returns {{tools: object, config: object, names: () => string[], get: (n: string) => any, has: (n: string) => boolean}} the context.
 */
export function Context(options = {}) {
	const config = plugin.Config(options);
	const registry = new Map();
	const tools = {
		register(definition) {
			registry.set(definition.name, definition);
		}
	};
	return {
		tools,
		config,
		names: () => [...registry.keys()],
		get: (n) => registry.get(n),
		has: (n) => registry.has(n)
	};
}

/**
 * Run a tool call and capture either its value or the thrown error, so tests can
 * assert on modelled failure paths without try/catch noise.
 *
 * @param {any} definition - a tool definition exposing `execute`.
 * @param {object} args - tool arguments.
 * @param {object} [options] - extra execute options (e.g. a fake signal).
 * @returns {Promise<{value?: any, error?: string}>} the outcome.
 */
export async function call(definition, args, options = {}) {
	try {
		return { value: await definition.execute(args, { signal: options.signal }) };
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

/**
 * Build a Notion-shaped rich-text run, for tests that start from API data.
 *
 * @param {string} content - the text.
 * @param {object} [annotations] - annotation overrides.
 * @param {string|null} [url] - an optional link.
 * @returns {object} the run.
 */
export function run(content, annotations = {}, url = null) {
	const out = { type: "text", text: { content }, annotations };
	if (url !== null) out.text.link = { url };
	return out;
}

/**
 * Build a Notion-shaped block, for tests that start from API data.
 *
 * @param {string} type - the block type.
 * @param {Array<object>} richText - the runs.
 * @param {object} [extra] - extra payload fields, e.g. `{ checked: true }`.
 * @returns {object} the block.
 */
export function block(type, richText = [], extra = {}) {
	return { object: "block", type, [type]: { rich_text: richText, ...extra } };
}

export default { plugin, Context, call, run, block };