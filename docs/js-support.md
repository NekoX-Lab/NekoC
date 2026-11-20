# JavaScript / TypeScript 支持契约

NekoC 把 JS/TS 的静态子集编译成 Kitten N 积木，**不是浏览器或 Node.js**。
普通计算优先用变量、函数、数组、对象和控制流；只有舞台、角色、输入、
调度等功能需要 [NekoC API](api.md)。本页针对默认 `kitten-n` 目标；Kitten 4
还会检查目标积木可用性。类型检查通过、前端能编译、与 JS 运行结果相同、
官方播放器兼容是四件不同的事。

本页所有 `ts example=... file=...` 代码块都是完整正例；
`tests/ts-unsupported-r2-tsdiag-docs.test.mjs` 按 example 分组编译**每一段**，
多文件例子使用内存文件系统。反例及位置/原因/建议契约由
`tests/ts-unsupported-r2-tsdiag.test.mjs` 验证。测试不会把“编译成功”当作
完整 JS 语义证明。下文的限制均给出可编译替代例编号。

## 1. 值、类型与表达式

| 能写什么 | 限制及替代 |
| --- | --- |
| `let`、`const`、已初始化 `var`，number/string/boolean；词法块和局部重名 | 不依赖未初始化变量的隐式 undefined；显式标注可空类型或给初值，见 **values/nullable**。优先 let/const，尤其集合回调不支持 var |
| 数值字面量、NaN/Infinity、算术、比较、`!`、三元、短路 `&&`/`||` | 不保证负零、NaN 比较与完整 JS 相同，见末节；混合 any/union 的 `+` 和宽松相等可能拒绝，显式 String 或具体数字类型，见 **values** |
| 数字位运算 `& | ^ ~ << >> >>>` 及语句复合赋值 | 只接收静态数字；不支持 BigInt。大整数用文本，位操作前显式提供数字，见 **values** |
| 简单变量前后置更新；声明/return/语句中的部分逗号和链式赋值 | 属性更新值、条件/重复求值位置的逗号拒绝；拆成语句，见 **updates** |
| `as`、`satisfies`、泛型类型、interface/type、declare、重载签名、类型命名空间 | 类型擦除不等于运行时转换；不能借 any/断言伪造对象、类、集合或可空身份；运行时 namespace 不支持，改顶层声明，见 **types/objects** |
| 模板字符串、静态 `typeof` | tagged template 不支持，改普通函数；动态 typeof 用显式类型标记，见 **values** |
| `null`、`undefined`、`void 0`、`?.`、`??`、语句 `??=` | 要保留具体的 `T \| null \| undefined` 域；混合域/any 空值、`f?.()`、不安全 `!`、复杂 optional receiver 拒绝；保存 receiver 后判空，见 **nullable** |
| 普通赋值和算术/位复合赋值 | `||=`、`&&=` 拒绝；非可空的 `??=` 拒绝，防止退化为无条件赋值；显式 if，见 **updates** |

**values**：明确数字/文本域；普通函数替代 tag，类型标记替代动态 typeof。

```ts example=values file=main.ts
let count: number = 3;
const largeInteger = "9007199254740993";
const kind = "number";
function label(text: string): string { return "value=" + text; }
console.log(label(String(count)), largeInteger, kind);
count = (count << 1) | 1;
console.log(count, `${count}`, typeof 1);
```

**types**：声明可用于描述形状，不创建运行时对象或命名空间。

```ts example=types file=main.ts
interface Point { x: number }
type Coordinate = number;
namespace Types { export type Value = number; }
declare const unusedAmbient: number;
function twice(n: number): number;
function twice(n: number) { return n * 2; }
const p: Point = { x: 2 };
const n = (p.x as Coordinate) satisfies number;
console.log(twice(n));
```

**updates**：保存旧值并独立更新；逻辑赋值用分支。若目标是调用结果，先保存对象。

```ts example=updates file=main.ts
let n = 0;
if (!n) n = 2;
if (n) n = 3;
const p = { x: 1 };
const old = p.x;
p.x++;
console.log(old, p.x, n);
```

**nullable**：可选属性需在类型中声明，接收者复杂时先保存。

```ts example=nullable file=main.ts
interface Config { title?: string }
const config: Config = {};
let title: string | undefined = config.title;
title ??= "untitled";
console.log(title);
let p: Config | null = null;
console.log(p?.title ?? "missing");
p = { title: "ready" };
if (p !== null) console.log(p.title ?? "missing");
```

详细域与收窄规则见 [null/undefined](ts-nullable.md)。不支持 `void expr` 随意
丢弃结果；把调用作为独立语句，需要返回空值时用显式可空类型，见 **events**。

