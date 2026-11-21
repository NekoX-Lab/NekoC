# r2：PICKCAT KN 积木运行缺口

## 统计口径

基线 `d6de9815600bbc4fe1cef4e7c775257d0c704422`，49 个 KN 原生 JSON。
`tools/compat/kn-r2-corpus.mjs` 只读扫描场景、角色、过程工作区，含未触发脚本、
禁用积木和 JSON/XML shadow；每种类型按不同作品数去重排序。变量类型不算积木。
旧版缺 `toolType` 及 `TANYUE_KN` 仅在扫描器的浅拷贝视图归一化，运行仍传原文件。
不把静态出现、600 帧无错误或“有执行路径”当作官方完整兼容认证。

300 项覆盖表当前没有“缺失”项，但不是官方全集。语料含 28 种表内
部分语义/占位项；以下按作品数降序、类型名排序：

| 类型 | 作品数 | 基线状态 |
| --- | ---: | --- |
| `username_get` | 9 | 部分语义 |
| `global_animation` | 8 | 部分语义 |
| `show_hide_ranking` | 7 | 部分语义 |
| `update_ranking` | 7 | 部分语义 |
| `ai_chat_answer` | 6 | 部分语义 |
| `ai_chat_ask` | 6 | 部分语义 |
| `user_id_get` | 6 | 部分语义 |
| `get_voice_answer` | 4 | 部分语义 |
| `new_conversation` | 4 | 部分语义 |
| `voice_recognition` | 4 | 部分语义 |
| `open_hide_camera` | 3 | 部分语义 |
| `set_system_preset` | 3 | 部分语义 |
| `user_ranking_info` | 3 | 部分语义 |
| `ai_text_result` | 2 | 部分语义 |
| `ai_text_photo` | 1 | 部分语义 |
| `enable_face_detect_by_actor` | 1 | 部分语义 |
| `enable_face_detect_by_photo` | 1 | 部分语义 |
| `enable_object_detect_by_photo` | 1 | 部分语义 |
| `get_face_detection_result` | 1 | 部分语义 |
| `get_object_detection_result` | 1 | 部分语义 |
| `get_orientation` | 1 | 固定值占位 |
| `get_voice_volume` | 1 | 部分语义 |
| `recognize_body_part` | 1 | 部分语义 |
| `recognize_gesture` | 1 | 部分语义 |
| `set_camera_alpha` | 1 | 部分语义 |
| `translate` | 1 | 部分语义 |
| `translate_result` | 1 | 部分语义 |
| `user_info_of_th` | 1 | 部分语义 |

另有清单外 `bcm_translator_text_execution_block`（3 作品，两个在启动路径阻断）
与 `kids_move_right`（1 作品）。其余清单外项多数为已支持的阴影、过程和别名；
“清单外”不能直接解释为“不支持”。完整列表、出现次数、作品 ID 及输入 SHA-256
留在本地 `dist/r2-knblocks/frequency.json`，不提交任何第三方作品。

## 官方少儿移动证据

官方主包 URL：`https://creation.bcmcdn.com/neko/web/release/static/js/main.0f3db563.js`。
SHA-256：`42841119872219828a193880c7261774643e05e14848be58e6679d78b9add827`。
源码为单行，以下均为从 0 开始的字符/UTF-8 字节偏移（本段两者相同）：

- 2668219–2668303：四个 `kids_move_*` 名称定义。
- 109619：按 kids 模式加载 chunk 42 / module 29042。
- 11191836：webpack chunk 文件名映射到 `42.3dd2ca05.chunk.js`。
- 2921998：每步 25 像素、速度 200 像素/秒。
- 2238261：共享 `changeTargetPosition`：有限非零距离；非正时长立即移动；
  正时长注册 `blocking: true` task，逐 tick 在当前单轴坐标上增加增量，
  `on_end` 将该轴校正到起始位置加完整位移，不覆盖另一轴。

动态包 URL：`https://creation.bcmcdn.com/neko/web/release/static/js/42.3dd2ca05.chunk.js`。
SHA-256：`0be9bcf1696995dc1b7cc9f6d86c5abe9bbd0263641db17c5c24c388c0730885`。

