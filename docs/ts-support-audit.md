# TS 写法支持情况（实测）

原有 156 条用例之外，普通 JS 兼容性回归见 `tests/js-compat.test.mjs` 和 `samples/js_compat.ts`：使用 `compile-ts-bcmkn` 编译，再由 `nekoc run --ticks 120` 在固定 60 Hz 虚拟时间内核对快照。对象积木格式依据 `tests/fixtures/kn-semantics/objects.bcmkn` 与 `docs/kn-objects-official.json` 的官方取证。`samples/js_compat.ts` 生成的作品已通过 `tools/editor-compat.mjs`（`ok: true`）。

## 能用，结果正确

### Map / Set

支持 string/number 键与字面量联合、Map 基本 API、Set 基本 API、插入顺序和 live for-of/forEach、引用别名与字段传递、`get` 的 undefined/`??`。数字键按 SameValueZero。回归覆盖词频、去重和图邻接表，并逐条与 Node 比较。数组值、逃逸迭代器、Array.from/spread 等边界有明确诊断；存储成本与完整限制见 [ts-map-set.md](ts-map-set.md)。

### 变量

- 顶层 `let` / `const`：常量初始值（数字、字符串、布尔）写入变量表；数组、对象、函数调用等非常量初始值和普通顶层语句按源码顺序放入隐式开始脚本。
  - 有隐式脚本时，显式 `onStart` 仍是各自独立、并发运行的开始脚本，只是开头先等待顶层初始化完成（生成的 `__nekoc_ready` 标志）；初始化含 `wait` 时也会等它完成。没有隐式脚本时与原来完全一样。角色工作区的独立开始事件不在此屏障内。
  - 常量仍在所有脚本运行前存在，不实现 JS 的暂时性死区；不要依赖声明前读取变量。
- 回调里的局部 `let` / `const`，以及 `=`、`+=`、`-=`、`*=`、`/=`、`%=`、`++`、`--`。字符串变量用 `+=` 是拼接。
- `const [a, b] = [1, 2]` 数组解构。
- `enum`：成员会直接编译成常量，支持数字和字符串成员以及显式赋值（`A = 5`）。

### 函数

- 小型简单函数（若干局部声明加一个 `return`，或者没有 `return` 的语句函数）调用时内联展开。显式数字参数的静态函数按调用图估计展开成本：单次成本超过 256，或成本 ×（静态调用点数 − 1）超过 512 时改为共享自制积木；重复调用、参数和局部变量替换都计入饱和估计。字符串/资源名称、非数字或未标注参数、生成的数组辅助函数和回调保持原有策略。阈值不依赖耗时，不是运行速度保证；详见 [ts-inline-budget.md](ts-inline-budget.md)。
- 递归函数（包括互相递归）、带多个 `return` 或提前 `return` 的函数，会自动编译成自制积木：
  - 返回值的编译成有返回值的积木，不返回值的编译成普通积木。
  - 参数和函数里的 `let` / `const` 局部变量每次调用独立：包装积木为每次调用分配一个列表帧，递归调用之后局部变量的值不会被覆盖。报告器递归深度上限是 200 层。
  - 递归函数的返回类型要写出来（如 `function sum(n: number): number`），否则 TS 推断为 `any`，`+` 会报错。
  - `return c ? a : b` 只计算被选中的分支，所以 `n < 2 ? n : fib(n - 1) + fib(n - 2)` 这种写法能正常结束。
