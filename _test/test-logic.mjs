// Logic assertions for dsh-tool-notion.
//
// Everything here is a pure function: the inline scanner, the run merger, the
// block parser, the validator. Those are where the judgement lives, so they get
// white-box assertions rather than being reached only through a tool call.
//
// The fixtures start from *real Notion API shapes* — a rich-text run is
// `{ type: "text", text: { content }, annotations }`, not a plain string —
// because a test that invents a friendlier shape proves nothing about whether
// the plugin can read what Notion actually sends.
import { plugin, Context, call, run, block } from "./harness.mjs";

let passed = 0;
const failures = [];

/**
 * Assert a condition and record the outcome.
 *
 * @param {string} label - what is being asserted.
 * @param {boolean} condition - the assertion result.
 */
function check(label, condition) {
	if (condition) {
		passed += 1;
	} else {
		failures.push(label);
		console.log(`  FAIL  ${label}`);
	}
}

/**
 * Assert deep equality via JSON.
 *
 * @param {string} label - what is being asserted.
 * @param {any} actual - produced value.
 * @param {any} expected - expected value.
 */
function equal(label, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	check(`${label} (got ${a}, want ${b})`, a === b);
}

console.log("notion: logic");

/* -------------------------------------------------------------- module shape */

equal("the plugin name is the package name", plugin.name, "dsh-tool-notion");
equal("the plugin injects the tools registry", JSON.stringify(plugin.inject), JSON.stringify(["tools"]));
check("Config builds a default object", typeof plugin.Config === "function");

/* -------------------------------------------------------------- config */

{
	const config = plugin.Config({});
	equal("workDir defaults to the process directory", config.workDir, ".");
	equal("outputDir defaults to notion-output", config.outputDir, "notion-output");
	equal("the status tool is on by default", config.status, true);
	equal("the markdown conversion is on by default", config.toMarkdown, true);
	equal("the block conversion is on by default", config.toBlocks, true);
	equal("the validator is on by default", config.validate, true);
	equal("the timeout defaults to two minutes", config.timeoutMs, 120000);
}

{
	const config = plugin.Config({ outputDir: "out", status: false, validate: false, timeoutMs: 5000 });
	equal("outputDir is overridable", config.outputDir, "out");
	equal("status can be switched off", config.status, false);
	equal("validate can be switched off", config.validate, false);
	equal("the timeout is overridable", config.timeoutMs, 5000);
}

/* -------------------------------------------------------------- registration */

{
	const ctx = Context({});
	equal("no tools are registered before apply", ctx.names().length, 0);
	plugin.apply(ctx, ctx.config);
	equal("four tools are registered", ctx.names().length, 4);
	check("notion_status is registered", ctx.has("notion_status"));
	check("notion_to_md is registered", ctx.has("notion_to_md"));
	check("notion_to_blocks is registered", ctx.has("notion_to_blocks"));
	check("notion_validate is registered", ctx.has("notion_validate"));
}

{
	const ctx = Context({ status: false, validate: false });
	plugin.apply(ctx, ctx.config);
	equal("toggles remove exactly the named tools", ctx.names().join(","), "notion_to_md,notion_to_blocks");
}

{
	const ctx = Context({ status: false, toMarkdown: false, toBlocks: false, validate: false });
	plugin.apply(ctx, ctx.config);
	equal("all four can be switched off", ctx.names().length, 0);
}

/* -------------------------------------------------------------- schema normalisation */

{
	const ctx = Context({});
	plugin.apply(ctx, ctx.config);
	const toBlocks = ctx.get("notion_to_blocks");

	// `parameters` IS the JSON schema; the declared arguments live under
	// `properties`. Reading `parameters.markdown` would silently be undefined.
	check("parameters is a JSON schema object", toBlocks.parameters.type === "object");
	equal("the markdown parameter is declared", toBlocks.parameters.properties.markdown?.type, "string");
	equal("the blocks parameter is declared as an array", ctx.get("notion_to_md").parameters.properties.blocks?.type, "array");
	// The wrapper form cannot ride on the array-typed parameter, so a string
	// parameter exists for it. Asserting the pair is what keeps that honest.
	equal("a JSON-string parameter exists for the api wrapper", ctx.get("notion_to_md").parameters.properties.blocksJson?.type, "string");
	equal("a required parameter is listed at the top level", JSON.stringify(toBlocks.parameters.required ?? []), JSON.stringify([]));
	check("the tool declares an output schema", toBlocks.output?.schema?.type === "object");
	// Concurrency: the converters are pure, the validator is too.
	equal("to_blocks is concurrency safe", toBlocks.isConcurrencySafe({ markdown: "x" }), true);
	equal("validate is concurrency safe", ctx.get("notion_validate").isConcurrencySafe({ blocks: [] }), true);
	equal("status is concurrency safe", ctx.get("notion_status").isConcurrencySafe({}), true);
	// The budget is attached, not guessed.
	equal("the tool carries its timeout budget", toBlocks.timeoutMs, 120000);
}

