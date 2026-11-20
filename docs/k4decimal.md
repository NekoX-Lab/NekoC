# Kitten 4 普通四则运算的十进制兼容

## 已验证的规则

只读指定离线播放器的 `player_v2.2d180c468559fbd29528.js.orig`：

- `Tn6a` 的 `math_arithmetic` 调用内部 `f`；数字 ADD、MINUS、MULTIPLY、DIVIDE 分别调用 `haXk.Decimal` 的 plus/minus/times/dividedBy，再 `toNumber()`。
- `haXk` 是 decimal.js-light 风格实现：默认 `precision:20, rounding:4`。**普通运算内部调用 `I(result, precision)`，没有传 rounding，实际是向零截断 20 位有效数字**；不能把默认 rounding=4 套在普通运算上。
- Number 输入先按 JS 最短十进制字符串构造 Decimal；每次操作后立即转回 Number，而不是跨多个积木保留无限精度。
- 数字 ADD 以外的 ADD 仍走 JS `+`；非有限操作数的 Decimal 构造失败由 `f` 捕获并回退 JS 运算。DIVIDE 仅对 Number ±0 和精确字符串 `"0"` 提前回退；`"0.00"`、`"-0"`、`"0e1"` 进入 Decimal，零分子先返回 +0，非零分子遇零除数才抛出并回退 JS（保留 Infinity 符号）。无效字符串仍回退得到 NaN。没有新增运行期错误，也没有把 NaN/Infinity 一律改成零。
- `change_variable` 在 `Tn6a` 明确调用相同的 `f(previous,n,ADD/MINUS)`；全局、脚本及角色私有变量共用 typed 运算规则。保留先求 n、再读旧值的顺序，以及非数字 ADD 拼接和对象旧值不写入的规则；角色私有变量使用当前 clone/tell 上下文。
- `oiyH/math_modulo` 是原生 `%`，独立探针 `.3 % .1 = .09999999999999998`，不改成 Decimal.mod。
- POWER 在 `Tn6a` 源码中也调用 Decimal.pow，但它包含整数幂、ln/exp 和额外内部精度规则，**本轮未实现**，不能声称所有 K4 数学运算已兼容。本轮不改物理求解器、三角函数或 KN/TS 算术。

## 实现与回归

`src/engine/k4decimal.rs` 用任意精度整数表示十进制系数/指数，四则运算后截断到 20 位有效数字，再由 Rust 正确舍入的十进制解析转回 f64。没有 epsilon、固定小数位或对显示文本的补丁。整数安全范围内的加减乘使用可证明精确的快路径；小数仍走十进制。

有限 Number 的加减乘还可由 `src/engine/k4decimal/compact.rs` 使用 i128 精确系数计算；缩放或运算溢出即回退原 BigInt，除法和字符串操作数不走此路径。仍从 JS 最短十进制文本构造系数，只在完整结果上截断，保留精确零规范化及负数下溢的有符号零。`tests/r2_perf/decimal_internal.rs` 与原 BigInt 算法做位级差分，CI 不设置耗时断言。

K4 编译为专用 typed arithmetic / Binary 操作，解释器、深层求值、JIT 数值守卫、`Numeric::Add`、JIT helper 和 change_variable 共用规则；KN 的 Binary 加减乘除保持原有实现。布尔/null/对象不先偷偷变成 Decimal Number，而是保留构造失败时的原生回退。普通有限数字字符串也保留 Decimal 的精确十进制输入；超大字符串指数（超出本适配器 ±2048）仍在原有 Number 回退范围，不作为本轮兼容性结论。

原创夹具由 `tools/compat/k4decimal-fixtures.mjs` 生成，官方结果及资源 SHA-256 保存在 [k4decimal-evidence.json](k4decimal-evidence.json)。不携带官方源码或第三方作品。

- hot：动态变量四则、直接数值 EQ、LT、转文本、warp 1200 次，count=1200，连续 `.1` 累加为 120；两帧均核对。
- values：正负、指数、接近整数、相消、大数、下溢/上溢、连续运算、列表存取后计算、非数字拼接、change_variable、布尔回退、精确数字字符串和原生取模。
- nonfinite：±Infinity、NaN、±0、零除及转文本，官方不报错；观察非有限数使用字符串以免 JSON null 隐去类型。
- `(-1 / Infinity)` 先产生 -0，其倒数为 -Infinity；`change_variable` 减去零后 Decimal 规范化为 +0，倒数变为 Infinity。旧双模式回归中的 -0 保留断言据此更正，不影响 KN 的有符号零。
- error：热循环后读取空列表越界，官方仍报 `lists_get_value_bad_index`；本地检查错误、typed 状态及 PC，不能吞越界。
- private：角色私有变量增减及 warp 1200 次，add=0.3/sub=0.2/accumulate=120；另测文本拼接和列表旧值不写入。官方两帧均无错误。
- zero：42 组除法组合，包含 Number ±0、字符串 `"0"`/`"0.00"`/`"-0"`/`"0e1"`/无效字符串除数，分别配零、非零、无效字符串分子；结果显式转文本。

