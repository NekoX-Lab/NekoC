# r3-k4ui：K4 选择问答的显示与释放交互

本次交付限定 `ask_and_choose` 的 Web overlay，不修改 VM、公共调度结构、
Kitten N 生成物或第三方作品。输入询问框、介绍弹窗和列表监视器保留现有实现；
不能据此称所有 K4 界面积木已经对齐。

## 官方来源

只读离线文件：
`K4_PLAYER_DIR/src/player/build/player_v2.2d180c468559fbd29528.js.orig`。
SHA-256：`0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160`。
以下偏移为该文件 **0 起始 JavaScript 字符偏移**，不是字节位置：

| 定位 | 行为依据 |
| --- | --- |
| `604355` 附近 `ask_and_choose` | 选项先转成字符串；超过 19 个 UTF-16 code unit 的显示为前 19 个加 `…`。回调仍取原选项，序号加一；空字符串不替换为默认文案 |
| `904644` 附近 `cn.pop_selection` / `on_stage_resize` | 外边距 10，行高 `stageHeight * .0888`；只有 `width > height` 才两列，否则单列 |
| `cn.show` / `show_selections` | 横屏行数 `ceil(count/2)`，竖屏行数 `count`；滑入距离为总行高加 10；偶数列横排、奇数末行仍保持单格宽 |
| `cn.show_header` / domain `ask_and_choose` | 角色可见时用角色气泡提问，不再显示面板标题；空问题不显示空白标题 |
| `cn.init_selections` / `select_item` | `mouseup`、`touchend` 选择；按下不选择。可以从外部按下、移入按钮后释放；hover/touch 高亮底色 `2719487`（`#297eff`），文字白色 |

固定离线包与指定在线发布物的关系见
[既有在线/离线取证](compatibility/k4-online-vs-offline.md)。本次没有重新认证在线发布物，
没有访问内部 GitLab、登录或提交作品。未参考/移植 HateNeko。

## 修复

- K4 根据舞台横竖方向选择 2/1 列，动画初始距离采用相同列数。
- K4 保留空白选项、连续空格和原始答案；只截断显示文本。KN 保持原来的文案和 click 激活。
- K4 明确隐藏空标题及可见角色的标题，不依赖宿主页恰好带有 `[hidden]` CSS。
- K4 在释放时提交选择，并保留键盘/辅助技术的 `click(detail=0)`。
- 同一面板只接受一次成功提交；输入队列拒绝时仍可重试，过期面板不可提交。
- 选择面板拦截 click 及既有指针/键盘事件，避免传播给舞台；touch 激活也有高亮。

### 审查修复：真实输入捕获与触摸

- DOM `touchend.target` 保留按下目标，不能用它决定答案。选择面板改用主指针 `pointerup`
  的 client 坐标，通过 `elementFromPoint` 找到当前面板实际命中的选项；第一项按下、
  第三项释放只提交第三项。`pointercancel` 不提交。`touch-action:none` 防止选择滑动变成页面滚动。
- 背景 canvas 被 `StageInput` 捕获的指针在释放时，先调用活动 overlay 的命中钩子；
  命中选择则通过既有 `releasePointer()` 清理原 target 和 capture，再提交答案，
  不发出舞台 mouse_up、mouse_click 或 swipe。已入队的 mouse_down 不丢弃，
  用空 state 配对清理，保留拖拽的最后位置和队列预留逻辑。KN 不走此分支。
- 吞掉同一次选择后浏览器补发的 mouseup/click，下一次 pointerdown 正常恢复舞台输入；
  键盘/辅助技术 click 仍保留。面板替换/重置后，旧触摸即使被浏览器重新命中到新面板也不能答新题。
- 释放在所有选项之外不提交，允许重试。官方桌面 Edge 触摸模拟在此情况会回退提交
  按下的第一项（本次实测 index=0）；这里有意保留更安全的“不静默选择”差异，
  不声称此边界官方等价。取消、真触屏和多指规则也不外推为完整官方对齐。

## 回归与复现

`tests/r3-k4ui.test.mjs` 默认运行无浏览器的确定性单元测试，包含横屏、竖屏、
正方形、空白/长文本、UTF-16 截断、标题显隐、重复释放、过期控件、背压、事件隔离和 KN 隔离。
默认还验证对照夹具可编辑、没有发布 AST、只有原创内联图片和预期问答积木。
原始版本启用集成的独立运行是 **11/11 通过，0 跳过**；审查指出其 img 背景
没有生产 pointer capture，不能证明背景跨入选择路径。现已升级探针并扩展回归。