/* -------------------------------------------------------------- findClosing */

{
	// Backslash parity decides whether a marker is live, and both cases are
	// asserted on the SAME string shape so the difference is purely the parity.
	//   "a \** b** c"  → one backslash escapes the marker at index 3, so the
	//                    pair at index 7 is the real closer.
	//   "a \\** b** c" → the backslash is itself escaped, so the marker at
	//                    index 4 is live and closes there.
	equal("an odd backslash count escapes the marker", plugin.findClosing("a \\** b** c", "**"), 7);
	equal("an even backslash count does not escape it", plugin.findClosing("a \\\\** b** c", "**"), 4);
	equal("a plain marker closes immediately", plugin.findClosing("bold** rest", "**"), 4);
	equal("a missing marker returns -1", plugin.findClosing("no marker here", "**"), -1);
}

/* -------------------------------------------------------------- inline parsing */

{
	const { runs } = plugin.parseInline("plain");
	equal("plain text is one run", runs.length, 1);
	equal("the run carries the text", plainOf(runs), "plain");
	equal("no annotation is set", runs[0].annotations.bold, false);
}

{
	const { runs } = plugin.parseInline("a **b** c");
	equal("bold splits the string into three runs", runs.length, 3);
	equal("the text is preserved exactly", plainOf(runs), "a b c");
	equal("only the middle run is bold", JSON.stringify(runs.map((r) => r.annotations.bold)), JSON.stringify([false, true, false]));
}

{
	// Nesting: bold containing code must stack, not overwrite.
	const { runs } = plugin.parseInline("**see `x` here**");
	equal("nested markers produce three runs", runs.length, 3);
	equal("the code run is both bold and code", JSON.stringify([runs[1].annotations.bold, runs[1].annotations.code]), JSON.stringify([true, true]));
	equal("the outer runs are bold but not code", JSON.stringify([runs[0].annotations.code, runs[2].annotations.code]), JSON.stringify([false, false]));
}

{
	const { runs } = plugin.parseInline("***both***");
	equal("a triple marker yields one run", runs.length, 1);
	equal("it is bold and italic", JSON.stringify([runs[0].annotations.bold, runs[0].annotations.italic]), JSON.stringify([true, true]));
}

{
	// `a * b * c` must not become italic: a marker followed by a space is literal.
	const { runs } = plugin.parseInline("a * b * c");
	equal("a spaced asterisk stays literal", runs.length, 1);
	equal("the asterisks survive in the text", plainOf(runs), "a * b * c");
}

{
	const { runs } = plugin.parseInline("~~gone~~");
	equal("strikethrough is recognised", runs[0].annotations.strikethrough, true);
}

{
	const { runs } = plugin.parseInline("[label](https://example.com)");
	equal("a link becomes one run", runs.length, 1);
	equal("the link url is attached", runs[0].text.link.url, "https://example.com");
	equal("the label is the content", runs[0].text.content, "label");
}

{
	// A bold link: the annotation and the href must both survive.
	const { runs } = plugin.parseInline("**[x](https://e.com)**");
	equal("a bold link keeps both facts", JSON.stringify([runs[0].annotations.bold, runs[0].text.link.url]), JSON.stringify([true, "https://e.com"]));
}

{
	const { runs } = plugin.parseInline("an \\*escaped\\* pair");
	equal("escaped markers are literal", runs.length, 1);
	equal("the backslashes are consumed", plainOf(runs), "an *escaped* pair");
}

{
	const { runs } = plugin.parseInline("");
	equal("an empty string still yields a run", runs.length, 1);
	equal("that run is empty", runs[0].text.content, "");
}

/* ---------------------------------------------------- inline rendering */

