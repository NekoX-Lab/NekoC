# r4-memory：长期运行的资源生命周期

本任务使用自有积木 AST，不读取或提交第三方作品。测试目标是**已死亡对象
和历史帧不能继续占用资源**，不是禁止仍然存活的列表或绘图内容增长。
不以 RSS、GC 时机或运行耗时作为 CI 断言。

## 修复

- VM 的复用克隆槽位在实际删除时释放未闭合填充路径、文字造型和气泡。
  私有列表仍走既有释放路径；存活克隆的状态和 K4 延迟删除边界不变。
- `StageRenderer.apply` 仅在同步绘制期间持有打包画笔视图，成功、异常、
  无效帧和 context-lost 提前返回均不会留下新的视图引用。
- 角色文字造型 LRU 在既有 256 条上限外增加 16 MiB 名义持有预算：
  `Canvas RGBA + GPU RGBA + alpha mask + UTF-16 key`，即 `9*w*h+2*key.length`。
  淘汰前提交批次，随后删除 GL 纹理并移除 JS 缓存；重新加载清零计数。
  与既有 K4 滤镜池策略一样，允许**一个**超过预算的文字造型独占缓存，
  不缩小文字、不改变命中测试掩码；换成小造型后会回收它。

该预算是逻辑载荷估算，不包括浏览器对象头、驱动分配粒度或重复字符串
存储优化，不应标成实测物理 RAM 或显存。已删除克隆的几何槽位保留并复用，
`Vec` 容量高水位也不保证缩回操作系统；这些不是随执行历史线性增长。
修复前克隆负载滞留到槽位复用，文字缓存虽限制条数但可累计极大的历史
纹理；两者属于不必要的高水位保留，不宣称已经证明它们会无限增长。
画笔视图仅会钉住最近一个完整帧缓冲区，也不是不断叠加历史帧的泄漏。

## 确定性回归

- `tests/r4-memory/workload.rs`：每帧创建 12 个克隆，各绘制 128 段；
  同时操作克隆私有嵌套列表、全局列表，显示文字和气泡，
  等待后删除。作品在 KN 解释器和默认 JIT 各推进 10,000 帧。
- `tests/r4-memory/internal.rs`：逐帧检查槽位、任务、通知、输出和全局
  列表边界，预热后容器容量必须保持不变；用 `Weak` 见证私有列表
  及嵌套列表的释放，重启释放存活值。
  独立回归检查 KN 立即删除和 K4 延迟删除前后大轮廓/文字/气泡的寿命。
- `tests/r4-memory.test.mjs`：10,000 次克隆绘制/删除，检查真实 renderer
  方法的持有容器和 GL create/delete 计数；覆盖按字节及条数淘汰、LRU、
  批次提交次序、单个超预算造型、重载释放、异常和 context-lost。
  可选浏览器测试在 KN 和 K4 两条路径各运行 2,000 帧，每帧 64 段，
  检查真实 GL 资源生命周期、持久画笔像素和 GL 错误。

```bash
bash E:/nekoc-wt/_cargo.sh test --lib r4_memory_tests -- --nocapture
bash E:/nekoc-wt/_cargo.sh test --lib export_original_work_for_editor_check -- --ignored
bash E:/nekoc-wt/_remote.sh 'NEKOC_R4_MEMORY_BROWSER=1 node --test tests/r4-memory.test.mjs'
```

导出的自有作品为远端 `target/r4-memory/original.bcmkn`；远端安装有 Playwright
及 Chromium 后，可执行 `node tools/editor-compat.mjs` 检查官方编辑器兼容性。
使用 Edge 时为浏览器回归设置 `NEKOC_BROWSER_CHANNEL=msedge`。

## 官方证据与边界

生命周期修复沿用已有语义，而不增加官方内存限制。K4 实际删除前保留
本帧 drawable 的行为，证据在 `docs/kitten4-partial-lifecycle-7.md` 及
`src/engine/k4_lifecycle.rs` 引用的官方 `iNFq/destruct_entity/update_dispose`；
既有 `tests/kitten4_semantics.rs` / `tests/kitten4_partial_lifecycle_7.rs`
回归覆盖删除时序。16 MiB 是 NekoC 缓存策略，不是官方限制。

本测试不证明官方长时间运行的内存曲线，也不证明 wasm 线性内存会缩小。
官方作品对本次组合压力的逐帧输出一致性**未验证**；浏览器资源计数
不能证明驱动立即返还物理显存。遗留原生 KN `_object_*` 可构造 Rc 环，
本次无环列表压力不覆盖通用对象环回收，仍属后续范围。