## 2. 函数、作用域、控制流和调度

支持普通函数、具名变量绑定的 arrow/function expression、静态可解析的嵌套函数
及函数实参特化。递归标量局部使用调用帧；小函数可能内联。
支持 if/else、while、do/while、通用 for、switch/fallthrough、break/continue、
合法标签跳转。for-of 支持数组、列表、字面量字符串及受限 Map/Set 迭代。

| 限制 | 替代 |
| --- | --- |
| rest/解构参数、逃逸函数值、动态 call/apply/bind、不安全可变捕获 | 数组参数或显式状态参数，见 **functions** |
| 默认值不能安全绑定/求值、可观察的省略 optional 参数不支持的路径 | 使用明确默认常量；需要副作用时按 JS 顺序先求值全部实参再求默认，见 **functions** |
| generator/yield、async/await/for-await、Promise/microtask | 返回数组或显式循环；事件状态和 wait，见 **functions/events**；不承诺 Promise 时序 |
| `for...in`、动态字符串 for-of、通用迭代器协议 | 固定属性逐个读取；数组 for-of；BMP 文本用 charAt 循环，见 **loops/objects** |
| 跨函数/未捕获 throw；finally 中带非局部完成；对象程序 throw | 返回显式状态，见 **status**；局部标量 try/catch 可用 |
| 事件/DSL callback 默认参数被忽略的路径 | 无参 callback 内初始化，见 **events** |
| 定时器捕获调用局部、角色工作区内定时器 | 在根工作区调度，用顶层共享状态，见 **events** |
| using/await using、debugger、with、import.meta/new.target | 手工初始化/清理、console.log、显式属性/参数，见 **cleanup/objects** |

**functions**：参数显式化，生成器改为返回数组。

```ts example=functions file=main.ts
function sum(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}
function plus(a: number, b = 1): number { return a + b; }
const input = [1, 2, 3];
const result = sum(input);
console.log(plus(result));
```

**loops**：动态字符串示例限定 BMP（ASCII/常用汉字），不拿 UTF-16 单元当 emoji。

```ts example=loops file=main.ts
let total = 0;
outer: for (let i = 0; i < 3; i++) {
  for (const n of [1, 2]) {
    if (n === 1) continue;
    total += n;
    if (total > 3) break outer;
  }
}
let text = "猫abc";
for (let i = 0; i < text.length; i++) console.log(text.charAt(i));
do { total--; } while (total > 2);
switch (total) { case 2: console.log("two"); break; default: console.log(total); }
```

**status**：显式状态替代跨函数异常。

```ts example=status file=main.ts
function valid(n: number): boolean { return n >= 0; }
const input = 3;
if (valid(input)) console.log(Math.sqrt(input));
else console.log("invalid input");
try { throw "local"; } catch (error) { console.log(error); }
```

**events**：顶层初始化先完成，onStart 独立协作调度；计时器延迟单位是毫秒。

```ts example=events file=main.ts
let state = 0;
onStart(() => {
  const initial = state + 1;
  state = initial;
  wait(0.01);
  console.log(state);
});
const handle = setTimeout(() => { state = 2; }, 20);
clearTimeout(handle);
```

**cleanup**：不是自动资源管理；真正外部资源应由宿主提供显式接口。

```ts example=cleanup file=main.ts
let active = false;
function initialize() { active = true; }
function cleanup() { active = false; }
initialize();
console.log(active);
cleanup();
```

## 3. 数组与对象

数组为稠密列表，普通对象为固定形状的列表堆引用。别名共享内容。
对象方法/访问器不支持，不等于 class 方法/访问器不支持。

| API / 语法 | 接受边界及替代 |
| --- | --- |
| 数组 literal、length、0 基索引、声明解构（含跳过项和 rest） | 不支持 hole/spread、嵌套/default 解构；用明确元素、slice/concat、逐层读取，见 **arrays/objects** |
| 数组索引写、算术/位复合写 | 必须证明为稳定稠密数组界内非负整数；追加用 push，删除用 splice；length 只允许赋 0，见 **arrays** |
| push/unshift/splice | 语句效果可用；需要返回值时显式保存元素/长度，见 **arrays** |
| slice/concat/reverse/join/at/includes/indexOf/lastIndexOf/pop/shift | 参数数量/静态域受限；不传显式 undefined/thisArg/spread；负索引和搜索位置按各方法规则处理；可能缺失结果不等价 JS undefined，先检查长度/索引，见 **arrays** |
| map/filter/forEach/reduce/find/findIndex/some/every/sort | 静态 callback；部分遍历禁止缩短数组、让出执行及不透明过程；reduce 优先传初值，见 **callbacks** |
| flat | 仅 depth 1、结构稳定且只含子数组的字面量；多层展平用嵌套循环，见 **arrays** |
| Array.isArray | 静态类型已知、稳定且无副作用的值；先保存结果，不作动态类型系统，见 **arrays** |
| Array(n).fill(v)、Array.from({length:n}, inlineMapper) | 仅这些工厂形态；一般 a.fill、Array.from(iterable)、flatMap 不支持，改循环，见 **factory**。动态 length 和 mapper 第一参数有已知差异，见末节 |
| `{x: value}`、简写、固定键 obj.x/obj["x"]，嵌套/引用/对象参数返回 | 动态 key/新增属性/对象 spread、原型、反射、对象解构、对象 coercion/日志拒绝；固定字段或 Map，显式读取/复制，见 **objects/maps** |
| delete | 不支持删属性或制造 hole；删除数组元素用 splice；对象用 validity 标记，见 **objects** |

