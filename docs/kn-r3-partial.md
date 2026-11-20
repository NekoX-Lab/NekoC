# r3：KN 本地列表复制的共享引用

## 范围与结果

任务基线 `d6de981` 的 107 个“部分语义”已全部是硬件、AI、网络、账户或设备/宿主服务；
其中 60 个硬件项、47 个服务项的逐项清单见 [partial 第二轮](kn-partial2.md)。
没有列表/文本/数学/角色/画笔这类纯本地 partial 可直接升级。
本轮不把失败/无设备分支升级成完整支持，而是选择现有“有执行路径／未完整验证”的
`list_copy` 补齐具体本地缺口，并核对 `list_index_of` / `list_is_exist` 的引用身份语义。
partial 仍为 **107**；完整语义认证仍为 **0**。

## 官方证据

2026-11-19 匿名官方编辑器 `https://kn.codemao.cn/editor`，工程版本 **0.27.4**：

- `https://creation.bcmcdn.com/neko/web/release/static/js/main.bfc86683.js`
  SHA-256 `e2b26e0bdc9decfa8d53c0e40eb8e6c9e68d91157e96e82197efd19a14eae4d4`。
- `https://creation.bcmcdn.com/neko/web/release/static/js/crc_libs.a21338b6.js`
  SHA-256 `bd3b9858abe09d7552acd560d0f318139cd61a5b7a44364c153737421246c850`。
- main 的 UTF-8 byte **1661413**：`getListDomainFunctions:function`。
  该函数内 `u.aV.listCopy`、`u.aV.listIndexOf`、`u.aV.listIsExist` 注册分别位于
  byte **1665413**、**1666112**、**1666456**（锚点含前缀 `(t,`）。
  copy 对完整源列表深拷贝，再清空目标、写回元素；findIndex / some 使用 `===`。
  旧 `main.8ccf2442.js` 的相同工厂和实现也核对过，但本次实测不混用旧模块编号。
- 原创夹具由 [kn-r3-partial-probe.mjs](../tools/compat/kn-r3-partial-probe.mjs) 生成在
  `dist/r3-knpartial/lists.bcmkn`（不是第三方作品）。精确字节 SHA-256：
  `1c8b66aa3c8f484dd45a211400ac919003be216b89b0354e04920d153300346a`。
  编辑器检查 **54 blocks，issues: []，pageErrors: []，ok: true**。
  线上原生工程及下述局部调用均 `pageErrors: []`；原始报告在忽略的
  `dist/r3-knpartial/official.json`、`editor-compat.json`；
  可提交的原创观测快照见 [kn-r3-partial-official.json](kn-r3-partial-official.json)，
  不含第三方 bundle/资源，测试核对夹具字节及证据完整性。

### 原生工程观测（不是局部调用替代品）

源列表的两个元素引用同一个 `[7]`，复制到目标后，用列表搜索检查身份，并修改目标首元素：

| 输出变量 | 官方结果 | 含义 |
| --- | --- | --- |
| same_copy | true | 在目标中查找第二元素，首次位置为 1，共享引用被保留 |
| detached | true | 在源中查找目标首元素，结果为 0，与源分离 |
| copied_second_length | 2 | 修改目标首元素后，目标第二元素同步变化 |
| source_length | 1 | 源嵌套列表不变 |
| same_self_copy | true | 源复制到自身后，两个嵌套元素仍共享引用 |
| done | 1 | 事件链正常结束 |

### 官方域函数局部调用（与原生工程分列）

`source = [shared, shared, {shared}]` 复制后：目标前两元素同一引用，
对象属性仍指向同一份目标嵌套列表，各自与源分离。
修改 `target[0]` 后 `[target[1].length, target[2].shared.length, shared.length] = [2,2,1]`。
自复制也保持该跨路径别名，并分离旧嵌套引用。

| 搜索样例 | index_of | is_exist |
| --- | ---: | --- |
| `["1",1,1]` 查 number 1 | 2 | true |
| `["1",1]` 查 string "1" | 1 | true |
| `[NaN]` 查 NaN | 0 | false |
| `[-0]` 查 0 | 1 | true |
| `[shared]` 查同一列表 | 1 | true |
| `[shared]` 查另一份同内容列表 | 0 | false |
| `[object]` 查同一对象 / 同内容另一对象 | 1 / 0 | true / false |
| `[null]` 查 null；`[undefined]` 查 undefined | 1 | true |
| 非列表 number 42 | numeric NaN | false |

最后一行仅是官方证据，不宣称 VM 已实现非法列表的警告/降级行为。

## 实现及回归

旧 `list_copy` 对每个元素单独调用 `deep_clone`，每次新建访问表，错误地拆散跨元素共享引用。
现在 KN 路径将整个源列表作为一张图一次深拷贝，再写回目标原有列表容器；
因此目标别名稳定，源隔离、跨列表/对象属性共享引用和自复制均正确。
使用现有 `Cell::deep_clone`，未移植 HateNeko 或官方源码。
K4 保留原实现，不改变该任务范围之外的语义。

[tests/kn_r3_partial.rs](../tests/kn_r3_partial.rs) 的 5 个测试覆盖共享列表、共享对象及属性、
自复制、目标容器别名、多次复制隔离、空源清空、重启隔离、严格搜索及 NaN；
每项请求 JIT 开/关，不将开启等同于所有分支进入热 native code。
修复前测试实际观察首个位置错误为 2、修改第二嵌套列表无传播；修复后 5 项通过。

## 复现

```bash
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/compat/kn-r3-partial-probe.mjs
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules node tools/editor-compat.mjs dist/r3-knpartial/lists.bcmkn --channel msedge --out dist/r3-knpartial/editor-compat.json
bash E:/nekoc-wt/_cargo.sh test --test kn_r3_partial
node tools/compat/kn-catalog-status.mjs --snapshot docs/kn-block-coverage.md
```

## 未验证及风险

- 不认证整项完整支持：循环图、JS 特殊对象/原型、稀疏数组、错误 UI、列表更新事件和持久化未验证。
- VM 的循环列表仍有既有拒绝策略；不据 `deep_clone` 的防环能力声称支持官方循环图。
- 搜索非法列表仍走 VM 的错误策略，非官方警告后返回；输入求值顺序和全部原生组合未验证。
- 不对 K4 复制语义作新结论；新实现严格限 KN。
- 线上发布变化可能使模块导出定位失效；探针缺失导出即失败，不把未完成实测记为成功。