- 27325：共享 `u` handler 读取 `steps` 一次、计算 `steps * 25`、时长为距离/200。
  对非有限数/非 Number 报告警告后**没有 return**，因此数值字符串仍被乘法转换。
- 28367、28535、28707、28880：上、下、右、左注册，分别选择 y+/y−/x+/x−。
- 面板 number shadow 的最小值 1 是 UI 约束；不应在 VM 额外夹取负数。

`tools/compat/kn-r2-kids-probe.mjs` 校验上述两个包的 SHA-256，抽取未改写的
共享 helper，在原创 actor/task-manager 适配器上执行 40 组局部调用，
记录 `dist/r2-knblocks/kids-evidence.json`。它验证位移/输入转换/阻塞请求，
不是完整浏览器调度或像素差分。官方源文件及摘录只放忽略的 dist。

实现放在 `src/engine/kn_kids.rs`，四方向共用少量原生分派，沿用任务的动画
生命周期。正步数阻塞当前脚本；其他脚本继续；零/非有限位移不污染坐标；
负数立即反向移动。增量式动画保留并发脚本的中间改动，结束时单轴校正。
所有新增积木回归放在 `tests/kn_r2_blocks.rs`。

### 复审修订：画笔、更新阶段与极值

- 所有 kids 坐标变化都调用现有 `line(actor, old)`，记录笔迹、填充轮廓并
  更新颜色碰撞栅格；包括负数即时移动、普通 tick 增量和最终位置校正。
  官方 main 在 5438755 附近的坐标 setter 发出 `change(position)`，
  5422486 附近画笔监听该事件并调用 `draw_line`。本地回归检查实际
  `Frame.lines` 和笔抬起时仍记录的 `pen_fills.points`，不是仅比较坐标。
- 动画改为普通脚本阶段之后统一更新；普通 tick 增量移动，到期本帧只执行 on_end，
  不额外 on_tick，下一次 update 才通过 AnimStep 继续后继。
  官方 RuntimeManager 在 4824448 附近先 step_code 后 task_manager.update；4849971 的
  task_update 到期排队 dispose。复审探针使用未改写的官方方法，原创
  actor/clock/script 适配器结果为 x=100/125/60/100，after=0/0/0/1
  （0/125/250/251ms）；本地 JIT 开关两种模式均按该序列回归。
  原来测试中脚本阶段内先移动、再被并发写覆盖的预期已纠正。
- 保留 `distance / 200 * 1000` 两次运算的毫秒 lifetime：极大有限步数
  `2e306` 在毫秒转换时成为 Infinity，后续 125ms tick 位移为 0；
  极小步数 `1e-323` 的秒时长下溢为 0，按官方即时移动。
- 本地复审材料与重跑结果位于忽略的 `dist/review-r2-knblocks/` 和
  `dist/r2-knblocks/revision-official-{phase,extremes}.*`。这是未改写
  官方方法的局部执行，不宣称完整浏览器原生工程或像素端到端认证。

### 第二次复审：组合动画与取消阶段

- 接受 kids 与 glide 相互覆盖顺序的问题。KN 正有限时长 glide 与 kids
  共用独立运动任务队列，普通脚本全部执行后按实际登记顺序更新，不按脚本
  创建顺序或当前 ready cursor 推断；脚本内只保留运动 blocker。
  Kitten 4 glide 及零时长即时路径不改为这套 KN 队列。
- 固定官方包的 `moveTargetTo`（字符偏移 2236868）、
  `changeTargetPosition`（2238261）均登记 TaskManager task；
  module 34139 的 add_task push 与 update 顺序是上述调整的依据。
  已重跑审查的 `official-mix.mjs`、`official-cli-samples.mjs`；
  kids→glide（100px/0.5s）在 0/125/250ms 为 x=0/25/50。
- 运动 owner 使用稳定 task id，不依赖会压缩的 interpreter 索引；
  停止其他脚本立即禁止后继，但不删除本帧末更新。下次 update 入口清掉
  已终止 owner 的运动，取消不触发终点校正，不允许多帧继续移动。
  官方 dispose_block_group（4832429）及
  dispose_other_block_groups_of_entity（4833034）只排队销毁；
  官方 stop 探针 0/125/下一 update 的 x=10/35/35。
