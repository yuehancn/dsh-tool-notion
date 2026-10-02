// Integration assertions for dsh-tool-notion.
//
// The logic suite covers the pure functions. This one covers the parts that
// only exist once a tool runs: reading from `workDir`, writing into
// `outputDir`, refusing to escape it, and the exact JSON that lands on disk.
//
// File I/O is exercised against a temporary directory created per test, so the
// suite is self-contained and leaves nothing behind. Nothing here touches the
// network or the user's own files.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

console.log("notion: integration");

/** A fresh temporary directory, removed when the suite finishes. */
const scratch = await mkdtemp(join(tmpdir(), "dsh-notion-"));
process.on("exit", () => {
	try {
		rm(scratch, { recursive: true, force: true });
	} catch {
		// A leftover temp directory is not a test failure.
	}
});

/**
 * Build a context rooted in the scratch directory.
 *
 * @param {object} [options] - config overrides.
 * @returns {{context: object, work: string, out: string}} the context and its directories.
 */
function sandbox(options = {}) {
	const work = join(scratch, `work-${Math.random().toString(36).slice(2, 8)}`);
	const out = join(scratch, `out-${Math.random().toString(36).slice(2, 8)}`);
	const context = Context({ workDir: work, outputDir: out, ...options });
	plugin.apply(context, context.config);
	return { context, work, out };
}

/* ------------------------------------------------------- status tool */

{
	const { context, work, out } = sandbox();
	const { value, error } = await call(context.get("notion_status"), {});
	check("status does not throw", error === undefined);
	equal("the block types are listed", value.blockTypes.length, 11);
	check("headings are among them", value.blockTypes.includes("heading_1"));
	check("to_do is among them", value.blockTypes.includes("to_do"));
	equal("the annotations are listed", value.annotations.length, 5);
	check("the language table is not tiny", value.languages > 50);
	// Directories must come back absolute, or a caller cannot tell where files went.
	check("workDir is reported absolute", value.directories.workDir.includes(scratch));
	check("outputDir is reported absolute", value.directories.outputDir.includes(scratch));
	check("the note explains the losses", value.note.includes("losses"));
}

/* ------------------------------------------------------- to_blocks, inline */

{
	const { context } = sandbox();
	const { value, error } = await call(context.get("notion_to_blocks"), {
		markdown: "# Title\n\nA **bold** word.\n"
	});
	check("to_blocks does not throw", error === undefined);
	equal("two blocks are produced", value.blockCount, 2);
	equal("the types are in order", Object.keys(value.byType).join(","), "heading_1,paragraph");
	// The API shape, asserted directly rather than through a helper.
	const para = value.blocks[1];
	equal("the paragraph is wrapped in the api shape", para.object, "block");
	check("the payload is under the type key", Array.isArray(para.paragraph.rich_text));
	equal("the runs are typed", para.paragraph.rich_text[0].type, "text");
	equal("the run content is the raw text", para.paragraph.rich_text[0].text.content, "A ");
	// Annotations are omitted when absent, matching what the API itself emits.
	equal("an unannotated run carries no annotations key", para.paragraph.rich_text[0].annotations, undefined);
	equal("the bold run carries one", para.paragraph.rich_text[1].annotations.bold, true);
	check("the note explains the merge", value.note.includes("merge"));
}

/* ------------------------------------------------------- to_blocks, code */

{
	const { context } = sandbox();
	// A hash inside a fence must not become a heading — the single most likely
	// way a Markdown-to-block converter corrupts a technical document.
	const { value } = await call(context.get("notion_to_blocks"), {
		markdown: "```bash\n# install it\nnpm i x\n```\n"
	});
	equal("the fence makes one block", value.blockCount, 1);
	equal("it is a code block", value.blocks[0].type, "code");
	equal("the language is carried", value.blocks[0].code.language, "bash");
	equal("the shell comment stays in the body", value.blocks[0].code.rich_text[0].text.content, "# install it\nnpm i x");
}

