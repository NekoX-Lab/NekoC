# r3：画笔路径进入 JIT region

## 选择范围

在起点 `d6de981` 保存独立 release `jit-corpus`，只读运行外部 K4 和
KN 语料（60 帧、seed 1、每帧 2,000,000 指令），用
`tools/compat/jit-report.mjs` 统计回退原因。

K4 的 `unsupported-or-impure/PenPath` 为 63,314 次，是该类回退的最大项：
`305999424` 为 47,264 次，`324380532` 为 15,466 次，`335327306` 为
584 次。只扩展 `PenPath(begin/close)` 和同一绘图流程的 `FillColor`，
不顺带放行调度、动画、克隆或其它外观操作。

## 执行边界

- 两个操作均无动态输入，不运行 reporter，不改变 tasks/slots/locals/parameters
  数组地址；路径 Vec 和绘图 raster 的分配不使 NativeContext 缓存失效。
- 使用现有 `h_transfer → h_exec → Engine::exec`，保留 actor/stage 检查、
  路径重置、退化/重复 close、填充颜色和线/文字/图像的绘制顺序。
- close 可能增加填充输出。沿用 `h_transfer` 的执行后输出上限检查：到达
  1,024 个填充或总计 65,536 个路径点时，立即退出 region，退款尚未执行的
  指令，不能在调度器观察上限前执行后继。
- 失败仍消耗当前一条指令，PC、源块位置和未执行的后继保持解释器约定。
  没有改循环让出、指令预算、运行时语义或播放器格式。
- 这属于 **region 内通用委托**，如实计入 `delegated_ops` 和
  `helper_reasons["op/PenPath"]` / `op/FillColor`。不是将 Canvas/raster
  算法编成机器码，也不能把 region 覆盖率提升当成纯 native 覆盖或提速。

## 回归与复验

`tests/jit_r3.rs` 构造仓库原创的内存作品，实际跨过热阈值，并断言对应
helper 确实执行。逐帧比较 wire metadata、绘图 bytes、普通/精确状态快照、
预算让出、指令数和调度次数；重启后重复检查已有 region：

- KN/K4 的退化路径、重新 begin、重复 close、抬笔路径与混合印章顺序；
- 小指令预算下跨帧保存未闭合路径；
- 1,024 填充和 65,536 总点数两个独立输出上限；
- 不开启 profile 的真实执行路径；
- 热路径非法起点的错误时点和后继保护；
- 先由 actor 加热同一过程、再由 stage 调用时仍拒绝画笔操作。
- 显式启用颜色检测 raster，覆盖热路径填充后 clear、记录路径时非法移动、
  17/997/1,000,000 指令预算与重启，避免只验证不分配 raster 的默认路径。

示例复现（Cargo 入口按本地工作环境配置）：

```bash
bash E:/nekoc-wt/_cargo.sh test --test jit_r3
bash E:/nekoc-wt/_cargo.sh build --release --bin jit-corpus
target/release/jit-corpus.exe E:/nekoc/dist/kitten4-corpus --out dist/r3-jit/k4-after.json --frames 60 --seed 1
node tools/compat/jit-report.mjs dist/r3-jit/k4-before.json dist/r3-jit/k4-after.json --out dist/r3-jit/k4-comparison.md
```

## 证据与限制

本次只改变执行 tier，**新增测试和语料差分不是独立官方 oracle**。
既有官方路径/填充依据见
[K4 第三轮画笔证据](kitten4-partial-pen-3.md)及其
`kitten4-partial-pen-3-evidence.json`：只读官方
`player_v2.2d180c468559fbd29528.js.orig`，SHA-256
`0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160`，
`a1xw` factory 内 `draw_fill_pattern` 约 50156，包含抬笔路径、重新开始、
自交、填充色和混合印章的已有实测。本次不重录该官方证据，不扩大其认证范围。
本次另核验同一外部只读文件及 SHA-256：UTF-8 解码后的 0-based 字符位置
`set_fill_style` 637851、`set_pen_path` 638029（明确拒绝 Scene），
`draw_fill_pattern` 方法定义 812521（使用 fill/stroke 色，关闭并清空路径）。
只记录位置，不将官方 bundle 或实现片段入库。

KN 全部路径语义、任意第三方作品的官方轨迹/像素、真实输入、长时运行和
ARM 真机均**未验证**。未参考或移植 HateNeko。
实测覆盖率、错误清单、原始检查摘要和本地测速仅记录在未提交的 `OC-REPORT.md`
以及本 worktree 忽略的 `dist/r3-jit/`，不将第三方作品复制进仓库。
