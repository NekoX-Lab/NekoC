# Kitten N 匿名云变量与本地数据

2026-11-19 核对官方源码及匿名分享播放器后，NekoC 的 KN 默认行为应继续允许
会话内读写。匿名用户不建立云变量连接；初始化结束后，`public` 变量走普通变量
分支，写入立即影响当前运行实例。`private` 和 `private_list` 分别是官方的
LocalVariable、LocalList，匿名时不会加载或保存用户设备存储，仍可在运行中修改。
因此不能把 K4 的云服务失败规则直接用于 KN。

本次补充独立的 [Rust 回归测试](../tests/r2_kncloud.rs)，固定现有匿名语义。
没有引入 KN 网络连接、登录状态或新的持久化选项。现有 `set_cloud_backend` /
`--cloud-memory` / `--cloud-file` 针对 K4 云绑定，不会让 KN 实例变为已登录状态。

## 类型与行为

| KN 保存类型 | 官方名称 | 未登录时初始化 | 未登录时读写 | 跨实例保存 |
| --- | --- | --- | --- | --- |
| `public` | PublicCV | 保留作品保存值；跳过云连接 | 普通变量分支，立即本地读写 | 不保存至云 |
| `private` | LocalVariable | 保留作品保存值；跳过用户存储加载 | 普通变量分支，存储 helper 因缺用户 ID 返回 | 不保存至设备用户档案 |
| `private_list` | LocalList | 保留作品保存列表 | 普通列表操作，存储 helper 因缺用户 ID 返回 | 不保存至设备用户档案 |
| `any` / `list` | Variable / List | 作品保存值 | 普通变量 / 列表 | 会话内 |

这份 KN 枚举没有 `public_list` 云列表类型。旧 K4 导入转换器中的
`cloud_lists_*` / `public_list` 字符串不是 KN 原生云列表实现证据。
只 grep `cloud` 会漏掉语料中的上述三种保存类型。

## 官方源码证据

