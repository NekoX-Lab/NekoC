# NekoC 命令行约定

运行 `nekoc --help` 查看子命令，运行 `nekoc <子命令> --help` 查看中文参数说明。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令完成；显式请求帮助或版本也返回 0 |
| 1 | 文件、编译、运行或测试失败；检查/验证不通过；差异/场景/预期不匹配 |
| 2 | 命令行用法错误：缺少参数、未知子命令、无效参数值、参数冲突 |

`diff --limit` 必须大于 0；`coverage` 和 `bench-import` 至少需要一个输入文件。
`coverage` 是调查报告：报告中的不支持积木和运行问题属于调查结果，不影响成功生成报告的退出码。
`bench-import` 中的编译、运行或导出错误返回 1，具体错误保留在报告中。
`watch` 是长驻进程，单次编译失败会报告错误并继续监听；启动/监听失败返回 1。主动终止遵循操作系统的信号处理。

## JSON 输出

所有子命令接受全局 `--json`，可写在子命令前后。普通有限命令的 stdout 恰好包含一个 JSON 文档，
成功及预期失败不再混入进度、日志或 Rust 的错误调试输出。stderr 保留给底层不可恢复异常等非协议输出。
`--help` / `--version` 优先，始终输出供人阅读的文本。`--` 后的 `--json` 是位置参数，不是输出开关。

```sh
nekoc check game.nk.ts --json
nekoc --json build game.nk.ts -o game.bcmkn
nekoc run game.bcmkn --ticks 60 --expect expected.json --json
nekoc validate game.bcmkn --out validation.json --json
nekoc diff old.bcmkn new.bcmkn --limit 20 --json
nekoc export-player game.bcmkn --out player.zip --wasm-dir packages/nekoc/dist/web --json
nekoc run game.bcmkn --input-script recording.json --json
```

- `check` 和 `build --check` 保留 `{"ok":true,"diagnostics":[]}` 格式；诊断包含 severity/source/code/message，以及可用时的 file/line/column。
- `validate` 输出原始验证报告 `{"ok":true,"issues":[]}`（部分目标带 format）。
- 其他有限命令成功时输出 `{"ok":true,"command":"build","result":{"out":"game.bcmkn"}}`；result 依命令包含 out、report、snapshot、differences、reports 或测试进程 stdout/stderr。
- 文件/依赖/编译等异常输出 `{"ok":false,"command":"...","error":{"kind":"...","message":"...","hint":"..."},"diagnostics":[...]}`。参数解析失败的 error.kind 为 usage，尚无 command/diagnostics；解析成功、读入复现包后才识别的参数冲突也为 usage，并携带 command/diagnostics。
- 差异、预期、场景、单元测试以及导入基准失败也携带 `ok:false`、error 和 result。检查/验证正常完成但发现问题时仍使用原 diagnostics/issues，不额外包装。
- `run --json` 将快照放在 `result.snapshot`；`--out` 写入的文件仍是原始快照，可直接供 `--expect` 使用。比较失败时不写输出文件，实际快照和差异在 result 中。
- `export-player --json` 成功时返回 `command:"export-player"` 和 `result.out`；打包器的输出捕获在 `result.stdout` / `result.stderr`，不会混入协议流。打包失败返回 1，并保留这两个字段及中文下一步提示。
- `coverage --json` / `bench-import --json` 将批量结果放入 `result.reports` 数组；发生读取等异常时只输出一个错误文档，不先输出部分结果。
- `watch --json` 是 NDJSON：每次编译输出一行 JSON，带 `command:"watch"`、`event:"compile"`、ok 及 result/error；单次失败不会退出。

无 `--json` 时保留已有命令的文本/文件输出，以及 run 的原始快照和 coverage/bench-import 的逐行 JSON。
错误消息追加中文“下一步”，包括缺文件、权限、JSON 格式、Node.js/TypeScript 依赖、前端位置和编译诊断。
普通文件输出的父目录须事先存在，路径含空格时请加引号。

## 播放器导出

`nekoc export-player <作品.bcmkn|作品.bcm|JSON> --out <新目录|新文件.zip> [--wasm-dir <Web 绑定目录>]`
将作品、素材和浏览器运行时打包为无需服务器的独立播放器。现有输出路径绝不覆盖；输出父目录可自动创建。
导出环境需要 Node.js 22+、源码中的 npm 依赖，以及 wasm-bindgen Web 绑定（默认 `packages/nekoc/dist/web`）。
未指定 `--json` 时保留打包器的进度和完成消息；成功为 0，作品、依赖、素材、输出等错误为 1，缺少必需参数等用法错误为 2。

## 输入脚本与复现重放

`run --input-script <文件>` 按 schema 区分两种输入，不会在复现包校验失败时降级为旧脚本：

- `nekoc-input-v1` 保留原引擎路径，可显式指定 `--ticks` / `--frames`、`--seed`、`--event` 和云参数；默认运行 1 帧。
- `nekoc-repro-v1` 使用包内确认的时间线（含零帧）、随机种子和固定 1/60 秒步长，并验证作品指纹、runner 版本、协议、状态摘要及预算让出次数。
- 复现包不得搭配 `--ticks` / `--frames`、`--seed`、`--event` 或任何显式 `--cloud-*` 参数；即使 `--cloud-user anonymous` 等于默认值也冲突。这类参数冲突返回 2（JSON 的 `error.kind:"usage"`）；包损坏、版本/指纹/摘要不匹配返回 1。`--legacy-runtime` 与 `--input-script` 互斥。
- 无 `--json` 时输出原始 `nekoc-repro-run-v1` 报告；有 `--json` 时保持 `command:"run"`，完整报告位于 `result.snapshot`，其中的 `repro.matched` 表示验证通过。`--out` / `--expect` 始终使用未包装的原始报告，允许中断/丢弃输入的记录仅表示已确认前缀可重放，不保证完整录制。

这些是 NekoC 自身的 CLI 协议，不代表官方编辑器或播放器的行为保证。