`tools/compat/r3-k4ui-probe.mjs` 从仓库原创 fixture 生成四个 **内存中的可编辑 K4 作品**，
官方编译后启动。无第三方语料输入，不生成 `.bcmkn`。
在横屏、竖屏、角色可见、空问题四种情形采集首帧和稳定帧 40 的组件状态及画面，
再对照真实 canvas + `StageInput` + `StageOverlay` + 生产 `play.css`；
canvas 背景由官方同帧去掉选择框后的画面绘入，但事件由生产 `StageInput` 处理。
使用真实浏览器鼠标验证背景按下后移入释放，并断言 capture 清理、配对空 state、
没有舞台点击/抬起/滑动；不再忽略 click 泄漏。

`recordChoiceGestures()` 另外用可信鼠标、键盘和 Edge CDP 触摸逐手势复位，
覆盖背景→第三项、第一项→第三项、触摸 tap、取消、选项外释放、半尺寸舞台、竖屏、
满队列重试、换题/重置中途释放，以及选择后的普通舞台点击。五种手势实际运行同一
官方内核作对照，记录 hash、errors、外部请求和答案；结果在 `dist/r3-k4ui/gestures.json`。
`tests/stage-input.test.mjs` 另有确定性满队列/拖拽测试，断言先释放 capture/旧 target
再入队答案、最后拖拽位置不丢、队列不超过 256，且 KN 不调用 K4 钩子。

```bash
NEKOC_NODE_MODULES=<包含-playwright-的-node_modules> \
K4_PLAYER_DIR=<只读离线-app-目录> \
NEKOC_R3_K4UI_INTEGRATION=1 \
node --test tests/r3-k4ui.test.mjs
```

原始 PNG、逐例及总 JSON 写入忽略的 `dist/r3-k4ui/`；不提交官方画面或代码。
记录包括实际 bundle hash、外部请求动作、按钮位置尺寸、标签、标题显隐、像素残差及选择序号。
像素对照关闭 DOM 自动聚焦，避免把浏览器键盘 focus ring 当作官方图形边线；
生产实现仍保留键盘可访问性，不复制官方图片。

本次 Windows Edge 对照（RGB 容差 8，完整画面 changedPercent）：

| 原创探针 | 首帧 | 稳定帧 40 |
| --- | ---: | ---: |
| landscape，1280×720 三选项 | 0.07194% | 0.74674% |
| portrait，620×900 三选项 | 0.26953% | 1.47993% |
| visible，可见角色 | 0.00022% | 0.54036% |
| no-question，空问题 | 0.00022% | 0.54036% |

几何回归逐按钮四维容差 0.1 舞台像素；实测最大偏差不足 0.05。
像素回归上限为竖屏 1.6%、其它 1%，是保留当前栅格化残差的回归界限，不是官方像素等价声明。
每例官方 `mouseup` 返回 0 起始 index=2，本地返回原始第三项 `"  third  "` 及 choice=3；
hover 的文字均为白色，本地底色 `rgb(41,126,255)` 与官方常量相同。

## 已知边界 / 未验证

- 不声称完全像素相同：PIXI 与 CSS 的字体、圆角边线、阴影和亚像素取整有残差。
- 中间滑入帧暂未作像素一致断言。官方独立 PIXI ticker 与 VM update 不同相位；
  oracle 的第 2 个 VM update 仍可能尚未推进 PIXI，不能把一次 VM update 冒称一次 UI ticker。
  单元测试只验证既有 NekoC 每次 apply 的递推公式；没有修改这条时序。
- 正方形规则有源码和单元测试，未取得原生正方形舞台的官方截图。
- 真触屏设备、多指、屏幕旋转/动态改变舞台尺寸、字体替代、DPR 和跨浏览器均未验证。
- 长问题的 PIXI 宽度测量/标题省略规则、输入询问框样式、介绍分页、列表滚动/皮肤仍是后续；
  本次没有将这些 partial 范围升级为已对齐。
- 浏览器对照实际挂载 StageInput 并让 answer 经其有界队列，不是完整 Rust VM 或真实角色命中差分；
  renderer 的角色命中为 null，实际角色拖拽/取消及队列预留由确定性 StageInput 测试另外覆盖。
