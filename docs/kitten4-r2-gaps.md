# K4 r2：匿名身份、鼠标目标与相邻场景

## 范围与证据身份

本轮只读审计 pickcat K4 的 62 份发布 JSON 和 kitten4-corpus 的 53 份 BCM，
共 115 份、没有字节相同的重复文件。全部用本分支 release、seed 1、600 tick 无输入运行；
另尝试指定官方离线内核的 60 update 逐帧对照。第三方作品和轨迹仅在忽略的 `dist/r2-k4gaps/`。
全量前后统计与检查结果见本 worktree 未提交的 `OC-REPORT.md`。

官方文件：`K4_PLAYER_DIR/src/player/build/player_v2.2d180c468559fbd29528.js.orig`，
SHA-256 `0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160`。
下列偏移为从 0 开始的 JS UTF-16 字符偏移。没有复制官方实现；独立实现仅限经验证分支。
该包与既往线上包的关系见 [在线/离线取证](compatibility/k4-online-vs-offline.md)，
不是本次对当前线上发布物的重新认证。

## 修复与优先级

| 修复 | 证据 | 语料影响口径 |
|---|---|---|
| 普通 Web 匿名用户名为 `未登录用户`，不是空串 | `TL4g/R.username_get` @556487，`N.not_logged_in_user` @553835 附近；原创 identity/cloud-record 实测 | 37/115 份含 `username_get`，这是静态候选，非 37 份已证明修复；319664490 的首个云玩家记录差异直接命中 |
| `self_face_to` / `self_move_specify` 遇到未初始化鼠标，不污染朝向和坐标 | `Tn6a/F.l` @587540 检查目标 x/y 都 finite；`self_face_to` @589010；`self_move_specify` @589397 同样检查 | 246877091 的首帧 NaN 朝向及 284554184 的 NaN 坐标是全量对比中的明确候选；其余差异另报 |
| `__next_scene` / `__previous_scene` 按场景顺序切换，首尾越界忽略 | `Tn6a/switch_to_screen` @612121，分支 @612433、@612757 | 278906793 修改前在第516次 update 报 unknown scene；原创探针验证前进、后退、首尾不循环且后续脚本继续 |

相邻切换严格使用原始 `scenes_order`，不使用为显式 ID 引用补齐后的内部场景数组。
未列入排序的场景仍可按 ID 进入，但从该场景执行上一/下一场景均不操作。
`unlisted-scene`、`unlisted-previous`、`unlisted-next` 三份原创探针覆盖该边界；
依据为上述官方分支及同输入逐帧观测。这修正了独立审查指出的排序表不完整反例。

改动限定 K4：鼠标 guard 和相邻场景分支均检查 `RuntimeSemantics::Kitten4`；
不改变 `check_screen` 的查找含义，不改公共列表越界规则，也不增加隐式云联网。
回归同时运行默认 JIT 开关与禁用 JIT；这些短探针不宣称触发热循环的 native region。

静态优先级分母固定为115份：匿名用户名37份，移动到鼠标29份，朝向鼠标16份，
相邻场景6份。一个作品可同时属于多类；这是含积木/选项的作品数，不是实际执行或修复成功数。

## 云模式核查：不应把 account 401 当作禁写依据

本次结果否定“全新匿名、无云后端时必须把所有云写设为 no-op”的假设，
因此保留已有匿名未连接会话内写入行为；文件/内存后端仍是显式本地模拟选项。

`TL4g/R.p` @554255 的顺序是：

1. 单积木运行模式 `run_state === 2` 拒绝写。
2. 索引缺省或严格 number、有限且大于0才能继续。
3. `socket.is_connected === false`：直接原地更新列表并发本地通知，没有登录检查。
4. `socket.is_connected === true`：入队等待服务端回包；每列表队列上限60；本地不即时更新。

`K.update_list_by_action` @564951 使用 splice；空列表 replace 第1项或正数越界会追加。
`cloud_variables_set` @555027 的登录判断限制发送，本地更新在判断之外。
`vxpV/I` @1723492 与 `O8fc/get_var_or_list` @497235 则使未注入服务器 specs 的云初值为0/空表，
不采用作品云元数据中保存的 value。

原创云矩阵见 [证据 JSON](kitten4-r2-cloud-evidence.json)：一个浏览器串行4组、120个 update。

| 条件 | 实测 |
|---|---|
| 本地账户接口401、匿名、未连接、正常 Start | 中项替换、末项替换、越界追加均生效 |
| 另注入数字 work_id | 相同结果，排除缺 work_id 是本地写生效的必要条件 |
| 仅注入 connected=true、无回包 | 两次 replace 确实调用但列表不变；恢复false后下一次写入生效 |
| cloud-writes 原创夹具 | 公共标量 room/message、私有标量7、列表 head/tail/inserted/replacement |

所有外部请求阻断；0运行错误、0页面异常、0 WebSocket、0本地写请求。
**401来自本地 oracle，数字作品号和 connected 状态属于明确的诊断注入，
不是官方云服务器、真实握手、登录、断线重连或权限实测。**
成功连接后断线时 UI 与内部连接标志可能不同，源码可见但实际断线时序仍未验证。

### 三个指定作品

302847313 本身没有云列表；314915568 的初始化 replace 先加索引再写1000项；
336263165 的市场 replace 位于点击/问答分支，不能用无输入启动证明它被执行。
本次官方离线运行三者也记录普通 `lists_get_value_bad_index`：

| 作品 | 官方完成帧 | 官方错误 reporter |
|---|---:|---|
| 302847313 | 0 | `2QiwfSgTAbUvRshcN9sT`，索引3 |
| 314915568 | 1 | `QUMpZcKiq5gwfTszoTkX`，索引0；官方错误上报随后另触发 Redux 异常 |
| 336263165 | 0 | `3W4LqtJWGgMOjbN2qFKP`，索引2 |

NekoC 报错关联语句而官方记录 reporter，不能把 block ID 不同直接解释成执行顺序不同；
302847313 索引2/3也不同，具体首个输入求值顺序尚未对齐。
这些作品缺服务器初值的运行失败不应通过伪造值或吞掉普通列表越界来“修复”。

## 复现

设置 `K4_PLAYER_DIR`、`NEKOC_NODE_MODULES` 为只读外部内核与 Playwright 后：

```bash
node tools/compat/k4-r2-gaps-fixtures.mjs --record
node tools/compat/k4-r2-cloud-probe.mjs --record
node --test tests/k4-r2-gaps.test.mjs
bash E:/nekoc-wt/_cargo.sh test --test k4_r2_gaps --test k4_r2_cloud
```

前者生成8份仓库原创 BCM，并绑定资源/夹具哈希与38帧官方观测；
后者复用已有原创云夹具，默认只写 dist，`--record` 才更新精简文档证据。
没有新生成或修改 Kitten N 作品；K4 `.bcm` 经官方 JSONEntityCompiler 和运行时验证，
不能用只接受 `.bcmkn` 的编辑器工具冒充其验证。

## 保留边界与后续

- 60 update、600 tick 均为无输入窗口，不证明所有点击/问答/网络分支。
- 随机作品跨内核序列不同、克隆 ID 不配对、官方素材加载失败均单列未验证。
- 变量作用域导出差异、计时/造型帧边界、物理/素材度量仍有负例，不宣称全语料一致。
- 摄像头、语音、Wood/Python 等缺设备/后端分支保留既有占位分类。
- 无 HateNeko 逻辑移植；没有变更 TS 前端或统一审计文档。
