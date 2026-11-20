# r2-tsobject：普通对象分享兼容复核

## 基线与范围

本轮基线 `d6de981` 已有 [列表堆对象降级](ts-share-objects.md)，并非仍使用
`_object_literal` / `_object_get` / `_object_set` 的旧前端。因此沿用全局扁平
列表堆、数字句柄、静态属性槽和自制积木，不再引入另一套对象表示，也不修改
旧作品的 Rust 对象积木运行时。

`tests/fixtures/r2-tsobject.ts` 是独立可执行的纯 TypeScript 复现作品：

- 属性读写、文本复合赋值、布尔写入和引用相等。
- 对象参数、同一对象返回、新对象返回及初始化次数。
- 嵌套属性替换、旧子对象别名、对象中的数组和数组中的对象。
- 有副作用的赋值目标、下标和右值；右值改写属性时仍使用此前读取的值。
- 空对象的独立身份，以及数字、`length`、`toString`、`constructor` 数据属性。

原 TS 由 Node 擦除类型后执行，输出 24 条标量日志。Node 测试动态比较
`nekoc run` 的日志；Rust 回归另检查解释器和 JIT。结构回归遍历整个 workspace
report（包含所有自制积木），禁止私有对象积木以及 `list_new/list_create`。

## 官方 bundle 定点复核（2026-11-19）

本次重新下载任务指定的公开 `main.0f3db563.js`（12,107,636 字节），SHA-256：

```text
42841119872219828a193880c7261774643e05e14848be58e6679d78b9add827
```

`_object_literal/get/set` 分别命中 4/4/3 次，全部位于 module 11153 的声明和
源码/积木转换逻辑；module 89196 的 20 个运行域工厂没有对象工厂。结论限定为
这个精确 bundle，不能以名字出现在转换器中推断分享播放器提供对象运行实现。

以下是未修改原文件的 0 基 byte offset；列表行从 `(0,c.Z)` 注册表达式开头
计算，比旧对象设计文档的 `u.aV.*` 锚点早 10 字节，文件内容/hash 相同。

| 实现 | module | byte offset |
| --- | ---: | ---: |
| 列表工厂 | 89196 | 2181538 |
| `list_item` / `list_append` | 89196 | 2183056 / 2183666 |
| `replace_list_item` / `list_length` | 89196 | 2184994 / 2185981 |
| `temporary_list` | 89196 | 2187110 |
| 变量/列表读取、写入 | 97289 | 4852293 / 4853198 |
| debug 过程参数、返回 | 15220 | 4714934 / 4715692 |
| optimized 过程帧、返回 | 83084 | 4789541 / 4785886 |
| debug warp 进入/退出 | 15220 | 4718384 |
| optimized warp 有界让出 | 83084 | 4784608 |

从 bundle 原样抽取工厂、纯辅助模块和关键方法，局部执行 **26/26 通过**：
1 基列表索引、原地读写、列表身份、参数/返回身份和 flat-heap 场景均符合降级
所需操作。研究脚手架替代了 webpack loader、通知 sink 和输入 this-context，
没有重写积木解释器。完整位置、短原文、方法 hash 和脚手架范围保存在
`dist/r2-tsobject/official-evidence.json`，复查脚本为
`dist/r2-tsobject/recheck-official.mjs`。**未重跑历史 Heart 54/54 完整 fixture。**

特别注意：warp 抑制普通循环让出，但存在 iteration/time budget，不是无限
原子执行保证；本次局部测试不能证明任意宽度堆分配的并发安全。

历史版本复核：`v0.4.0` 指向 `1c4fe2834256660e46c3e1a8315dc73d29478ec8`，
其 `ts/compile-ts.mjs:4089/4112/4130` 直接生成上述三个私有对象积木；
`038c7a6b42b8a45e4a9ad6f923021de9c7b52284` 已改为列表堆。因此社区反馈对应
旧版确有依据，本轮主要是复核当前实现并封堵其类型/返回边界。

## 本轮修复

### 提前空返回不能伪造对象引用

原先“函数体存在最终返回值”的检查会漏过较早的 `return;`：

```ts
function make(stop: boolean): {value: number} {
  if (stop) return;
  return {value: 7};
}
console.log(make(true).value);
```

