# KN 等待与帧边界（r3）

## 本次修复范围

KN 的 `wait` 不是“到达时间戳后立即解除阻塞”：

1. 执行 `wait` 的更新末尾初始化等待任务。
2. 后续更新末尾观察到超时，标记任务待释放。
3. 再下一次更新入口释放阻塞，脚本才可继续。

因此 `wait(0)`、负数等待至少跨过两个更新边界。此前 NekoC 只对
Kitten 4 使用这套生命周期，KN 会提前一个更新继续；现在共用已有的
`wait_started` / `wait_finished` 机制。没有改变 K4、普通循环让出、
`wait_until` 或异步扩展的生命周期。

## 官方证据与复现

`docs/kn-r3-scheduling-official.json` 保存真实官方编辑器原生内核的逐更新
变量快照、两个 bundle 的 URL/SHA-256、浏览器版本和原创 fixture 的散列。
探针只暴露 webpack 加载器、读取运行时状态、提供确定性时钟和包装 update；
没有替换积木处理器、解释器、调度器或等待实现，没有登录或发布作品。

本次实际服务的官方文件：

- `https://creation.bcmcdn.com/neko/web/release/static/js/main.bfc86683.js`
- `https://creation.bcmcdn.com/neko/web/release/static/js/crc_libs.a21338b6.js`

后者 SHA-256：`bd3b9858abe09d7552acd560d0f318139cd61a5b7a44364c153737421246c850`。
可定位的源码标记（字符偏移，以该文件 UTF-8 解码后的 JS 字符串计）：

| 标记 | 偏移 | 意义 |
| --- | ---: | --- |
| `prototype.update=function(){var t=this;this.event_bus.runtime_manager.before_update` | 995897 | 调度前清理、调度后更新等待任务 |
| `prototype.thread_wait=function` | 1000422 | 创建具有 lifetime 的阻塞任务 |
| `prototype.update_dispose=function` | 1002999 | 更新入口处理待释放任务 |
| `prototype.task_update=function` | 1023012 | 首次只初始化 start_tick；后续才比较 lifetime 并 dispose_task |
| `prototype.get_interpreter_sorters=function` | 1003659 | 广播优先、创建帧和创建顺序参与排序 |

下载文件仅保留在忽略的 `dist/r3-knsched/`，不入库。

```bash
node tools/compat/kn-r3-sched.mjs --generate
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/compat/kn-r3-sched.mjs
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/editor-compat.mjs tests/fixtures/kn-r3-sched/*.bcmkn --channel msedge --out dist/r3-knsched/editor-compat.json
node tools/compat/kn-r3-sched.mjs --archive
bash E:/nekoc-wt/_cargo.sh test --test kn_r3_sched
```

每个更新使用 16 ms 时钟增量，不把 Playwright 的等待时间当作运行帧数。
8 个更新后停止采样；所有 10 个原创 fixture 已通过官方编辑器检查
（`ok: true`，无 issues/pageErrors）。Rust 回归对等待、条件等待和重复执行
逐帧比较，解释器/JIT 都执行 600 次 start，覆盖热身后的执行路径。

| 用例 | 官方 trace 的前四次更新 |
| --- | --- |
| wait-zero | `AB`, `AB`, `ABab`, `ABab` |
| wait-negative | `AB`, `AB`, `ABa`, `ABa` |
| wait-positive（32 ms） | `A`, `A`, `A`, `Aa` |
| wait-until | `AB`, `ABa`, `ABa`, `ABa` |
| repeat（3 次） | `AB`, `ABAB`, `ABABAB`, `ABABABab` |

`dt=0`、1 ms、100 ms 的回归还确保零等待的帧边界不依赖写死的 60 Hz。

## 已发现但本次未修复的调度差异

以下也有逐帧官方实测，保存在同一份 JSON 中，但**不代表已与 NekoC 对齐**。
本次保持小范围修复，避免把事件队列和广播生命周期重构混在等待修复里。

| 用例 | 官方前四帧 | NekoC 当前实现的差异 |
| --- | --- | --- |
| broadcast | `AB`, `ABR`, `ABR`, `ABRr` | 接收任务会加入当前帧 ready 队列 |
| broadcast-wait | `A`, `AR`, `AR`, `ARrB` | 接收任务提前启动，进而影响发送者续跑时机 |
| broadcast-empty | `A`, `A`, `AB`, `AB` | 没有接收者时直接继续，没有 Pending/Sending 等待边界 |
| broadcast-overlap | `A`, `AR`, `AR`, `ARr` | 同帧两次同名广播官方合并，本地逐次新建接收任务 |
| clone | `AB`, `ABK`, `ABKb`, `ABKbk` | 克隆启动任务会加入当前帧 ready 队列 |

多发送者、递归广播、接收者被停止/删除、跨场景克隆的组合边界尚未验证。
不能仅把 `ready.push_back` 删除就宣称完整对齐：还需处理消息合并、广播
状态机、绑定等待者及任务优先级。

## 语料验证的边界

工具支持 `--corpus <只读作品.bcmkn>`，把同一原始作品装入官方编辑器播放器，
读取 35 次真实调度更新后的变量；第三方作品不写入跟踪路径。
本次选取作品 `336319534`《帧率测试模板（开源）》。时钟由探针控制为
16 ms/更新，帧 1–32 的“帧1”依次为 2、4、…、64，帧 33 显示“帧率 : 64”，
帧 34 开始下一轮计数。原始观察在 `dist/r3-knsched/corpus-official.json`。

```bash
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/compat/kn-r3-sched.mjs --corpus E:/nekoc/dist/pickcat-corpus/knbcmkn/336319534.bcmkn
```

可选 Rust 对比通过 `NEKOC_R3_SCHED_CORPUS` 指定只读原始作品，逐更新核对
计数与显示文本；默认 CI 不依赖第三方语料。此验证使用官方**编辑器播放器**，
不是线上作品详情的 share-player 页面；share-player 同样时序**未验证**。

`NEKOC_R3_SCHED_EVIDENCE` 可指定观察 JSON 的位置。对比前会核对原始作品
SHA-256，避免使用不同版本作品的观察值。NaN/Infinity 等特殊等待输入的
官方边界本次未验证。
