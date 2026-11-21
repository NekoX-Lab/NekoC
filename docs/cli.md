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
`lint` 是只读静态建议：有警告仍返回 0，读取、格式或命令行错误沿用 1 / 2。
`bench-import` 中的编译、运行或导出错误返回 1，具体错误保留在报告中。
`watch` 是长驻进程，单次编译失败会报告错误并继续监听；启动/监听失败返回 1。主动终止遵循操作系统的信号处理。

## JSON 输出

所有子命令接受全局 `--json`，可写在子命令前后。普通有限命令的 stdout 恰好包含一个 JSON 文档，
成功及预期失败不再混入进度、日志或 Rust 的错误调试输出。stderr 保留给底层不可恢复异常等非协议输出。
`--help` / `--version` 优先，始终输出供人阅读的文本。`--` 后的 `--json` 是位置参数，不是输出开关。

```sh
nekoc check game.nk.ts --json
nekoc lint game.bcmkn --json
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

## 作品 Lint

`nekoc lint <作品.bcmkn|作品.bcm|JSON> [--json]` 检查未使用变量/列表、不会自动触发的脚本、
没有接收入口的广播、超大资源和重复造型。它不编译或运行作品、不访问网络、不下载素材，也不修改输入文件。
普通文本包含中文说明、处理建议、原文件 JSON Pointer，以及适用时的所属场景/角色名称和积木 ID。

JSON 沿用通用成功封装：

```json
{"ok":true,"command":"lint","result":{"format":"kitten-n","diagnostics":[{"severity":"warning","code":"unused_list","message":"列表“草稿”没有积木引用，也未显示监视器","suggestion":"确认不需要保留初始数据或扩展引用后，删除此项。","location":{"path":"/variables/variablesDict/list-id","owner_kind":null,"owner_id":null,"owner_name":null,"block_id":null}}]}}
```

- `format` 为 `kitten-n` 或 `kitten4`。位置直接指向原始 JSON；K4 不经过转换，因此未知扩展不会因编译失败而阻止检查。K4 须保留各场景/角色的 `block_data_json/blocks` 和 `connections`；只有发布 AST 的文件明确报错。
- `unused_variable` / `unused_list`：没有积木字段引用且未显示监视器。读、写、游离/禁用脚本以及 KN 过程里的字段引用均计入；按 ID 或名称保守匹配，扩展中的动态引用需人工确认。
- `untriggered_script`：禁用的顶层入口，或已识别的常用命令游离栈（赋值、移动、对话、等待、条件/循环、追加列表、广播）。保留顶层 reporter、过程定义和未知扩展，不假定所有非标准名称都是死脚本；不做全程序可达性证明。
- `broadcast_without_receiver`：静态字符串广播找不到同名、启用的顶层 `self_listen` / `self_listen_with_param`。扫描全部场景；出现动态接收消息表达式时保守跳过此规则，动态发送也不猜测。不会推断场景切换、克隆或外部扩展的可达性。
- `large_resource`：资源声明大小或内嵌 data URL 解码大小 **大于 5 MiB**，或声明宽/高 **大于 4096**。扫描造型、声音、视频字典；字节字段支持非负整数 `size` / `fileSize` / `file_size` / `byteLength`。无元数据的远程 URL 大小未知，不猜测。阈值是 NekoC 建议，不是官方上传限制。
- `duplicate_costume`：两个造型字典项的非空 URL 完全相同。不会下载或比较不同 URL 的内容；不同名称、旋转中心、角色共用同一图片也可能是有意设计，绝不自动删除。

这些规则只给出可复查的静态风险，不是官方运行失败保证。格式证据和未验证边界见 [lint.md](lint.md)。

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