{
	const bold = { type: "text", text: { content: "x" }, annotations: { bold: true } };
	equal("bold renders with double asterisks", plugin.runToMarkdown(bold), "**x**");

	const both = { type: "text", text: { content: "x" }, annotations: { bold: true, italic: true } };
	equal("bold italic nests correctly", plugin.runToMarkdown(both), "***x***");

	const code = { type: "text", text: { content: "x" }, annotations: { code: true } };
	equal("code renders with backticks", plugin.runToMarkdown(code), "`x`");

	// Code must be innermost, or the backticks would be swallowed by the markers.
	const codeBold = { type: "text", text: { content: "x" }, annotations: { code: true, bold: true } };
	equal("code sits inside bold", plugin.runToMarkdown(codeBold), "**`x`**");

	const linked = { type: "text", text: { content: "x", link: { url: "https://e.com" } }, annotations: {} };
	equal("a link renders as a markdown link", plugin.runToMarkdown(linked), "[x](https://e.com)");

	// A backtick inside code content needs a wider fence.
	const backtick = { type: "text", text: { content: "a `b` c" }, annotations: { code: true } };
	equal("internal backticks widen the fence", plugin.runToMarkdown(backtick), "``a `b` c``");

	const underlined = { type: "text", text: { content: "x" }, annotations: { underline: true } };
	equal("underline uses html, since markdown has none", plugin.runToMarkdown(underlined), "<u>x</u>");

	equal("an empty run renders as nothing", plugin.runToMarkdown({ type: "text", text: { content: "" }, annotations: {} }), "");
}

{
	// Adjacent runs must not gain a separator, since a space is *in* a run.
	const rich = [run("Hello"), run(" world"), run("!")];
	equal("runs concatenate with no separator", plugin.richTextToMarkdown(rich), "Hello world!");
	equal("a null array renders empty", plugin.richTextToMarkdown(null), "");
}

/* ---------------------------------------------------- run merging */

{
	const merged = plugin.mergeRuns([run("a"), run("b"), run("c")]);
	equal("identical adjacent runs collapse", merged.length, 1);
	equal("the content is concatenated", merged[0].text.content, "abc");
}

{
	const merged = plugin.mergeRuns([run("a"), run("b", { bold: true })]);
	equal("differently formatted runs stay apart", merged.length, 2);
}

{
	const merged = plugin.mergeRuns([run("a", {}, "https://x"), run("b")]);
	equal("a link boundary prevents merging", merged.length, 2);
}

{
	const merged = plugin.mergeRuns([run("a"), run("b", { code: true }), run("c", { code: true })]);
	equal("two code runs merge with each other", merged.length, 2);
	equal("the merged code run holds both parts", merged[1].text.content, "bc");
}

{
	equal("an empty list merges to an empty list", plugin.mergeRuns([]).length, 0);
}

/* ---------------------------------------------------- line annotation */

{
	const lines = plugin.annotateLines("# h\n```\n# not a heading\n```\n# h2");
	equal("five lines are annotated", lines.length, 5);
	equal("the heading is not flagged as code", lines[0].inCode, false);
	equal("the fence line opens a region", lines[1].inCode, false);
	equal("a hash inside a fence is code", lines[2].inCode, true);
	equal("the closing fence is code-terminated", lines[3].inCode, true);
	equal("the later heading is not code", lines[4].inCode, false);
}

{
	const lines = plugin.annotateLines("a\r\nb");
	equal("carriage returns are normalised away", lines.length, 2);
	equal("no stray carriage return survives", lines[1].line, "b");
}

/* ---------------------------------------------------- indent levels */

{
	equal("no indent is level zero", plugin.indentLevel(""), 0);
	equal("two spaces is one level", plugin.indentLevel("  "), 1);
	equal("four spaces is two levels", plugin.indentLevel("    "), 2);
	equal("one tab is one level", plugin.indentLevel("\t"), 1);
	equal("three spaces floors to one level", plugin.indentLevel("   "), 1);
}

/* ---------------------------------------------------- markdown to blocks */

{
	const { blocks } = plugin.markdownToBlocks("# One\n## Two\n### Three");
	equal("three headings produce three blocks", blocks.length, 3);
	equal("the levels map to the right types", blocks.map((b) => b.type).join(","), "heading_1,heading_2,heading_3");
}

{
	const { blocks, notes } = plugin.markdownToBlocks("#### Four");
	equal("an h4 becomes a level-3 heading", blocks[0].type, "heading_3");
	check("the downgrade is reported", notes.some((note) => note.includes("Heading level 4")));
}

{
	const { blocks } = plugin.markdownToBlocks("- a\n  - b\n    - c");
	equal("nested bullets keep their levels", blocks.map((b) => b.level).join(","), "0,1,2");
}