- 箭头函数常量，如 `const f = (x) => x + 1`，规则同上。
- 局部变量和参数会先改成全局唯一名，词法块、循环、调用方和被调用方的同名变量互不遮蔽。支持嵌套函数、函数表达式和静态可知的函数实参；可变捕获、逃逸函数值、递归捕获和递归函数参数特化明确报错。
- 内联调用的实参只计算一次，按顺序在函数体之前计算（没用到的参数也会计算）；数组实参按引用传递，函数里 `a.push(x)` 会改到调用方的数组。
- 默认参数 `function f(x, y = 10)`：常量默认值在调用处展开；`y = next()`、`y = settings.size` 这类默认值在调用处按参数顺序计算一次，前提是不读任何参数、用到的名字在定义处和调用处指同一个文件级变量或函数，否则编译报错。已有顺序限制：`f(undefined, next())` 中前面的副作用默认值可能先于后面的显式实参求值，不等于 JS 的“全部显式实参先求值”；请先按 JS 顺序保存实参及默认值再显式传入。内联预算不修复这项已有 lowering 问题，见 [ts-inline-budget.md](ts-inline-budget.md)。
- 有返回值的函数也可以单独作为一条语句调用，返回值会被丢弃。
- 可以给标量参数重新赋值（`n = n - 1`）：前端生成局部副本，递归时副本和其他标量局部变量都放在每次调用独立的帧中。函数值参数不允许重新赋值。
- `defineProc`、`param()`、`callProc`、`defineReporter`、`returnValue`、`callReporter`。
- `tell` / `tellAndWait` 的唯一角色名在组装时转换成实际分配的角色 ID，避免编辑器把目标下拉框重置成 `?`。

### 控制流

- `if / else if / else`。
- `while`、`do...while`（至少执行一次）、`repeat(n, ...)`、`repeatTimes`、`repeatUntil`、`forever`、`warp`。
- 一般 `for` 循环：每轮重新计算条件，支持小数起点、变量步长、`i *= 2`、复杂条件、多个循环变量、循环体里改循环变量和 `for (;;)`。常量整数范围且循环变量只读时仍用紧凑的遍历积木。
- `for (const x of ...)`：可以遍历数组字面量、已知数组变量和 `self.list("名字")`（或 `.get()`），被遍历的值只计算一次；字符串字面量按 Unicode 码点遍历。
- `break`：能跳出各种循环，也能写在 `switch` 的任意位置；带标签的 `break` 能跳出外层循环或带标签的块。
- `continue`：可以写在嵌套的 `if` 和 `switch` 里；`for` 的步进和 `do...while` 的条件仍会执行。
- `switch`：支持贯穿和条件 `break`，判别值只计算一次。
- `try / catch`：try 里嵌套循环和条件中的 `throw` 都会跳到本地的 catch，`catch (e)` 拿到抛出的值（`new Error("x")` 拿到 `"x"`）。
  - 跨函数的异常和没有 catch 接住的 `throw` 编译报错，不会悄悄变成"停止"。
  - `try/finally` 里有 `return` / `break` / `continue` / `throw` 时编译报错（未实现每种完成方式都执行 finally）。

### 表达式