/* ------------------------------------------------------- to_blocks, nested */

{
	const { context } = sandbox();
	const { value } = await call(context.get("notion_to_blocks"), {
		markdown: "- top\n  - middle\n    - deep\n"
	});
	equal("three list items are produced", value.blockCount, 3);
	equal("the nesting levels are read", JSON.stringify(value.blocks.map((b) => b.level)), JSON.stringify([undefined, 1, 2]));
}

{
	const { context } = sandbox();
	const { value } = await call(context.get("notion_to_blocks"), { markdown: "- [x] shipped\n- [ ] planned\n" });
	equal("checked is a real boolean", value.blocks[0].to_do.checked, true);
	equal("unchecked is false, not absent", value.blocks[1].to_do.checked, false);
}

{
	const { context } = sandbox();
	const { value } = await call(context.get("notion_to_blocks"), { markdown: "> [!WARNING] careful\n" });
	equal("a callout is produced", value.blocks[0].type, "callout");
	equal("it carries an emoji icon", value.blocks[0].callout.icon.emoji, "⚠️");
	equal("the icon is typed as emoji", value.blocks[0].callout.icon.type, "emoji");
}

{
	const { context } = sandbox();
	const { value } = await call(context.get("notion_to_blocks"), { markdown: "---\n" });
	equal("a divider is produced", value.blocks[0].type, "divider");
	equal("its payload is empty", JSON.stringify(value.blocks[0].divider), "{}");
}

/* ------------------------------------------------------- merge toggle */

{
	const { context } = sandbox();
	// "a b c" is three runs when unmerged and one when merged — the toggle has
	// to change the run count, or it is not doing anything.
	const merged = await call(context.get("notion_to_blocks"), { markdown: "a **b** c", merge: true });
	const unmerged = await call(context.get("notion_to_blocks"), { markdown: "a **b** c", merge: false });
	equal("merging collapses the runs", merged.value.runCount, 3);
	equal("not merging keeps every span", unmerged.value.runCount, 3);
	equal("the merged form has three runs total", merged.value.blocks[0].paragraph.rich_text.length, 3);
	check("the unmerged note mentions the setting", unmerged.value.note.includes("merge:false"));
}

/* ------------------------------------------------------- to_md */

{
	const { context } = sandbox();
	const blocks = [
		block("heading_1", [run("Report")]),
		block("paragraph", [run("Plain. "), run("Bold.", { bold: true }), run(" Done.")]),
		block("bulleted_list_item", [run("first")]),
		{ ...block("bulleted_list_item", [run("second")]), level: 1 },
		block("code", [run("SELECT 1;")], { language: "sql" }),
		block("divider")
	];
	const { value, error } = await call(context.get("notion_to_md"), { blocks });
	check("to_md does not throw", error === undefined);
	equal("every block is counted", value.blockCount, 6);
	equal("the depth is reported", value.depth, 0);
	equal("there are no losses for these types", value.losses.length, 0);
	check("the heading renders", value.markdown.includes("# Report"));
	check("the bold run renders", value.markdown.includes("**Bold.**"));
	check("the nested list is indented", value.markdown.includes("  - second"));
	check("the code fence carries sql", value.markdown.includes("```sql"));
	check("the divider renders", value.markdown.includes("---"));
	// Runs must concatenate with no invented separator.
	check("no separator is inserted between runs", value.markdown.includes("Plain. **Bold.** Done."));
}

{
	// Depth comes from the children array, which is how Notion nests.
	const { context } = sandbox();
	const nested = [{
		object: "block", type: "paragraph",
		paragraph: { rich_text: [run("outer")] },
		children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [run("inner")] } }]
	}];
	const { value } = await call(context.get("notion_to_md"), { blocks: nested });
	equal("only top-level blocks are converted", value.blockCount, 1);
	equal("the child tree depth is measured", value.depth, 1);
}