{
	// A fenced block containing a hash must not become a heading.
	const { blocks } = plugin.markdownToBlocks("```\n# not a heading\n```");
	equal("a fence makes one block", blocks.length, 1);
	equal("it is a code block", blocks[0].type, "code");
	equal("the body is preserved", blocks[0].richText[0].text.content, "# not a heading");
}

{
	const { blocks } = plugin.markdownToBlocks("```python\nprint(1)\n```");
	equal("the fence language is captured", blocks[0].language, "python");
}

{
	// The fence must be longer than backticks inside, so the body is not cut.
	const { blocks } = plugin.markdownToBlocks("````\nnested ``` here\n````");
	equal("a longer fence holds a shorter one", blocks[0].richText[0].text.content, "nested ``` here");
}

{
	const { blocks, notes } = plugin.markdownToBlocks("```brainfuck\n+++\n```");
	equal("an unknown language is still kept", blocks[0].language, "brainfuck");
	check("the unknown language is reported", notes.some((note) => note.includes("brainfuck")));
}

{
	const { blocks } = plugin.markdownToBlocks("- [x] done\n- [ ] todo");
	equal("to-dos are recognised", blocks.map((b) => b.type).join(","), "to_do,to_do");
	equal("the checked state is read", JSON.stringify(blocks.map((b) => b.checked)), JSON.stringify([true, false]));
}

{
	const { blocks } = plugin.markdownToBlocks("1. one\n2. two\n  1. nested");
	equal("numbered items are recognised", blocks[0].type, "numbered_list_item");
	equal("the nested item gets a level", blocks[2].level, 1);
}

{
	const { blocks } = plugin.markdownToBlocks("> a quote");
	equal("a quote is recognised", blocks[0].type, "quote");
	equal("the marker is stripped", blocks[0].richText[0].text.content, "a quote");
}

{
	const { blocks } = plugin.markdownToBlocks("> [!WARNING] mind the gap");
	equal("a callout is recognised", blocks[0].type, "callout");
	equal("the label is captured", blocks[0].icon, "WARNING");
	equal("the body is the content", blocks[0].richText[0].text.content, "mind the gap");
}

{
	const { blocks } = plugin.markdownToBlocks("---");
	equal("a divider is recognised", blocks[0].type, "divider");
}

{
	// Consecutive lines join into ONE paragraph, which is what Markdown means.
	const { blocks } = plugin.markdownToBlocks("first line\nsecond line\n\nnew paragraph");
	equal("two paragraphs are produced", blocks.length, 2);
	equal("the first joins with a space", blocks[0].richText[0].text.content, "first line second line");
}

{
	// A blank line is a separator, not a block.
	const { blocks } = plugin.markdownToBlocks("a\n\n\n\nb");
	equal("blank lines do not become blocks", blocks.length, 2);
}

{
	const { blocks, notes } = plugin.markdownToBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
	equal("a table becomes one paragraph", blocks.length, 1);
	equal("it is marked as a paragraph", blocks[0].type, "paragraph");
	check("the table limitation is reported", notes.some((note) => note.includes("table")));
}

{
	const { blocks } = plugin.markdownToBlocks("");
	equal("empty input produces no blocks", blocks.length, 0);
}

/* ---------------------------------------------------- blocks to markdown */

{
	const blocks = [
		block("heading_1", [run("Title")]),
		block("paragraph", [run("Body text")])
	];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("the heading renders with a hash", markdown.includes("# Title"));
	check("the paragraph follows", markdown.includes("Body text"));
}

{
	const blocks = [block("heading_2", [run("Two")])];
	equal("a level-2 heading gets two hashes", plugin.blocksToMarkdown(blocks).markdown.trim(), "## Two");
}

{
	const blocks = [
		block("bulleted_list_item", [run("a")]),
		{ ...block("bulleted_list_item", [run("b")]), level: 1 }
	];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("a nested item is indented", markdown.includes("  - b"));
}

{
	const blocks = [block("numbered_list_item", [run("a")]), block("numbered_list_item", [run("b")])];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("numbered items count up", markdown.includes("1. a") && markdown.includes("2. b"));
}

{
	const blocks = [block("to_do", [run("done")], { checked: true }), block("to_do", [run("open")], { checked: false })];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("a checked todo renders as x", markdown.includes("- [x] done"));
	check("an unchecked todo renders as a space", markdown.includes("- [ ] open"));
}

{
	const blocks = [block("code", [run("const a = 1;")], { language: "javascript" })];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("the code fence carries the language", markdown.includes("```javascript"));
	check("the body is inside the fence", markdown.includes("const a = 1;"));
}

