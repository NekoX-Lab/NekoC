# r3-k4effects：零角度扭曲仍是启用的滤镜

基线：`d6de981`。本次只修复一类有官方证据的像素差异，不升级五种特效写入积木的整体兼容等级。

## 原因与修复

第十一轮链式特效夹具在清除后再次逐项写入中性值。写入扭曲 `0` 时，官方仍启用
TwistFilter，并保留 `20px` padding；本地原先仅以 `effects[5] > 0` 判断是否启用。
这改变了后续像素化和 ASCII 的共享滤镜边界、POT 中间纹理大小及采样格线，
即使扭曲角度本身为零，也不能当作“关闭滤镜”。

VM 现在单独记录 `k4_twist_enabled`：有效 scope 5 写入后为真，clear 后为假。
数值数组和属性读取保持原样，不用特殊浮点数充当状态。该字段只在真时序列化，
KN 和未启用滤镜的旧帧格式不变。普通克隆和帧快照保留此状态；重新启动从初始状态恢复。
渲染器的角色、场景背景和软体光栅入口传递此状态，并在零角度时保留 padded pass。
增量帧仅改变该状态也会触发重绘。没有改调度、表达式编译、滤镜公式或容差。

## 官方证据

离线包只读路径：`E:/nekoc-wt/_ref/k4player/Kitten4播放器/resources/app`。
包内 `src/player/build/player_v2.2d180c468559fbd29528.js.orig` SHA-256：
`0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160`。
以下位置是 UTF-8 解码后的 **0-based UTF-16 offset**：

| 方法 | offset | 行为 |
| --- | ---: | --- |
| `a1xw/jt.get_effect_filter` | 793395 | 创建/复用滤镜后无条件设 enabled=true |
| `a1xw/jt.set_twist` | 795853 | 先启用滤镜，再夹取角度到 0..100，设置角度、半径、offset |
| `a1xw/jt.disable_effects` | 796653 | 禁用各滤镜并恢复默认读数 |

`r3-k4effects-official.json` 保存上述窗口 hash、包身份和官方 VM 连续52帧的真实
filter enabled/padding/angle 观测。第27..32帧角度为0、enabled=true、padding=20；
clear 后 enabled=false。这不是通过伪造 renderer 输入推导的结论。
没有移植 HateNeko，也没有复制官方函数体、shader、素材或第三方作品入库。

## 像素结果

复用仓库原创第十一轮 `.bcm` 和内联 SVG，不修改历史夹具或历史证据。
两端真实 VM 逐帧运行，固定60Hz、seed=1，960×720 全画布，白底复合，RGB容差8，
零遮罩。修复前后使用相同夹具和官方包；每次捕获前后核查 executable、renderer、fixture
身份不变。完整 PNG、帧状态及容差0/1辅助结果留在忽略的 `dist/r3-k4effects/`；
入库证据 `r3-k4effects-pixels.json` 仅保留逐帧容差8计数、MAE和身份信息。

| 原创夹具 | 连续帧 | 修复前最大超差像素 | 修复后 |
| --- | ---: | ---: | ---: |
| `self_set_effect_2-actor-chain` | 52 | 629 | 0 |
| `self_change_effect_3-actor-chain` | 66 | 629 | 0 |
| `self_set_effect_2-scene-chain` | 52 | 1679 | 0 |
| `self_change_effect_3-scene-chain` | 66 | 1679 | 0 |

共236帧，修复前各有6帧超差，修复后全部为0。这里的0表示**容差8内通过**，
不表示每个字节完全一致。Rust 回归在解释器/JIT 两种模式下覆盖五种 writer、场景/角色、
clear、重启及 KN 序列化兼容；Node 回归绑定官方观测与配对像素证据。

## 复验

```bash
export K4_PLAYER_DIR='E:/nekoc-wt/_ref/k4player/Kitten4播放器/resources/app'
export NEKOC_NODE_MODULES='D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules'
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 bash E:/nekoc-wt/_cargo.sh build --bin k4-trace
node tools/compat/r3-k4effects.mjs --probe
node tools/compat/r3-k4effects.mjs --label=fixed
bash E:/nekoc-wt/_cargo.sh test --test r3_k4effects
bash E:/nekoc-wt/_remote.sh 'node --test tests/r3-k4effects.test.mjs tests/kn-catalog-status.test.mjs'
```

修复前需另以基线二进制与基线 renderer 运行 `--label=baseline`（不要把当前代码的
结果冒充基线）。两次结果齐备后 `--record` 可整理入库证据。

变基至 PR #83 的合批/图章缓存实现后，重新采集了以上四组 fixed 证据，
`rendererLfSha256` 绑定合并后的文件；baseline 和第十一轮历史证据保持不变。
启用零角度扭曲的 K4 绘制不会进入普通合批，进入 padded pass 前先提交已有批次；
过滤器内部与最终复合也不合批。图章的缓存命中、第二次使用准入和淘汰策略保持原样。
`tests/r3-render.test.mjs` 补充缓存图章到滤镜的提交顺序测试；启用
`NEKOC_R3_RENDER_BROWSER=1` 时还对比关闭合批/图章缓存的同版渲染器，覆盖冷/热
图章、仅启用位变化、混合角色和背景的零角度滤镜。该对比验证优化不改变像素，
不替代以上真实官方 VM 对照。

## 未验证与后续

- ripple 的官方 displacement 素材在指定包中不可用，本次仍排除 scope 4，完整资源条件**未验证**。
- 多GPU、多倍率、任意实数角度、全部滤镜排列、动态变装/缩放、竞争切场及软体边缘像素**未验证**。
- 颜色/亮度等中性矩阵自身的“启用而非关闭”差别未引入通用状态模型；本次只处理已测量的零角度扭曲。
- 继承快照与普通克隆保留字段有结构/单元测试覆盖，但零角度扭曲克隆的官方像素配对**未验证**。
- 未生成/修改 KN `.bcmkn`；额外以现有原创 `kn-warp/straight-line.bcmkn` 跑官方编辑器检查，
  版本0.27.4，`ok: true`。这不替代 K4 原生播放器证据。
