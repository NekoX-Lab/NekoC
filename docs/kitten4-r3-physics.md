# R3：K4 像素碰撞与边缘反弹

本轮将 K4 的像素碰撞和动作反弹从 KN 通用近似中分离，实现在
`src/engine/k4_collision.rs`；不改变物理求解器、调度和 KN 行为。

## 官方证据与复验

只读内核：`K4_PLAYER_DIR/src/player/build/player_v2.2d180c468559fbd29528.js.orig`。
SHA-256：`0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160`。
源码定位（字符偏移用于固定版本辅助搜索，不是复制的实现）：

- `JfQ3`（411282）：`f/u/c/q` 定义 0.7 倍 alpha 缓冲、坐标取整及角色变换。
- `a1xw/Data.get_texture_internal_points`（777305）：12 格间隔、四邻点 alpha 门槛。
- `a1xw/Lt.check_bumped_other`（紧邻 827000）：同场景、显隐、完全离场排除；
  相交矩形按 JS Math.round 取整，横纵步长 2；通常至少五个命中，面积小于 10 的角色一个命中。
- `a1xw/Lt.check_relation_with_edge`（829937）与
  `bounce_if_collision_with_edge`（830611）：边缘感知和动作反弹不是同一种采样。
  反弹按内部不透明点，同时处理右、左、上、下边；重新旋转后按采样极值保留 10 像素间距。
  仅当 pivot 两分量均非零时补偿旋转中心；隐藏角色仍能执行反弹。
- `Tn6a/self_bounce_off_edge`（588804）：调用上面的角色动作，不是物理速度反射。

```bash
# 设置外部只读内核与 Playwright 路径后，在仓库根目录执行
node tools/compat/k4-r3-physics.mjs --record
bash E:/nekoc-wt/_cargo.sh test --test k4_r3_physics
```

`tests/fixtures/kitten4/r3-physics.json` 和 `r3-collision.json` 是仓库原创探针参数及工作区。
工具在内存中合并探针，确保实体/积木 ID 全局唯一；完整 trace 写忽略的
`dist/k4-r3-physics/`。两份 `docs/kitten4-r3-*-evidence.json` 记录输入 hash、
官方资源 hash 和结果，不包含第三方源码或语料。

48 个反弹用例各四个 update，覆盖四边、四角、朝内、透明留白、空造型、小造型、
缩放、旋转类型、单/双轴 pivot 和物理速度。`physical-speed` 确认动作反弹不把向右速度 2
改成向左速度，后续 update 仍向右运动。录制器必须确认真实物理 chunk
`6ed56cf80a197b1dad00403ef2d55f9f4c357cb000cc52b5b0ba32c3989730d6` 已加载。
136 个角色碰撞探针验证双向查询、接边、低于五点/达到五点、小面积例外、离场、显隐与跨场景；
新增奇偶尺寸/交集高度、正负位置/半像素网格、微小角色左右/上下翻转，查询取第4帧以等待翻转生效。
审查修复保持PIXI的Y向下坐标生成采样网格（含JS半整数取整），逐点取负映射回VM；
alpha保留官方一维缓冲的列边界别名，但安全拒绝最终缓冲外索引。
LEFT_RIGHT旧几何判断与`geometry()`采用相同的两层余数归一化，新增±710°、±1070°及±90°/±450°，
覆盖零/双轴/单轴pivot。朝向比较仅容许整圈表示差异，位置仍逐帧严格比较，不掩盖漏反弹。
Rust 回归分别跑解释器及默认 JIT 配置；这些短脚本不证明 native 热区已生成。

## 语料调查

只读扫描 `E:/nekoc/dist/kitten4-corpus` 和 `E:/nekoc/dist/pickcat-corpus/k4`，
例如 263085262、322524617 使用动作反弹，143928845 使用物理碰撞控制。
对三份作品各取得官方 60 update；运行原本地诊断二进制对比的最早角色差异分别是：

| 作品 | 观察 | 结论边界 |
| --- | --- | --- |
| 263085262 | 第16帧 rotation，官方约37、本地0 | 本地未注入 alpha 素材；不能据此断言剩余反弹算法错误 |
| 143928845 | 第1帧 clone ID presence | 未配对随机克隆 ID；不是碰撞结果差异证据 |
| 322524617 | 第1帧 x，官方约53.6144、本地-480 | 完整作品初始状态/素材/随机输入未隔离，未验证 |

完整语料结果仅保留在 `dist/k4-r3-physics/corpus-summary.json`，不将语料或素材入库。
本地二进制采集于反弹修复后、五点碰撞修复前，表格不是最终版本全语料认证。
修复结论以原创同输入探针和固定内核源码为依据，不宣称三份完整作品已对齐。

## 保留边界

- alpha 缓冲从已有二值 mask 中心点重采样；任意图片的 Canvas 双线性重采样、半透明边缘、
  文字和复杂滤镜链**未验证**。无 mask 仍沿用矩形假设。
- `bump` 对舞台边缘仍使用已有路径；本轮没有声称复现轮廓 marching-squares 全部细节。
  反弹后 `bump(edge)` 仍可能为真，官方实测如此，不应强行清零。
- 物理接触仍走已有 Rapier/plane 路径；旋转刚体、多体接触、soft 与 LiquidFun 完整等价**未验证**。
- 超大透明输入设置安全上限：相交采样超过一百万点返回 false；反弹 alpha 缓冲超过
  一百万像素不执行反弹。此范围不宣称官方一致。
- 不复现官方一帧内缓存旧的碰撞结果；同帧移动后重复查询的缓存相位**未验证**。
- 未移植 HateNeko 或官方实现；仅按源码可观察规则独立编写。