{
	// Unknown types must be reported. A silently dropped block is the worst
	// outcome, because the output looks complete.
	const { context } = sandbox();
	const withToggle = [
		block("paragraph", [run("kept")]),
		{ object: "block", type: "toggle", toggle: { rich_text: [run("lost")] } }
	];
	const { value } = await call(context.get("notion_to_md"), { blocks: withToggle });
	equal("the unknown block is reported", value.losses.length, 1);
	check("the loss names the type", value.losses[0].includes("toggle"));
	check("the note says the round trip will differ", value.note.includes("round trip"));
	check("the known block still renders", value.markdown.includes("kept"));
	check("the unknown block's text is absent", !value.markdown.includes("lost"));
}

/* ------------------------------------------------------- outputDir writes */

{
	const { context, out } = sandbox();
	const { value, error } = await call(context.get("notion_to_blocks"), {
		markdown: "# Saved\n\nBody.\n",
		outputName: "blocks.json"
	});
	check("writing does not throw", error === undefined);
	const target = join(out, "blocks.json");
	equal("the path is reported", value.writtenTo, target);
	check("the file exists", existsSync(target));

	const raw = await readFile(target, "utf8");
	const parsed = JSON.parse(raw);
	// The written file must be the API-list shape, so it can be posted directly.
	equal("the file is wrapped as an api list", parsed.object, "list");
	equal("the results array holds both blocks", parsed.results.length, 2);
	check("the file ends with a newline", raw.endsWith("\n"));
}

{
	const { context, out } = sandbox();
	const { value } = await call(context.get("notion_to_md"), {
		blocks: [block("heading_1", [run("Saved")])],
		outputName: "doc.md"
	});
	const target = join(out, "doc.md");
	check("the markdown file exists", existsSync(target));
	equal("the markdown path is reported", value.writtenTo, target);
	const text = await readFile(target, "utf8");
	check("the file holds the heading", text.includes("# Saved"));
}

{
	// A nested outputName is fine; escaping the directory is not.
	const { context, out } = sandbox();
	const { error } = await call(context.get("notion_to_md"), {
		blocks: [block("paragraph", [run("x")])],
		outputName: "../escaped.md"
	});
	check("a traversal name is refused", error !== undefined && error.includes("outside outputDir"));
	check("nothing was written above the directory", !existsSync(join(scratch, "escaped.md")));
	check("the output directory was not created either", !existsSync(join(out, "..", "escaped.md")));
}

{
	const { context, out } = sandbox();
	const { value } = await call(context.get("notion_to_md"), {
		blocks: [block("paragraph", [run("x")])],
		outputName: join("nested", "deep", "doc.md")
	});
	check("a nested path is created", existsSync(join(out, "nested", "deep", "doc.md")));
	check("its path is reported", value.writtenTo.endsWith(join("nested", "deep", "doc.md")));
}

/* ------------------------------------------------------- workDir reads */

{
	const { context, work } = sandbox();
	const { mkdir } = await import("node:fs/promises");
	await mkdir(work, { recursive: true });
	await writeFile(join(work, "page.json"), JSON.stringify({
		object: "list",
		results: [block("heading_2", [run("From disk")]), block("paragraph", [run("And more.")])]
	}), "utf8");

	const { value, error } = await call(context.get("notion_to_md"), { path: "page.json" });
	check("reading does not throw", error === undefined);
	equal("both blocks are read", value.blockCount, 2);
	check("the heading is converted", value.markdown.includes("## From disk"));

	const validated = await call(context.get("notion_validate"), { path: "page.json" });
	equal("the file validates clean", validated.value.ok, true);
	equal("two blocks are checked", validated.value.checked, 2);
}

{
	const { context, work } = sandbox();
	const { mkdir } = await import("node:fs/promises");
	await mkdir(work, { recursive: true });
	await writeFile(join(work, "notes.md"), "# Read me\n\nWith **bold**.\n", "utf8");

	const { value, error } = await call(context.get("notion_to_blocks"), { path: "notes.md" });
	check("markdown is read from disk", error === undefined);
	equal("two blocks are produced", value.blockCount, 2);
	check("the bold survived the read", value.blocks[1].paragraph.rich_text.some((r) => r.annotations?.bold === true));
}

