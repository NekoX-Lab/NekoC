# 导出自带播放器的 HTML / ZIP

`nekoc export-player` 将作品、图片 / 音频 / 视频、NekoC WASM 运行器和网页入口打成一个目录或 ZIP。解压后双击 `index.html`，或将整个目录部署到任意静态站点的子目录；播放端不需要 Node、Rust 或本机服务。

## 准备导出工具

当前导出命令面向源码 checkout：需要 Node.js 22+、Rust 的 `wasm32-unknown-unknown` target，以及与 `Cargo.lock` 匹配的 wasm-bindgen CLI。生成的包则完全独立。

```bash
npm ci --ignore-scripts
rustup target add wasm32-unknown-unknown
# wasm-bindgen CLI 版本须与 Cargo.lock 一致；也可用 WASM_BINDGEN 指定其路径。
# 在本任务的共享构建环境中，所有 cargo 命令必须通过信号量。
export NEKOC_CARGO_WRAPPER=E:/nekoc-wt/_cargo.sh
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
node packages/nekoc/build.mjs
bash E:/nekoc-wt/_cargo.sh build --bin nekoc
```

其它开发环境使用自己的 cargo 包装器，或不设置 `NEKOC_CARGO_WRAPPER`；这是**构建时**依赖，不是播放时服务。默认 WASM web 绑定来自 `packages/nekoc/dist/web`。

## CLI

```bash
# 仓库自有的小型 K4 示例：两个内联 SVG，不依赖第三方作品或网络素材。
target/debug/nekoc export-player tests/fixtures/kitten4/visual-stamp.bcm --out dist/my-player
target/debug/nekoc export-player tests/fixtures/kitten4/visual-stamp.bcm --out dist/my-player.zip

# KN .bcmkn 同样支持；自定义的 WASM 绑定必须与当前源码版本配套。
target/debug/nekoc export-player my-game.bcmkn --out dist/my-game --wasm-dir packages/nekoc/dist/web
```

Windows 可使用 `target/debug/nekoc.exe`。输出扩展名为 `.zip`（不区分大小写）时生成 ZIP，否则生成目录。**输出路径必须不存在**；不会清空已有文件或目录。打包失败退出非零，错误包含失败素材的名称与原因。原始作品保持不变。

ZIP 发布使用同文件系统硬链接以避免覆盖已有文件，目标文件系统需支持硬链接（例如 NTFS / ext4）；不支持时请导出目录。

命令先使用原生导入器检查作品结构和积木支持，再启动 Node 打包器。导出工具查找默认源码树的 `tools/build-player-export.mjs`；迁移工具目录后可用 `NEKOC_PLAYER_EXPORT` 指定该脚本的完整路径，脚本仍需配套的 `web/`、`LICENSE` 和 npm 依赖。此版本未把导出工具加进预构建 CLI / npm 发布压缩包。

## 包的结构与离线机制

| 文件 | 内容 |
| --- | --- |
| `index.html` | 明确的「开始游玩」入口，初次打开不自动执行作品 |
| `play.css`、`player.js` | 现有播放器的样式和打包脚本 |
| `project.js` | 作品数据及转换为 data URL 的全部资源字典素材 |
| `runtime.js` | WASM 字节及 Worker 代码；播放时创建 Blob Worker |
| `manifest.json` | 素材大小 / SHA-256、运行器大小、各文件大小 / SHA-256 |
| `README.txt`、`LICENSE.txt` | 离线打开说明及 NekoC 许可证 |

入口只使用相对路径的经典脚本和 CSS。运行器从内存字节初始化，Worker 是自包含经典脚本，无需 `fetch(file://...)`、跨源 ES module 加载、浏览器安全开关或服务端 API。静态托管也使用相同文件和 WASM 后端。ZIP 必须先完整解压，不能只打开压缩包预览中的 HTML。

导出时解析图片 / 音频 / 视频资源字典；支持 `data:`、相对于输入作品目录的文件路径、`file:`、HTTP 和 HTTPS。重复地址只读取一次。资源名、ID 和程序字符串保持原样，程序内的 URL / 云数据不当作素材自动下载。带外部引用的 SVG 会明确拒绝，请先转换为自包含 SVG 或 PNG。

K4 先通过原生导出器把规范数据中的编辑应用到源作品，再内嵌素材并重新导入，保持修改与保真元数据一致；不会把第三方作品复制进源码树。

## 环境与体验

- 浏览器需支持 WebAssembly、Web Worker 和 WebGL 2；打开后显示 `WASM · 浏览器内运行`。普通本机 Web 服务显示 `本机 VM`。
- 页面显示 WASM 下载字节数（静态站）、内置字节读取（离线包）、初始化阶段，以及图片 / 视频处理数。未知总量显示不定进度，不伪造百分比。音频仍在播放时解码。
- 「暂停」保留进度；「停止」关闭当前运行会话、释放输入和媒体，下一次「开始游玩」从头执行；「重玩」重新加载资源并启动。
- 运行错误位于舞台外的可滚动提示区，支持聚焦和关闭；不会盖住舞台中心。错误后可重新开始或导入。
- 重作品需要更多下载、解码和 WASM 内存；内置运行器的 base64 约增加三分之一存储。单素材上限 64 MiB、去重后素材总量上限 256 MiB，且内嵌后的作品必须满足播放器 64 MiB 握手上限。超限明确报错，应先缩小素材。
- 浏览器的音视频自动播放、麦克风 / 设备权限和安全上下文限制仍适用。依赖网络积木、云端服务或第三方扩展的作品不能因此获得离线服务能力；本包不内嵌外部扩展服务。
- 严格 CSP 的托管站需允许相对脚本、`blob:` Worker、`data:` 媒体和 WASM 编译。

## 回归验证与证据范围

```bash
# 基本打包及错误路径测试无需浏览器 / 真实 WASM。
node --test tests/r2-player-export.test.mjs tests/r2-player-feedback.test.mjs

# 构建完整 CLI + WASM 后，执行真实 Edge / Chromium E2E。
# playwright 可装在本 checkout，或用 NEKOC_NODE_MODULES 指向其 node_modules。
NEKOC_PLAYER_EXPORT_E2E=1 node --test tests/r2-player-export.test.mjs
NEKOC_PLAYER_FEEDBACK_E2E=1 node --test tests/r2-player-feedback.test.mjs
```

真实导出测试调用 CLI，打开目录包的 `file://`、ZIP 解压后的 `file://` 及嵌套静态路径，并使用仓库自有的 `input-kn.bcmkn` 复验 KN 离线包。运行至少八次更新，检查实际截图非黑、停止 / 再开始、无外部 HTTP 请求和无页面异常。`file://` 场景禁用网络，不添加关闭浏览器安全机制的参数。默认浏览器 channel 为 `msedge`，可用 `NEKOC_BROWSER_CHANNEL`、`NEKOC_BIN` 调整。

这些是 **NekoC 自身浏览器回归**，不证明官方播放器一致性。本次未移植 HateNeko，也未修改 VM 积木语义。**未验证**：Safari / Firefox、移动真机、设备权限、音视频全格式、超大作品的内存上限、官方完整 UI 动态对照。