- 算术 `+ - * / % **`、一元负号。`%` 和 JS 一样（`-7 % 3` 得 `-1`），官方积木也是这样算的。
- 比较、`!`。
- `&&`、`||`、三元 `c ? a : b`：编译成带"如果/否则"分支的报告器自制积木，只计算被选中的一边，结果是操作数本身（和 JS 一样，`0 || "x"` 得 `"x"`）。不使用分享播放器缺失的 `logic_ternary`。
- `??`：能静态证明不是空值的数字、字符串、布尔操作数照旧（`let a = 0; a ?? 7` 得 `0`）；类型显式含 `null`/`undefined` 的操作数按运行时哨兵判空，右侧只在为空时求值，不会当成"或"。见 `docs/ts-nullable.md`。
- `a++`、`++a`、`a--`、`--a` 可以用在表达式里（限可变的简单变量）。
- 位运算 `& | ^ ~ << >> >>>`：支持任意数字表达式，以及语句位置的 `&= |= ^= <<= >>= >>>=`（变量、稳定稠密数组元素、数字对象属性）。按 JS ToInt32/ToUint32 截断小数、将 NaN/Infinity 归零、模 2^32，移位数取低 5 位；`>>>` 返回 uint32，其余返回 int32。操作数从左到右只求值一次。常量仍折叠，`x | 0`、`x >>> 0`、低位掩码和移位走算术特化；通用 `& | ^` 在 warp 自制积木内最多循环 32 次，仅生成分享播放器支持的积木。非数字类型及表达式位置的复合赋值明确报错。
- 逗号表达式支持语句、声明初值、返回值，以及 `for` 的初始化和步进；`continue` 后仍执行完整步进。条件表达式和循环条件中的逗号明确报错，避免把每轮求值错误提升到循环外。
- `null`、未初始化局部变量的静态比较和 `typeof` 在值可证明不变时折叠。类型显式含 `null`/`undefined` 的值（含可选属性、可空字段）用运行时哨兵存储，支持 `?.`、`??`、`??=`、判空与收窄（`docs/ts-nullable.md`）；`any`/`unknown` 中的空值仍明确报错。
- 常量 `toFixed`、进制 `toString`、`isNaN` / `Number.isNaN`、`charCodeAt` / `String.fromCharCode`、字符串 `at` / `slice` 按 JS 折叠；动态十进制 `toString()` 和常量边界的字符串 `slice` 也支持，其他动态变体明确报错。
- `JSON.stringify` 只支持常量折叠（包括嵌套数组字面量和 JS 转义）；非常量以及 replacer/spacing 参数明确报错。分享播放器不支持 JSON 报告器，不生成该积木。
- `Math.floor / ceil / round / trunc / abs / sqrt / exp / log / log10 / pow / max / min / random`、`Math.sin / cos / tan / asin / acos / atan`（弧度）、`Math.PI`、`Math.E` 等常量。
  - `Math.max` / `Math.min` / `Math.trunc` 的每个参数只计算一次，按从左到右的顺序。数字 max/min 任一位置的 NaN 均传播为数值 NaN，后续实参仍完整求值；支持单参数、多参数、±Infinity 及嵌套/递归调用。trunc 保留 NaN 和 ±Infinity；不保证负零模型，也不扩展 any/文本强制转换。
  - 标准三角函数在弧度和角度间换算，使用分享播放器支持的 `math_trig` / `math_arc_trig`，不生成缺失的 `math_trig_rad`；实参只计算一次。
- `Number()`、`parseFloat()`、`parseInt()`（取整数部分）、`String()`。
- 新增 `Math.sign / cbrt / log2 / hypot / atan2`。`sign / cbrt / log2 / atan2` 通过辅助自制积木保存实参，避免重复执行实参表达式；`hypot` 内联为 `Math.sqrt(Math.pow(a, 2) + …)`，每个实参只计算一次。以有限数字为支持范围；`atan2` 不保留负零象限，`hypot` 不承诺 Infinity/NaN 特殊组合的 JS 语义。
- `Number.isInteger` 支持数字输入，包括函数参数/返回值；新增保证 NaN 和 ±Infinity 返回 false，有限整数为 true、小数为 false。静态类型为文本/布尔的实参返回 false，副作用仍求值一次。动态混合类型输入不保证 JS 语义。

### 字符串