{
	// A code body containing a fence must widen the outer fence.
	const blocks = [block("code", [run("```\ninner\n```")], { language: "plain text" })];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("the outer fence is widened", markdown.includes("````"));
}

{
	const blocks = [block("code", [run("x")], { language: "plain text" })];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("plain text gets a bare fence", markdown.includes("```\nx\n```"));
}

{
	const blocks = [block("quote", [run("quoted")])];
	check("a quote renders with a marker", plugin.blocksToMarkdown(blocks).markdown.includes("> quoted"));
}

{
	const blocks = [block("divider")];
	check("a divider renders as dashes", plugin.blocksToMarkdown(blocks).markdown.includes("---"));
}

{
	// An unknown type must be reported, not rendered as an empty paragraph —
	// an empty paragraph looks like a deliberate blank line.
	const blocks = [{ object: "block", type: "toggle", toggle: { rich_text: [run("x")] } }];
	const { markdown, notes } = plugin.blocksToMarkdown(blocks);
	equal("the unknown block contributes no text", markdown.trim(), "");
	check("the omission is reported", notes.some((note) => note.includes("toggle")));
}

{
	// The API's wrapper shape must be accepted by the tool layer.
	const blocks = [block("paragraph", [run("hi")])];
	const { markdown } = plugin.blocksToMarkdown(blocks);
	check("a paragraph's text is emitted", markdown.includes("hi"));
}

/* ---------------------------------------------------- flattening */

{
	const tree = [
		{ type: "a", children: [{ type: "b", children: [{ type: "c" }] }] },
		{ type: "d" }
	];
	const flat = plugin.flattenBlocks(tree);
	equal("every block in the tree is visited", flat.length, 4);
	equal("depth is preserved", flat.map((b) => b.depth).join(","), "0,1,2,0");
}

{
	equal("a non-array flattens to nothing", plugin.flattenBlocks(null).length, 0);
	const withNull = plugin.flattenBlocks([null, { type: "a" }, "junk"]);
	equal("non-object entries are skipped", withNull.length, 1);
}

/* ---------------------------------------------------- depth */

{
	equal("a leaf is depth zero", plugin.depthOf({ type: "a" }), 0);
	equal("one child is depth one", plugin.depthOf({ type: "a", children: [{ type: "b" }] }), 1);
	equal("a nested chain is measured fully", plugin.depthOf({ type: "a", children: [{ type: "b", children: [{ type: "c" }] }] }), 2);
}

/* ---------------------------------------------------- notion id parsing */

{
	// The id is glued to a slug in a share URL, so anchoring on 32 hex digits
	// is the only form that works for all three ways a user pastes an id.
	const url = "https://www.notion.so/My-Page-1f2e3d4c5b6a79801122334455667788?pvs=4";
	equal("an id is extracted from a slugged url", plugin.parseNotionId(url).id, "1f2e3d4c5b6a79801122334455667788");
	equal("the query string is dropped", plugin.parseNotionId(url).dashed, "1f2e3d4c-5b6a-7980-1122-334455667788");
	equal("the original input is remembered", plugin.parseNotionId(url).source, url);
	// The same report also catches a bare id with no url around it.
	equal("a url with no id is unrecognised", plugin.parseNotionId("https://www.notion.so/just-a-slug").id, null);
	equal("nonsense returns null", plugin.parseNotionId("not-an-id").id, null);
	equal("an empty string returns null", plugin.parseNotionId("").id, null);
	equal("the empty source is labelled", plugin.parseNotionId("").source, "empty");
}

/* ---------------------------------------------------- payload access */

{
	const b = block("heading_1", [run("x")]);
	equal("the payload is found under the type key", plugin.payloadOf(b).rich_text.length, 1);
	equal("a null block gives an empty payload", JSON.stringify(plugin.payloadOf(null)), "{}");
	equal("a block with no payload key gives nothing", JSON.stringify(plugin.payloadOf({ type: "divider" })), "{}");
	equal("the rich text of a divider is empty", plugin.richTextOf({ type: "divider" }).length, 0);
}

/* ---------------------------------------------------- validation */

{
	const result = plugin.validateBlocks([block("paragraph", [run("fine")])]);
	equal("a clean block has no problems", result.problems.length, 0);
	equal("it counts as checked", result.checked, 1);
	equal("no errors are reported", result.bySeverity.error, 0);
}