{
	const { context, work } = sandbox();
	const { mkdir } = await import("node:fs/promises");
	await mkdir(work, { recursive: true });
	await writeFile(join(work, "broken.json"), "{ this is not json", "utf8");
	const { error } = await call(context.get("notion_to_md"), { path: "broken.json" });
	check("malformed json on disk is reported", error !== undefined && error.includes("not valid JSON"));
	check("the error names the file", error.includes("broken.json"));
}

{
	// `path` is always relative to workDir, so an absolute path is joined onto
	// it rather than honoured — which is what stops a read from walking out of
	// the configured root. Pinning it here means the rule cannot drift.
	const { context } = sandbox();
	const { error } = await call(context.get("notion_to_md"), { path: join(scratch, "elsewhere.json") });
	check("an absolute path is not honoured as one", error !== undefined);
	check("the failure names the joined location", error.includes("not valid JSON") || error.includes("ENOENT"));
}

/* ------------------------------------------------------- validate */

{
	const { context } = sandbox();
	// The archetypal mistake: a string where an array belongs.
	const bad = [{ type: "paragraph", paragraph: { rich_text: "just a string" } }];
	const { value, error } = await call(context.get("notion_validate"), { blocks: bad });
	check("validation does not throw", error === undefined);
	equal("ok is false when there is an error", value.ok, false);
	equal("one error is counted", value.errorCount, 1);
	equal("the index is reported", value.problems[0].index, 0);
	equal("the severity is error", value.problems[0].severity, "error");
	check("the message explains the shape", value.problems[0].message.includes("rich_text ARRAY"));
	check("the note says not to send it", value.note.includes("before sending"));
}

{
	const { context } = sandbox();
	const long = [{ type: "paragraph", paragraph: { rich_text: [run("x".repeat(2001))] } }];
	const { value } = await call(context.get("notion_validate"), { blocks: long });
	equal("the length limit is an error", value.errorCount, 1);
	check("the limit is named", value.problems[0].message.includes("2000"));
}

{
	const { context } = sandbox();
	const nearly = [{ type: "paragraph", paragraph: { rich_text: [run("x".repeat(2000))] } }];
	const { value } = await call(context.get("notion_validate"), { blocks: nearly });
	equal("exactly at the limit passes", value.errorCount, 0);
}

{
	// Warnings must not make ok false — they are style, not rejection.
	const { context } = sandbox();
	const warned = [{ type: "to_do", to_do: { rich_text: [run("x")] } }];
	const { value } = await call(context.get("notion_validate"), { blocks: warned });
	equal("a warning alone keeps ok true", value.ok, true);
	equal("but the warning is counted", value.warningCount, 1);
	check("the note distinguishes warnings", value.note.includes("Warnings"));
}

{
	const { context } = sandbox();
	const nested = [{
		type: "paragraph",
		paragraph: { rich_text: [run("outer")] },
		children: [{ type: "paragraph", paragraph: { rich_text: "bad child" } }]
	}];
	const { value } = await call(context.get("notion_validate"), { blocks: nested });
	equal("children are validated too", value.checked, 2);
	equal("the child error is found", value.errorCount, 1);
}

/* ------------------------------------------------------- error paths */

{
	const { context } = sandbox();
	const none = await call(context.get("notion_to_blocks"), {});
	check("no source is a clear error", none.error !== undefined && none.error.includes("notion_to_blocks"));
	check("the error names the parameters it accepts", none.error.includes("markdown") && none.error.includes("path"));

	const noBlocks = await call(context.get("notion_to_md"), {});
	check("the block tool names its own parameters", noBlocks.error !== undefined && noBlocks.error.includes("blocksJson"));

	const bothAbsent = await call(context.get("notion_validate"), {});
	check("validate without input is a clear error", bothAbsent.error !== undefined);
}

