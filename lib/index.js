// dsh-tool-notion — move text in and out of Notion's block model.
//
// There is no API client here on purpose. The plugin works on the *data*
// Notion exchanges — the block JSON a page export contains, and the
// Notion-flavoured Markdown it exports to — so it stays useful without a
// token and stays testable without a network.
//
// The whole difficulty is one asymmetry, and it is worth stating plainly
// because every bug in this file traces back to it:
//
//   * Markdown says a paragraph is ONE string.
//   * Notion says a paragraph is an ARRAY of rich-text runs, each carrying its
//     own annotations.
//
// So `**bold** and plain` is four runs in Notion (`**bold**` split across the
// markers) and one line in Markdown. Going one way is a parse; going the other
// is a merge that has to decide whether adjacent runs with the same
// annotations collapse. Those two operations are NOT inverses of each other,
// and pretending otherwise is how round-trip bugs get shipped. Every lossy
// step in this file is reported rather than hidden.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "dsh-tool-notion";
const inject = ["tools"];

/* ------------------------------------------------------------- constants */

/**
 * The annotation keys Notion uses on a rich-text run, and whether each one is
 * a toggle. `link` is excluded because it is a value, not a toggle, and mixing
 * a string-valued key into a boolean map is how `{ link: "https://x" }` gets
 * truthiness-compared somewhere later.
 */
const ANNOTATIONS = ["bold", "italic", "strikethrough", "underline", "code"];

/**
 * Block types this plugin can express in Markdown, and the reverse map.
 *
 * Notion has roughly thirty block types. Claiming to support all of them would
 * mean silently dropping the ones that do not map — so the mapping is explicit
 * and anything outside it is reported as unconvertible instead.
 */
const MARKDOWN_BLOCKS = {
	paragraph: "p",
	heading_1: "#",
	heading_2: "##",
	heading_3: "###",
	bulleted_list_item: "-",
	numbered_list_item: "1.",
	to_do: "- [ ]",
	quote: ">",
	code: "```",
	divider: "---",
	callout: "> [!NOTE]"
};

/** Heading level for each heading block type, for the reverse direction. */
const HEADING_LEVELS = { heading_1: 1, heading_2: 2, heading_3: 3 };

/**
 * Inline Markdown markers, longest first so `***` is tried before `**` and
 * `*`. Getting this order wrong makes `**bold**` parse as an empty italic run
 * followed by text.
 */
const INLINE_MARKERS = [
	{ token: "***", annotations: { bold: true, italic: true } },
	{ token: "___", annotations: { bold: true, italic: true } },
	{ token: "**", annotations: { bold: true } },
	{ token: "__", annotations: { bold: true } },
	{ token: "~~", annotations: { strikethrough: true } },
	{ token: "`", annotations: { code: true } },
	{ token: "*", annotations: { italic: true } },
	{ token: "_", annotations: { italic: true } }
];

/** Fenced-code language hints Notion accepts; anything else is passed through. */
const KNOWN_LANGUAGES = new Set([
	"abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++",
	"c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow",
	"fortran", "f#", "gherkin", "git", "glsl", "go", "graphql", "groovy",
	"haskell", "html", "java", "javascript", "json", "julia", "kotlin",
	"latex", "less", "lisp", "livescript", "lua", "makefile", "markdown",
	"markup", "matlab", "mermaid", "nginx", "objective-c", "ocaml", "pascal",
	"perl", "php", "plain text", "powershell", "prolog", "protobuf", "python",
	"r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss", "shell",
	"sql", "swift", "typescript", "vb.net", "verilog", "vhdl", "visual basic",
	"webassembly", "xml", "yaml", "java/c/c++/c#"
]);

/**
 * The callout label vocabulary, and the emoji each one maps to.
 *
 * This has to be a bijection, because a callout's label carries its *meaning*
 * and the emoji is only how Notion draws it. An earlier draft mapped labels to
 * emoji on the way out but read the icon back expecting a label, so every
 * `[!WARNING]` came back as `[!NOTE]` — a silent downgrade of a warning into a
 * note, which is exactly the kind of loss that matters.
 */
const CALLOUT_EMOJI = {
	NOTE: "📘",
	TIP: "💡",
	IMPORTANT: "❗",
	WARNING: "⚠️",
	CAUTION: "🛑"
};

/** The reverse map, so an emoji read back off a block recovers its label. */
const EMOJI_CALLOUT = Object.fromEntries(Object.entries(CALLOUT_EMOJI).map(([label, emoji]) => [emoji, label]));

/* -------------------------------------------------------------- helpers */

/**
 * Build an empty annotation map, so a run always carries all five keys.
 *
 * Notion omits absent annotations, but normalising here means a consumer never
 * has to distinguish "absent" from "false" — which is the kind of distinction
 * that produces `undefined` leaking into a renderer.
 *
 * @returns {object} every annotation key mapped to false.
 */
function emptyAnnotations() {
	const out = {};
	for (const key of ANNOTATIONS) out[key] = false;
	return out;
}

/**
 * Strip a Notion page URL or bare id down to its 32-hex-character form.
 *
 * Notion hands out ids in three shapes and all three are the same page:
 * `1f2e...` bare, `1f2e...-...-...` dashed, and the last path segment of a
 * share URL. Normalising once here beats scattering regexes through the file.
 *
 * @param {string} value - a url, a dashed id, or a bare id.
 * @returns {{id: string|null, dashed: string|null, source: string}} the normalised forms.
 */