任务指定的 bundle 是
[main.0f3db563.js](https://creation.bcmcdn.com/neko/web/release/static/js/main.0f3db563.js)，
12,107,636 字节，SHA-256
`42841119872219828a193880c7261774643e05e14848be58e6679d78b9add827`。
同日实际播放页加载
[main.d0a9bd01.js](https://creation.bcmcdn.com/neko/web/release/static/js/main.d0a9bd01.js)，
12,109,440 字节，SHA-256
`5082351d82cdd430e91da7f8b3b076f998a89d37395f57adbd3f73f17e7b075f`。

以下偏移为解码成 JS 字符串后的 UTF-16 索引，从 0 开始，不是文件字节偏移。
两版下列五段相关函数体逐字一致；完整下载及摘录只留在本地忽略的
`dist/r2-kncloud/`，仓库不携带官方实现。

| 功能 / 定位锚点 | 指定版本模块 / 偏移 | 实际播放版本模块 / 偏移 |
| --- | --- | --- |
| `initRuntimeCloudData` 的 `De` / `Oe`，随后 `initRuntimeLocalData` 的 `Pe` / `Le` | 43773 / 2352717 | 23853 / 2354682 |
| `getVariablesDomainFunctions` | 89196 / 2166534 | 18833 / 2168486 |
| `getListDomainFunctions` 的列表变更通知 helper | 89196 / 2181538 | 18833 / 2183490 |
| `updateLocalVariableStorage` 的 `w`，随后 `getLocalVariableStorage` | 92921 / 261562 | 55310 / 261549 |
| 已登录初始化 `J` / `$`，socket 失败处理及远端缺项回退 | 11004 / 2444499 | 32280 / 2446474 |

匿名控制流：

1. `generateHeartVariables` 把作品定义的 `value` 原样送入变量规格（指定版模块
   26921，偏移 2373148）；`UserVariableImpl.set_variable_specs` 存入运行变量。
2. `initRuntimeCloudData` 检查是否有 `private` / `public`；登录检查失败时显示提示，
   发出 `CLOUD_VARIABLE_INIT_END` 后返回，未调用 socket 初始化。
3. `variables_get` / `variables_set` / `change_variables` 的等待仅持续到初始化完成，
   不会因为匿名而永远等待。读操作返回 runtime manager 中的变量。
4. 写操作进入云分支需要 socket 已连接、不是预览、有 `cvId`、不在本地回退清单、
   类型为 PublicCV。否则直接更新舞台变量和 runtime manager；LocalVariable 再尝试
   调用本地存储 helper。云分支中的标量类型 / 字符长度限制不适用于这个本地分支。
5. `initRuntimeLocalData` 未登录直接返回 `shouldContinue: true`，不替换作品列表。
   列表修改会通知 runtime / 舞台；LocalList 的额外持久化调用缺用户 ID 时跳过。

失败处理（源码检查，**没有登录后网络故障实测**）：socket 的 `connect_error`、
非法 JSON、非成功 `connect_state` 都让初始化返回 `state: false`；初始化器把
`socketStatus` 设为 false，完成初始化事件，保留当前变量值。离线时也直接采用本地
处理。连接成功但远端列表缺少某个 `cvId` 时将其加入 `localRunCloudVariable`。
连接后的写入会排队等待服务端更新，不能把匿名的立即本地写规则推广至已登录连接。

## 匿名播放器实测

环境为 Windows、Edge 157.0.0.0、Playwright；每个作品使用空 cookies / origins 的
新 browser context。通过真实的中央播放按钮启动，原项目不替换，只在 bundle 的
唯一 webpack 启动标记前暴露 loader，供读取登录标记、云状态和变量。没有注入
输入、调用变量写入接口或修改调度 / 时钟。随后在同一匿名 context 刷新并重播。

所有已采集播放实例的 `isLogin` 都为 false、`socketStatus` 都为 false。
账号探测 `GET /tiger/v3/web/accounts/profile` 返回 **403 / 用户未登录**；
没有 `/neko/cv` 请求，也没有 cloudstorage WebSocket。页面提示
“作品中有部分积木需要登录使用”。这不是 K4 云接口 401 的复用结论。

| 作品 | 观察结果 | 能证明的范围 |
| --- | --- | --- |
| [336732738 我的作品](https://kn.codemao.cn/player?type=2&workId=336732738) | 首次图片加载未完成；刷新后正常运行 123 帧，`private` 的 Num_ 从保存值 0 变为 11 | 私有变量匿名本地写生效；不能把首次加载停滞当云写失败 |
| [329455966 醒梦AI](https://kn.codemao.cn/player?type=2&workId=329455966) | 运行后 `private_list` 记忆有 1 项；刷新重播先观察到空列表，再有 1 项 | 本地列表匿名可写，未因登录提示停止；未验证 AI 服务 |
| [332867134 联机测试](https://kn.codemao.cn/player?type=2&workId=332867134) | 两个 `public` 变量保持数字 0；没有云连接 | 匿名公共变量可读；无输入未触发写路径，不把零值当写失败 |
| [335905785 抽卡模拟器](https://kn.codemao.cn/player?type=2&workId=335905785) | 7 个 `public` 值保持 0；作品等待交互 | 此轮只验证匿名初始化和读取，没有证明交互后的写入 |
| [336642022 KN检测在线](https://kn.codemao.cn/player?type=2&workId=336642022) | 当前发布版名为“KN检测在线 和 五人联机”；`public` 在线的人从数字 0 变为字符串 `"/未登录用户"`；刷新重播再次得到该字符串 | 直接证明公共变量匿名本地写生效；发布作品已更新，不与旧语料逐帧配对 |

原始请求记录、截图、typed 状态及实际源码 hash 在
`dist/r2-kncloud/browser/anonymous.json`、`public-write.json` 和 `public-fallback.json`。
后一个作品当前下载 URL 为
`https://creation.bcmcdn.com/922/user-files/Fo3uyKjJTFVA4wn78E96LbWBJnES.bcmkn`，
原始响应 SHA-256 为
`868b976b9ac1bb7c20feba675c5441b0e19061ee837a74fd6ca56f543017299c`。
浏览器始终播放当前公开版本，没有强行替换为冻结语料；这份作品已比语料多出
`chat` 公共变量，故其发布版的字符串不能冒充旧语料的预期值。其余作品也没有
宣称完成在线发布物与冻结输入的完整 canonical hash 配对。
播放前还未设置变量规格时，诊断 `get_variable` 对未知 ID 会初始化数字 0；
特别是列表的播放前数字 0 **不能解释为已启动后的列表初值**。上述列表结论只使用
`running: true` 的记录。采样标签是观察时间，不等于固定帧；不声称与 NekoC 逐帧一致。

## 语料与回归范围

只读 KN 语料 49 份中，22 份含 `public`、`private` 或 `private_list`。
逐份以 `nekoc run <json> --ticks 600 --seed 1` 连续执行两次；本任务运行时代码没有
变动，前后使用相同二进制。19 份执行成功，两次相关变量 / 列表完全一致。
另 3 份（297168191、313570150、336191749）都因
`KN camera turn_on requires a camera backend` 编译失败，属于未完成验证。

代表性前后值：329455966 的记忆列表长度 `1 → 1`；332867134 两个公共变量
`0/0 → 0/0`；336732738 的 Num_ `147 → 147`；333289842 的拥有物品
`"0,0,0" → "0,0,0"`。这些是 NekoC 600 帧的结果；官方 Num_=11 的记录只有
123 帧，不能比较绝对值。334947481 的 Y 为 NaN，官方对应状态**未验证**。
详细全部作品前后状态只存 `dist/r2-kncloud/corpus/report.json`。

Rust 测试使用原创内存项目，覆盖 `public` / `private` 的缺失、空及非空 `cvId`，
非零保存值、增减、写后即读、文本 / 长文本 / 列表别名、重启和新实例隔离，
LocalList 的追加 / 插入 / 替换 / 删除 / 清空 / 复制 / 读取，以及 K4 显式
本地 backend 不覆盖 KN 数据。主要用例同时运行默认 VM 与禁用 JIT 的 VM。
测试不依赖网络或第三方作品，也不把本地测试成功冒充官方全行为认证。

登录状态切换、已登录云服务写入成功 / 限流 / 重连、用户设备持久化、云排行和
跨设备同步均**未验证**。本轮没有移植 HateNeko 代码。
