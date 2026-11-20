# KN 变量／列表监视器外观取证

本页记录公开 KN 播放器的 DOM 实测和 NekoC 的实现范围，不代表完整作品的 VM、性能或逐像素一致性。

## 官方来源与复现

匿名打开并点击中央播放按钮：

- <https://kn.codemao.cn/player?type=2&workId=328708918>：`FPS`、`渲染延迟`。
- <https://kn.codemao.cn/player?type=2&workId=333289842>：`物品栏`，点击后展开六个实时条目。
- <https://kn.codemao.cn/player?type=2&workId=336319534>：纯文字监视器，包含保存的 `scale: 2`。

2026-11-19 实测浏览器为 Windows Edge，viewport 1200×800、DPR 1。公开入口实际加载的是新 bundle，而不是任务说明中的旧 hash：

- JS：`https://creation.bcmcdn.com/neko/web/release/static/js/main.d0a9bd01.js`
- SHA-256：`5082351d82cdd430e91da7f8b3b076f998a89d37395f57adbd3f73f17e7b075f`
- 组件 CSS：`https://creation.bcmcdn.com/neko/web/release/static/css/main.8f3874f5.css`，包含 `VariableContent`、`ListWidget`、`StageList` 规则；`459.cfc9844a.chunk.css` 不含这些组件规则，不作为本页数值来源。取证工具将实际命中的 CSS URL、SHA-256 和组件名写入 `evidence-<id>.json` 的 `stylesheets`。
- 2026-11-21 复测该 CSS SHA-256：`6c98aef90b99b34655a99a9e788843fb2b86fb1188cca17dc083e7dd2a7e08c3`。
- JS 字符偏移：`VariableContent_wrapper` 为 11402582；`ListWidget_slideWrapper` 为 11361464。定位后只检查对应组件及常量模块，不提交 bundle 或官方图像。
- JS 常量模块 `94521` 的 `g6 = 0.8`；变量组件的 `transform` 使用保存倍率乘以它。

复现命令（Playwright 不作为生产依赖）：

```bash
NEKOC_NODE_MODULES=<含 playwright 的 node_modules> node tools/compat/r2-knmonitor-oracle.mjs
KN_MONITOR_INTEGRATION=1 NEKOC_NODE_MODULES=<同上> node --test tests/r2-knmonitor.test.mjs
```

工具只匿名访问公开播放器，不登录、不发布。`dist/r2-knmonitor/` 保存下载源码、原作品截图、隔离舞台截图、DOM/CSS 数值及并排图；第三方作品不写入被跟踪文件。比较图隐藏作品画布，向 NekoC `StageOverlay` 输入同一时刻的官方可见值，以隔离监视器排版。它不是两个 VM 跑整部作品的语义比较。

## 测量结果

以下尺寸为组件 CSS 像素。变量与折叠列表按钮还需要乘 **`0.8 × saved.scale × 舞台显示倍率`**：默认 `scale: 1` 的 64px 监视器实际占 51.2 个舞台像素。展开卡片与其中列表行则乘 **列表面板自适应倍率 × 舞台显示倍率**，不乘胶囊的保存倍率。

| 元素 | 官方 DOM/CSS |
| --- | --- |
| 普通变量外壳 | 高 64，背景 `#ffa161`，1px 边框 `#fac8a6`，圆角 16，阴影 `0 3px 0 rgba(0,0,0,.2)`，padding `0 8px 0 16px` |
| 名称 | 24px / 24px、weight 500、`#333`，min-width 32，保留空白 |
| 值框 | 高 48、min-width 56、padding `0 12px`、左 margin 12，白底，2px `#f28926` 边框，圆角 12，24px / 24px、weight 500、`#624026` |
| 私有变量所属角色名 | `#863802`，名称前加角色名和宽 20 的 `·` 分隔 |
| `style: "text"` | 只显示值，无变量名；54px / 54px、weight 800、黑字，1.5px 白描边和 `1px 3px` 阴影 |
| 列表折叠按钮 | 高 64、padding 6、圆角 32、背景 `rgba(0,0,0,.2)`；名称胶囊高 52、min-width 56、padding `0 12px`、圆角 26、背景 `#ffcf29`、22px weight 500、字色 `#344265`；右侧箭头占宽 40 |
| 列表展开卡片 | 原始 308×431；标题高 65，18px / 27px、weight 400；内部列表宽 284、高 348 |
| 列表行 | 高 44；索引宽 60、18px、`#c0cae6`；值 16px、`#51628c`、padding `10px 7px 10px 12px`，单行省略；行 weight 500 |

