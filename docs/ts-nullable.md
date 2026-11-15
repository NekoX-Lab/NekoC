# TypeScript null / undefined、可选属性与可选链

NekoC 支持类型里显式写出 `null` / `undefined` 的值：可选属性、可空字段、
可选链 `?.`、空值合并 `??` / `??=`、与 `null` / `undefined` 比较以及据此收窄。
生成的作品只用官方变量、列表、运算、比较、逻辑、控制、文本、自制积木和
`warp`，不使用 `_object_*`、`logic_ternary` 或 `math_trig_rad`。

```ts
class ListNode {
  constructor(public value: number, public next: ListNode | null = null) {}
}
let head: ListNode | null = null;
for (let i = 1; i <= 3; i++) head = new ListNode(i, head);
for (let cur = head; cur !== null; cur = cur.next) console.log(cur.value);
console.log(head?.next?.next?.next?.value); // undefined

interface Config { width?: number; title?: string }
function describe(c: Config): string {
  return (c.title ?? "untitled") + ":" + (c.width ?? 100);
}
console.log(describe({}));               // untitled:100
console.log(describe({ width: 0 }));     // untitled:0
```

## 运行时哨兵值

Kitten N 没有 null 和 undefined，未写入的变量、列表项和对象堆槽位都是 `0`。
因此 NekoC 给可空位置选用一对哨兵值：

| 值的类型（去掉 null/undefined 后） | null | undefined |
| --- | --- | --- |
| `number`、`boolean`、对象 / class 实例引用、数组 | 文本 `"null"` | 文本 `"undefined"` |
| `string` | 数字 `-1` | 数字 `-2` |

选择依据：

- Kitten N 的 `logic_compare` 等于比较不在文本和数字之间做类型转换：文本
  `"null"` 不等于任何数字、布尔值或对象句柄（句柄是从 1 开始的数字），数字
  `-1` 也不等于任何文本，包括文本 `"-1"`。所以哨兵永远不会和同一位置的合法值
  相撞，判断只需要两次官方等于比较。
- null 和 undefined 各占一个值，`===` 能区分二者；`== null` 降为“等于 null 哨兵
  或等于 undefined 哨兵”，与 JavaScript 的宽松相等一致。
- 数字、布尔和引用位置直接用文本 `"null"` / `"undefined"`，`console.log` 和字符串
  拼接不需要额外积木就能打印出 JavaScript 的结果；只有字符串位置的哨兵需要在
  输出或拼接时换回 `"null"` / `"undefined"`。
- 不用 `0`、空文本或 `NaN`：它们都是合法值，也是 Kitten N 的默认值，会把
  “未写入”和“写入了 0”混为一谈。

哨兵只出现在类型含 `null` / `undefined` 的位置。不涉及 null/undefined 语法的
程序原样交给后续编译步骤，生成的积木和输出与之前逐字节一致
（`tests/ts-nullable.test.mjs` 对既有 fixture 做回归检查）。

## 支持范围

- 可空类型：`T | null`、`T | undefined`、`T | null | undefined`，`T` 为
  `number`、`string`、`boolean`、数组、顶层声明的 interface / type 别名 / class。
  变量、参数、返回值、对象属性、class 字段、数组元素都可以是可空类型。
- 可选属性：interface、类型字面量和 class 字段上的 `x?: T`。对象字面量可以省略
  可选属性，省略的属性和没有初始值的可选 / 可空 class 字段读出 `undefined`。
  没有初始值的可空 `let` 也是 `undefined`。
- `null`、`undefined`、`void 0` 字面量；可空函数里的 `return;` 返回 `undefined`。
- `a?.b`、`a?.b.c`、`a?.[i]`、`a?.m(args)`（含 class 方法），既可作值也可作独立
  语句。接收者只求值一次；短路时右侧的属性读取、方法调用和实参都不执行。
- `a ?? b`：`a` 只求值一次，`b` 只在 `a` 为 null/undefined 时求值。`0`、`false`、
  空文本照常保留。`a ??= b` 作为独立语句支持变量、`this` 和属性路径。