**arrays**：替代展开、浅复制、声明解构、显式界限和迭代复制。

```ts example=arrays file=main.ts
const xs = [1, 2, 3];
const copy = xs.slice();
const joined = xs.concat([4]);
const [head, ...tail] = xs;
xs[0] = 5;
copy.push(4);
copy.unshift(0);
copy.splice(1, 1);
if (copy.length > 0) console.log(copy[0]);
const out: number[] = [];
for (const row of [[1, 2], [3]]) for (const x of row) out.push(x);
console.log(head, tail.join(","), joined.length, out.join(","), Array.isArray(xs));
```

**callbacks**：不在遍历期间删除，用返回新数组的 filter。

```ts example=callbacks file=main.ts
const xs = [3, 1, 2];
const ys = xs.filter(x => x > 1).map(x => x * 2);
console.log(ys.reduce((sum, x) => sum + x, 0));
console.log(xs.some(x => x > 2), xs.every(x => x > 0));
const index = xs.findIndex(x => x === 2);
if (index >= 0) console.log(xs[index]);
xs.sort((a, b) => a - b);
xs.forEach(x => { console.log(x); });
```

**factory**：显式有限长度检查和应用上限替代不受限分配；不依赖工厂 mapper 首参。

```ts example=factory file=main.ts
let count = 3;
const xs: number[] = [];
if (Number.isInteger(count) && count >= 0 && count <= 100) {
  for (let i = 0; i < count; i++) xs.push(i * 2);
}
console.log(xs.join(","));
```

**objects**：固定形状、手工复制；对象要打印标量字段。对象递归分配/修改和不安全
让出路径改为循环或状态机；详见 [对象边界](ts-share-objects.md)。

```ts example=objects file=main.ts
const original = { x: 1, valid: true, child: { y: 2 } };
const copy = { x: original.x, valid: original.valid, child: original.child };
const child = original.child;
console.log(original.x, child.y);
original.valid = false;
copy.child.y = 3;
console.log(child.y);
```

## 4. 字符串、数值与标准库

API 名出现在 TypeScript 标准库中不表示目标支持。未列出的标准库 API 不应
依靠宿主 JS 执行；未知调用产生兼容诊断。所有动态方法都要求接收者类型可确定。

| 接受的 API | 限制及替代 |
| --- | --- |
| String(v)、文本 `+`、模板、length、charAt、substring | 对象不可转文本；s[i] 需常量字符串内界整数，动态用 charAt，见 **strings** |
| includes/indexOf/lastIndexOf/startsWith/endsWith、split | 搜索/分隔符须字符串；支持数值位置/limit；RegExp 不支持，见 **strings** |
| replace/replaceAll | 恰好两个字符串参数，无 regex/replacer function；replaceAll 可能空 search 的动态非 BMP 场景拒绝，见 **strings** |
| repeat/padStart/padEnd、concat、trim/trimStart/trimEnd、toUpperCase/toLowerCase | 增长上限和 Unicode 差异见末节；业务限定 BMP/ASCII 或保留原文本，见 **strings** |
| 字符串 slice、at、charCodeAt、String.fromCharCode | slice 的动态接收者只支持常量边界；其余主要常量折叠，不能制造孤立代理项。动态末尾字符用 BMP charAt，见 **constant-methods/strings** |
| Number、单目 +、parseInt/parseFloat | Number 动态只接受 number/boolean；prefix parser 只接受字面量原始值和字面量 radix；动态解析应在宿主完成后传数值或自行编写受限解析器，见 **numbers** |
| Number.isInteger、常量 isNaN/Number.isNaN、数字 toString、toFixed | 动态 isNaN、动态 toFixed、动态非十进制格式拒绝；动态输出用 String，固定格式用常量，见 **numbers/constant-methods** |
| JSON.stringify | 仅可折叠常量、单个实参；无动态 JSON.parse/stringify/replacer/space；用明确字段协议或预处理输入，见 **constant-methods/objects** |
| Math.floor/ceil/round/trunc/abs/sqrt/exp/log/log10/pow/min/max/random | 固定 arity，min/max 至少一参；用数字参数；其他算法显式组合，见 **math** |
| Math.sin/cos/tan/asin/acos/atan/atan2/sign/cbrt/log2/hypot | 弧度接口，辅助过程或积木实现；不承诺所有 IEEE-754 特殊组合一致，见末节及 **math** |
| Math.PI/E/SQRT2/SQRT1_2/LN2/LN10/LOG2E/LOG10E | 不支持其他 Math/Number 常量或方法（如 fround/imul、Number.isFinite/isSafeInteger）；用具体算法/应用输入约束，见 **math/factory** |
| console.log | 标量参数以空格拼接；无浏览器控制台对象检查器，见 **values** |