function parseNotionId(value) {
	const text = String(value ?? "").trim();
	if (text === "") return { id: null, dashed: null, source: "empty" };
	// A share URL puts the id at the END of the last path segment, glued to a
	// human-readable slug: `.../My-Page-1f2e3d4c5b6a79801122334455667788`.
	// Anchoring on 32 trailing hex characters handles that, the bare form, and
	// the dashed form, without needing three separate patterns.
	const withoutQuery = text.split(/[?#]/u)[0];
	const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(withoutQuery);
	if (match === null) return { id: null, dashed: null, source: "unrecognised" };
	const compact = match[1].replace(/-/gu, "").toLowerCase();
	const dashed = [
		compact.slice(0, 8),
		compact.slice(8, 12),
		compact.slice(12, 16),
		compact.slice(16, 20),
		compact.slice(20)
	].join("-");
	return { id: compact, dashed, source: text };
}

/**
 * Turn a plain string into a single-run rich-text array.
 *
 * @param {string} text - the text.
 * @param {object} [annotations] - annotation overrides.
 * @param {string|null} [href] - an optional link.
 * @returns {Array<object>} a one-element rich-text array.
 */
function textRun(text, annotations = {}, href = null) {
	const run = { type: "text", text: { content: String(text) }, annotations: { ...emptyAnnotations(), ...annotations } };
	if (href !== null) run.text.link = { url: href };
	return run;
}

/**
 * Flatten a rich-text array back to a plain string.
 *
 * @param {Array<object>} rich - the run array.
 * @returns {string} the concatenated content.
 */
function plainText(rich) {
	if (!Array.isArray(rich)) return "";
	return rich.map((run) => run?.text?.content ?? run?.plain_text ?? "").join("");
}

/**
 * Read the value stored under a block's own type key.
 *
 * Notion puts a block's payload under a key named after the type
 * (`{ type: "heading_1", heading_1: { ... } }`), so every access needs the
 * same two-step lookup. Centralising it means a missing payload is handled
 * once instead of producing `undefined` at a dozen call sites.
 *
 * @param {object} block - the block.
 * @returns {object} the payload, never undefined.
 */
function payloadOf(block) {
	if (block === null || typeof block !== "object") return {};
	const key = block.type;
	if (typeof key !== "string") return {};
	const value = block[key];
	return value !== null && typeof value === "object" ? value : {};
}

/**
 * Collect the rich-text array out of a block payload.
 *
 * @param {object} block - the block.
 * @returns {Array<object>} the runs, possibly empty.
 */
function richTextOf(block) {
	const payload = payloadOf(block);
	return Array.isArray(payload.rich_text) ? payload.rich_text : [];
}

/**
 * Render one run back to inline Markdown.
 *
 * Order matters and is not arbitrary: `code` is rendered innermost because
 * Markdown backticks suppress every other marker inside them. Emitting
 * `**\`x\`**` is right; `` `**x**` `` is wrong, and the difference is invisible
 * until someone copies the text out.
 *
 * @param {object} run - the rich-text run.
 * @returns {string} the inline Markdown.
 */
function runToMarkdown(run) {
	const content = run?.text?.content ?? run?.plain_text ?? "";
	if (content === "") return "";
	const annotations = run?.annotations ?? {};
	let out = String(content);

	// A literal backtick inside code content would terminate the span early, so
	// pick a fence one backtick wider than the longest run of backticks inside.
	if (annotations.code) {
		const longest = (out.match(/`+/gu) ?? [""]).reduce((max, run) => Math.max(max, run.length), 0);
		const fence = "`".repeat(longest + 1);
		const pad = out.startsWith("`") || out.endsWith("`") ? " " : "";
		out = `${fence}${pad}${out}${pad}${fence}`;
	}
	// Bold and italic are applied outside code, and bold outside italic so the
	// result nests as `***x***` rather than `**__x__**`.
	if (annotations.italic) out = `*${out}*`;
	if (annotations.bold) out = `**${out}**`;
	if (annotations.strikethrough) out = `~~${out}~~`;
	if (annotations.underline) out = `<u>${out}</u>`;

	const url = run?.text?.link?.url;
	if (typeof url === "string" && url !== "") out = `[${out}](${url})`;
	return out;
}

/**
 * Render a rich-text array to inline Markdown.
 *
 * Adjacent runs are emitted in order with no separator — a space the author
 * typed is *in* a run, so inserting one between runs would add characters that
 * were never there. This is the most common way a naive exporter corrupts text.
 *
 * @param {Array<object>} rich - the runs.
 * @returns {string} the inline Markdown.
 */
function richTextToMarkdown(rich) {
	if (!Array.isArray(rich)) return "";
	return rich.map(runToMarkdown).join("");
}

/**
 * Find the closing marker for an inline span, skipping escaped markers.
 *
 * @param {string} text - the text after the opening marker.
 * @param {string} token - the opening marker.
 * @returns {number} the index of the closing marker, or -1.
 */
function findClosing(text, token) {
	let index = 0;
	while (index < text.length) {
		const at = text.indexOf(token, index);
		if (at === -1) return -1;
		// Count the backslashes immediately before; an odd count means escaped.
		let slashes = 0;
		while (at - slashes - 1 >= 0 && text[at - slashes - 1] === "\\") slashes += 1;
		if (slashes % 2 === 0) return at;
		index = at + token.length;
	}
	return -1;
}

/**
 * Parse an inline Markdown string into rich-text runs.
 *
 * This is a scanner rather than a regex chain, because nesting is real:
 * `**bold with `code` inside**` has to come out as three runs with the
 * annotations stacked, and no single regex survives that.
 *
 * @param {string} text - the inline Markdown.
 * @param {object} [inherited] - annotations carried in from an enclosing span.
 * @returns {{runs: Array<object>, notes: Array<string>}} runs and any caveats.
 */
function parseInline(text, inherited = {}) {
	const runs = [];
	const notes = [];
	let buffer = "";
	let index = 0;

	/** Push the accumulated plain text as a run before starting a new span. */
	const flush = () => {
		if (buffer === "") return;
		runs.push(textRun(buffer, inherited));
		buffer = "";
	};

	while (index < text.length) {
		// Escaped punctuation is a literal character, never a marker.
		if (text[index] === "\\" && index + 1 < text.length && /[\\`*_~[\]()<>#+-.]/u.test(text[index + 1])) {
			buffer += text[index + 1];
			index += 2;
			continue;
		}

		// Links first: `[text](url)` may contain markers inside the label.
		if (text[index] === "[") {
			const close = text.indexOf("](", index);
			if (close !== -1) {
				const end = text.indexOf(")", close);
				if (end !== -1) {
					const label = text.slice(index + 1, close);
					const url = text.slice(close + 2, end);
					flush();
					const inner = parseInline(label, inherited);
					notes.push(...inner.notes);
					if (inner.runs.length === 0) {
						runs.push(textRun(label, inherited, url));
					} else {
						for (const run of inner.runs) {
							run.text.link = { url };
							runs.push(run);
						}
					}
					index = end + 1;
					continue;
				}
			}
		}

		let matched = null;
		for (const marker of INLINE_MARKERS) {
			if (!text.startsWith(marker.token, index)) continue;
			const after = index + marker.token.length;
			// A marker must not be followed by whitespace, or `a * b * c` would
			// parse as an italic span across the middle of a sentence.
			if (after >= text.length || /\s/u.test(text[after])) continue;
			const close = findClosing(text.slice(after), marker.token);
			if (close === -1) continue;
			matched = { marker, after, close: after + close };
			break;
		}

		if (matched === null) {
			buffer += text[index];
			index += 1;
			continue;
		}

		flush();
		const innerText = text.slice(matched.after, matched.close);
		const inner = parseInline(innerText, { ...inherited, ...matched.marker.annotations });
		notes.push(...inner.notes);
		for (const run of inner.runs) runs.push(run);
		index = matched.close + matched.marker.token.length;
	}

	flush();

	// An empty string still needs to be representable, or a blank paragraph
	// would vanish on a round trip.
	if (runs.length === 0) return { runs: [textRun("", inherited)], notes };
	return { runs, notes };
}

/**
 * Merge adjacent runs that carry identical formatting.
 *
 * Notion itself produces runs split at arbitrary points, and a caller comparing
 * two conversions wants `[{text:"a"},{text:"b"}]` and `[{text:"ab"}]` to be
 * recognised as the same content. Without this, a round-trip equality check
 * fails for a reason that has nothing to do with the text.
 *
 * @param {Array<object>} runs - the runs to merge.
 * @returns {Array<object>} the merged runs.
 */
function mergeRuns(runs) {
	const out = [];
	for (const run of runs) {
		const previous = out[out.length - 1];
		if (previous === undefined) {
			out.push({ ...run, annotations: { ...run.annotations } });
			continue;
		}
		const sameAnnotations = ANNOTATIONS.every((key) => Boolean(previous.annotations?.[key]) === Boolean(run.annotations?.[key]));
		const sameLink = (previous.text?.link?.url ?? null) === (run.text?.link?.url ?? null);
		if (sameAnnotations && sameLink) {
			previous.text.content += run.text?.content ?? "";
		} else {
			out.push({ ...run, annotations: { ...run.annotations } });
		}
	}
	// A merge can leave a single empty run where there were two; that is correct
	// and is deliberately not special-cased.
	return out;
}

/**
 * Split Markdown source into lines, tracking fenced code regions.
 *
 * A `#` inside a fenced block is code, not a heading — which means the block
 * splitter cannot be line-by-line. Tracking the fence state is a single pass
 * and avoids a class of bugs where a shell comment in a code sample becomes an
 * H1 and swallows the rest of the document.
 *
 * @param {string} source - the Markdown.
 * @returns {Array<{line: string, inCode: boolean, fence: string|null}>} annotated lines.
 */
function annotateLines(source) {
	const lines = String(source).replace(/\r\n?/gu, "\n").split("\n");
	const out = [];
	let fence = null;
	for (const line of lines) {
		const fenceMatch = /^\s*(```+|~~~+)(.*)$/u.exec(line);
		if (fence === null && fenceMatch !== null) {
			out.push({ line, inCode: false, fence: fenceMatch[1] });
			fence = fenceMatch[1];
			continue;
		}
		if (fence !== null && fenceMatch !== null && fenceMatch[1].startsWith(fence[0])) {
			out.push({ line, inCode: true, fence: null });
			fence = null;
			continue;
		}
		out.push({ line, inCode: fence !== null, fence: null });
	}
	return out;
}

/**
 * Parse Notion-flavoured Markdown into blocks.
 *
 * The result is a flat list with an explicit `level` on list items, matching
 * how Notion actually stores nesting (children arrays) while staying simple
 * enough to assert on. Indentation is turned into a level rather than a tree,
 * because a four-space indent means nesting in some documents and a code block
 * in others — and guessing wrong silently re-parents content.
 *
 * @param {string} source - the Markdown.
 * @returns {{blocks: Array<object>, notes: Array<string>}} blocks and caveats.
 */
function markdownToBlocks(source) {
	const lines = annotateLines(source);
	const blocks = [];
	const notes = [];
	let index = 0;

	while (index < lines.length) {
		const { line, inCode } = lines[index];

		// --- fenced code -----------------------------------------------------
		const fenceOpen = /^\s*(```+|~~~+)\s*([\w+#/-]*)\s*$/u.exec(line);
		if (fenceOpen !== null && !inCode) {
			const fence = fenceOpen[1];
			const language = fenceOpen[2] ?? "";
			const body = [];
			index += 1;
			while (index < lines.length) {
				const candidate = lines[index];
				if (/^\s*(```+|~~~+)\s*$/u.test(candidate.line)) break;
				body.push(candidate.line);
				index += 1;
			}
			if (index < lines.length) index += 1; // consume the closing fence
			const normalised = language === "" ? "plain text" : language.toLowerCase();
			if (language !== "" && !KNOWN_LANGUAGES.has(normalised)) {
				notes.push(`The code fence language "${language}" is not one Notion documents; it was kept as-is and may not highlight.`);
			}
			blocks.push({
				type: "code",
				level: 0,
				language: normalised,
				richText: [textRun(body.join("\n"))]
			});
			continue;
		}

		// --- blank line ------------------------------------------------------
		if (line.trim() === "") {
			index += 1;
			continue;
		}

		// --- divider ---------------------------------------------------------
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
			blocks.push({ type: "divider", level: 0, language: null, richText: [] });
			index += 1;
			continue;
		}

		// --- table (kept verbatim, since Notion tables are not rich text) ----
		if (/^\s*\|.*\|\s*$/u.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/u.test(lines[index + 1].line)) {
			const rowCount = [];
			while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index].line)) {
				rowCount.push(lines[index].line);
				index += 1;
			}
			notes.push("A Markdown table was kept as a single paragraph; Notion stores tables as child blocks, which this plugin does not synthesise.");
			blocks.push({ type: "paragraph", level: 0, language: null, richText: [textRun(rowCount.join("\n"))] });
			continue;
		}

		// --- callout ---------------------------------------------------------
		const callout = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/iu.exec(line);
		if (callout !== null) {
			const body = [callout[2] ?? ""];
			index += 1;
			while (index < lines.length && /^\s*>\s?/u.test(lines[index].line)) {
				body.push(lines[index].line.replace(/^\s*>\s?/u, ""));
				index += 1;
			}
			blocks.push({
				type: "callout",
				level: 0,
				language: null,
				icon: callout[1].toUpperCase(),
				richText: parseInline(body.join("\n").trim()).runs
			});
			continue;
		}

		// --- blockquote ------------------------------------------------------
		if (/^\s*>\s?/u.test(line)) {
			const body = [];
			while (index < lines.length && /^\s*>\s?/u.test(lines[index].line)) {
				body.push(lines[index].line.replace(/^\s*>\s?/u, ""));
				index += 1;
			}
			blocks.push({ type: "quote", level: 0, language: null, richText: parseInline(body.join("\n").trim()).runs });
			continue;
		}

		// --- heading ---------------------------------------------------------
		const heading = /^\s*(#{1,6})\s+(.*)$/u.exec(line);
		if (heading !== null) {
			const level = heading[1].length;
			// Notion has exactly three heading sizes; h4-h6 have nowhere to go.
			if (level > 3) notes.push(`Heading level ${level} has no Notion equivalent and was stored as a level-3 heading.`);
			const type = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
			blocks.push({ type, level: 0, language: null, richText: parseInline(heading[2]).runs });
			index += 1;
			continue;
		}

		// --- to-do -----------------------------------------------------------
		const todo = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/u.exec(line);
		if (todo !== null) {
			blocks.push({
				type: "to_do",
				level: indentLevel(todo[1]),
				language: null,
				checked: todo[2].toLowerCase() === "x",
				richText: parseInline(todo[3]).runs
			});
			index += 1;
			continue;
		}

		// --- list item -------------------------------------------------------
		const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line);
		if (bullet !== null) {
			blocks.push({ type: "bulleted_list_item", level: indentLevel(bullet[1]), language: null, richText: parseInline(bullet[2]).runs });
			index += 1;
			continue;
		}
		const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/u.exec(line);
		if (numbered !== null) {
			blocks.push({ type: "numbered_list_item", level: indentLevel(numbered[1]), language: null, richText: parseInline(numbered[3]).runs });
			index += 1;
			continue;
		}

		// --- paragraph (consecutive non-blank lines join into one) -----------
		const paragraph = [line.trim()];
		index += 1;
		while (index < lines.length) {
			const candidate = lines[index];
			if (candidate.inCode || candidate.line.trim() === "") break;
			if (/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~)/u.test(candidate.line)) break;
			paragraph.push(candidate.line.trim());
			index += 1;
		}
		blocks.push({ type: "paragraph", level: 0, language: null, richText: parseInline(paragraph.join(" ")).runs });
	}

	return { blocks, notes };
}

/**
 * Convert leading whitespace to a list nesting level.
 *
 * Two spaces or one tab per level, which is what Notion's own exporter emits.
 * A tab counts as one level regardless of how wide it renders, because the
 * alternative (expanding to a fixed tab width) makes nesting depend on a
 * setting the file does not record.
 *
 * @param {string} whitespace - the leading whitespace.
 * @returns {number} the nesting level, 0 for top level.
 */
function indentLevel(whitespace) {
	if (whitespace === "") return 0;
	let spaces = 0;
	for (const character of whitespace) {
		if (character === "\t") spaces += 2;
		else if (character === " ") spaces += 1;
	}
	return Math.floor(spaces / 2);
}

/**
 * Convert blocks back to Notion-flavoured Markdown.
 *
 * @param {Array<object>} blocks - the blocks.
 * @returns {{markdown: string, notes: Array<string>}} the Markdown and caveats.
 */
function blocksToMarkdown(blocks) {
	const lines = [];
	const notes = [];
	const listCounters = [];

	for (const block of blocks) {
		const type = block?.type ?? "paragraph";
		const rich = richTextOf(block);
		const inline = richTextToMarkdown(rich);

		switch (type) {
			case "heading_1":
			case "heading_2":
			case "heading_3": {
				const level = HEADING_LEVELS[type];
				lines.push(`${"#".repeat(level)} ${inline}`, "");
				break;
			}
			case "bulleted_list_item":
			case "to_do": {
				const level = Number(block.level ?? 0);
				listCounters.length = level + 1;
				const indent = "  ".repeat(level);
				const checked = payloadOf(block).checked === true;
				lines.push(`${indent}- ${type === "to_do" ? `[${checked ? "x" : " "}] ` : ""}${inline}`);
				break;
			}
			case "numbered_list_item": {
				const level = Number(block.level ?? 0);
				listCounters[level] = (listCounters[level] ?? 0) + 1;
				listCounters.length = level + 1;
				lines.push(`${"  ".repeat(level)}${listCounters[level]}. ${inline}`);
				break;
			}
			case "quote": {
				lines.push(...inline.split("\n").map((row) => `> ${row}`), "");
				break;
			}
			case "callout": {
				// Read the label back off the icon, so `[!WARNING]` survives a
				// round trip instead of degrading to `[!NOTE]`.
				const icon = calloutLabel(payloadOf(block));
				lines.push(`> [!${icon}] ${inline}`, "");
				break;
			}
			case "code": {
				const payload = payloadOf(block);
				const language = typeof payload.language === "string" ? payload.language : "plain text";
				// The fence must be longer than any run of backticks in the body,
				// or a code sample containing ``` would end the block early.
				const longest = (plainText(rich).match(/`{3,}/gu) ?? [""]).reduce((max, run) => Math.max(max, run.length), 0);
				const fence = "`".repeat(Math.max(3, longest + 1));
				lines.push(`${fence}${language === "plain text" ? "" : language}`, plainText(rich), fence, "");
				break;
			}
			case "divider":
				lines.push("---", "");
				break;
			case "paragraph":
				lines.push(inline, "");
				break;
			default: {
				// Unknown types are reported, not silently rendered as empty
				// paragraphs — an empty paragraph looks like a deliberate blank line.
				notes.push(`Block type "${type}" has no Markdown equivalent and was omitted.`);
				continue;
			}
		}
	}

	// Collapse the trailing blank line, and never emit runs of blank lines.
	const markdown = lines.join("\n").replace(/\n{3,}/gu, "\n\n").replace(/\s+$/u, "") + "\n";
	return { markdown, notes };
}

/**
 * Walk a nested block tree depth-first into a flat list.
 *
 * Notion returns children under `children`, and a flat list is much easier to
 * assert on. The depth is preserved as `depth` so callers can still reason
 * about nesting — and so a round trip does not flatten a nested list by
 * accident.
 *
 * @param {Array<object>} blocks - the tree.
 * @param {number} [depth] - current depth.
 * @returns {Array<object>} the flattened blocks, each with a `depth`.
 */
function flattenBlocks(blocks, depth = 0) {
	const out = [];
	if (!Array.isArray(blocks)) return out;
	for (const block of blocks) {
		if (block === null || typeof block !== "object") continue;
		out.push({ ...block, depth });
		if (Array.isArray(block.children) && block.children.length > 0) {
			out.push(...flattenBlocks(block.children, depth + 1));
		}
	}
	return out;
}

/**
 * Check a block array for the mistakes that make Notion reject or mis-render it.
 *
 * Every check here corresponds to a failure that is otherwise silent: the
 * request succeeds and the page is subtly wrong.
 *
 * @param {Array<object>} blocks - the blocks to validate.
 * @returns {{problems: Array<object>, checked: number, bySeverity: object}} the findings.
 */
function validateBlocks(blocks) {
	const problems = [];
	const flat = flattenBlocks(blocks);
	const push = (severity, index, message) => problems.push({ severity, index, message });

	flat.forEach((block, index) => {
		const type = block?.type;
		if (typeof type !== "string" || type === "") {
			push("error", index, "The block has no `type`, so Notion cannot tell what it is.");
			return;
		}
		if (!(type in MARKDOWN_BLOCKS) && type !== "table") {
			push("warning", index, `Block type "${type}" is not one this plugin converts; it will be omitted from Markdown.`);
		}
		const payload = payloadOf(block);

		// Text-bearing blocks must use `rich_text`, not `text` or a bare string.
		const textBearing = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "code"];
		if (textBearing.includes(type)) {
			if (!Array.isArray(payload.rich_text)) {
				push("error", index, `A "${type}" block must carry a rich_text ARRAY, not a string. Notion's shape is { rich_text: [ { type: "text", text: { content: "…" } } ] }.`);
			} else {
				payload.rich_text.forEach((run, runIndex) => {
					if (run === null || typeof run !== "object" || run.type !== "text") {
						push("error", index, `rich_text[${runIndex}] must be { type: "text", … }; a bare string is rejected.`);
						return;
					}
					if (typeof run.text?.content !== "string") {
						push("error", index, `rich_text[${runIndex}].text.content must be a string.`);
					}
					const url = run.text?.link?.url;
					if (url !== undefined && url !== null && !/^https?:\/\//iu.test(String(url))) {
						push("warning", index, `rich_text[${runIndex}] links to "${url}", which is not an http(s) URL; Notion will drop it.`);
					}
					if (run.annotations !== undefined) {
						for (const key of Object.keys(run.annotations)) {
							if (key === "link") {
								push("warning", index, `Annotations carry a "link" key, but the URL belongs under text.link.url; the value here is ignored.`);
								continue;
							}
							if (!ANNOTATIONS.includes(key) && !["color", "underline"].includes(key)) {
								push("warning", index, `Annotation "${key}" is not one Notion defines and will be ignored.`);
							}
						}
					}
				});
			}
			if (plainText(payload.rich_text).length > 2000) {
				push("error", index, "A single rich-text run exceeds Notion's 2000-character limit and must be split.");
			}
		}

		if (type === "to_do" && typeof payload.checked !== "boolean") {
			push("warning", index, "A to_do block without a boolean `checked` renders unchecked regardless of intent.");
		}
		if (type === "code" && typeof payload.language !== "string") {
			push("warning", index, "A code block without a `language` falls back to plain text.");
		}
		if (type === "code" && typeof payload.language === "string" && !KNOWN_LANGUAGES.has(payload.language.toLowerCase())) {
			push("warning", index, `Code language "${payload.language}" is not one Notion documents; highlighting may be lost.`);
		}
		if (block.level !== undefined && (!Number.isInteger(block.level) || block.level < 0)) {
			push("error", index, `\`level\` must be a non-negative integer; got ${JSON.stringify(block.level)}.`);
		}
		// List nesting cannot skip a level, unlike HTML.
		if (block.level !== undefined && block.level > 0) {
			const previous = flat[index - 1];
			const previousLevel = previous?.level ?? 0;
			if (block.level > previousLevel + 1) {
				push("warning", index, `Level ${block.level} follows level ${previousLevel}, skipping a step; Notion will clamp it to level ${previousLevel + 1}.`);
			}
		}
	});

	const bySeverity = { error: 0, warning: 0 };
	for (const problem of problems) bySeverity[problem.severity] += 1;
	return { problems, checked: flat.length, bySeverity };
}

/**
 * Pull the block array out of whatever the caller supplied.
 *
 * Notion's API answers with `{ object: "list", results: [...] }`, and that
 * wrapper is what people actually have on hand — so it has to be accepted
 * somewhere. It cannot be accepted through the `blocks` parameter, because
 * `defineTool` enforces an array there before the tool body runs; an object
 * would be rejected with "must be an array" and the caller would have no idea
 * why. Hence the string form, parsed here, and this one place where the three
 * accepted shapes converge.
 *
 * @param {object} args - the tool arguments.
 * @param {string} toolName - the tool name, for error messages.
 * @returns {Array<object>} the block array.
 */
function resolveBlocks(args, toolName) {
	let raw = args.blocks;

	if (raw === undefined && typeof args.blocksJson === "string") {
		try {
			raw = JSON.parse(args.blocksJson);
		} catch (error) {
			throw new Error(`notion: blocksJson is not valid JSON (${error?.message ?? error}).`);
		}
	}

	if (raw === undefined) {
		throw new Error(`notion: ${toolName} needs \`blocks\` (an array) or \`blocksJson\` (the raw API response as a string).`);
	}

	const list = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : null;
	if (list === null) {
		throw new Error("notion: expected a block array, or an object with a `results` array. Pass it as `blocksJson` if it is the raw API response.");
	}
	return list;
}

/* --------------------------------------------------------------- config */

const DEFAULT_TIMEOUT_MS = 120000;

const Config = z.object({
	/** Directory that relative input paths resolve against. */
	workDir: z.string().default("."),
	/** Directory that output files are written to. */
	outputDir: z.string().default("notion-output"),
	/** Register `notion_status`. */
	status: z.boolean().default(true),
	/** Register `notion_to_md`. */
	toMarkdown: z.boolean().default(true),
	/** Register `notion_to_blocks`. */
	toBlocks: z.boolean().default(true),
	/** Register `notion_validate`. */
	validate: z.boolean().default(true),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
});

/* ----------------------------------------------------------------- apply */

/**
 * Register the enabled Notion tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	// Hoisted above the first use, so the status tool and the converters share
	// one budget rather than the status tool capturing `undefined`.
	const timeoutMs = config.timeoutMs;

	/* -- notion_status ----------------------------------------------------- */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "notion_status",
			description: "Report which Notion block types this plugin can convert in each direction, the annotation keys it understands, and the working directories. Check this before a conversion so an unsupported block type is a known limitation rather than a surprise.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						blockTypes: { type: "array", required: true, items: { type: "string" } },
						annotations: { type: "array", required: true, items: { type: "string" } },
						languages: { type: "number", required: true },
						directories: {
							type: "object", required: true, additionalProperties: false,
							properties: {
								workDir: { type: "string", required: true },
								outputDir: { type: "string", required: true }
							}
						},
						note: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`Notion conversion — ${value.blockTypes.length} block types, ${value.annotations.length} annotations, ${value.languages} known code languages`,
						`blocks:      ${value.blockTypes.join(", ")}`,
						`annotations: ${value.annotations.join(", ")}`,
						`workDir:     ${value.directories.workDir}`,
						`outputDir:   ${value.directories.outputDir}`,
						value.note
					].join("\n")
				}]
			},
			timeoutMs,
			isConcurrencySafe: () => true,
			execute() {
				return {
					blockTypes: Object.keys(MARKDOWN_BLOCKS),
					annotations: [...ANNOTATIONS],
					languages: KNOWN_LANGUAGES.size,
					directories: { workDir: resolve(config.workDir), outputDir: resolve(config.outputDir) },
					note: "Both directions are lossy in ways that are reported rather than hidden: Markdown has three heading levels where Notion does too, but h4–h6, tables and nested toggles have no direct equivalent. A conversion returns a `losses` list naming every block it could not express exactly."
				};
			},
			presentCall: () => ({ card: "generic", title: "Notion conversion capability", kind: "other", rawInput: {} })
		}));
	}

	/* -- notion_to_md ------------------------------------------------------ */
	if (config.toMarkdown) {
		ctx.tools.register(defineTool({
			name: "notion_to_md",
			description: "Convert a Notion block array (as exported by the API, or hand-written) into Notion-flavoured Markdown. Handles headings, lists with nesting, to-dos, quotes, callouts, code fences, dividers and inline annotations. Reports anything it cannot express instead of dropping it silently.",
			parameters: {
				blocks: { type: "array", description: "The block array, in Notion's own shape. See `blocksJson` for the API wrapper form." },
				blocksJson: { type: "string", description: "The whole API response as a JSON string, i.e. `{\"object\":\"list\",\"results\":[…]}`. Use this when you have the raw response rather than a bare array — the wrapper cannot be passed as `blocks` because the array type is enforced before the tool body runs." },
				path: { type: "string", description: "Read the block JSON from this file instead of passing it inline." },
				outputName: { type: "string", description: "Write the Markdown to this filename inside outputDir." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						markdown: { type: "string", required: true },
						blockCount: { type: "number", required: true },
						depth: { type: "number", required: true },
						losses: { type: "array", required: true, items: { type: "string" } },
						writtenTo: { type: "string" },
						note: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`${value.blockCount} block(s) at depth ${value.depth} → ${value.markdown.length} characters of Markdown`,
						value.writtenTo === undefined ? "" : `written to ${value.writtenTo}`,
						value.losses.length === 0 ? "" : `losses:\n${value.losses.map((item) => `  · ${item}`).join("\n")}`,
						"",
						value.markdown.trimEnd()
					].filter((line) => line !== "").join("\n")
				}]
			},
			timeoutMs,
			isConcurrencySafe: () => true,
			async execute(args) {
				let list;
				if (args.path !== undefined) {
					const raw = await readFile(resolve(join(config.workDir, args.path)), "utf8");
					let parsed;
					try {
						parsed = JSON.parse(raw);
					} catch (error) {
						throw new Error(`notion: ${args.path} is not valid JSON (${error?.message ?? error}).`);
					}
					list = resolveBlocks({ blocks: parsed }, "notion_to_md");
				} else {
					list = resolveBlocks(args, "notion_to_md");
				}

				const result = blocksToMarkdown(list);
				// `depthOf` already reports the deepest child level, so a flat
				// list is 0 — adding one here would claim every document with
				// paragraphs in it has nesting.
				const depth = list.reduce((max, block) => Math.max(max, depthOf(block)), 0);

				let writtenTo;
				if (args.outputName !== undefined) {
					const target = resolve(join(config.outputDir, args.outputName));
					const outputRoot = resolve(config.outputDir);
					// Refuse to escape the configured directory; a name is a name.
					if (target !== outputRoot && !target.startsWith(outputRoot + (process.platform === "win32" ? "\\" : "/"))) {
						throw new Error(`notion: outputName "${args.outputName}" would write outside outputDir.`);
					}
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, result.markdown, "utf8");
					writtenTo = target;
				}

				return {
					markdown: result.markdown,
					blockCount: list.length,
					depth,
					losses: result.notes,
					writtenTo,
					note: result.notes.length === 0
						? "Every block had a Markdown equivalent; nothing was approximated."
						: `${result.notes.length} loss(es) reported. The Markdown is still usable, but a round trip will not return the original blocks.`
				};
			},
			presentCall: () => ({ card: "generic", title: "Notion blocks → Markdown", kind: "other", rawInput: {} })
		}));
	}

	/* -- notion_to_blocks -------------------------------------------------- */
	if (config.toBlocks) {
		ctx.tools.register(defineTool({
			name: "notion_to_blocks",
			description: "Parse Notion-flavoured Markdown into a block array shaped the way the Notion API expects, including rich-text runs split at annotation boundaries. Fenced code is not mistaken for headings, and inline nesting (bold containing code) is preserved.",
			parameters: {
				markdown: { type: "string", description: "The Markdown source. Pass this or `path`." },
				path: { type: "string", description: "Read the Markdown from this file instead of passing it inline." },
				outputName: { type: "string", description: "Write the block JSON to this filename inside outputDir." },
				merge: { type: "boolean", description: "Collapse adjacent runs with identical formatting. Defaults to true." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						blocks: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
						blockCount: { type: "number", required: true },
						runCount: { type: "number", required: true },
						byType: { type: "object", required: true, additionalProperties: true },
						losses: { type: "array", required: true, items: { type: "string" } },
						writtenTo: { type: "string" },
						note: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`${value.blockCount} block(s), ${value.runCount} rich-text run(s)`,
						`types: ${Object.entries(value.byType).map(([type, count]) => `${type}×${count}`).join(", ")}`,
						value.writtenTo === undefined ? "" : `written to ${value.writtenTo}`,
						value.losses.length === 0 ? "" : `losses:\n${value.losses.map((item) => `  · ${item}`).join("\n")}`,
						"",
						JSON.stringify(value.blocks, null, 2)
					].filter((line) => line !== "").join("\n")
				}]
			},
			timeoutMs,
			isConcurrencySafe: () => true,
			async execute(args) {
				let source;
				if (args.path !== undefined) {
					source = await readFile(resolve(join(config.workDir, args.path)), "utf8");
				} else if (args.markdown !== undefined) {
					source = args.markdown;
				} else {
					throw new Error("notion: notion_to_blocks needs `markdown` or `path`.");
				}

				const parsed = markdownToBlocks(source);
				const shouldMerge = args.merge !== false;
				const blocks = parsed.blocks.map((block) => toNotionBlock(block, shouldMerge));

				const byType = {};
				for (const block of blocks) byType[block.type] = (byType[block.type] ?? 0) + 1;
				const runCount = blocks.reduce((sum, block) => sum + (block[block.type]?.rich_text?.length ?? 0), 0);

				let writtenTo;
				if (args.outputName !== undefined) {
					const target = resolve(join(config.outputDir, args.outputName));
					const outputRoot = resolve(config.outputDir);
					if (target !== outputRoot && !target.startsWith(outputRoot + (process.platform === "win32" ? "\\" : "/"))) {
						throw new Error(`notion: outputName "${args.outputName}" would write outside outputDir.`);
					}
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, `${JSON.stringify({ object: "list", results: blocks }, null, 2)}\n`, "utf8");
					writtenTo = target;
				}

				return {
					blocks,
					blockCount: blocks.length,
					runCount,
					byType,
					losses: parsed.notes,
					writtenTo,
					note: shouldMerge
						? "Adjacent runs with identical formatting were merged. Pass merge:false to keep one run per parsed span."
						: "merge:false — every parsed span stays a separate run, matching how an HTML-to-block converter usually emits them."
				};
			},
			presentCall: () => ({ card: "generic", title: "Markdown → Notion blocks", kind: "other", rawInput: {} })
		}));
	}

	/* -- notion_validate --------------------------------------------------- */
	if (config.validate) {
		ctx.tools.register(defineTool({
			name: "notion_validate",
			description: "Check a block array for the mistakes that make Notion reject a request or render it wrongly: a string where a rich_text array belongs, a run over the 2000-character limit, annotations in the wrong place, a missing to_do checked flag, list nesting that skips a level. Reports each finding with a severity and the offending index.",
			parameters: {
				blocks: { type: "array", description: "The block array to check." },
				blocksJson: { type: "string", description: "The whole API response as a JSON string, i.e. `{\"object\":\"list\",\"results\":[…]}`." },
				path: { type: "string", description: "Read the block JSON from this file instead." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						checked: { type: "number", required: true },
						errorCount: { type: "number", required: true },
						warningCount: { type: "number", required: true },
						problems: {
							type: "array", required: true,
							items: {
								type: "object", additionalProperties: false,
								properties: {
									severity: { type: "string", required: true },
									index: { type: "number", required: true },
									message: { type: "string", required: true }
								}
							}
						},
						note: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						value.ok ? `${value.checked} block(s) checked, no errors` : `${value.checked} block(s) checked — ${value.errorCount} error(s), ${value.warningCount} warning(s)`,
						...value.problems.map((problem) => `  [${problem.severity}] block ${problem.index}: ${problem.message}`),
						value.note
					].join("\n")
				}]
			},
			timeoutMs,
			isConcurrencySafe: () => true,
			async execute(args) {
				let list;
				if (args.path !== undefined) {
					const raw = await readFile(resolve(join(config.workDir, args.path)), "utf8");
					let parsed;
					try {
						parsed = JSON.parse(raw);
					} catch (error) {
						throw new Error(`notion: ${args.path} is not valid JSON (${error?.message ?? error}).`);
					}
					list = resolveBlocks({ blocks: parsed }, "notion_validate");
				} else {
					list = resolveBlocks(args, "notion_validate");
				}

				const { problems, checked, bySeverity } = validateBlocks(list);
				return {
					ok: bySeverity.error === 0,
					checked,
					errorCount: bySeverity.error,
					warningCount: bySeverity.warning,
					problems,
					note: bySeverity.error === 0
						? "No errors. Warnings are style-level: Notion will accept the payload, but the rendered result may not match the intent."
						: "Errors listed here correspond to payloads Notion rejects or renders as empty. Fix them before sending."
				};
			},
			presentCall: () => ({ card: "generic", title: "Notion block validation", kind: "other", rawInput: {} })
		}));
	}
}