- `+` / `+=`：按 TS 类型检查器给出的操作数类型决定。有一边是字符串（字面量、模板字符串、`string` 标注、函数返回值、元组位、`string[]` 元素、对象属性等）就编译成"连接"积木；`any`、混合联合类型（如 `string | number`）和非原始值编译报错，拼接请写 `String(x)`，相加请给出准确的数字类型（如 `getVar<number>("x")`）。
- 模板字符串 `` `n=${x}` ``。
- `.length`、`s[i]`、`s.charAt(i)`、`s.slice(a, b)`、`s.substring(a, b)`、`s.includes(x, position?)`、`s.split(sep?, limit?)`。
- `charAt/substring` 按接收者、实参顺序各求值一次；数字下标向零截断，substring 钳位到 `[0,length]` 后交换反序边界，相等返回空串。charAt 越界返回空串。NaN 按 0，Infinity 按边界处理；不修改原生 selectText 的反向截取规则。slice 保持原有常量下标（含负数）和半开空区间语义，不交换边界。
- `startsWith/includes/indexOf` 的 position 默认 0；`endsWith` 的 endPosition、`lastIndexOf` 的 position 默认文本长度。支持负数/小数/超界/空 needle；lastIndexOf 的 NaN 按末端，其余按 0。split limit 按 uint32 截断/模 2^32（非有限值按 0），省略为 2^32−1；每次返回新数组，接收者不变。额外实参、spread、显式 undefined 和正则/强制转换重载定位拒绝，提示省略可选参数或使用字符串。
- padding 精确补至截断后的长度，空 fill 或无需补齐直接返回；repeat 次数向零截断。支持动态变量/表达式/函数/循环次数、目标长度和 fill。NaN 按 0；动态 repeat 负整数/正负 Infinity 返回空串，非法常量计数可编译报错；repeat 运行时只保留总长不超过 65536 UTF-16 单元的完整副本，padding target 运行时钳位到 [0,65536] 且不截原串。非 BMP fill 若需不完整副本则保守返回原串，常量可精确折叠时仍检查孤立代理项。以上是已知差异，不是完整 JS RangeError/资源语义，详见 docs/api.md。
- `indexOf`、`lastIndexOf`、`startsWith`、`endsWith`、`replace`、`replaceAll`、`trim`、`trimStart`、`trimEnd`、`repeat`、`padStart`、`padEnd`、`toUpperCase`、`toLowerCase`（只转换英文字母）、`concat`。
  - 这些方法没有对应积木，编译器会生成用循环实现的辅助自制积木，用到哪个才加哪个。
  - 比较字符时用的是积木的"等于"，和积木本身的规则一致（例如数字形式的文本 `"1.0"` 和 `"1"` 视为相等）。
- UTF-16 安全：BMP 证明只作为快速路径优化。未知形参/容器/字段/被循环与声明重写的绑定不再编译拒绝，而在代码单元选择/搜索前运行时检查；ASCII/中文保持正常结果，非 BMP 保守替换为空接收者，避免孤立代理项 VM 异常（文档化差异）。无 position includes/startsWith 和确定非空 separator split 仍使用安全原生路径保留 emoji；空/未知 separator 走 guard。写入事实继续覆盖赋值、更新、循环、解构和全部合并声明，使不可靠静态证明转为 guard。普通 self/any/as 不豁免运行时安全限制。
- `join()`、`selectText()`、`length(x)`。

### 数组（列表值）