- 全停会抑制剩余本帧 task 更新；restart 清空运动队列。KN 角色显式销毁
  与固定官方 `destruct_entity`（4832226）一致，在下一 update 入口执行；
  请求帧保留 drawable 和最后一次运动。实际删除、场景清理及 clone-cap
  淘汰仍清掉该角色所有运动，防止复用 slot 后旧 task 写入新角色。
- 本轮 `tests/kn_r2_blocks.rs` 新增两种动画启动顺序、不同终点的结束校正
  与逐段笔迹、登记顺序不同于脚本创建顺序、停止当前/其他/其他角色/全部、
  取消后多帧不移动及角色删除回归，JIT 开关均覆盖。
- 局部官方探针只执行未改写的 helper/manager/task 方法与原创适配器；
  停止探针的下一次 update disposal orchestration 为原创适配，不宣称
  完整官方 update_dispose 或浏览器原生脚本端到端调度认证。证据仅留
  忽略的 `dist/review-r2-knblocks-round2/` 与 `dist/r2-knblocks/round2-*`。
- 本轮新 release 的审查原始夹具第 1/7/8/9 帧：glide 的 x 为
  0/20/23.3333333333/26.6666666667，stop 为
  10/30/33.3333333333/33.3333333333，停止后不再移动。仅补原生元数据
  的副本通过官方 `/kids` editor-compat（8/7 blocks、均 `ok:true`），
  同一 release 第 9 帧坐标及线程数与原件一致。49 作品各 600 帧仍为
  47/49，输入哈希全部一致、原成功 47 项无回退；保留原有 physics
  不支持和 return 缺 VALUE 两项明确失败，不宣称全语料全通过。

## 官方服务失败与代码占位块证据

同一固定主包 `main.0f3db563.js` 的零基源码位置：

| 范围 | 字节位置 | 官方行为与本轮边界 |
| --- | ---: | --- |
| 摄像头面板 handler | 2189303 | `open_hide_camera` 等待 `turnOn`；失败后仍结束命令 |
| webcam handler | 2213871 | `open_close_webcam` 共享摄像头状态 |
| 摄像头 `turnOn` | 2047284 | 权限拒绝设置 `NO_PERMISSION`，发摄像头 STOP 事件后返回；不是作品 stop-all |
| 摄像头 `turnOff` | 2053470 | 恢复关闭状态；失败后的关闭重置 alpha，已关闭时重复关闭不重置，复核见 kn-r3-camera.md |
| chat / preset / new conversation | 2200880 / 2201888 / 2202728 | 离线拒绝、清空答案缓存；没有成功回答 |
| OCR actor / photo | 3496105 / 3497524 | 保留既有显式离线空结果 profile |
| face / object detection | 2195152 / 2198141 | 未登录提前返回；不制造检测结果 |
| classifier actor / photo / camera | 2203834 / 2206354 / 2208017 | 缺模型或离线拒绝；不返回虚构预测 |
| 翻译命令 / reporter | 2088181 / 2089219 | 空白提前返回；网络失败命令不弹成功对话框，reporter 返回空文本 |
| 翻译 HTTP | 2083587 | 失败 catch 得到 null；不是将原文当作译文 |
| 代码占位块定义 / 禁用提示 | 1660357 / 1626615 | 无匹配积木的代码转换占位符，和联网翻译服务无关 |

本地 `dist/r2-knblocks-services/probe.mjs` 在隔离浏览器加载固定包，仅暴露
webpack loader；真实域函数不替换。初始化仅允许静态 CDN 资源，拦截 API 和
WebSocket；随后切换 offline，CDP 摄像头权限设为 denied，不使用假设备。
`probe-report.json` 与 `source-index.json` 保留原始观察、摘录散列和位置。

- 两种摄像头 `turn_on` 均为 Promise resolved undefined，状态
  `turn_off → no_permission`；`turn_off` 恢复关闭。只观察到摄像头 STOP，
  没有 runtime.stop。原创原生脚本执行到两条 after 日志和独立 witness。
- 原生 chat 脚本执行到 new / preset / ask 三条 after 日志，独立 witness 继续。
- 网络失败的翻译命令执行到 after-translate，独立 witness 继续；reporter 对
  非空文本及数字输入都返回 string 空串，未伪造内容。
