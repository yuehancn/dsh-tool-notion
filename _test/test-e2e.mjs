// End-to-end assertions for dsh-tool-notion.
//
// This suite takes one realistic page — the kind of document that actually gets
// moved between Notion and a repository — and runs it through the whole
// pipeline in both directions, checking that meaning is preserved rather than
// merely that the tools did not throw.
//
// The document is deliberately hostile to a naive converter:
//
//   · a shell code block containing `#` comments (which must not become headings)
//   · a fenced block containing a nested fence
//   · bold text containing inline code (nesting that must stack, not overwrite)
//   · a link whose label is bold (annotation and href on the same run)
//   · a nested checklist
//   · a callout
//   · text with literal asterisks that must not become italics
//
// Each of those is a place a converter silently corrupts content, which is the
// failure mode that matters: the output still looks like a document. So the
// suite asserts the *text content* survives, not just the block count.
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
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

console.log("notion: end to end");

const scratch = await mkdtemp(join(tmpdir(), "dsh-notion-e2e-"));
process.on("exit", () => {
	try {
		rm(scratch, { recursive: true, force: true });
	} catch {
		// A leftover temp directory is not a test failure.
	}
});

/**
 * The document under test. Every construct here is one a converter can get
 * wrong without the output looking wrong.
 */
const DOCUMENT = [
	"# Deploy Runbook",
	"",
	"Follow these steps **in order**. The service will be **unavailable** while you do.",
	"",
	"## Preflight",
	"",
	"- [x] announce in `#ops`",
	"- [ ] take a database snapshot",
	"  - [ ] verify the snapshot completes",
	"",
	"> [!WARNING] Do not skip the snapshot step.",
	"",
	"## Commands",
	"",
	"```bash",
	"# stop the workers first",
	"systemctl stop worker",
	"# then deploy",
	"./deploy.sh --target prod",
	"```",
	"",
	"## Notes",
	"",
	"The flag `--force` is **not** the same as `--hard`. See [the manual](https://example.com/manual).",
	"",
	"A literal asterisk looks like this: 2 * 3 * 4.",
	"",
	"---",
	""
].join("\n");

const work = join(scratch, "work");
const out = join(scratch, "out");
await mkdir(work, { recursive: true });
await writeFile(join(work, "runbook.md"), DOCUMENT, "utf8");

const context = Context({ workDir: work, outputDir: out });
plugin.apply(context, context.config);

/* ---------------------------------------------------- 1. markdown → blocks */

const forward = await call(context.get("notion_to_blocks"), {
	path: "runbook.md",
	outputName: "runbook.blocks.json"
});
check("the forward conversion succeeds", forward.error === undefined);
check("a block file was written", existsSync(join(out, "runbook.blocks.json")));

const types = forward.value.blocks.map((b) => b.type);
check("a level-1 heading is produced", types[0] === "heading_1");
check("level-2 headings are produced", types.filter((t) => t === "heading_2").length === 3);
check("checklist items are produced", types.filter((t) => t === "to_do").length === 3);
check("a callout is produced", types.includes("callout"));
check("a code block is produced", types.includes("code"));
check("a divider is produced", types.includes("divider"));

// The `#` comments inside the shell fence must be body text, not headings —
// the single most damaging failure for a technical document.
const codeBlock = forward.value.blocks.find((b) => b.type === "code");
equal("the code language is bash", codeBlock.code.language, "bash");
check("the shell comment stayed in the body", codeBlock.code.rich_text[0].text.content.includes("# stop the workers first"));
equal("no spurious heading_2 came from the comments", types.filter((t) => t === "heading_2").length, 3);

// Nested checklist item must carry its level.
const todos = forward.value.blocks.filter((b) => b.type === "to_do");
equal("the first two are top level", JSON.stringify(todos.slice(0, 2).map((b) => b.level)), JSON.stringify([undefined, undefined]));
equal("the nested one is level 1", todos[2].level, 1);

// `--force` in backticks must be a code run, not plain text. Found by content
// rather than by index, so the assertion does not depend on a magic offset.
const notesBlock = forward.value.blocks.find((b) => plugin.plainText(plugin.richTextOf(b)).includes("--force"));
check("the notes paragraph is found", notesBlock !== undefined);
const notesRuns = plugin.richTextOf(notesBlock);
check("backticked flags become code runs", notesRuns.some((r) => r.annotations?.code === true && r.text.content === "--force"));
check("the link becomes a run", notesRuns.some((r) => r.text.link?.url === "https://example.com/manual"));
check("the bold word is a bold run", notesRuns.some((r) => r.annotations?.bold === true && r.text.content === "not"));
check("the plain text is not swallowed", plugin.plainText(notesRuns).includes("is not the same as"));

// A literal asterisk must survive as text rather than becoming italics.
const asteriskBlock = forward.value.blocks.find((b) => plugin.plainText(plugin.richTextOf(b)).includes("looks like this"));
check("the asterisk line is found", asteriskBlock !== undefined);
check("the asterisks are preserved", plugin.plainText(plugin.richTextOf(asteriskBlock)).includes("2 * 3 * 4"));
check("no italic run was invented", plugin.richTextOf(asteriskBlock).every((r) => r.annotations?.italic !== true));

/* ---------------------------------------------------- 2. the file on disk */