- `x === null`、`x !== undefined`、`x == null`、`x != undefined`，以及两个同类型
  可空值之间的 `==`；`switch` 的 `case null`。
- 真值判断：条件里的 `if (x)`、`!x`、`!!x`、`x && x.ok`、`x ? a : b` 对可空引用
  等价于“不是 null/undefined”；可空数字、字符串、布尔值还按 JavaScript 规则把
  `0`、`""`、`false` 视为假。用 `x || y` / `x && y` 取值时，左侧须是变量或属性
  路径，且两侧值类型相同；对象值的 `&&` / `||` 取值仍按普通对象规则拒绝。
- 收窄：TypeScript 检查器收窄后的分支（`if (x !== null)`、提前 `return`、
  `while (cur !== null)` 等）按非空类型编译，属性读取、方法调用和算术照常可用。
- 输出：`console.log(null)`、`console.log(x)`、字符串拼接、模板字符串和
  `String(x)` 都打印 `null` / `undefined`，与 JavaScript 一致。
- 可空数组元素的 `push`、`indexOf(null)`、`includes(null)`、`map(v => v ?? 0)`。

## 拒绝范围

以下写法给出带源码位置的编译错误，并提示替代写法：

- null / undefined 参与算术、关系比较或作为接收者，例如 `null + 1`、`undefined < 1`。
- 未收窄就读取可能为空的值：算术、关系比较、属性读取、方法调用。先写
  `if (x !== null)` 或使用 `?.` / `??`。
- 非空断言 `x!` 作用于可能为空的值（运行时不会检查），以及可选链中的 `!`。
- 可选链的接收者不是变量、`this`、属性路径或常量 / 变量下标，例如 `g()?.v`：
  先存进 `const`。不支持 `f?.()`，函数不是运行时值。
- `??=` 用作表达式；`??` 两侧值类型不同。
- 同时含多种值类型的可空联合，例如 `string | number | null`；不同值类型可空值
  之间的 `==`。
- `any` / `unknown` 中的 null（沿用既有诊断）。
- `void 0` 以外的 undefined 来源：数组 `pop` / `shift` / `find` 的结果不带运行时
  undefined，用于可空位置时报错，请先检查长度或用 `findIndex` 后按下标读取；
  数组越界读取仍是 Kitten N 的空值，不是 undefined。
- 可空值所用的 interface / type / class 必须在文件顶层声明。
- `delete obj.x`，以及第 1、2 步已有的全部对象和 class 限制。
- `Map<string | number, T>` 暂不支持。
- 对象引用不能转成文本，可空引用也一样；请打印标量属性。

## 编译方式

前端在 class 降级之前运行 `ts/tsfeat-nullable.mjs`：用开启 strictNullChecks
的检查器取得每个位置的声明类型与收窄类型，把可空类型改写为非空类型，并把
哨兵、判空、`??`、可选链等改写成保留名字 `__nekocNil*` 的调用（这些名字禁止用户
使用）。改写不增删换行，错误位置保持原源码行列。积木编译器把这些调用展开成
官方比较、逻辑和报告器自制积木（`ts/nil-intrinsics.mjs`），短路分支复用
`&&` / `||` / `?:` 的报告器结构，只计算被选中的一侧。

## 验证入口

- `tests/ts-nullable.test.mjs`：每项特性的编译与 Node / VM 差分、每条拒绝路径的
  诊断、官方积木与自制积木参数 / 返回值格式检查，以及不使用 null 的程序保持
  原样的回归检查。
- `tests/fixtures/ts-nullable.ts`：链表、二叉树、可选配置、`?.`、`??`、`??=`、
  比较与输出，Node 和 `nekoc run` 输出 42 条日志逐条一致。
- `tests/ts_nullable.rs`：在解释器和 JIT 两种模式下核对该 fixture。
- 用 `nekoc build` 生成的作品须通过 `node tools/editor-compat.mjs <作品.bcmkn>`
  （`ok: true`）。
