# Web 绘制批处理与图章缓存

`web/renderer.js` 在两段同步绘制作用域内合并连续纹理绘制：

- `apply()` 的图章增量，写入当前场景的持久画笔 FBO；
- `drawScene()` 的舞台合成，包括造型克隆和文本角色。

## 保持像素的边界

只合并**连续、同纹理、无特效**的 quad，不按纹理重新排序。每批最多
1024 个实例，位置、尺寸、角度和 tint 为每实例属性；顶点变换与片元
运算沿用普通纹理 shader。透明对象仍按原顺序混合。

以下操作前提交待绘批次：换纹理、达到批容量、非空画笔段、填充、
柔体栅格绘制、视频更新、纹理淘汰以及不能批处理的特效路径。作用域
退出时通过 `finally` 提交，避免跨越 FBO、viewport、投影或场景变换。
空间滤镜、背景 repeat UV 和 packed tint 继续使用原路径。

KN 文字印章、文本角色已有纹理缓存，现可直接参与批处理。K4 图章仍
先在 Canvas 上旋转/缩放、栅格化，**不**改成旋转预渲染字形的 GL quad。
缓存键包含完整栅格输入：舞台尺寸、实际分辨率、绝对位置（含亚像素）、
角度、尺寸、对齐/颜色或造型标识，防止错误复用抗锯齿边缘或裁剪结果。
K4 图片图章保留旧路径的透明度/特效策略，本优化不改变其语义。

## 资源上限

- 批缓冲：1024 × 9 个 float，CPU/GPU 各 36 KiB，shader/VAO/缓冲按需创建，
  由同一个 renderer 跨作品复用。
- K4 图章 LRU：最多 128 项、合计 8 MiB RGBA 纹理；超大单项走旧的 scratch
  texture，不进入缓存。重新加载作品释放缓存纹理，重置字节计数。
- 删除或覆盖待绘纹理之前先提交批次，避免延迟引用已释放或被改写的内容。

`stats.stampTextureBytes` 为 K4 图章缓存字节数；`stats.stampUploads`
为当前 `apply()` 内新上传的 K4 图章数量。已有 `textUploads`、
`drawCalls` 的含义不变。

## 回归验证

默认 CI 执行 `tests/r3-render.test.mjs` 中的确定性队列、容量、LRU 与
纹理生命周期测试；不包含耗时断言。

安装 Playwright 并设置 `NEKOC_NODE_MODULES` 后，可启用实浏览器测试：

```bash
NEKOC_R3_RENDER_BROWSER=1 node --test tests/r3-render.test.mjs
```

测试通过 `git show` 读取 `7b057f26955ca47fb2a13c0a0cb17d94fd66fb14` 的
旧 renderer，并校验其 LF SHA-256 为
`eb5f51230e59c5fc695cd489e173282803d568d3b0b3eb54b623692679e028a3`。
这是仓库 round-11 视觉证据记录的源码，不复制任何第三方实现。
测试要求同一浏览器中新旧 renderer 的完整 RGBA **逐字节相同**，不增加
容差、不遮罩画面，包括大量半透明旋转克隆/文字、图章淘汰、画笔/填充
交错、分辨率调整、场景恢复，以及已有 transition-10 的全部 8 组视觉
基线输入及每组 65 个时间采样。

历史官方证据仍为 `docs/kitten4-partial-effects-11-*.json` 和
`docs/kitten4-partial-transition-11-*.json`；其哈希明确指向历史 renderer，
不将旧采集结果改标为新实现。上述新旧像素回归只证明这些输入在被测
浏览器上的画面保持，**不是**对所有作品或所有 GPU 的官方一致性认证。
其它浏览器/GPU、动态字体加载和全语料官方重测属于未验证范围。
