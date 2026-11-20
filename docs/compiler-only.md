# 只用编译器：安装、包内容与验证

## 选择入口

- 只想写 TS 并导出 `.bcmkn`：Node.js 22+ 和 `@fttawa/nekoc` 即可，不需要 Rust。
- 不安装本机依赖：[在线编译页](https://nekox-lab.github.io/NekoC/)在浏览器完成检查和导出。
- 需要原生 `.bcm` 导出、模板参数、watch 或 JIT：[预编译原生包](install.md)包含完整 CLI。
- 修改 NekoC 才需克隆源码、安装 Rust；npm/WASM 构建步骤见[包文档](../packages/nekoc/README.md)。

```sh
npx --yes --package=@fttawa/nekoc nekoc check hello.ts --json
npx --yes --package=@fttawa/nekoc nekoc build hello.ts -o hello.bcmkn
```

本地安装用 `npm install --save-dev --save-exact @fttawa/nekoc`，之后
`npx --no-install nekoc check hello.ts --json` / `npx --no-install nekoc build hello.ts`。
也可安装 Release 的 `fttawa-nekoc-<版本>.tgz`，TypeScript 仍需网络或 npm 缓存。
使用明确的 `--package=@fttawa/nekoc` 或先安装本地包，避免让 npx 猜测包名。

## 实际发布内容

仓库根 `package.json` 是私有开发项目 `nekoc-ts-frontend`；可发布包定义在
`packages/nekoc/package.json`。从仓库根直接 `npm pack` 不是用户安装包的构建流程。

| 包内路径 | 用途 |
| --- | --- |
| `bin/nekoc.mjs` | npm 注册的 `nekoc` 命令；提供 check/build/run |
| `index.mjs`、`browser.mjs`、`api.mjs`、`index.d.ts`、`frame.mjs` | Node/浏览器 API、类型和播放器帧解析 |
| `dist/frontend/` | TS 前端模块与 `nekoc.d.ts`，和原生发布包共享模块清单 |
| `dist/nodejs/` | Node CommonJS wasm-bindgen 绑定与预编译 `.wasm` |
| `dist/web/` | 浏览器 ES module 绑定与预编译 `.wasm` |
| `dist/resources.mjs` | 检查器使用的 NekoC / TypeScript 标准库声明 |
| `package.json`、`README.md`、许可证 | npm 元数据、用法和许可信息 |

唯一 npm 运行时依赖是 TypeScript；没有 native addon 或安装生命周期脚本。
消费者安装时不调用 cargo，也不临时下载原生 NekoC 可执行文件。
`files` 用显式入口清单，排除仅供源码维护者使用的 `build.mjs` 和测试。
Rust 源码、桌面/Web Studio 静态界面、浏览器扩展及示例作品不在这个包里。

当前 WASM 是编译器与播放器共用模块，Node/浏览器各带一份；“只装编译器”是
更轻的**使用路径**，不是新增的仅含编译器模块。npm `--target=kitten4` 选择
K4 兼容检查/降低规则，`build` 输出仍是 `.bcmkn`；原生 `.bcm` 用原生 CLI 导出。
npm `run --frames` 是 WASM 无头日志入口，原生 `run --ticks` 的快照、事件等选项
不能直接照搬。原生包还包括 `nekoc`/`web` 二进制、前端、示例和发布附加资源，
详情见 [install.md](install.md)，二者不是同一种安装包。

## 复测与体积口径

本次基于仓库 `0.4.3` 源码构建、Rust wasm32 release + wasm-bindgen 0.2.130，
在 Node.js 22.23.5 / npm 10.9.9（Linux x64）实际 pack/install 的结果如下。
这是本次首次完整安装的测量快照；压缩包与 README 随后续代码变化会改变，
不应拿这里的数值作为 CI 上限。

| 项目 | 字节 | 约 MiB（1024² 字节） |
| --- | ---: | ---: |
| 当前源码 npm tarball | 3,613,387 | 3.45 |
| 当前源码包解包，43 个文件 | 12,662,597 | 12.08 |
| 单份 WASM（Node/浏览器各一份） | 4,296,147 | 4.10 |
| TypeScript 5.9.3 依赖 | 23,625,066 | 22.53 |
| 安装后的整个 node_modules | 36,292,101 | 34.61 |

另直接从 npm registry 下载已发布的 `@fttawa/nekoc@0.4.3` 核对：
39 个文件，压缩 3,373,388 字节（3.22 MiB），解包 12,281,246 字节
（11.71 MiB），单份 WASM 4,182,967 字节。该发布物含 `build.mjs`；
本次清单已去掉它。发布版本与当前源码虽然版本号相同，但前端和 WASM 已有
变化，**不是同一产物**；以上差值不能解释为本次文档/清单修改导致的体积增长。
本任务没有发布或覆盖 registry 的 0.4.3。

维护者先构建 `packages/nekoc/dist/`，然后在仓库根执行：

```sh
bash tools/smoke-npm-package.sh
# 等价的单独回归测试
npm --prefix packages/nekoc run test:pack
```

`packages/nekoc/test/r2-entry.test.mjs` 会：

1. 真实执行 `npm pack --ignore-scripts --json`，审计 tarball 中的必需文件、bin 和依赖。
2. 在仓库外、无祖先 `node_modules` 的干净目录安装该 tarball，不使用源码目录链接。
3. 用离线 `npm exec` 检查安装生成的命令入口，禁止缺包时在线补装另一份 CLI。
4. 清空 PATH，确认 cargo/rustc/原生 nekoc 不可用，再检查和编译 `stage_demo.nk.ts`，运行确认 `cat done`。
5. 检查相对 import，默认输出文件名，以及 TS2322 的 JSON 诊断和退出码 1。
6. 输出真实字节数到 `dist/releases/npm-package-size.json`，保留 tarball 和自有示例导出作品。

安装阶段仍需 TypeScript 下载或缓存；运行不需要在线编译服务。体积统计区分
`.tgz` 压缩字节、包解包字节、TypeScript 依赖字节和整个 `node_modules` 文件
字节总和；最后一项受 npm 版本、bin shim 和平台影响，不是文件系统实际占用块数。

生成示例另外用 `node tools/editor-compat.mjs dist/releases/npm-smoke-stage.bcmkn`
核对官方编辑器，只有 `ok: true` 算通过。安装回归本身不证明全部 TS/积木语义
与官方运行时一致；支持范围仍以兼容性文档中的逐项证据为准。
