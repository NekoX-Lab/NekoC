# TypeScript 诊断与 JSON 契约

`nekoc check main.ts` 同时执行类型检查、目标兼容性检查及作品结构检查。
`--no-types` 仅关闭类型检查；语法错误和不支持的语法仍然报错。
`nekoc build main.ts` 的前端错误使用相同的源码片段和建议格式。
源码诊断指向原始文件，包括导入模块及被编译器展开的回调，不展示生成的辅助函数源码。

```text
main.ts:2:9: error TS2322: Type 'string' is not assignable to type 'number'. [types]
  2 |   const count: number = "bad";
    |         ^
  help: Make the value's type match the declared variable or parameter type; use an explicit conversion if needed.
```

## 分类

| `source` | 含义 | 处理方式 |
| --- | --- | --- |
| `syntax` | TypeScript 解析失败，如缺少表达式、括号 | 先修正源码语法 |
| `types` | TypeScript 类型检查失败，如赋值类型、参数数量不匹配 | 对照类型声明修正值或调用 |
| `compat` | NekoC 子集/所选目标不支持的构造或调用 | 按建议改写；类型检查通过不代表可编译 |
| `project` | 装配后或输入作品的结构错误 | 修正作品或重新生成 |

解析器诊断在开关类型检查时都归为 `syntax`，同一文件同一位置的相同解析错误只输出一次。
`NEKOC_INTERNAL` 表示前端异常，不应解释成用户语法不受支持；建议提供最小复现。
一次检查可以同时包含 `types` 与 `compat`，这两类不会相互覆盖。

## 稳定 JSON 结构

使用 `nekoc check main.ts --json` 或 `nekoc build main.ts --check --json`。
前端入口为 `node ts/compile-ts.mjs --check --json main.ts`；npm/浏览器 SDK 的
`check(entry, options)` 返回相同信封。

```json
{
  "ok": false,
  "diagnostics": [
    {
      "severity": "error",
      "source": "syntax",
      "code": "TS1109",
      "message": "Expression expected.",
      "file": "/project/main.ts",
      "line": 2,
      "column": 9,
      "snippet": "let a = ;",
      "suggestion": "Fix the syntax at the marked position; check for a missing expression, delimiter or closing bracket."
    }
  ]
}
```

| 字段 | 类型与约定 |
| --- | --- |
| `ok` | boolean；不存在 error 时为 true |
| `diagnostics` | 诊断数组；成功且无诊断时为 `[]` |
| `severity` | `error` 或 `warning` |
| `source` | 上述四种分类 |
| `code` | 字符串，如 `TS2322`、`NEKOC`、`NEKOC_INTERNAL`；与消息分离 |
| `message` | 原始纯文本消息，不含文件定位前缀、源码 gutter 或 help 行 |
| `file` | 可选字符串；路径来自编译器/宿主，可能为绝对路径或虚拟文件路径 |
| `line` / `column` | 可选正整数，从 1 开始；column 按 TypeScript 的 UTF-16 代码单元计数 |
| `snippet` | 必有；原始出错行（保留缩进、不含换行符），无法读取时为 `null`；空行是 `""` |
| `suggestion` | 必有字符串；建议的修正或进一步排查方法 |

字段名、类型及分类为本契约；客户端应允许新增字段，不依赖对象键顺序或诊断英文原文。
通用 `NEKOC` 覆盖多种子集限制，不是每个错误独有的编号。建议优先提取已有的明确改写提示，
没有专门提示时指向支持的子集/API 文档；建议不代表自动修复。

正常诊断结果在 stdout 输出一个 JSON 对象，错误退出码为 1，成功为 0，stderr 不混入诊断文本。
不加 `--json` 时 Rust CLI/独立前端在 stderr 输出人类可读诊断，npm CLI 的 check 文本在 stdout。
直接运行前端编译也支持 `node ts/compile-ts.mjs --json main.ts output.json`：
stdout 返回同样的信封，成功时将 workspace report 写入指定输出文件；失败不写 report。
独立前端的 `--check --report-out=...` 是供装配流程使用的 report sidecar，仍不进入 JSON 信封。

JS `checkFile()` 内部 API 额外返回 `report`，`compileFile()` 抛出的 `CompileError`
保持原有 `message`、`code`、`location` 并带上完整 `diagnostics`，可用
`compileErrorDiagnostics(error)` 取得、`formatDiagnostic(diagnostic)` 格式化。

## 没有源码的位置

文件不存在、宿主读取失败、全局 TypeScript 配置错误、作品结构错误可能没有有效源码坐标。
这些错误不伪造 `1:1`：保留已知的 file，省略未知 line/column，snippet 为 null，仍提供建议。
JSON 契约描述诊断结果；命令行参数用法错误、缺少 Node/前端、损坏的作品/模板及输出写入失败
属于命令基础设施错误，仍可能通过 stderr 报错，而不是诊断信封。

CRLF、CR、LF、Unicode 行分隔符均正确分行；文本指示符保留 tab，按 UTF-16 位置生成。
终端对全角字符/emoji 的显示宽度各异，编辑器应使用 line/column 定位，不依赖终端指示符的像素对齐。

本变更只改诊断分类和呈现，不改变生成积木或运行语义；不构成对官方播放器行为的新断言。
