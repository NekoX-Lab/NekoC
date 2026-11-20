# r3-knpen：KN 画笔起点叠色与重复落笔

本次交付一个可独立合并的画笔修复，不宣称画笔／图章／填充／图层全域已对齐。

## 官方证据

- 匿名官方播放器：<https://kn.codemao.cn/player?type=2&workId=336156254>。
- 只读语料：作品「画笔」，原始 JSON SHA-256
  `a67430d73f409da665eef2a53580a3f3a92df13f86cb65fef700b6540a195b29`。
- 播放器运行时版本 `0.27.4`；本次主 bundle 为
  `https://creation.bcmcdn.com/neko/web/release/static/js/main.d0a9bd01.js`，
  SHA-256 `5082351d82cdd430e91da7f8b3b076f998a89d37395f57adbd3f73f17e7b075f`。
- [冻结实测](r3-knpen-evidence.json) 保存版本、bundle 哈希、源码锚点位置、
  每例实际绘制增量／像素样本和并排比较误差，不包含第三方实现源码或作品内容。

实验在真实官方播放器载入语料、点击播放后执行。使用原生 registry 的画笔函数，
通过单次同步 `page.evaluate` 调用原创动作序列；项目脚本不会插入这次 JS 执行中。
唯一被包装的 `draw_line` 只记录参数并转发原函数。原生画笔上下文直接提供像素。
这属于语料环境中的**隔离语义探针**，不是原作品按原输入完整运行的帧同步验证。

官方实际行为：

1. 每条移动先在原坐标画圆，再画闭合、圆角的两点线段，两次 source-over。
2. 落笔时画零长度点；零长度 Canvas stroke 本身没有像素，因此只画一次圆。
3. 已落笔且原坐标任一轴为零时，再落笔会再画点；两轴非零时不重复画。
4. 清除共享画笔画布，但不抬笔，下一段仍从当前位置继续。

## 修复

旧 KN GPU shader 每条线只画一次胶囊，漏掉移动起点的额外叠色。
新 shader 在**单个实例内**先合成圆盘、后合成线段，保留原有 9-float 协议、
批量实例绘制和印章分割位置，不增加 CPU 历史或把所有圆盘／线段拆成两批。
零长度仍只有圆盘；不同颜色的交叉段保持提交顺序。

VM 的重复落笔判断和颜色感应 raster 复用 KN／K4 共同的 Canvas 规则，放在
`src/engine/canvas_pen.rs`。K4 原有规则不变。

50% 透明度的起点（颜色 `#204060`）：

| 像素 | 官方 alpha | 修复前 alpha | 修复后 alpha |
| --- | ---: | ---: | ---: |
| 落笔后移动的起点 | 224 | 192 | 223 |
| 中间线段 | 128 | 128 | 128 |

新实现是解析式 GPU 抗锯齿，不是官方 Canvas 的逐像素复制；起点内部残留 1 byte
量化误差。圆边／细线仍有抗锯齿差异，3.5 宽度的误差可能略增，**未解决**。
颜色感应仍沿用无 AA 的像素中心采样；不宣称颜色碰撞完全等价官方。

## 复验

所有 cargo 命令按工作环境规则经 `bash E:/nekoc-wt/_cargo.sh` 执行。

1. `cargo test --test r3_knpen -- --nocapture` 的
   `R3_KNPEN_FRAMES=[...]` JSON 保存为 `dist/r3-knpen/frames.json`。
2. `node tools/compat/r3-knpen-fixtures.mjs` 在忽略目录生成原创 `.bcmkn`；
   `node tools/editor-compat.mjs dist/r3-knpen/fixtures/*.bcmkn --channel msedge`
   核对官方编辑器接受。
3. 设置 `NEKOC_NODE_MODULES` 后运行：
   `node tools/compat/r3-knpen-probe.mjs <只读语料文件> --player --record`。
   此命令须实际 VM 输出与官方记录逐值相等（容差 `1e-6`）才允许记录。
4. 并排图在 `dist/r3-knpen/player-*-comparison.png`，列顺序：官方／修复前／修复后。
   修复前固定为提交 `d6de981`，不随当前 HEAD 变化。
5. `R3_KNPEN_BROWSER=1 node --test tests/r3-knpen.test.mjs` 对真实 WebGL 做
   0.5×／1×／2× 内部像素、颜色交叉、印章批次分割、空闲帧和清除回归。
   薄线／端点 AA 边界不冒充精确相等断言。

## 未验证／后续

- 图章（文字、造型）、填充和角色／画笔图层全序未在本次隔离画笔探针中验证；
  不因已有实现或 K4 证据而视为 KN 一致性证明。
- 语料完整交互流程、跨场景画笔保留、多浏览器／实体 GPU 的 AA、超大坐标和
  极短非零线段尚未验证。
- 未移植或参考 HateNeko；实现依据官方播放器实测及源码锚点。