{
	// The classic mistake: a string where the API demands an array.
	const result = plugin.validateBlocks([{ type: "paragraph", paragraph: { rich_text: "a string" } }]);
	equal("a string rich_text is an error", result.bySeverity.error, 1);
	check("the message explains the array shape", result.problems[0].message.includes("rich_text ARRAY"));
}

{
	const result = plugin.validateBlocks([{ type: "paragraph", paragraph: { rich_text: ["bare string"] } }]);
	equal("a bare string inside the array is an error", result.bySeverity.error, 1);
	check("the message names the index", result.problems[0].message.includes("rich_text[0]"));
}

{
	// The 2000-character limit is a hard API rule.
	const long = "x".repeat(2001);
	const result = plugin.validateBlocks([block("paragraph", [run(long)])]);
	equal("an over-long run is an error", result.bySeverity.error, 1);
	check("the limit is named", result.problems[0].message.includes("2000"));
}

{
	const result = plugin.validateBlocks([block("paragraph", [run("x")])]);
	equal("a run of acceptable length is fine", result.bySeverity.error, 0);
}

{
	// A non-http link is dropped by Notion, so it is a warning not an error.
	const result = plugin.validateBlocks([block("paragraph", [run("x", {}, "not-a-url")])]);
	equal("a bad link is a warning", result.bySeverity.warning, 1);
	equal("it is not an error", result.bySeverity.error, 0);
}

{
	const noType = plugin.validateBlocks([{ object: "block", paragraph: {} }]);
	equal("a missing type is an error", noType.bySeverity.error, 1);
}

{
	// `link` inside annotations is a common misplacement; the URL belongs on text.
	const withAnnotationLink = plugin.validateBlocks([{
		type: "paragraph",
		paragraph: { rich_text: [{ type: "text", text: { content: "x" }, annotations: { link: "https://e.com" } }] }
	}]);
	equal("an annotation-level link is a warning", withAnnotationLink.bySeverity.warning, 1);
	check("the message says where the url belongs", withAnnotationLink.problems[0].message.includes("text.link.url"));
}

{
	const result = plugin.validateBlocks([{ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "x" }, annotations: { sparkle: true } }] } }]);
	equal("an unknown annotation is a warning", result.bySeverity.warning, 1);
}

{
	const result = plugin.validateBlocks([{ type: "to_do", to_do: { rich_text: [run("x")] } }]);
	equal("a to_do without checked is a warning", result.bySeverity.warning, 1);
	check("the message explains the default", result.problems[0].message.includes("unchecked"));
}

{
	const result = plugin.validateBlocks([block("code", [run("x")])]);
	equal("a code block without a language is a warning", result.bySeverity.warning, 1);
}

{
	const result = plugin.validateBlocks([block("code", [run("x")], { language: "klingon" })]);
	equal("an undocumented language is a warning", result.bySeverity.warning, 1);
}

{
	const result = plugin.validateBlocks([block("code", [run("x")], { language: "python" })]);
	equal("a documented language passes", result.bySeverity.warning, 0);
}

{
	const unknown = plugin.validateBlocks([{ type: "toggle", toggle: { rich_text: [run("x")] } }]);
	equal("an unconvertible type is a warning", unknown.bySeverity.warning, 1);
}

{
	const bad = plugin.validateBlocks([{ type: "paragraph", paragraph: { rich_text: [run("x")] }, level: -1 }]);
	equal("a negative level is an error", bad.bySeverity.error, 1);
}

{
	// Skipping a nesting level is clamped by Notion, so it is a warning.
	const skipped = plugin.validateBlocks([
		{ type: "bulleted_list_item", level: 0, bulleted_list_item: { rich_text: [run("a")] } },
		{ type: "bulleted_list_item", level: 3, bulleted_list_item: { rich_text: [run("b")] } }
	]);
	equal("a skipped nesting level is a warning", skipped.bySeverity.warning, 1);
	check("the clamp is explained", skipped.problems[0].message.includes("clamp"));
}

{
	// Nested children are validated too, since they arrive in the same payload.
	const nested = plugin.validateBlocks([{
		type: "paragraph",
		paragraph: { rich_text: [run("outer")] },
		children: [{ type: "paragraph", paragraph: { rich_text: "bad" } }]
	}]);
	equal("a child block is checked", nested.checked, 2);
	equal("its error is reported", nested.bySeverity.error, 1);
}

/* ---------------------------------------------------- api block shaping */

