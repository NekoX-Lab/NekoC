# WASM 播放器本地性能复验

`tools/profile-wasm-player.mjs` 测量真实浏览器中的 Worker 后端，与同机
Rust WebSocket 后端对照。它不向 CI 添加耗时断言，也不把测量数字写进文档。

## 准备

安装 TypeScript、Playwright、Chromium/Edge、Rust WASM target，以及与
`Cargo.lock` 匹配的 wasm-bindgen CLI；详见 `packages/nekoc/README.md`。

```bash
node packages/nekoc/build.mjs
cargo build --release --bin web
node tools/profile-wasm-player.mjs --out dist/wasm-player/profile.json
```

支持 `NEKOC_CARGO_WRAPPER`（包构建）、`WASM_BINDGEN`、`NEKOC_NODE_MODULES`
和 `NEKOC_BROWSER_CHANNEL`。需走仓库外 cargo wrapper 的环境应通过 wrapper
执行上面的 cargo 命令。

可指定作品、WASM 绑定目录、本机后端二进制及样本量：

```bash
node tools/profile-wasm-player.mjs \
  --wasm packages/nekoc/dist/web --web target/release/web.exe \
  --runs 5 --warmup 30 --frames 180 --budget 16 \
  --out dist/wasm-player/after.json \
  samples/three_body.bcmkn samples/pen_display_fast.bcmkn
```

比较改动前后时，分别保存同版本 wasm-bindgen 生成的两个绑定目录，顺序运行，
避免同时跑浏览器或本机重型构建。结果包含作品和 WASM 的 SHA-256，
但不包含作品内容或私有变量快照。

## 指标边界

- 每次新建浏览器进程和本机 Rust 服务，避免后端导入缓存跨次复用。
  同一次测量交替先测 WASM / Rust，减少固定顺序偏差。
- 真实链路使用 `wasmBackend`、`PlayerConnection`、`StageRenderer`。
  启动分为作品下载、JS 解析、Worker 导入、素材加载、握手、首帧。
  计时从上述前端模块导入完成后开始，不包含这些模块的下载、解析和执行；
  `startup.total` 是此边界内的启动时间，不是完整网页导航冷启动时间。
  `assets` 包括创建渲染器、素材加载和初始静态画面提交，不是纯素材下载耗时。
  Worker 导入包含 Worker 启动、WASM 流式初始化、诊断和协议转换，
  **不能**把它称为纯解析耗时。
- 另用独立浏览器拆测绑定加载、WASM 下载、`WebAssembly.compile`、实例化，
  以及导入、导入结果解析、握手序列化和 WASM 内的解析/编译/启动。
  拆测会禁用流式编译，不能把各阶段简单相加当成真实启动时间。
- HTTP 使用 loopback 和 `no-store`，不是公网/弱网下载测量；浏览器进程之外
  的操作系统磁盘缓存未清空。素材仍遵循项目 URL，自带公网素材可能波动。
- 首帧以 `gl.finish()` 完成为界，表示 GPU 命令已完成，不是物理屏幕扫描完成。
  不含播放器外壳布局、用户点击等待、音频解码或设备授权。
- 稳定运行先预热，再记录每帧 VM、往返、解码、绘制提交和总耗时，保留原始样本。
  使用固定 `dt`、相同 budget、不合并 tick，不按显示刷新率等待；稳定阶段的
  绘制只统计 CPU 提交，不逐帧等待 GPU 完成。
- 结果同时记录指令数量、预算让出次数、传输字节和素材错误。
  原生有 JIT，WASM 无 JIT；时间预算让出、随机数和外部素材可能令完成工作量不同。
  **不同工作量的帧耗时不能直接解释为 VM 加速比。** 使用中位数和尾部数据，
  不以单次均值或受干扰样本宣称性能改进。

## 本次优化范围

WASM 导入回复保持 `{project, report}` 格式，但直接借用导入后的树进行序列化，
不再通过 `json!` 先把整棵作品和报告复制成第二棵 `Value` 树。
作品、诊断、扩展字段、K4 保真元数据和帧协议均不变；JS API 不变。
Rust 单元测试核对原始编码，npm 包测试覆盖 node/web 两套真实绑定。
可选真实链路冒烟（不设时间阈值）：

```bash
NEKOC_WASM_PROFILE_E2E=1 node --test tests/r2-wasm.test.mjs
```

此测试沿用基准的构建/浏览器前提，校验双后端首帧、样本数量和统计数据。
支持 `NEKOC_WEB_BIN` 和 `NEKOC_PROFILE_WASM_DIR` 指定构建产物。

此改动不缓存作品或 VM，不共享运行状态，也不延后素材加载；没有修改调度器、
时间预算、编译优化级别或官方积木语义。对素材加载占主导的作品，单独消除
序列化复制不保证总启动时间明显下降。后续可以在保持资源几何/碰撞和场景切换
语义的前提下单独研究素材策略，不应凭启动数字改变素材可用时机。
