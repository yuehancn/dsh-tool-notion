# dsh-tool-notion

Notion 区块与 Markdown 的双向转换插件，给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用。

**没有 API 客户端，没有外部依赖。** 你从 Notion 导出（或从 API 拿到）一份区块数组，它转成 Markdown；你有一份 Markdown，它转成可以直接回写的区块数组。中间不做网络请求 —— 所以它能离线跑、能进测试、也不会因为一个 token 过期就整个失败。

```
notion_to_md      blocks  →  Markdown
notion_to_blocks  Markdown →  blocks
notion_validate   两边都收，报出结构问题
notion_status     先说清楚哪些块类型它认得
```

---

## 为什么要单独做这个

看起来是「数组 ↔ 字符串」，写起来才知道反了。

**Notion 的段落是一组富文本 run，Markdown 的段落是一个字符串。**

```
Notion:  [ {content:"Hello ",annotations:{}}, {content:"world",annotations:{bold:true}} ]
Markdown: "Hello **world**"
```

一个段落能有任意多个 run，每个 run 带自己的 `bold` / `italic` / `strikethrough` / `underline` / `code`，还能各带各的链接。要变成一行文本，就得在**每一个注解边界**切开插标记；要从一行文本变回去，就得**把相邻的、注解相同的 run 合并**才能得到 Notion 原本想要的形状。

**这两个方向不是互逆操作。** 一个是切分，一个是合并。这就是本插件里代码量的主要来源，也是测试里绝大多数断言在盯的地方。

---

## 安装

```yaml
# cordis.patch.yml
plugins:
  dsh-tool-notion:
    workDir: "."
    outputDir: "notion-output"
```

```bash
dsh plugin add dsh-tool-notion
```

---

## 工具

### `notion_status`

在转换之前先问它。它返回：

- **`toMarkdown`** —— 能转成 Markdown 的块类型列表和它们的标记
- **`toBlocks`** —— 能转回区块的 Markdown 构造
- **`annotations`** —— 认识哪五个注解键
- **`callouts`** —— 五种 callout 标签 ↔ emoji 的对应表
- **`directories`** —— `workDir` / `outputDir` 的绝对路径

先看这个，就能把「不支持的块类型」变成一条已知边界，而不是转换到一半发现丢了东西。

### `notion_to_md`

收一份区块数组，产出 Notion 风格的 Markdown。

```js
// 参数（三选一）
{ blocks:        [ … ] }        // 区块数组本身
{ blocksJson:    "[…]" }        // 原始 API 响应（字符串），内部 JSON.parse
{ results: { … } }              // 带 results 的 API 包装对象，会自动认出来
```

**为什么要有 `blocksJson`：** `defineTool` 会在 `execute` 跑之前就校验参数类型，所以 `blocks` 这个参数只能收数组。而 Notion API 返回的是一个带 `results` 的对象。把对象塞进 `blocks` 会在**你还没机会处理之前**就被框架拒掉（`invalid arguments: "blocks" must be an array`）。所以留了一个字符串入口，让原始响应能原样递进来。

输出会在遇到无法表示的结构时**显式报告**，而不是默默吞掉。

### `notion_to_blocks`

收 Markdown，产出区块数组。

```js
{ markdown: "# Title\n\nSome **bold** text." }
{ path: "notes/export.md" }        // 相对路径，按 workDir 解析
```

产出的数组可以直接喂给 Notion 的 append 接口。

### `notion_validate`

不转换，只检查。收 `blocks` / `blocksJson`，报出：

- 区块数组的结构错误（缺 `type`、payload 形状不对）
- 不认识的块类型
- 空 run、缺 `content` 的 run
- callout 标签无法回读的情况

**要判断的是「这份数据能不能安全往返」，不是「这份数据合不合法」。** 所以它盯的是会静默丢信息的地方。

---

## 五个注解，和有顺序的标记

`annotations` 有五个键：`bold` `italic` `strikethrough` `underline` `code`。

写标记的时候**顺序是定死的**，因为顺序变了意思就变了：

| 场景 | 写法 | 为什么 |
|---|---|---|
| 粗体 + 斜体 | `***x***` | 不是 `**__x__`，粗体在外、斜体在内 |
| 行内代码 | 最内层 | 反引号会**压制**其他所有标记，所以代码必须包在最里面 |
| 删除线 | `~~x~~` | |

`INLINE_MARKERS` 表是按**从长到短**扫的（`***` 先于 `*`，`___` 先于 `_`），否则 `***x***` 会被解析成三个独立的 `*`。

**反斜杠奇偶性决定标记是不是活的** —— 这是行内扫描里最容易写错的一条：

```
"a \** b** c"    → 7 个字符：反斜杠转义了 *，标记没生效
"a \\** b** c"   → 4 个字符：反斜杠自己被转义，标记是活的
```

同一个形状，一个反斜杠之差，结果完全不同。测试里两种情况都钉了。

**反引号要加宽围栏**：如果内容里本身有反引号，外面的围栏就得比里面长。行内代码和围栏代码块都是这个规则。

---

## Callout 的标签 ↔ emoji 必须是双射

这是开发过程中测试**自己抓出来的一个真 bug**，值得单独说。

Markdown 写 callout 用的是**语义标签**：

```markdown
> [!WARNING]
> 这会删库。
```

Notion 存 callout 用的是**图标 emoji**。所以中间要做一次映射。第一版写了单向映射：解析时把 `WARNING` 存进 `icon`，回写时又把 emoji 写进 `icon`，再读回来时期待看到标签 —— 结果**每一个 `[!WARNING]` 都变成了 `[!NOTE]`**。

