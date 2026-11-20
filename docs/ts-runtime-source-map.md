# TypeScript 运行错误定位

TypeScript → workspace report → `.bcmkn` → Engine → CLI / Player 的定位数据共用
作品顶层 `sourceMap`。格式为积木 ID 到 `{file, line, column}` 的映射，行、列均从
1 开始，列沿用 TypeScript 的 UTF-16 字符偏移。`file` 使用与 lowering 的 sourceIdentity
相同的入口目录相对模块身份，统一 `/` 分隔：入口为 `main.ts`，导入可为
`lib/util.ts` 或 `../shared/util.ts`。不写宿主绝对目录；移动工程、native 与 WASM
虚拟文件宿主输出一致。运行时原样展示可读相对路径，不需要访问原文件。

运行错误示例：

```text
invalid costume for nekoc-actor-Cat [actor Cat (nekoc-actor-Cat), main.ts:3:5] at block b2
```

- 角色包含名称及实例 ID；过程中的运行错误显示实际执行角色。
- 报告器求值错误保留最内层可定位积木；没有报告器位置时保留执行语句积木。
- 错误消息与可信定位由内部结构化诊断分别传递，展示时才合并；消息、角色名或
  文件名里的 `at block` / `[actor` 文本不会被反解析为定位，也不会阻止追加真实定位。
- 未知过程参数在 VM 编译阶段就会失败，也会带报告器积木及可用的源码位置。
- CLI 保留更新帧上下文；WebSocket/HTTP Player 的错误 JSON 保留完整错误文本，
  浏览器按文本显示；WASM 边界使用 alternate Display 保留 anyhow 错误链。

## 重编译与导入

组装时先删除模板旧 `sourceMap`，再复制本次前端报告的映射。即使本次报告无映射，
也不会继承模板中与新积木 ID 重合的旧位置。导入作品没有映射时仍显示角色和积木。
只有 `file` 非空且行列为正整数的位置才作为 TS 位置展示；早期仅有行列、没有文件名的
映射不会被猜测成入口文件。运行时只索引实际积木树，不为资源元数据中的 ID 建立定位。

## 精度范围

普通语句、角色回调、导入函数、显式过程及多行报告器输入有回归覆盖；内联返回报告器
在创建时记录定义处表达式来源，外层调用不会覆盖；递归 `else if` 条件不继承前一分支来源。
部分 TS lowering 会打印并重新解析代码而丢失原始区间：仅在源文件文本未变化时沿用原区间；
文本变化后保守省略 TS 坐标。即使原文件只有一个同 kind、同文本节点，也不能据此认证
来源（它可能属于未调用的函数）。无法确认的合成代码保持积木定位，不将生成文件行号
冒充原始 TS 行号。
完整的 class/nullable/collection 等多轮改写 source map 仍需各 lowering pass 提供精确 origin。

本功能添加诊断元数据，不改变积木错误语义。例如 KN `list_item` 越界返回 NaN，
K4 的对应操作可抛错误；已有官方证据见 `kn-value-types-official.json`、
`kitten4-run-errors.md`。不能为了演示行号而将 KN 越界改成抛错。

官方编辑器的打开兼容性由 `tools/editor-compat.mjs` 对实际生成作品检查；这不表示
官方播放器会展示 NekoC 的 TS 位置，也不承诺官方编辑器编辑后保留该自定义映射。
