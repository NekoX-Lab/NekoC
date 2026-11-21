# 可直接运行的创作模板

复制一个 `.nk.ts` 即可开始创作；无需底板作品或素材下载。五个模板的色块造型是源码内的 PNG data URL，可替换成自己的图片 URL（星星/背包先用占位色块表示）。编译产物不入库。

提示使用不等待的 `think()` 气泡；`say()` 在当前前端默认等待两秒，不适合直接放进需要快速响应的按键事件。
数字键按当前 API 写键码字符串（`"49"` / `"50"` 对应主键盘 1 / 2），不要写成 `"1"` / `"2"`。

| 模板 | 操作 | 参数修改位置 | 已知限制 |
| --- | --- | --- | --- |
| [移动与碰撞](movement-collision.nk.ts) | 方向键移动蓝色方块，绕过橙墙；R 复位 | 文件顶部 `SPEED`、`START_*`、`LIMIT_*`、`PLAYER_HALF`、`WALL_*` | 单个静态轴对齐障碍；按轴撤回，无重力/物理引擎；斜向较快；大步长会穿墙，请保持默认小步长。改碰撞尺寸时也要同步造型尺寸；保持默认中心偏移 0 |
| [菜单与场景切换](menu-scenes.nk.ts) | 点击蓝色按钮或松开空格开始；点击星星/松开空格加分；松开 M 返回 | 顶部 `TITLE`、`TARGET_SCORE`；`menu`/`game` 两个 `screen` 声明 | 每次进入游戏重置得分，`visits` 累计进入次数；没有存档；键盘以松开触发，避免长按重复切换 |
| [列表背包](list-inventory.nk.ts) | 松开 1/2 拾取苹果/药水；松开空格使用第一格；松开 R 清空 | 顶部 `CAPACITY`、`ITEM_ONE/TWO`、`appendList("inventory", ...)` 初始物品 | 同名物品独占一格，先进先出；用官方命名列表 API，索引从 1 开始；无拖拽/堆叠/持久化；容量应为正整数且不小于初始列表长度 |
| [菜单、挑战与结算](menu-scenes-quest.nk.ts) | 点击蓝色按钮/松开空格开始；点击金色方块/松开空格收集；达标自动结算；结算页点击按钮/松开 R 重玩；游戏或结算页松开 M 返回 | 顶部 `TITLE`、正整数 `TARGET_SCORE`；`menu`/`play`/`result` 三个 `screen` 及其造型常量 | 每次进入挑战清零分数、累计局数；结算保留本局分数；无存档，重新运行作品全部重置 |
| [可选格列表背包](list-inventory-select.nk.ts) | 松开 1/2 拾取；松开左右键循环选格（方括号标记）；松开空格使用选中格；松开 D 丢弃；松开 R 清空 | 顶部正整数 `CAPACITY`、`ITEM_ONE/TWO`、初始 `appendList`；`used` 为本次运行使用次数 | 同名物品各占一格；删除末格后选中前一格，空包选中值为 1；清空不重置使用次数；无堆叠/拖拽/存档；初始物品数不能超过容量 |

## 编译、检查、运行

先按仓库根目录说明安装 NekoC 和 Node.js。以下在仓库根目录运行，把文件名换成其它模板也一样：

```bash
mkdir -p dist
nekoc check samples/templates/movement-collision.nk.ts --json
nekoc build samples/templates/movement-collision.nk.ts -o dist/movement-collision.bcmkn
nekoc run dist/movement-collision.bcmkn --ticks 600
node tools/editor-compat.mjs dist/movement-collision.bcmkn
```

`editor-compat` 需要 Playwright 和可访问的官方编辑器，结果必须为 `ok: true`。
无头 `run` 不显示画面；实际操作可把产物导入 Kitten N 官方编辑器，或用 Web Studio 打开（见根目录 README）。先点击舞台获得键盘焦点。

自动回归：`cargo test --test r2_templates`。测试从这三个源文件构建 `.bcmkn`、检查结构、各运行 600 帧，并通过逐帧输入验证撞墙/绕行/边界、菜单往返与分数重置、背包容量/顺序/空包操作。官方编辑器检查验证积木可载入，不等于完整官方运行行为一致性证明。

移动循环的 `wait(0.02)` 不是“每两帧移动一次”：官方 KN 的等待初始化、到期观察、入口释放和循环边界分开推进（实测依据见 [KN 时序说明](../../docs/kn-r3-scheduling.md)）。在测试的 60 Hz 更新下，每四次更新移动 4 像素，因此从 x=-180 向右按住 120 帧只到 x=-60，尚未撞墙；继续按住才停在 x=-48。回归分别验证这两个状态，并给绕行及舞台边界留足输入帧数，不以旧的等待提前恢复时序作为期望。模板步长、碰撞尺寸和松开触发的按键逻辑不因此改变。

`node --test tests/r2-templates.test.mjs` 另检查前端编译和内嵌 PNG 完整性，无需浏览器或网络。

新增进阶模板回归：`cargo test --test r4_templates2`。对两个模板分别检查 TS 类型、编译产物结构、空跑 600 帧，并在优化/非优化、JIT/解释器组合下重放输入：三场景往返、达标结算、重玩与中途退出、满包拒绝、左右循环选格、使用/丢弃中间和末尾物品、空包操作、清空后继续拾取及重新启动重置。上述操作语义由 NekoC 本地引擎验证；官方编辑器 `editor-compat` 仅证明积木结构可载入，完整官方交互行为仍为**未验证**，不据此声称官方运行逐帧一致。

两个进阶模板可以独立构建，不依赖基础版源文件：

```bash
nekoc check samples/templates/menu-scenes-quest.nk.ts --json
nekoc build samples/templates/menu-scenes-quest.nk.ts -o dist/menu-scenes-quest.bcmkn
nekoc check samples/templates/list-inventory-select.nk.ts --json
nekoc build samples/templates/list-inventory-select.nk.ts -o dist/list-inventory-select.bcmkn
node tools/editor-compat.mjs dist/menu-scenes-quest.bcmkn dist/list-inventory-select.bcmkn
```

修改目标分数时保持 `TARGET_SCORE` 为正整数；修改背包容量时保持 `CAPACITY` 为正整数且不小于初始物品数，建议保持较小容量以便气泡完整展示。使用物品只删除选中项并增加 `used`，不附带生命值等游戏效果；可在空格事件中按物品名添加自己的效果。`R` 只清空背包，重新启动整个作品才重置 `used` 和初始物品。

### 进阶模板的官方编辑器实测

2026-11-21 使用 `tools/editor-compat.mjs` 在 `https://kn.codemao.cn/editor` 检查优化/非优化四个产物，官方编辑器版本及工程版本均为 **0.27.4**，每项及总结果均为 `ok: true`，`issues: []`、`pageErrors: []`。当时编辑器脚本为 `main.bfc86683.js`。

| 模板（优化/非优化产物相同） | 积木数 | 产物 SHA-256 |
| --- | ---: | --- |
| `menu-scenes-quest` | 93 | `aa83368a732a814ce9778215c9f7386af33ae58406e3d7fed7f2a0d820664790` |
| `list-inventory-select` | 248 | `2aab9d550e93e91d48851c047ede099fd9ad511328683cf1cf3a76dc1f0e587d` |

这证明上述字节的作品能够通过官方编辑器结构、积木字段及连接检查；不将此结果扩大解释为官方播放器全交互或逐帧一致性证据。编译产物及原始检查报告保存在本次验证的被忽略目录 `dist/r4-templates2/`，不入库；可用上述构建和检查命令重新验证。
