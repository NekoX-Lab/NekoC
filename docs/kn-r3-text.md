# KN 文本与数字边界（r3-kntext）

## 范围和结论

本次使用匿名官方编辑器 0.27.4 的**未修改域函数**实测 718 条调用；另外用原创完整工程确认 null/undefined 的输入归一化和嵌套拼接。证据分别是 [kn-r3-text-evidence.json](kn-r3-text-evidence.json) 和 [kn-r3-text-playback.json](kn-r3-text-playback.json)。后者同时绑定编辑器兼容检查的夹具 SHA-256，`ok: true`。不参考或移植 HateNeko。

- **数字格式**：数字转文本是 `String(number)`，不固定小数位，不做 UI 式截断。`1.23` → `"1.23"`，`0.1 + 0.2` → `"0.30000000000000004"`；`-0` → `"0"`；NaN、正负 Infinity 分别为 `"NaN"`、`"Infinity"`、`"-Infinity"`。绝对值在 `[1e-6, 1e21)` 用普通十进制，外侧用小写 `e`，正指数有 `+`。覆盖阈值前一/后一可表示浮点数、正负值、最小次正规数、最大有限值和安全整数附近。现有 `ryu-js` 在这组边界上已一致，无需修改数字格式器。
- **文本比较**：六种比较符均区分大小写，无 locale 排序和 Unicode 规范化。两个文本按 UTF-16 码元排序，不是 UTF-8 字节序；例如 `"😀" < "\uE000"` 为 true。数字文本与文本比较按字典序，和数字混合做数值关系比较；相等仍区分类型。官方 numeric NaN 与 numeric NaN 的 `EQ` 为 true、`NEQ` 为 false（不是 JS `===`）；列表搜索仍保留 strict equality，未修改。
- **包含判断**：区分大小写；null、undefined、numeric NaN 在任一侧直接为 false，不能先把 undefined 转为 `"undefined"` 再搜索。
- **拼接**：文本原始拼写和大小写不变；数值用上述格式。每个 join 独立在首个 undefined 停止拼接；外层不得把嵌套 join 展平，否则丢失截断边界。官方在域调用前将 null 报告值归一化为 undefined，因此原生 `join("a", JSON.parse("null"), "b")` 是 `"a"`，并非直接域函数拿到原始 null 时的 `"anullb"`。新增 Rust 回归明确区分这两种证据；此处不改通用 Cell::text 的 null 显示。
- **大小写 API**：官方注册 `String.toLowerCase` / `String.toUpperCase`，参数名为 `CONSTRUCTOR`；这是代码 API，不声称存在同名可见面板积木。规则是 `String(CONSTRUCTOR ?? "")` 后调用非 locale 的 Unicode 大小写映射。新增独立 `src/engine/kn_text.rs`，复用已有 KN String 转换，支持省略参数、null/undefined、数字、布尔、列表，以及 `ß` → `SS`、`İ` → `i̇`、连字展开和希腊末尾 sigma。未增加或虚构 TS 前端 API。

## 官方源码定位

证据中的 bundle URL、完整 SHA-256、字节偏移、定点摘录哈希可复核。官方源码/摘录只放忽略的 `dist/r3-kntext-official/`，不入库。

| bundle | 字节偏移（从 0 开始） | 定位 |
| --- | ---: | --- |
| `main.bfc86683.js` | 1633709 | `convertType,(function`：string 分支返回 String(s) |
| `main.bfc86683.js` | 1633566 | `textLength,(function`：toString().length |
| `main.bfc86683.js` | 1633025 | `textContain,(function`：nullish/NaN 拒绝及 includes |
| `main.bfc86683.js` | 2972283 / 2972394 | `String.toLowerCase` / `String.toUpperCase` |
| `crc_libs.a21338b6.js` | 819970 | EQ/NEQ 走 equality helper，关系比较直接用 JS 运算符 |
| `crc_libs.a21338b6.js` | 822175 | text_join：连续 ADD 输入，undefined 终止，逐项字符串化 |

完整工程播放另外确认 `nanEq=true`、`nanNe=false`、`unicode=true`、`joinStop="a"`、`joinNested="abc"`、`joinNull="a"`。这避免把仅由源代码或直接域调用推得的 null 行为误当作完整工程行为。

## 回归和复现

KN 原生相等与 TS 数值相等需要分开：TS 的两个静态 number 操作数先按从左到右各求值一次，保存到调用局部参数，再以 `a <= b && a >= b` 实现相等（不等取反）。这样 NaN 不等于自身，Infinity 和正负零保持 JS 数值语义，而不改变原生 KN EQ。`tests/tsnonfiniteinit-cases.mjs` 同时覆盖四种等号、操作数副作用顺序、递归和热循环，并由 Rust/CLI 在优化开关和解释器/JIT 下与 Node 配对。未知/混合非原始类型不新增保证。

`tests/kn_r3_text.rs` 对 716 条可通过积木输入复现的域结果分别跑解释器和 JIT（两个 raw-null join 刻意排除），每条在 80 次循环中重复；另覆盖热循环 NaN、拼接树文本排序、console_log 的嵌套 join 及 null 截断。718 条官方调用的完整性与证据对应关系由 `tests/kn-r3-text.test.mjs` 检查。

```bash
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/compat/kn-r3-text-probe.mjs --record
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/compat/kn-r3-text-playback.mjs
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/editor-compat.mjs dist/r3-kntext-official/playback.bcmkn --channel msedge --out dist/r3-kntext-official/editor-compat.json
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/compat/kn-r3-text-playback.mjs --record
bash E:/nekoc-wt/_cargo.sh test --test kn_r3_text
bash E:/nekoc-wt/_remote.sh node --test tests/kn-r3-text.test.mjs tests/kn-catalog-status.test.mjs
```

## 限制与风险

- 官方域函数在当前版本被 bind，`Function#toString` 为 native code；源码定位按未改动下载 bundle 的锚点/hash，不伪造函数体。
- 完整工程覆盖的是表述的最小用例，不是所有 718 条都通过页面逐一播放；大小写 API 的官方证据是注册域调用，不声称完整 TS→官方播放器端到端已验证。
- Unicode 映射使用 Rust 标准库的完整映射。列出的 Unicode 样例已配对，但 Rust 与浏览器随 Unicode 数据版本升级的全部新增字符差异**未验证**。
- 孤立 UTF-16 surrogate、稀疏/循环数组、callable 原型、深层数组在 text_contain/text_length 的特殊处理、UI 数字显示、小数固定位数 API、多帧调度及性能**未验证**。不将本次回归描述为全部文本语义一致。
- Text 的排序修复也作用于 K4，因为该产品同样使用 JS 关系比较；本次重点证据为 KN，K4 完整矩阵**未验证**。