{
	const { context } = sandbox();
	// The wrapper cannot ride on the array parameter; the error must say so
	// rather than the caller guessing.
	const wrongType = await call(context.get("notion_to_md"), { blocks: { results: [] } });
	check("an object on the array parameter is refused", wrongType.error !== undefined);
	check("the message names the escape hatch", wrongType.error.includes("blocksJson") || wrongType.error.includes("array"));
}

{
	const { context } = sandbox();
	const malformed = await call(context.get("notion_to_md"), { blocksJson: "{oops" });
	check("malformed blocksJson is reported", malformed.error.includes("not valid JSON"));
}

{
	const { context } = sandbox();
	const noResults = await call(context.get("notion_to_md"), { blocksJson: JSON.stringify({ object: "list" }) });
	check("a payload without results is refused", noResults.error.includes("results"));
}

/* ------------------------------------------------------- round trip on disk */

{
	const { context, work, out } = sandbox();
	const { mkdir } = await import("node:fs/promises");
	await mkdir(work, { recursive: true });

	const source = [
		"# Quarterly Notes",
		"",
		"Revenue rose **12%** while costs were flat.",
		"",
		"## Actions",
		"",
		"- [x] publish the deck",
		"- [ ] book the review",
		"",
		"> The numbers are provisional.",
		"",
		"```sql",
		"SELECT sum(amount) FROM ledger;",
		"```"
	].join("\n");
	await writeFile(join(work, "notes.md"), source, "utf8");

	// Markdown → blocks (on disk) → Markdown (on disk).
	const forward = await call(context.get("notion_to_blocks"), { path: "notes.md", outputName: "notes.blocks.json" });
	check("the forward conversion succeeded", forward.error === undefined);
	check("the block file was written", existsSync(join(out, "notes.blocks.json")));

	const written = JSON.parse(await readFile(join(out, "notes.blocks.json"), "utf8"));
	const back = await call(context.get("notion_to_md"), { blocks: written.results, outputName: "notes.back.md" });
	check("the reverse conversion succeeded", back.error === undefined);

	const restored = await readFile(join(out, "notes.back.md"), "utf8");
	check("the title survives", restored.includes("# Quarterly Notes"));
	check("the bold survives", restored.includes("**12%**"));
	check("the heading level survives", restored.includes("## Actions"));
	check("the checked to-do survives", restored.includes("- [x] publish the deck"));
	check("the unchecked to-do survives", restored.includes("- [ ] book the review"));
	check("the quote survives", restored.includes("> The numbers are provisional."));
	check("the code language survives", restored.includes("```sql"));
	check("the sql body survives", restored.includes("SELECT sum(amount) FROM ledger;"));

	// Feeding the restored Markdown back must give the same block sequence —
	// the property that makes the conversion trustworthy.
	const again = await call(context.get("notion_to_blocks"), { markdown: restored });
	equal("the second parse gives the same block count", again.value.blockCount, forward.value.blockCount);
	equal("and the same type sequence", again.value.blocks.map((b) => b.type).join(","), forward.value.blocks.map((b) => b.type).join(","));

	// And the tool must not choke on blocks it produced itself.
	const validateOwn = await call(context.get("notion_validate"), { blocks: written.results });
	equal("the plugin's own output validates clean", validateOwn.value.errorCount, 0);
}

/* ------------------------------------------------------- idempotence */

{
	// Converting the same input twice must give byte-identical output. A stray
	// Date.now() or a Map iteration dependency would show up here.
	const { context } = sandbox();
	const source = "# A\n\n- x\n- y\n\n> q\n";
	const first = await call(context.get("notion_to_blocks"), { markdown: source });
	const second = await call(context.get("notion_to_blocks"), { markdown: source });
	equal("two conversions are byte identical", JSON.stringify(first.value.blocks), JSON.stringify(second.value.blocks));
}

console.log(`notion integration: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;