- 用数组字面量、`split()`、`tempList()` 初始化的变量是列表。
- 支持 `a[i]`（读第 i + 1 项）、`a[i] = v`、`a.length`、`a.push(x)`、`a.includes(x)`。读越界下标得到 Kitten N 的空值 `NaN`，不是 JS 的 `undefined`。
- `map`、`filter`、`forEach`、`reduce`（需要初始值）、`find`（找不到时返回空字符串）、`findIndex`、`some`、`every`、`sort`（可带比较函数，原地排序）、`indexOf`、`lastIndexOf`、`join`、`concat`、`slice`、`reverse`、`pop`、`shift`、`unshift`、`splice`。可以链式调用，如 `a.map(...).filter(...).join(",")`。
  - 回调里可以使用外面的变量；但不能使用外层自制积木（递归函数等）的参数，需要先复制到变量。
  - `reverse()` 原地修改数组并返回同一引用。
  - 数组 `slice(start?, end?)` 先对接收者、全部显式数字边界从左到右各求值一次，再读取已保存接收者的长度。边界小数向零截断、NaN 按 0、负数相对末尾，最后钳位到 `[0, length]`，支持 ±Infinity；省略起点/终点分别按 0/长度，空范围和反向范围返回空列表。结果是新的稠密列表，浅复制保留对象、实例及嵌套列表元素的引用身份，不改源列表结构。非数字及显式 null/undefined 边界定位报错，提示转换或省略；不扩展稀疏数组、不改变普通 `a[i]` 越界值和原生列表索引。
  - 语句位置 `push/unshift/splice` 先保存接收者，再从左到右保存全部实参，之后才修改原列表。保存值属于每次调用，嵌套和递归调用不会覆盖；`splice` 仍限现有非负起点子集。
  - `includes/indexOf/lastIndexOf` 支持数字 `fromIndex`：小数向零截断，负数从末尾计数，NaN 按 0，省略 `lastIndexOf` 起点时从末项开始。显式 `undefined` 定位报错并提示省略参数。数字 NaN 仅能被 `includes` 找到；不扩展混合类型相等规则。导入模块也先加载完整类型信息再合成 helper，因此注解数组参数、函数返回数组和 concat 标量参数与入口文件遵守同一校验规则，不绕过 any/数组标量联合类型诊断。
  - `concat()` 支持零个、一个或多个静态可知的数组/标量实参，先求值全部实参再按顺序浅复制，源数组和元素引用身份保持。未知类型、数组/标量联合类型需先收窄；spread、thisArg 及多余实参明确报错。
  - `map/filter/forEach/reduce/some/every/find/findIndex` 固定初始遍历长度，每轮读取实际元素；追加不延长回调遍历，修改后续元素会被看到。`filter/forEach/reduce/some/every` 跳过缩短后已不存在的位置。`map` 的空洞结果、`find/findIndex` 对缺失项的 undefined 访问暂不支持，因此保守拒绝回调直接或经别名/函数缩短数组，以及让出/广播的情况，并提示移出遍历或改用显式循环。`getList` 与命名列表共享身份，检查包括 `deleteListItem`（含 self 前缀）、`self.list(...).delete/remove`，以及可用更短列表覆盖目标的 `copyList/copyTo`；即使操作无关列表也保守拒绝。`callProc/callReporter`（含 self 前缀）按字面量目标查找 `defineProc/defineReporter` 源码体，递归传播嵌套调用/普通函数包装的效果；已访问集合防止递归检查无限展开。目标或过程体不能静态确定时定位拒绝，提示使用字面量与可见定义、移出遍历或显式循环；已证明不缩短/不让出的过程仍可调用。普通 `for...of` 保持实时长度。
- 项目列表用 `appendList`、`listItem`、`listLength`、`deleteListItem` 等 API 或 `self.list("名字")`。
- `Array.from({length: n}, (_, i) => ...)`、`Array(n).fill(v)` 和 `new Array(n).fill(v)`。长度限定为有限非负整数；`Array.from` 负数截到 0、小数向下取整。映射的第一参数是目标平台的未定义占位值 0（不是 JS undefined），不支持 thisArg。fill 值求值一次，对象元素共享同一引用。

### 数据对象

- `{k: value}`、简写 `{k}`、嵌套数据对象，属性读取 `obj.k` / `obj[key]`（键必须是编译期常量）、赋值和 `+= / -= / *= / /= / %= / **=`，以及语句位置的属性 `++ / --`。
- 对象存成隐藏全局列表堆里的数字引用，只用分享播放器支持的列表积木，不用 `_object_*` 积木。别名、数组里的对象、函数参数和返回值都保留对象身份；复合赋值的目标和键各求值一次。详见 `docs/ts-share-objects.md`。
- 用到对象的程序里，函数编译成自制积木而不是内联展开；递归函数里修改或新建对象、以及递归局部变量要改写成循环。对象堆在重新开始前不回收。
- 缺失/可选属性、动态键、对象转换/打印/JSON、`delete`、表达式里的属性 `++` 明确报错；空键、`__proto__`、对象方法、访问器、展开和解构也报错。没有原型、类实例语义。

### 定时器

