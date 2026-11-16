# Map 和 Set

`Map<K, V>` 的键、`Set<T>` 的元素支持 `string`、`number` 及其字面量联合类型，包括 `string | number`。字符串 `"1"` 与数字 `1` 是不同的键。数字按 SameValueZero 比较：NaN 与 NaN 相等，0 与 -0 相等。

```ts
const counts = new Map<string, number>();
for (const word of "cat dog cat".split(" ")) {
  counts.set(word, (counts.get(word) ?? 0) + 1);
}
for (const [word, count] of counts) console.log(word, count);
const unique = new Set([3, 1, 3]);
for (const value of unique) console.log(value); // 3, 1
```

支持的接口：

- `new Map()`、`new Map<K,V>()`、`new Map([[k,v], ...])`（初始化参数必须是二元组字面量组成的数组）。无类型参数、无上下文类型的空构造器，从该变量的直接 `set`/`add` 写入推断类型；复杂场景请显式标注类型。
- Map：`set`（返回原 map，可以链式调用）、`get`、`has`、`delete`（返回布尔）、`clear`、只读 `size`。
- Set：`new Set(数组)`、`add`（返回原 set）、`has`、`delete`、`clear`、只读 `size`。
- `for (const [k,v] of m)`、直接放在 for-of 中的 `keys()`、`values()`、`entries()`，以及 `for (const x of s)`。entries 迭代必须使用两个简单变量的解构。
- `m.forEach((v,k,map) => { ... })`，Set 的回调前两个参数都是元素本身。必须是独立语句、内联箭头回调；回调的 return 只结束该次回调。回调局部变量请用显式初始化的 `let/const`；回调函数作用域的 `var`（包括嵌套块中的声明）明确报错。

Map 的值支持数字、字符串、布尔、已初始化的数据对象、类实例和具体的 Map/Set 引用。集合本身通过对象堆句柄传递，别名、函数参数/返回值、对象字段和类字段保持相同身份。图的邻接表可以写成 `Map<string, Set<string>>` 或 `Map<string, Vertex>`。

`get` 的结果是 `V | undefined`。缺失结果使用现有 nullable 哨兵，支持 `??`、`=== undefined`、保存到变量后收窄。字符串空值和 `false`、0 都不会误判成缺失。支持紧邻的 `if (m.has(k)) { ... m.get(k)! ... }`：m 和 k 必须是简单变量或字面量、与 guard 一致，guard 到 get 之前不能有调用、写入或属性/下标读取（可能触发 getter）；复杂控制流请保存 get 的结果，再用 `!== undefined` 检查。未经证明的 `get(...)!` 报错。

可空集合的可选方法调用（如 `box.m?.get(key)`、`set?.has(value)`）暂不支持，会在调用处报错。先把 receiver 保存到局部变量，再用 `!== undefined` / `!== null` 判空后调用；把键和值的计算放在判空分支内，可保留短路求值。可选 `?.size` 继续支持。

迭代按插入顺序；更新已有键不改变顺序，删除再插入排到最后。迭代使用 live 链：未访问的删除项跳过，尚未访问的值更新可见，新增项会访问；clear 后新增的项仍会访问。循环中的 break/continue 和回调 return 保持语义。与 JS 一样，不断新增项可能导致循环不结束。

存储复用隐藏全局列表 `__nekocObjectHeap`：集合头记录 first、last、size；条目记录 key、value、next、live。条目删除后保留链节点以支持迭代期间修改。`size` 为 O(1)，查找/更新/删除为 O(H)，clear 和完整遍历为 O(H)，H 是该集合自创建以来插入过的新条目数（含删除后重插）；插入的查找也是 O(H)，分配/链接为 O(1)。堆单个对象的槽位数由整个程序属性集合决定。堆在作品重启时回收，没有逐对象 GC；适合数十到数百项的小集合，频繁删除重插的长期运行程序会累计内存和查找成本。

明确报错的边界：数组作为 Map 值、可空或混合域的 Map 值（请用对象字段包装）、对象/布尔/symbol 作键、WeakMap/WeakSet、逃逸迭代器/自定义迭代器、`Array.from(m.keys())`、`[...s]`、带标签的集合 for-of、方法值/动态下标访问、修改 size、擦除或伪造集合类型的断言。不支持跨文件推断未标注的集合；跨文件使用明确函数签名和调用方集合标注，支持参数、返回值和带集合字段的对象。入口使用相对或绝对路径均可。

所有生成路径只使用分享播放器已登记的列表、变量、逻辑、控制流和自制积木，不使用 `_object_*`、`logic_ternary` 或 `math_trig_rad`。回归见 `tests/tsmap.test.mjs`、`tests/tsmap_runtime.rs`、`tests/fixtures/tsmap.ts`。