一个警告被静默降级成了提示。这种 bug 不会报错、不会崩，只会在某天有人因为没看到警告而删了库。

修法是把它做成**真正的双射**：

```js
const CALLOUT_EMOJI = { NOTE: "📘", TIP: "💡", IMPORTANT: "❗", WARNING: "⚠️", CAUTION: "🛑" };
const EMOJI_CALLOUT = Object.fromEntries(
  Object.entries(CALLOUT_EMOJI).map(([label, emoji]) => [emoji, label])
);

function calloutLabel(payload) {          // 读：emoji → 标签
  const icon = payload?.icon;
  const emoji = typeof icon === "string" ? icon : icon?.emoji;
  if (emoji === undefined) return "NOTE";
  return EMOJI_CALLOUT[emoji] ?? "NOTE";  // 不认识的 emoji 退回 NOTE，不是丢 callout
}
```

五个标签全部在测试里钉了往返。另外还钉了两种输入形状：`icon` 是裸字符串、`icon` 是 `{ type:"emoji", emoji }` 对象 —— Notion 两种都会返回。

**通用的教训：凡是「语义值 ↔ 表示值」的映射，都要有反向表和反向断言。单向映射静静吃掉信息的方式是无声的。**

---

## `parseNotionId` 要认带 slug 的 URL

Notion 分享链接把 id **粘在人类可读的 slug 后面**：

```
https://www.notion.so/My-Page-1f2e3d4c5b6a7c8d9e0f1a2b3c4d5e6f
                         ^^^^^^^ 这一段不是 hex
```

所以不能拿最后一段去匹配 `^[0-9a-f]{32}$` —— 会返回 `null`。正确做法是**先剥掉 query 和 hash，再在整串里找 32 位 hex**（或者带连字符的标准 UUID 形式）：

```js
const withoutQuery = text.split(/[?#]/u)[0];
const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu
  .exec(withoutQuery);
```

---

## 一个被测试逼出来的框架规则

`defineTool` 的 JSON schema 里，**每一个嵌套的 `{ type: "object" }` 都必须显式声明 `additionalProperties`** —— 固定形状写 `false`，自由映射写 `true`。不写就抛：

```
JsonSchemaError: … additionalProperties must be explicitly true or false
```

这个坑在本插件里踩了三次：嵌套的 `directories` 对象、`blocks` 数组的 `items`、以及 `byType` 这种自由映射。三次都是同一个错误，只是位置不同。**数组的 `items` 也算嵌套对象，也要声明。**

---

## 测试

```bash
node _test/run-all.mjs
```

三个套件跑在各自独立的子进程里 —— 每个套件都会用 `new Function` 重建一份插件副本，同进程会互相污染模块缓存。

```
notion logic:        230 passed, 0 failed
notion integration:  117 passed, 0 failed
notion end to end:    56 passed, 0 failed
```

**共 403 条断言。**

三个套件的分工：

- **`test-logic.mjs`（230）** —— 纯函数白盒。行内扫描（含反斜杠奇偶性）、run 合并、注解边界切分、围栏加宽、callout 双射、缩进层级、块校验。
- **`test-integration.mjs`（117）** —— 通过 `defineTool` 注册后的真实工具调用。参数 schema 形状（`required` 被提到顶层、`parameters.properties` 才是子项）、注册开关、错误信息、`workDir` 解析规则。
- **`test-e2e.mjs`（56）** —— 一份故意难伺候的 "Deploy Runbook" 文档，从 Markdown 一路走到区块再走回来。里面塞了：带 `#` 注释的 shell 围栏、嵌套围栏、含代码的粗体、粗体链接、嵌套清单、callout、字面星号。

### 一条钉住的路径规则

`path` 参数**按 `workDir` 解析** —— 绝对路径会被**拼到 workDir 后面**，而不是被当成绝对路径使用。这不是 bug，这正是「读不到配置根目录之外」的保证。集成测试里有一条断言专门钉这个行为，免得以后有人「顺手修好」它。

### 白盒断言的代价与收益

测试通过 `new Function` 把插件的内部函数（`parseInline`、`mergeRuns`、`calloutLabel` …）取出来直接断言。代价是 harness 要维护一份 `INTERNALS` 清单，漏一个就是 `plugin.X is not a function`。收益是**不用为了测一个纯函数去套一层 JSON 管道** —— 上面那个 callout bug 就是这么被抓到的。

---

## 目录

```
dsh-tool-notion/
├── lib/index.js               插件本体（4 个工具 + 全部转换逻辑）
├── cordis.patch.yml           插件加载配置
├── _test/
│   ├── harness.mjs            用真实 dsh-tools 重建 apply，并暴露内部函数
│   ├── test-logic.mjs         230 条
│   ├── test-integration.mjs   117 条
│   ├── test-e2e.mjs            56 条
│   └── run-all.mjs            三个套件各自跑在子进程
├── LICENSE                    MIT
└── README.md
```

---

## License

MIT © yuehancn

---

*本插件属于 DeepSeek Harness 工具插件系列。同一系列还有 `dsh-tool-comfyui`、`dsh-tool-gzh-publisher`、`dsh-tool-ocr`、`dsh-tool-media`、`dsh-tool-subtitle`、`dsh-tool-invoice`、`dsh-tool-qrcode`、`dsh-tool-epub`、`dsh-tool-podcast`、`dsh-tool-mining`。*