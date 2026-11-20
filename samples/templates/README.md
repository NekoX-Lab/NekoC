# 可直接运行的创作模板

复制一个 `.nk.ts` 即可开始创作；无需底板作品或素材下载。三个模板的色块造型是源码内的 PNG data URL，可替换成自己的图片 URL（星星/背包先用占位色块表示）。编译产物不入库。

提示使用不等待的 `think()` 气泡；`say()` 在当前前端默认等待两秒，不适合直接放进需要快速响应的按键事件。
数字键按当前 API 写键码字符串（`"49"` / `"50"` 对应主键盘 1 / 2），不要写成 `"1"` / `"2"`。

| 模板 | 操作 | 参数修改位置 | 已知限制 |
| --- | --- | --- | --- |
| [移动与碰撞](movement-collision.nk.ts) | 方向键移动蓝色方块，绕过橙墙；R 复位 | 文件顶部 `SPEED`、`START_*`、`LIMIT_*`、`PLAYER_HALF`、`WALL_*` | 单个静态轴对齐障碍；按轴撤回，无重力/物理引擎；斜向较快；大步长会穿墙，请保持默认小步长。改碰撞尺寸时也要同步造型尺寸；保持默认中心偏移 0 |
| [菜单与场景切换](menu-scenes.nk.ts) | 点击蓝色按钮或松开空格开始；点击星星/松开空格加分；松开 M 返回 | 顶部 `TITLE`、`TARGET_SCORE`；`menu`/`game` 两个 `screen` 声明 | 每次进入游戏重置得分，`visits` 累计进入次数；没有存档；键盘以松开触发，避免长按重复切换 |
| [列表背包](list-inventory.nk.ts) | 松开 1/2 拾取苹果/药水；松开空格使用第一格；松开 R 清空 | 顶部 `CAPACITY`、`ITEM_ONE/TWO`、`appendList("inventory", ...)` 初始物品 | 同名物品独占一格，先进先出；用官方命名列表 API，索引从 1 开始；无拖拽/堆叠/持久化；容量应为正整数且不小于初始列表长度 |

## 编译、检查、运行

先按仓库根目录说明安装 NekoC 和 Node.js。以下在仓库根目录运行，把文件名换成另两个模板也一样：

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