const onDisk = JSON.parse(await readFile(join(out, "runbook.blocks.json"), "utf8"));
equal("the file is the api list shape", onDisk.object, "list");
equal("every block is in the file", onDisk.results.length, forward.value.blockCount);
check("each block is wrapped for the api", onDisk.results.every((b) => b.object === "block" && typeof b.type === "string"));

/* ---------------------------------------------------- 3. the plugin's own output validates */

// Validated through `blocks` rather than `path`, because `path` resolves
// against workDir — the absolute output path is not readable that way, by
// design, so a caller cannot use reads to walk outside the configured root.
const selfCheck = await call(context.get("notion_validate"), { blocks: onDisk.results });
check("the validator accepts the plugin's own output", selfCheck.error === undefined);
equal("the plugin's output has no errors", selfCheck.value.errorCount, 0);
equal("every block was checked", selfCheck.value.checked, forward.value.blockCount);

/* ---------------------------------------------------- 4. blocks → markdown */

const backward = await call(context.get("notion_to_md"), {
	blocks: onDisk.results,
	outputName: "runbook.back.md"
});
check("the reverse conversion succeeds", backward.error === undefined);
const restored = await readFile(join(out, "runbook.back.md"), "utf8");

check("the title survives", restored.includes("# Deploy Runbook"));
check("the bold text survives", restored.includes("**in order**"));
check("the code fence and language survive", restored.includes("```bash"));
check("the shell comments survive", restored.includes("# stop the workers first"));
check("the checklist survives", restored.includes("- [x] announce in"));
check("the nested checklist item is indented", restored.includes("  - [ ] verify the snapshot"));
check("the callout survives", restored.includes("[!WARNING]"));
check("the quote marker survives", restored.includes("> [!WARNING]"));
check("the link survives", restored.includes("[the manual](https://example.com/manual)"));
check("the inline code survives", restored.includes("`--force`"));
check("the literal asterisks survive", restored.includes("2 * 3 * 4"));
check("the divider survives", restored.includes("---"));
check("the deploy command survives", restored.includes("./deploy.sh --target prod"));

/* ---------------------------------------------------- 5. round-trip stability */

// The strongest available check: parse the restored Markdown and confirm the
// block sequence is unchanged. Without this, "the text is there" could still
// hide a structural drift that changes meaning.
const again = await call(context.get("notion_to_blocks"), { markdown: restored });
equal("the block count is stable", again.value.blockCount, forward.value.blockCount);
equal("the type sequence is stable", again.value.blocks.map((b) => b.type).join(","), types.join(","));

// And the plain text of the whole document must be identical after two passes.
const before = forward.value.blocks.map((b) => plugin.plainText(plugin.richTextOf(b))).join("\n");
const after = again.value.blocks.map((b) => plugin.plainText(plugin.richTextOf(b))).join("\n");
equal("the full text round trips unchanged", after, before);

// Converting a third time must be byte identical, proving convergence.
const third = await call(context.get("notion_to_md"), { blocks: again.value.blocks });
equal("the output has converged", third.value.markdown, backward.value.markdown);

/* ---------------------------------------------------- 6. losses are reported, not hidden */

{
	// A document using constructs with no Markdown equivalent must say so.
	const exotic = [
		block("paragraph", [run("kept")]),
		{ object: "block", type: "toggle", toggle: { rich_text: [run("nested content")] } },
		{ object: "block", type: "table_of_contents", table_of_contents: {} },
		{ object: "block", type: "column_list", column_list: {} }
	];
	const { value } = await call(context.get("notion_to_md"), { blocks: exotic });
	equal("every unsupported block is reported", value.losses.length, 3);
	check("the toggle is named", value.losses.some((l) => l.includes("toggle")));
	check("the column list is named", value.losses.some((l) => l.includes("column_list")));
	check("the known block still renders", value.markdown.includes("kept"));
	check("the note warns the round trip will differ", value.note.includes("round trip"));
}

/* ---------------------------------------------------- 7. finding a real mistake */

{
	// A hand-written payload with the classic error: rich_text as a string.
	const broken = [{ type: "paragraph", paragraph: { rich_text: "I am a string, not an array" } }];
	const found = await call(context.get("notion_validate"), { blocks: broken });
	equal("the mistake is caught", found.value.ok, false);
	equal("it is classified as an error", found.value.errorCount, 1);
	check("the message teaches the right shape", found.value.problems[0].message.includes("rich_text ARRAY"));

	// And the converter must cope with it rather than crashing, since a caller
	// will validate first but not always.
	const tolerant = await call(context.get("notion_to_md"), { blocks: broken });
	check("the converter does not crash on bad input", tolerant.error === undefined);
	equal("it renders nothing for the bad block", tolerant.value.markdown.trim(), "");
}

/* ---------------------------------------------------- 8. deterministic */

{
	// Two independent runs over the same document must agree byte for byte.
	const second = Context({ workDir: work, outputDir: join(scratch, "out2") });
	plugin.apply(second, second.config);
	const rerun = await call(second.get("notion_to_blocks"), { path: "runbook.md" });
	equal("an independent run produces identical blocks", JSON.stringify(rerun.value.blocks), JSON.stringify(forward.value.blocks));
}

console.log(`notion end to end: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;