字体栈为 `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`，以及系统 Emoji 字体。NekoC 对 KN 显式使用同一字体栈，不受 Studio 外层字体覆盖。K4 原有样式不变。

列表不是常驻显示所有内容的灰色小框，也没有 Scratch 风格的长度 footer。点击胶囊后显示独立卡片、关闭按钮；多个列表可左右切换。官方用 `ReactVirtualized` 显示可见行，NekoC 同样只挂载可见行加 overscan。

横屏 900×562：卡片倍率 `445.8 / 431 = 1.0343387471`，左上舞台坐标约 `(290.7118, 58.1)`。竖屏按宽度约束适配。列表面板大小由舞台大小决定，不受胶囊保存倍率影响。

### 保存字段

- `position.x/y`：左上角舞台坐标，不乘监视器自身倍率。
- `scale`：整个监视器围绕左上角缩放，实际组件倍率为 `scale × 0.8`。官方编辑器交互把新倍率夹在 1 到 2；播放器直接消费保存值，因此 NekoC 接受有效正数，包括已有小于 1 的保存值。
- `style`：本轮支持 `default` 与 `text`。
- `currentEntityId`：显示所属角色名称。
- `createTime`：列表切换顺序。
- `offset`：本次 KN 组件不消费它，不应套用 K4 列表的尺寸逻辑。实测把 `offset` 从缺省改为 `{x:87,y:43}`，普通变量、列表胶囊、文字监视器的 rect 和 transform 均不变；把 `scale` 改为 1.5，左上角不动，宽高相对 scale=1 放大 1.5 倍。数据保留但不参与定位、尺寸。

## 实现与数据边界

`web/overlay.js` 的 KN 分支独立于 K4 canvas／DOM 监视器。节点按变量 ID 保留，列表更新和其它变量变化不重建滚动容器。重载作品、重置、隐藏当前列表会关闭面板；按钮、滚轮和键盘事件不泄漏到作品输入。专用按钮重置宿主播放器的 `gap` 和 hover 背景，避免 Studio／独立播放器的通用按钮 CSS 改变胶囊宽度与颜色；浏览器回归同时加载 `web/play.css` 核对。

旧 `Monitor { id, name, list, value }` 保持四字段不变。旧列表文本最多 100 项，且无法区分 `[]`、`[""]` 或含换行元素，不能拆换行反推行。新增的 `Frame.monitor_lists` 是 `id -> string[]`，来自**实时**全局／角色私有列表，保持元素边界和完整长度，仅 KN 可见列表发送；空 map 不序列化，K4 不发送此字段。旧前端可忽略新增字段，展开列表需前后端版本一同更新。

展开行使用官方模块 `45578` 的 `Qz` 有限深度格式，不使用旧 `Cell::text` 的数组强制转换：顶层 null 为 `null`、undefined 为 `undefined`；数组外包 `[]`，其中子数组直接显示 `[...]`，其它元素按 JS `String(value)`。例如 `[]` → `[]`、`["x","y"]` → `[x,y]`、`[[1],2]` → `[[...],2]`、`["",null]` → `[,null]`。旧摘要及 K4 的转换不变。取证工具同时记录官方格式化函数输出和官方展开 DOM 行，临时值只修改当前页面内存，不保存或发布作品。

## 已知差异／后续

- 展开列表的官方装饰 SVG（纸张、星星、勾选插画）没有复制进仓库；NekoC 使用原创黄色 CSS 卡片近似，条目、文本和主要几何位置对齐，但不声称背景逐像素一致。箭头与关闭图标同样使用原创 CSS／字形。
- 本轮不实现预设／自定义图标皮肤、本地持久变量或云变量的小图标；这些类型仍回退到普通外观。布尔值 true/false 的特殊着色没有添加，因为旧标量传输缺少可靠实时类型信息，不能把字符串 `"true"` 猜成布尔值。
- 未验证：移动端触摸滑动切换的惯性／300ms 卡片切换动画、监视器编辑拖动、所有皮肤、跨平台字体像素一致性。本轮提供按钮切换、滚动、键盘关闭。
- 全量可见 KN 列表每帧转字符串并传输，修复了 100 项截断，但特大列表可能增加传输和分配成本；前端虚拟行只限制 DOM 数量，不减少后端 payload。后续可设计按需窗口／增量列表协议。
- 本次没有参考或移植 HateNeko；依据是公开官方播放器 DOM/CSS 和组件读取路径。