**strings**：字符串搜索替代 regex；BMP charAt 替代不确定下标。

```ts example=strings file=main.ts
let text = " cat dog ";
console.log(text.charAt(1), text.substring(1, 4), text.slice(1, 4));
console.log(text.includes("cat"), text.indexOf("dog"), text.startsWith(" cat"));
console.log(text.split(" ").join("/"));
console.log(text.replace("cat", "猫"), text.replaceAll(" ", "_"));
console.log(text.trim().toUpperCase(), "x".repeat(3), "7".padStart(3, "0"));
```

**numbers**：转换不是类型断言。Boolean 构造器不属于这里的标准库支持集；
用数值比较/逻辑运算明确表达判断。

```ts example=numbers file=main.ts
const parsed = parseInt("42px", 10);
const fraction = parseFloat("1.5em");
let n: number = parsed;
console.log(Number(true), Number(n), String(n), n.toString());
console.log(Number.isInteger(n), fraction, n !== 0);
```

**constant-methods**：仅常量折叠不意味着可动态调用。

```ts example=constant-methods file=main.ts
console.log((12.5).toFixed(2), (255).toString(16));
console.log("abc".charAt(2), "A".charCodeAt(0), String.fromCharCode(65));
console.log(isNaN(0 / 0), Number.isNaN(1));
console.log(JSON.stringify([1, "x", true]));
```

**math**：浮点算法示例，结果精度取决于底层积木。

```ts example=math file=main.ts
let x = 3;
console.log(Math.floor(x), Math.ceil(x), Math.round(x), Math.trunc(x));
console.log(Math.abs(x), Math.sqrt(x), Math.pow(x, 2), Math.min(x, 4), Math.max(x, 4));
console.log(Math.sin(Math.PI / 2), Math.atan2(1, 1), Math.hypot(x, 4));
console.log(Math.sign(x), Math.cbrt(8), Math.log2(8), Math.random());
```

## 5. Map / Set 和 class

Map/Set 支持构造、链式 set/add、get/has/delete/clear、size、插入顺序及 live
for-of/内联 forEach。键和 Set 元素是 string/number（可混合），get 可返回 undefined。
Map 值为单一具体域的标量、对象、class 或集合；数组/nullable 值请包进对象。
不支持 WeakMap/WeakSet、对象/布尔键、逃逸 iterator、集合 spread、动态下标方法、
size 写入、直接带标签的集合 for-of。用显式循环、标量 ID 和普通数组替代，见 **maps**。
可空集合方法先保存并判空，不直接 `?.get()`；见 [集合规则](ts-map-set.md)。

```ts example=maps file=main.ts
const counts = new Map<string, number>();
for (const word of ["cat", "dog", "cat"]) counts.set(word, (counts.get(word) ?? 0) + 1);
const words: string[] = [];
for (const [word, count] of counts) { words.push(word); console.log(word, count); }
const seen = new Set<string>(words);
console.log(seen.has("cat"), counts.size);
```

class 支持顶层具名声明、初始化字段、constructor/参数属性、实例方法、this、
extends/super、abstract、受限 instanceof、多态实例 getter/setter、显式类名 static
字段/方法。不是完整 JS prototype 模型。以下限制均可用 **classes** 中的具名字段、
普通方法和显式初始化改写：class expression/嵌套类、#私有名、装饰器、泛型类/方法、
mixin/内建继承、函数值字段/脱离方法、static block/static this/static 继承、动态类值。
构造必须安全初始化；复杂 super/前向读取/初始化时虚调用会被拒绝，先初始化再调用。
跨模块类继承不支持，把相关类放同文件；详见 [类规则](ts-classes.md)。