- `setTimeout(() => {...}, ms)`、`setInterval(() => {...}, ms)` 和两种 `clear`，支持省略延时、箭头表达式回调及 function 回调；必须是内联无参回调。不支持字符串代码、附加回调参数及捕获外层函数参数（可先复制到变量）。
  - 暂不支持在 `sprite(...)` 回调内部声明定时器，会明确报错；请从根工作区调度。
- 每次返回独立对象句柄，使用生成广播、带参数接收脚本、`wait(ms / 1000)` 和循环；两种 clear 均将句柄标为取消，正在等待的脚本醒来后退出，不中断正在运行的回调。
- 是 Kitten N 协作式脚本，不是浏览器事件循环：帧量化、负延时按 0、0 延时也经 wait 让出调度。interval 在上一回调结束后重新等待，不补偿回调耗时，不执行追赶、不实现浏览器嵌套钳制。句柄不是浏览器数字 ID，不承诺跨角色共享。回调局部变量仍受现有全局存储限制。

### 其他

- `wait`、`broadcast` / `onMessage`、`sprite()` 块。

## 编译时报错（Kitten N 没有对应概念）

- 对象解构、可选调用 `f?.()` 和对调用结果的可选链 `g()?.x`（可空变量、属性路径上的 `?.` 已支持）、一般 `new X()`（包括 `Map`、`Set`、`Date`、`Promise`）、`class` 实例和对象方法调用。
- 动态 `typeof`、`in`、`instanceof`。
- 剩余参数 `...args`、给函数值参数重新赋值。
- `for...in`、动态字符串的 `for...of`、生成器 `function*`、正则表达式。
- `+`、`+=`、`==` 用在 `any`、混合联合类型或非原始值上（见上文"字符串"）。
- 读取参数的非常量默认值，以及不能证明定义处和调用处绑定一致的默认值；调用处同名局部变量已由唯一命名隔离。
- 非常量 `JSON.stringify`、`JSON.parse` 和动态 `String.fromCharCode / charCodeAt` 等缺少分享播放器实现的全局/方法。clamp 可写 `Math.min(hi, Math.max(lo, x))`。
- `async` 标记、`await` 表达式和 `for await...of`：没有实现 Promise / 微任务语义，因此在原始 AST 上、任何内联或降级之前报错，保留源文件及行列。普通函数、函数表达式、箭头函数、class 方法、事件/定时器/数组回调、嵌套和导入模块均受此限制；`--no-types`、npm 和浏览器前端也不会跳过此检查。迁移时，确实只需同步执行的代码可移除 `async` / `await` 并使用普通函数；协作式延时使用 `wait(seconds)`，异步顺序使用显式事件状态机。这些替代方案不提供 JS Promise / 微任务时序，不能无条件机械替换。

## 能编译，但和 JS 不完全一样

- K4 原生导出使用目标感知的普通 `for` 回退，不采用 KN 整数遍历优化；`nekoc check --target kitten4` 与导出策略一致。K4 尚无局部调用帧，重入事件中的普通 `for` 会明确报错；`forRange`、新自制积木等仍不支持。默认 KN 路径不变。目标 API、验证边界见 `docs/kitten4.md`。

- 读数组越界下标得到 `NaN`，不是 `undefined`（Kitten N 没有 undefined）。
- 报告器自制积木的递归深度上限是 200 层，更深的递归会报运行时错误。
- 事件回调的同一局部声明在多次并发调用之间仍共享存储；不同声明已唯一命名，普通函数局部变量按调用分帧。

逐条对照 Node 的语料结果见 `tests/ts-js-semantics/known-diff.md`。

## 写法建议

- 状态用 `setVar` / `getVar`，或者顶层 `let`；数据放进列表或数组变量。
- 递归函数写出返回类型。
- 字符串拼接时，让 `+` 的某一边能看出是字符串，或者直接用模板字符串、`String(x)`、`join()`。