`tests/k4decimal.rs` 逐帧比较两种执行模式的 typed 状态、PC、指令/预算和错误，hot/error/private 显式要求 native_ops>0；另测小指令预算挂起、80 层小数表达式的堆求值、clone/tell 私有变量上下文和 KN 仍返回二进制浮点结果。JIT 原生单测覆盖私有变量的数值快路径、typed 回退及失败输入保留旧值；差分回归用有副作用的 reporter 增量确认先求增量再读旧值，并覆盖重启和低预算。Node 测试核对夹具字节和官方证据，可选现场复跑。

```powershell
$env:K4_PLAYER_DIR='外部官方播放器 app 目录'
$env:NEKOC_NODE_MODULES='含 Playwright 的 node_modules'
node tools/compat/k4decimal-fixtures.mjs --record
$env:K4_ORACLE_INTEGRATION='1'
node --test tests/k4decimal.test.mjs
bash E:/nekoc-wt/_cargo.sh test --test k4decimal
```

本轮只定位并修正这些普通四则数值差异；不推断它们是所有语料后续错误的共同根因，也不声称完整作品和官方逐帧状态相同。

## 本地语料和开销记录

### 性能实验的源码与产物身份

比较 compact 快路径时，先冻结基线和优化侧的完整提交 ID；不要把后来移动的
`origin/main` 当成原实验基线。记录工作区差异，并把 `src/**`、`Cargo.toml`、
`Cargo.lock` 和相关测试的源码快照与冻结提交逐文件核对。换行归一化只用于说明
跨平台源码对应关系；原文件的 SHA-256 仍应单独保留。

两侧使用独立的源码目录及 `CARGO_TARGET_DIR`，记录实际构建命令、release profile、
目标平台、显式 feature 集和构建日志。所有 cargo 命令仍走项目指定的统一入口。
包装器会转发远端时，必须取回那次构建的产物，不能把本机旧 target 中的同名文件
当成新构建。运行前后复核程序和输入 SHA-256。不同哈希只证明文件不同，
不能单独证明一侧包含优化；构建日志及源码对应关系不可缺少。

每个原始样本保留参数、退出码、固定 seed/帧数/预热数、执行模式、逐帧时间、
指令数和终态；重新计算配对摘要，而不只信任缓存的 `equal` 或中位数。
`tools/bench/verify-pair.mjs` 可复核留存配对的程序/输入哈希、参数、原始终态和
摘要；它要求显式传入两侧预期程序哈希，但不能替代上述源码到程序的构建溯源。

若发现产物拿错，撤销整批数据对优化的归因，包括依赖该程序的全语料扫描；
不能仅把异常涨跌解释为噪声。保留原始记录供审计。采用他人留存的有效实验时，
明确区分原始测量日期、复核日期、执行者及当前源码对应关系，不称为新跑的性能
实验。报告同时列出真实作品、加减乘、未改除法及 BigInt 回退的有利和不利结果；
不同平台、作品级和同进程算法探针不混算。性能数字只放本地任务报告，CI 只做
确定性的完整性、语义和校验器回归，不增加耗时阈值。

对固定 53 件只读 K4 语料，使用 `origin/main` 的独立构建和本分支各运行 60 帧、seed 1/6/42，完整 coverage 对象深比较差异为 0；均为 ran=52/run=1。原有 `214725822.bcm` 仍报 `lists_get_value_bad_index (index Some(2), length 1) at block 8pBbyMp94KX94H4C0g28`。这保留了离线云内容缺项暴露的越界，不把异常吞掉。

另外 seed 1/42 各 53 件执行解释器/JIT 逐帧对照（含 typed 状态、别名、控制状态、错误及预算）：全部 `difference=null`；各 52 件完成 60 帧，214725822 在双方首帧报相同越界。原始本地报告在 ignored `dist/corpus-decimal-jit-{1,42}.json`。

本机 Windows x86_64 debug、同一 hot 夹具 2 帧 / 1200 次循环、7 次独立进程、关闭 profiling 的中位执行时间（含首次 JIT 编译，**不是稳态性能保证**）：

| 构建 | 解释器 μs | JIT μs |
|---|---:|---:|
| origin/main | 5968 | 15004 |
| 十进制兼容 | 33337 | 43334 |

该次兼容构建 profile 为 native_ops=7711、regions=1、node_calls=0，双模式状态无差异。BigInt 十进制对热数值循环有明显成本，不能宣称与原生 f64 一样快；CI 仅断言确定性值和 native_ops>0，不断言耗时。原始本地记录在 ignored `dist/decimal-timing.json`、`dist/decimal-hot-profile.json`。