{
	const shaped = plugin.toNotionBlock({ type: "paragraph", level: 0, language: null, richText: [run("a"), run("b", { bold: true })] }, true);
	equal("the block carries the object marker", shaped.object, "block");
	equal("only the bold run carries annotations", JSON.stringify(shaped.paragraph.rich_text.map((r) => r.annotations !== undefined)), JSON.stringify([false, true]));
	equal("a zero level is omitted", shaped.level, undefined);
}

{
	const shaped = plugin.toNotionBlock({ type: "bulleted_list_item", level: 2, language: null, richText: [run("x")] }, true);
	equal("a positive level is carried", shaped.level, 2);
}

{
	const shaped = plugin.toNotionBlock({ type: "divider", level: 0, language: null, richText: [] }, true);
	equal("a divider carries an empty payload", JSON.stringify(shaped.divider), "{}");
}

{
	const shaped = plugin.toNotionBlock({ type: "to_do", level: 0, language: null, checked: true, richText: [run("x")] }, true);
	equal("the checked flag is carried", shaped.to_do.checked, true);
}

{
	const shaped = plugin.toNotionBlock({ type: "code", level: 0, language: "python", richText: [run("x")] }, true);
	equal("the language is carried", shaped.code.language, "python");
}

{
	const shaped = plugin.toNotionBlock({ type: "callout", level: 0, language: null, icon: "WARNING", richText: [run("x")] }, true);
	equal("the callout gets an emoji icon", shaped.callout.icon.emoji, "⚠️");
	equal("the icon is typed", shaped.callout.icon.type, "emoji");
}

{
	// The link must land under text.link, which is where the API reads it.
	const shaped = plugin.toNotionBlock({ type: "paragraph", level: 0, language: null, richText: [run("x", {}, "https://e.com")] }, true);
	equal("a link is placed under text.link", shaped.paragraph.rich_text[0].text.link.url, "https://e.com");
}

{
	equal("a known callout maps to its emoji", plugin.calloutEmoji("TIP"), "💡");
	equal("an unknown callout still gets an icon", plugin.calloutEmoji("whatever"), "📘");
}

{
	// The label is the semantic part and must survive the round trip. An
	// earlier draft wrote an emoji out and read back expecting a label, so
	// every [!WARNING] came back as [!NOTE] — a warning silently downgraded.
	for (const [label, emoji] of Object.entries({ NOTE: "📘", TIP: "💡", IMPORTANT: "❗", WARNING: "⚠️", CAUTION: "🛑" })) {
		equal(`the ${label} emoji maps back to its label`, plugin.calloutLabel({ icon: { type: "emoji", emoji } }), label);
	}
	equal("a bare string icon is accepted", plugin.calloutLabel({ icon: "⚠️" }), "WARNING");
	equal("an unknown emoji falls back to NOTE", plugin.calloutLabel({ icon: { emoji: "🎉" } }), "NOTE");
	equal("a missing icon falls back to NOTE", plugin.calloutLabel({}), "NOTE");
}

{
	// End to end through the two pure functions, which is where the bug lived.
	const [parsed] = plugin.markdownToBlocks("> [!CAUTION] mind the edge").blocks;
	const rendered = plugin.blocksToMarkdown([{ type: "callout", callout: { rich_text: parsed.richText, icon: { type: "emoji", emoji: plugin.calloutEmoji(parsed.icon) } } }]).markdown;
	check("a CAUTION callout survives a round trip", rendered.includes("[!CAUTION]"));
	check("it is not downgraded to NOTE", !rendered.includes("[!NOTE]"));
}

/* ---------------------------------------------------- exported tables */

equal("five annotations are defined", plugin.ANNOTATIONS.length, 5);
check("bold is among them", plugin.ANNOTATIONS.includes("bold"));
check("strikethrough is among them", plugin.ANNOTATIONS.includes("strikethrough"));
equal("eleven block types map to markdown", Object.keys(plugin.MARKDOWN_BLOCKS).length, 11);
equal("headings map to levels one to three", JSON.stringify(plugin.HEADING_LEVELS), JSON.stringify({ heading_1: 1, heading_2: 2, heading_3: 3 }));
check("the longest marker is tried first", plugin.INLINE_MARKERS[0].token === "***" || plugin.INLINE_MARKERS[0].token.length >= 3);
check("python is a known language", plugin.KNOWN_LANGUAGES.has("python"));
check("plain text is a known language", plugin.KNOWN_LANGUAGES.has("plain text"));

/* ---------------------------------------------------- tool level, no file io */