```ts example=classes file=main.ts
class Counter {
  value = 0;
  constructor(public step: number) {}
  advance(): number { this.value += this.step; return this.value; }
}
const counter = new Counter(2);
console.log(counter.advance(), counter.value);
```

## 6. 模块与宿主环境

仅支持相对路径、同名 named function imports，导入模块只含函数与类型声明及
其他此类 imports。静态函数绑定包括 function expression、带括号 arrow、多声明
函数绑定和 const 函数别名；它们不产生要丢弃的模块运行期初始化。模块内供函数
使用的普通实例 class 可生成私有工厂，带 static
成员的模块类不在此范围。不能静默丢弃模块顶层初始化：把它移入显式 init 函数。
不支持默认/namespace/空/副作用 imports、导入别名、value export lists/re-export、
循环依赖、import=require、动态 import、npm/Node 模块。
类型专用 imports/exports 可擦除，不产生运行时加载。

**modules**：wrapper 替代 alias，显式调用替代隐式模块副作用。

```ts example=modules file=main.ts
import { initialize, double } from "./library";
function localDouble(n: number): number { return double(n); }
initialize();
console.log(localDouble(3));
```

```ts example=modules file=library.ts
export function initialize() { console.log("initialized"); }
export function double(n: number): number { return n * 2; }
```

不提供 DOM/window/document、fetch、网络/文件系统、eval/Function、Date、Symbol、
Proxy/Reflect、Web API、TypedArray/ArrayBuffer、Intl、Promise 等宿主设施。替代方案是
由宿主预处理数据，以数字/文本/固定对象传给程序（**values/objects**），舞台交互用
明确的事件 API（**events**）。`new Error(text)` 仅作为局部 throw 的消息形式，不是
通用 Error 实例支持（**status**）。

## 7. 已接受但不是完整 JS 的边界

以下来自当前实现及已有测试/文档；本页未新增官方运行时语义实测，不把推测称为
官方一致性。更细证据见 [对象证据](ts-share-objects.md)、[字符串 API](api.md)、
[内联限制](ts-inline-budget.md) 及对应专项测试。

- 数组越界、空 pop/shift、find 未命中不是统一的 JS undefined。先检查 length 或
  findIndex（**arrays/callbacks**）；不要把空列表项当 nullable 值。
- Array(n).fill 的动态非整数/负数长度没有 JS RangeError 保证；Array.from 的 mapper
  首参当前按占位 0 传入，不是缺失元素 undefined，默认参数也不能据此推断。
  不使用这些边界，改 **factory**。完整官方行为**未验证**。
- 字符串大小写转换只实现 ASCII；trim 只覆盖空格、tab、LF、CR。动态索引/搜索的
  部分路径要求 BMP 或运行时用空文本保护非 BMP，repeat/pad 上限 65536，动态非法
  repeat 返回空文本而不是 RangeError。完整 Unicode/异常语义**未验证**。
  业务限定输入域（**strings**），完整 Unicode 转换由宿主预处理。
- 原生负零、NaN 相等、某些非有限 Math 组合、离散 Math.random 不保证 JS 完全一致。
  用有限范围输入（**factory/math**）；不要用这些边界模拟 IEEE-754 测试。
- 普通函数混合省略默认值与后续副作用实参的顺序仍有限制。先按 JS 顺序保存明确实参，
  再计算需要的默认值并显式传入（**functions**）。
- 对象/集合堆运行中没有逐对象 GC，重启回收；不要无界分配（**factory**）。
- 兼容诊断不是全程序 JS lint：原始语法守卫检查未使用函数，但部分 API 检查按实际
  编译调用路径执行。仅将一个 API 放进未使用函数且编译成功，不能证明其支持。

## 检查入口与维护

运行 `node --test tests/ts-unsupported-r2-tsdiag*.test.mjs`；实际项目运行
`nekoc check entry.ts`（包含类型和兼容检查）。`--no-types` 仍须拒绝上述反例。
错误格式为 `文件:行:列: error NEKOC: 原因; alternative: 改写建议`，坐标从 1 开始；
具体错误代码及措辞可能随来源变化。输出诊断不得伪装成功或返回部分作品。
读取源码失败时没有可知行列，不虚构坐标。

实现入口：`ts/compile-ts.mjs`、`ts/js-support.mjs`；预处理模块依次处理集合、nullable、
class、常量方法、值/sequence、函数/作用域，再由前端生成积木。新增语法或 API 时同时
更新本表、编译正例和拒绝反例；专项文件中的详细限制仍需保持对应回归测试。
