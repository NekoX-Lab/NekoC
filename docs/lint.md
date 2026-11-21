# 作品静态检查

用法和诊断字段见 [命令行约定](cli.md#作品-lint)。`lint` 与 `check` / `validate` 分离：
前者提供非阻断的清理建议，后两者检查兼容性或结构错误。不生成或改写作品。

## 格式证据

- `docs/kitten4-block-schema.json` 记录官方 4.11.20 编辑器中 `Blockly.mainWorkspace.new_block(type)`
  经 `Blockly.json.block_to_json` 序列化得到的默认值和连接信息。`self_listen` 的
  `message` 是 value 输入、`DO` 是 statement、`previous` / `next` 为 null；
  `self_broadcast` / `self_broadcast_and_wait` 具有 `message` 输入及前后连接。
  `variables_set` / `variables_get` 的变量字段为 `VAR`，`broadcast_input` 的消息字段为 `MESSAGE`。
- K4 原始位置采用该快照说明中的 `connections[parentId][childId]`、`input_name`、
  `input_type`，并保留 `block_data_json/blocks` 的原始 ID；不依靠转换后的临时编号。
- `docs/compatibility/kn-share-player-blocks.json` 的 `sources[].sourceLocations.compileEvent`
  和 `compileDomainFunctions` 保存分享播放器主 bundle 的来源、哈希及字符位置，
  注册清单包含 `self_listen` / `self_listen_with_param` 和三种广播入口。
  KN 实际输入字段沿用仓库现有 `ts/compile-ts.mjs`、`src/bcmkn_compiler.rs` 的作品结构。
- `docs/kitten4-scheduling.md` 与 `docs/kitten4-scheduling-evidence.json` 包含官方离线
  `Tn6a` / `iNFq` 消息入口及广播调度的最小实测。`tests/r4_lint.rs` 读取已有自制
  `scheduling-broadcast.bcm` / `scheduling-broadcast-wait.bcm`，验证 lint 不误报其中的成对消息。
  这只验证 lint 对已有格式证据的使用，不表示本任务重新做了官方运行时差分。

## 保守边界与未验证

- 本任务没有新增官方编辑器/播放器实测；禁用脚本的所有版本细节、编辑器手动单击游离命令、
  扩展注入的接收器等均**未验证**。诊断措辞是“不会自动触发”或“没有静态消息接收入口”，
  不是“作品绝对无法执行”。草稿及故意不触发的栈可忽略。
- 不分析恒假条件、未调用过程、无发送者的接收入口、不可达场景以及消息的运行时计算值。
  K4 仅发布 AST、没有完整 `block_data_json/blocks` 和 `connections` 时明确报错，
  避免把未知引用误报为未使用；应使用带原工作区的作品。
- 变量引用按全部已收集积木的字符串字段保守匹配；同名但不同作用域的变量、与变量同名的普通
  文本可能抑制一条本来有效的未使用警告。未知扩展的 mutation/XML、`shadows` XML 或运行时
  生成引用不在当前分析范围。
- 超大阈值与资源大小字段兼容项属于 NekoC 的本地分析约定，并非官方上限。未声明大小的远程
  资源不联网探测；data URL 只计算有效 base64 或百分号编码的字节数，不做图像解码或像素比较。
- 相同 URL 不必然代表多余造型，也不保证远程内容永远不变；不同 URL 即使内容相同也不报重复。
- 不使用 HateNeko 源码，不移植官方实现，不添加任何第三方语料或 bundle。

KN 扫描使用显式栈；深层 `next` 链只在产生诊断时拼接完整 JSON Pointer，避免逐节点复制全路径。
回归覆盖 10000 层链，不使用墙钟性能断言。