- `disabled: true` 的 `bcm_translator_text_execution_block` 连同未注册的输入
  都被跳过，后继及 witness 继续；未禁用版本在 initialization 报
  `compile_domain_functions` / errorCode 6，未强制继续运行。语料中 31 个
  此类占位块（3 个作品）均明确 `disabled: true`。

探针 `pageErrors: []`，但有离线资源与 `canvas for stage not found` 等
consoleErrors；证据限于域函数和最小原生脚本，不作为完整编辑器/渲染认证。
服务原生案例完整调度仅观察后继与独立脚本能继续，未声明微任务相位等价。

实现（与 r3-camera 合并后的语义）：CLI 明确选择
`set_kn_offline_anonymous(true)`，通过 JSON `kn_panel_notices` 输出去重提示
`ai_offline` / `ai_login_required` / `ai_missing_model` / `camera_unavailable` /
`translation_unavailable`。Engine 库的 AI 仍须显式选择离线 profile；
摄像头则使用 r3-camera 的无后端可恢复路径，不再额外要求摄像头 opt-in。
摄像头打开失败当时保留 alpha，失败后关闭重置为 0.6，不创建流、画面或
检测成功状态；通知与 capture 状态在重启时清空，AI profile 保留。
所有通知共用 `PanelNotice` 与同一个去重队列，组合回归检查摄像头、AI、
翻译通知并存、异步后继及重启后的再次通知。
合入 r3-translator 后，四种转换占位块作为 statement 时的明确布尔禁用
状态均保留专用跳过规则；value/boolean 占位块作为 reporter 时保留官方
NaN/false、动态输入求值和 disabled_param 检查，见 kn-r3-translator-evidence.md。
未禁用的 execution 占位块仍给出含 block id 的诊断，未知积木仍报错，
不以通用 no-op 伪装支持。

## 复现

```bash
node tools/compat/kn-r2-corpus.mjs --corpus E:/nekoc/dist/pickcat-corpus/kn --out dist/r2-knblocks/frequency.json
node tools/compat/kn-r2-corpus.mjs --corpus E:/nekoc/dist/pickcat-corpus/kn --nekoc target/release/nekoc.exe --out dist/r2-knblocks/after.json
node tools/compat/kn-r2-kids-probe.mjs
node tools/compat/kn-r2-fixtures.mjs
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/editor-compat.mjs dist/r2-knblocks/fixtures/kids.bcmkn --url https://kn.codemao.cn/kids --channel msedge --out dist/r2-knblocks/editor-kids.json
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/editor-compat.mjs dist/r2-knblocks/fixtures/services.bcmkn --channel msedge --out dist/r2-knblocks/editor-services.json
```

## 未验证与边界

- 49 个原始输入以 seed=1、每作品 600 帧运行，当前 debug 与远端 release CLI 均为 47/49，
  基线为 42/49，原成功 42 个无回退。全部输入 SHA-256 前后一致。
  `303456318` 在禁用占位块之后仍遇到不支持的 `self_enable_physics`；
  `336191749` 在摄像头之后仍遇到返回块缺 `VALUE`。两者仍明确失败，
  不用通用 no-op 或猜测返回值制造全通过。
- 已核实并修正上述 scripts→task→下一 update dispose 相位及并发写入结果；
  少儿移动其余完整调度、暂停/重启的官方差分、画笔像素和全部并发顺序仍未验证，
  不声称完整浏览器逐帧全等。
- 不实现其余少儿积木；未被语料触发的 API 不以通用 no-op 吞掉。
- Scene background 的理论分支尚缺真实原生工作区可达性和目标语义证据，
  本轮不猜测扩展，仍保留为未验证边界。
- 账号、排名、全局动画、真实 AI/翻译/摄像头、网络权限等既有局限仍保留。
- 翻译 null/undefined 的官方域函数拒绝 Promise；最小原生命令观察仍继续，
  本 VM 对这类非法输入保留错误诊断，不声称该异常调度路径一致。
- 摄像头无设备/不支持的分支有源码证据；本次浏览器实测的是权限拒绝，
  不把 headless 无设备说成实测权限拒绝，也未验证真实设备成功路径。
- 没有移植 HateNeko 代码；第三方实现不是本次官方证据。
- 全量检查、逐作品 600 帧前后表、环境失败和提交号写入未提交的 `OC-REPORT.md`。