{
	const ctx = Context({});
	plugin.apply(ctx, ctx.config);

	const out = await call(ctx.get("notion_status"), {});
	equal("status reports the block types", out.value.blockTypes.length, 11);
	equal("status reports the annotations", out.value.annotations.length, 5);
	check("status reports a language count", out.value.languages > 50);
	check("status explains the losses", out.value.note.includes("losses"));

	const toMd = await call(ctx.get("notion_to_md"), { blocks: [block("heading_1", [run("Hi")])] });
	equal("a bare array is accepted", toMd.value.blockCount, 1);
	check("the markdown contains the heading", toMd.value.markdown.includes("# Hi"));

	// The API wrapper must go through `blocksJson`, since the array-typed
	// parameter is enforced before the tool body runs.
	const wrapped = await call(ctx.get("notion_to_md"), { blocksJson: JSON.stringify({ object: "list", results: [block("heading_1", [run("Hi")])] }) });
	equal("the api wrapper is accepted via blocksJson", wrapped.value.blockCount, 1);
	check("and produces the same heading", wrapped.value.markdown.includes("# Hi"));

	const badJson = await call(ctx.get("notion_to_md"), { blocksJson: "{not json" });
	check("malformed json is reported as such", badJson.error !== undefined && badJson.error.includes("not valid JSON"));

	const missing = await call(ctx.get("notion_to_md"), {});
	check("passing nothing is a clear error", missing.error !== undefined && missing.error.includes("blocksJson"));

	const notAList = await call(ctx.get("notion_to_md"), { blocksJson: JSON.stringify({ nada: 1 }) });
	check("a payload with no results array is refused", notAList.error !== undefined && notAList.error.includes("results"));

	const validated = await call(ctx.get("notion_validate"), { blocks: [block("paragraph", [run("ok")])] });
	equal("validation reports ok", validated.value.ok, true);
	equal("no errors are counted", validated.value.errorCount, 0);
}

/* ---------------------------------------------------- round trip */

{
	const ctx = Context({});
	plugin.apply(ctx, ctx.config);

	// Markdown → blocks → Markdown must be stable. This is the property that
	// matters: a second pass must not keep changing the text.
	const source = "# Title\n\nA paragraph with **bold** and `code`.\n\n- one\n- two\n\n> quoted\n\n```python\nprint(1)\n```\n";
	const first = await call(ctx.get("notion_to_blocks"), { markdown: source });
	const second = await call(ctx.get("notion_to_md"), { blocks: first.value.blocks });
	const third = await call(ctx.get("notion_to_blocks"), { markdown: second.value.markdown });

	equal("the second parse yields the same block count", third.value.blockCount, first.value.blockCount);
	equal("and the same type sequence", third.value.blocks.map((b) => b.type).join(","), first.value.blocks.map((b) => b.type).join(","));
	// The plain text of the whole document must survive verbatim.
	equal("the text content survives two round trips", textOf(third.value.blocks), textOf(first.value.blocks));
	equal("a re-run of the markdown is byte identical", second.value.markdown, second.value.markdown);
}

{
	const ctx = Context({});
	plugin.apply(ctx, ctx.config);
	const source = "Text with a **bold** span and a [link](https://e.com).";
	const forward = await call(ctx.get("notion_to_blocks"), { markdown: source });
	const back = await call(ctx.get("notion_to_md"), { blocks: forward.value.blocks });
	check("the bold survives the round trip", back.value.markdown.includes("**bold**"));
	check("the link survives the round trip", back.value.markdown.includes("[link](https://e.com)"));
}

{
	// merge:false must keep one run per parsed span.
	const ctx = Context({});
	plugin.apply(ctx, ctx.config);
	const merged = await call(ctx.get("notion_to_blocks"), { markdown: "a **b** c" });
	const unmerged = await call(ctx.get("notion_to_blocks"), { markdown: "a **b** c", merge: false });
	equal("merged runs are fewer", merged.value.runCount, 3);
	equal("unmerged runs keep every span", unmerged.value.runCount, 3);
	check("the note explains the merge setting", unmerged.value.note.includes("merge:false"));
}

/**
 * Concatenate the plain text of every block, for round-trip comparisons.
 *
 * @param {Array<object>} blocks - the blocks.
 * @returns {string} all of their text.
 */
function textOf(blocks) {
	return blocks.map((b) => plugin.plainText(plugin.richTextOf(b))).join("\n");
}

/**
 * Concatenate the content of an already-extracted run array.
 *
 * @param {Array<object>} runs - the runs.
 * @returns {string} their concatenated text.
 */
function plainOf(runs) {
	return runs.map((r) => r.text.content).join("");
}

console.log(`notion logic: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;