JS 在这条分支返回 `undefined`，访问属性应失败；不能把它送入后续堆地址计算。
现在在空返回语句处报告 `Object-returning functions must return an initialized
reference on every path`，保留用户文件、行、列。对象、对象数组、嵌套容器、
箭头函数、上下文签名和导入模块均有回归。嵌套的普通标量/void 回调不受影响。

### 对象边界必须保留标量属性的类型

对象类型不仅决定堆槽，也决定加法应生成数值积木还是文本拼接。原先递归边界
只检查对象句柄，对 `{value: 1} as {value: string}` 等错误断言会生成文本拼接，
与 TS 擦除断言后的 JS 结果不同。现在递归检查目标属性的兼容类型，覆盖断言、
对象数组、实参和返回边界；正常的数字/字符串/布尔字面量拓宽仍通过。
共享可变属性的标量存储类型必须双向兼容，不能将 `number` 拓宽为
`number | string`、`any` 或 `unknown`，否则较宽别名写入后会破坏原别名的运算。
新对象标量槽的初始值赋给显式宽类型时没有较窄对象别名，仍允许；例如
`const o: {value: number | string} = {value: 1}`。已有引用的嵌套转存仍需匹配，
复杂嵌套初值经前置降级生成局部引用后也可能保守拒绝；可显式声明子对象类型再组装。
class 分配助手会先预留不可访问的字段槽（例如 `never[]` 类型的空数组），再执行
已验证的用户初值；仅沿用 AST 元数据标记跳过这些内部占位值，不按用户命名放行。

不支持的形状仍应通过 `CompileError` 拒绝；此处不是开启完整 TypeScript 类型
检查，也不是新增运行时类型转换。动态 key、缺失属性、对象文本化的原始行号
另有回归。

### 无值回调仅退出当前过程

对象工厂里的 `forEach` 回调提前 `return;`，原先生成 `stop`，会连外层函数也
提前停止，导致后续对象读取输出 `NaN`。在 `NORMAL` 普通过程中改用现有事件
回调同款 `procedures_2_return_value`，mutation 为 `type="NORMAL" items="0"`。
只处理明确无值的过程；返回对象的函数提前空返回仍由上一项检查拒绝。主 fixture
末尾的回调恢复执行后，应正常输出对象字段 `30`。

指定官方 bundle 的 module 3796、byte offset `1959966` 工具箱源码按 NORMAL
类型生成 `items="0"` 且不生成 `VALUE` socket；module 56612、offset `4772074`
在 `e.params.VALUE` 缺失时生成传入 `undefined` 的过程返回；module 83084、offset
`4785886` 的 `step_return_value` 弹出当前过程帧。后两项使用原始方法和受控
this-context 局部执行通过，见 `dist/r2-tsobject/bare-return-evidence.json`，
不等同于完整官方调度器执行。

## 本次编辑器检查

2026-11-19，使用系统 Edge 无头运行 `tools/editor-compat.mjs --channel msedge`：
编辑器版本和工程版本均为 `0.27.4`，`blockCount: 1775`、`issues: []`、
`pageErrors: []`、`ok: true`。作品 SHA-256：

```text
1da423f85014874792e6663d2317ac1fe96107b16b56a7b16955492a06f073c3
```

当次编辑器加载的是 `main.bfc86683.js`，不是研究用的指定历史分享 bundle；
不能混同两者。完整报告为 `dist/r2-tsobject/editor-compat.json`。

## 重跑

在已构建 `target/debug/nekoc` 的工作树中：

```bash
node --test tests/r2-tsobject.test.mjs
bash E:/nekoc-wt/_cargo.sh test --test r2_tsobject
target/debug/nekoc build tests/fixtures/r2-tsobject.ts -o dist/r2-tsobject/fixture.bcmkn
target/debug/nekoc run dist/r2-tsobject/fixture.bcmkn --ticks 120
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/editor-compat.mjs dist/r2-tsobject/fixture.bcmkn --channel msedge
```

官方源码证据、编辑器检查和本地执行是不同验证层级，不能互相替代。真实已发布
作品的分享页播放需要有效 workId，本轮不登录、不发布；不能将前述检查称为完整
发布链路验收。官方 bundle、生成作品和测试日志仅存放在被忽略的 `dist/`。