/**
 * Depth of a block's child tree, for the `depth` field.
 *
 * @param {object} block - the block.
 * @returns {number} the deepest child depth, 0 for a leaf.
 */
function depthOf(block) {
	if (!Array.isArray(block?.children) || block.children.length === 0) return 0;
	return 1 + block.children.reduce((max, child) => Math.max(max, depthOf(child)), 0);
}

/**
 * Convert one parsed block into the exact shape the Notion API expects.
 *
 * The nesting difference matters: Notion pairs each rich-text run with its own
 * annotations object, so a run's formatting travels with its text. That is why
 * this is a separate step from parsing — parsing produces a convenient flat
 * form, and this step is where the API's stricter shape is imposed.
 *
 * @param {object} block - a block from `markdownToBlocks`.
 * @param {boolean} merge - whether to merge adjacent identical runs.
 * @returns {object} the API-shaped block.
 */
function toNotionBlock(block, merge) {
	const runs = merge ? mergeRuns(block.richText) : block.richText;
	const richText = runs.map((run) => {
		const out = { type: "text", text: { content: run.text.content } };
		if (run.text.link !== undefined) out.text.link = { url: run.text.link.url };
		const annotations = {};
		for (const key of ANNOTATIONS) if (run.annotations?.[key] === true) annotations[key] = true;
		if (Object.keys(annotations).length > 0) out.annotations = annotations;
		return out;
	});
	const base = { object: "block", type: block.type };
	if (block.level !== undefined && block.level > 0) base.level = block.level;

	switch (block.type) {
		case "divider":
			return { ...base, divider: {} };
		case "code":
			return { ...base, code: { rich_text: richText, language: block.language ?? "plain text" } };
		case "to_do":
			return { ...base, to_do: { rich_text: richText, checked: block.checked === true } };
		case "callout":
			return { ...base, callout: { rich_text: richText, icon: { type: "emoji", emoji: calloutEmoji(block.icon) } } };
		case "heading_1":
		case "heading_2":
		case "heading_3":
			return { ...base, [block.type]: { rich_text: richText } };
		case "bulleted_list_item":
		case "numbered_list_item":
		case "quote":
		case "paragraph":
		default:
			return { ...base, [block.type]: { rich_text: richText } };
	}
}

