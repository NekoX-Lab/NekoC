# r3 字符串与正则边界

## 实现范围

本次新增即时正则字面量 `.test(string)`：无 flags、纯文本，可带首尾
`^` / `$`，支持转义的正则标点以及 `\n`、`\r`、`\t`、`\f`、`\v`。
不执行用户正则，也不调用宿主 RegExp 求值；解析后生成已有的字符串、列表和
自制积木组合。输入只求值一次。后缀搜索保留重叠命中，每次从匹配的首个完整
Unicode 字符之后继续，避免截断代理对。

正则 flags、类、重复、分组、选择、正则对象/变量/属性、构造器和替换/分割
重载不在此子集中，编译器明确拒绝。`localeCompare` 不用 `<` / `>` 冒充 ICU
排序，而是给出选择显式排序策略的诊断。`String.at` 保持已有常量子集，并补上
ES2020 类型声明；动态调用、越界 undefined 和孤立代理项结果仍报错。

普通模板维持现有插值语义。标签模板（包括 `String.raw`）现在明确报错，
不再把标签丢弃后编译模板体；这避免漏掉标签副作用，以及 raw/cooked 转义差异。
正则值也不再作为正则源码字符串输出。

匹配参数的静态分析使用内存中的最小 String/Array 声明，因而支持既有字符串
方法的返回值（如 trim、substring）、字符串数组元素及 for-of 的字符串元素；
无需读取宿主标准库，compile/check 的类型检查开关不影响这项能力。正则参数
使用保留 null/undefined 的严格类型判断，不将 unknown、any、数字或可空联合
当作字符串放行；这些输入需要先缩窄类型或显式转换。

## 官方积木证据

以下来自官方编辑器运行时源码（不是 HateNeko）：

- URL：`https://creation.bcmcdn.com/neko/web/release/static/js/crc_libs.8196dbd1.js`
- 文件 SHA-256：`462bb78dc75f99002dfe628d15211941469aa01d71e12890327eedcdb142f8a7`
- 偏移均为从零起始的字符偏移，此处字节偏移相同。未把官方 bundle 或摘录入库。

| 锚点 | 偏移 | 检查长度 | 该段 SHA-256 |
| --- | ---: | ---: | --- |
| `text_split:function` | 827003 | 260 | `6d9d211c85d32e24fb168e2c0456f0ca048c4e45c6268bee3d13b33fb5a16a6f` |
| `text_select:function` | 822464 | 240 | `8552109ca130bab748c034e543c82fb1773e3d4c79073613d646bc8e7f3eca77` |
| `text_length:function` | 822370 | 93 | `5d09c25069ee8592b07d5a6265c6c2b9e43e4c9add1edbd91e0a244377a1f5c8` |
| `text_join:function` | 822263 | 135 | `0472dd571f58a5b6cdd3a993b7708177d2aaed911d699650590f3d87bafc455b` |

源码确认：split 先做 JS split，再把某些纯数字片段转换为 Number；select 使用
1-based、包含终点的 substring，反向区间会反转；length 按 JS 字符串长度；join
逐项拼接。正则 helper 因而在 split 输入前加非数字且不等于 needle 首字符的
保护前缀，保证命中前片段的长度不因 `007` → `7` 而丢失。后缀只在非空、正向
区间上选择文本。空模式仍通过过程调用求值输入，不折叠掉输入副作用。

官方编辑器 0.27.4 的结构检查通过：`tools/editor-compat.mjs` 对本次生成的
正则作品返回 `ok: true`、`issues: []`、`pageErrors: []`。
这不是官方播放器运行结果等价性的认证。Node 与 NekoC VM 的回归比较见
`tests/ts-r3-string.test.mjs`；全部组合在官方播放器上的逐项运行对照**未验证**。

## 既有差异及后续

pad/repeat 的 65536 增长上限、动态非法 repeat 返回空字符串，以及未知非 BMP
选择路径的保守运行时 fallback 均属于已有实现，本次未改动。尤其动态非 BMP
fill 的部分截取可能保守返回原串，即使截取恰好落在完整字符边界；不能把这类
结果视为 Node 等价。后续应单独改进为边界精确的降级或编译诊断。
更广的正则语法、动态 String.at 的 undefined 表示和本地化排序仍是后续工作。
