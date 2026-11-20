# KN 转换占位积木（r3-translator）

## 结论与范围

`bcm_translator_text_*_block` 是旧作品转换后保留文本的占位类型，
**不是**语言翻译服务 `translate` / `translate_result`。
离线时不能据其 mutation 文本重新执行旧物理、音频、抖动等功能，
也不能伪造翻译结果。指定语料的占位全部禁用；正确行为是跳过并保留后续语句。

本次核对官方公开分享播放器 bundle：

- URL：`https://creation.bcmcdn.com/neko/web/release/static/js/main.0f3db563.js`
- SHA-256：`42841119872219828a193880c7261774643e05e14848be58e6679d78b9add827`
- 大小：12107636 bytes。
- 取证时间：2026-11-19。
- 原始代码、提取函数、探针和完整结果只保存在忽略的 `dist/r3-translator/`，不入库。

这是固定版本取证，不宣称当前线上所有版本一致。实际公开页面当时引用
`main.d0a9bd01.js`；浏览器探针显式将主包固定为上述审计版本。

## 官方源码定位（UTF-8 字节偏移，0-based）

| 偏移 | 函数/注册位置 | 可观察结论 |
| ---: | --- | --- |
| 4674307 | `ws_json_to_json` | 保存 `disabled`；连接与字段转换成参数 |
| 4675823 | `parse_kind` | 非注册事件/过程等类型作为 domain block |
| 4754686 | `compile_statement` | 禁用语句在读取参数前跳过，继续 `next_block`，不编译子体 |
| 4757264 | `compile_expression` | 禁用 reporter 抛 `disabled_param`，不是返回默认值 |
| 4768316 | `compile_domain_functions` | 未注册的执行/事件占位报 `missing_domain_function` |
| 4772848 | `compile_params` | 动态参数按对象键顺序求值，再调用 handler（非确定性默认配置） |
| 2173924 | `bcm_translator_text_return_value_block` handler | 同步返回 number `NaN` |
| 2174004 | `bcm_translator_text_return_boolean_block` handler | 同步返回 boolean `false` |
| 10807860 | 旧作品 JSON 转换中的占位分类 | execution/event 明确写入 `disabled=true` |
| 10863132 | 旧作品 XML 转换中的占位处理 | execution/event 同样自动禁用 |

官方 handler 的固定返回不依赖登录、网络、参数文本或结果缓存，未启动任何翻译请求。
返回常量不意味着输入不求值：输入副作用属于 compiler 参数管线。

## 探针事实

### 提取真实官方函数（`extracted-report.json`）

未修改的官方函数在 Node VM 隔离执行，不提供网络 API；宿主/注册表和副作用哨兵为探针依赖，
**不等于整套官方调度器**。

- 四种类型 `disabled: true` 放在语句位置：都只执行后续哨兵 `NEXT`，
  不查找自己的 domain handler、不执行 ADD1/ADD0 或嵌套体。
- execution/event `disabled: false` 或无 disabled：`missing_domain_function`。
- boolean/value `disabled: false` 或无 disabled：先 `ADD1` 再 `ADD0`，然后返回 false/NaN，
  最后执行 NEXT。这里插入顺序故意与 ADD 数字后缀不同。
- boolean/value 放在表达式位置且禁用：均为 `disabled_param`。
- 两个返回 handler 对 undefined、空对象、带参数对象和 null 都同步返回固定类型；
  参数读取代理没有记录到属性访问，没有 Promise。

### 匿名浏览器原生注册表/handler（`native-report.json`）

Playwright 加载官方公开分享页和固定主包，匿名且 `navigator.onLine=false`，
外部账户/时间/作品请求被阻断；不登录、不提交 POST。

- execution/event：原生 domain index 为 undefined；没有普通或 lifetime responder。
- boolean/value：原生 domain function 存在，索引分别 174/173；
  每种四次原生调用均同步返回 false/NaN，未读参数代理。
- 该局部探针 `ok: true`、`errors: []`；它验证注册表与 handler，不冒充完整作品播放。
- 后续原生 JSONEntityCompiler/OptiCompiler 探针也完成 12 组语句编译和 6 组
  表达式编译：默认 `ignore_missing_domain_function=false`、deterministic 未设置。
  四类型 `isHat/isEvent/isResponder` 均为 false；游离根默认没有编译入口，
  即使名字带 event 也不应当作事件启动。强制编译入口的禁用语句通过，
  未禁用 execution/event 抛 HEART.CLIENT 6（No domain function of this type exists），
  禁用表达式抛 HEART.COMPILER.USER 8（There is a disabled expression in code）。

## NekoC 改动边界

- 仅在 KN 模式明确处理上述四个类型，不新增宽泛 `disabled`/未知块静默兜底。
- 禁用语句跳过自身、输入和嵌套体，继续 next；游离 event 根保持不启动，
  无论是否禁用（官方没有注册此类型为事件帽）。
- 两种启用 reporter 求值动态输入，保留 false/NaN 类型；禁用表达式明确报错。
- 未禁用 execution/event 位于可执行语句体时仍拒绝，不能把缺失实现伪装为成功。
- 原有 `translate` / `translate_result` 不变。

## 未验证

- 当前线上 `main.d0a9bd01.js` 与固定版本的全量差异、已登录场景、移动端。
- 指定两份完整第三方作品在官方播放器的逐帧轨迹、渲染/音频与全部交互。
- 官方 deterministic 参数排序模式、墙钟/微任务精确相位；本次只核对默认参数键顺序。
- 本次没有移植 HateNeko 实现；第三方实现不作为官方证据。

## 本地复验

- `tests/kn_r3_translator.rs` 使用原创最小工程覆盖跳过/继续、四类型禁用语句、
  启用执行/事件错误、禁用 reporter 错误、NaN/false 类型以及同步/异步输入副作用顺序。
  输入副作用测试累计 `AB`，同时检查次序和单次求值；JIT 开关分别运行。
- 原创工程 `dist/r3-translator/editor-fixture.bcmkn` 经
  `node tools/editor-compat.mjs ... --channel msedge` 检查：
  `editorVersion=0.27.4`、`blockCount=8`、`issues=[]`、`pageErrors=[]`、`ok=true`。
  作品 SHA-256 为 `efaf3bcb9617e0fd4884dfc2dba2f6af7fa7f25732a981e360c0a21ef3e62786`，
  检查当时编辑器包为 `main.bfc86683.js`；这是结构检查，不是该包的播放差分。
- 同工程本地运行 10 ticks：日志 `NaN`、`false`、`continued`，`active_threads=0`。
- 只读语料 319183075 已运行 600 ticks，不再报转换占位错误。
- 只读语料 303456318 已越过转换占位错误，但仍被旧物理指令
  `self_enable_physics`（`xnBVQ7gxCOL6KmFD95Dx`）拦截，未完成 600 ticks。
  本任务不将其它未知/物理指令静默兜底，也不据此声称完整作品兼容。