/**
 * Map a callout label to an emoji, since Notion callouts carry an icon.
 *
 * @param {string} label - NOTE / TIP / IMPORTANT / WARNING / CAUTION.
 * @returns {string} the emoji.
 */
function calloutEmoji(label) {
	return CALLOUT_EMOJI[String(label).toUpperCase()] ?? CALLOUT_EMOJI.NOTE;
}

/**
 * Recover a callout label from the icon on a block.
 *
 * Notion allows any emoji as an icon, including ones outside this vocabulary;
 * those fall back to NOTE rather than being dropped, so the block still renders
 * as a callout rather than becoming a plain paragraph.
 *
 * @param {object} payload - the callout payload.
 * @returns {string} the label.
 */
function calloutLabel(payload) {
	const icon = payload?.icon;
	// The API's shape is `{ type: "emoji", emoji: "…" }`, but a hand-written
	// payload often carries a bare string, so both are accepted.
	const emoji = typeof icon === "string" ? icon : icon?.emoji;
	if (emoji === undefined) return "NOTE";
	return EMOJI_CALLOUT[emoji] ?? "NOTE";
}

export { Config, apply, inject, name };
export {
	parseNotionId,
	textRun,
	plainText,
	payloadOf,
	richTextOf,
	runToMarkdown,
	richTextToMarkdown,
	parseInline,
	mergeRuns,
	annotateLines,
	markdownToBlocks,
	indentLevel,
	blocksToMarkdown,
	flattenBlocks,
	validateBlocks,
	toNotionBlock,
	depthOf,
	calloutEmoji,
	calloutLabel,
	findClosing,
	ANNOTATIONS,
	MARKDOWN_BLOCKS,
	HEADING_LEVELS,
	INLINE_MARKERS,
	KNOWN_LANGUAGES,
	CALLOUT_EMOJI,
	EMOJI_CALLOUT
};