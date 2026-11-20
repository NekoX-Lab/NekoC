# NekoC API Reference

Complete reference for all functions and APIs available in NekoC TypeScript projects.

## TypeScript vector length

`Math.hypot(...components)` supports any fixed number of finite numeric arguments,
including variables, function results and loop values. It saves each argument
once, left to right, in invocation-local procedure parameters. It finds the
maximum absolute component, sums squares of normalized components, then rescales
the square root. Empty and all-zero vectors return 0 without division by zero.
This avoids premature overflow/underflow for large/small finite components and
works with nested and recursive calls using share-player-supported blocks.
Actual result overflow can still produce Infinity. Infinity/NaN input combinations
and bit-identical V8 compensated summation remain outside the documented guarantee.

## Numeric helpers

For the Kitten N target, statically numeric `==`, `===`, `!=` and `!==` preserve JavaScript NaN
semantics, unlike the underlying KN equality block (which considers NaN equal
to NaN). The compiler saves both operands once, left to right, in invocation-local
parameters and combines ordered comparisons. Infinities and signed zeros retain
their numeric equality semantics. Strict equality with statically uncertain
operands (including generic, union and `any` primitive values), and `switch` case
selection, instead combine type-sensitive KN equality with a numeric NaN
exclusion. Text `"NaN"` remains ordinary text; arbitrary values are not sent
through numeric ordered comparisons. Nullable numeric `==`/`!=` use the same
exclusion while preserving `null == undefined`. All operands are saved once,
left to right, and matched switch cases do not evaluate later case expressions.
Existing object/container support and diagnostics are unchanged; object identity
requires supported explicit object types, not generic/`any` shape erasure. K4
lowering and native DSL `eq`/`neq` retain their existing semantics.

`Math.max` / `Math.min` accept one or more numeric arguments, save each once in
left-to-right order, and propagate numeric NaN in any position. Arguments after
NaN still run, including side effects. Single arguments, ±Infinity, numeric
function parameters/results and nested/recursive calls are supported.
`Math.trunc` preserves NaN and ±Infinity and truncates finite fractions toward zero.
`Number.isInteger` additionally guarantees false for numeric NaN and ±Infinity;
finite integers return true and fractions return false. Statically string/boolean
arguments return false while preserving their evaluation. Dynamic mixed types,
arbitrary any/text coercion, and signed-zero behavior are outside these guarantees.

Math helper NaN detection uses the saved numeric value's verified `String(number)` spelling
([official conversion evidence](kn-conversion-evidence.json)), then returns that
original number. It does not rely on Kitten N NaN equality or produce text `"NaN"`.

## TypeScript classes

Class declarations, fields, constructors (including parameter properties), `new`,
instance methods and `this` use the existing share-object heap and custom
procedures. Single inheritance, super, abstract members, instanceof, virtual
method/accessor dispatch and explicit-class static fields/methods are supported.
Receivers require a statically known class or base type. Static this/inheritance/
blocks, method values and runtime field additions are rejected. See
[TypeScript classes](ts-classes.md) for class-id intervals, construction order,
initialization safety, per-call frames and the complete supported subset.

## null, undefined and optional chaining

Types that spell out `null` or `undefined` (`T | null`, `T | undefined`, optional
properties `x?: T` and optional or nullable class fields) store runtime sentinels:
the texts `"null"` / `"undefined"` for numbers, booleans, arrays and object/class
references, and the numbers `-1` / `-2` for strings. Kitten N equality never
coerces between text and numbers, so a sentinel never equals a legal value.
Object literals may omit optional properties, which read as `undefined`.
Supported: `a?.b`, `a?.b.c`, `a?.[i]`, `a?.m()` (receiver evaluated once,
arguments skipped on short-circuit), `a ?? b` (fallback evaluated lazily),
standalone `a ??= b`, `=== null`, `!== undefined`, `== null`, truthiness tests and
checker narrowing. `console.log`, string concatenation, templates and `String()`
print `null` / `undefined` as JavaScript does. Rejected with a source location:
null/undefined arithmetic or relational comparisons, reading a maybe-null value
without narrowing, `x!` on a maybe-null value, `?.` on call results, `f?.()`,
`??=` as an expression, mixed unions such as `string | number | null`, nulls in
`any`/`unknown`, `pop`/`shift`/`find` results used as undefined, `delete` and
`Map`. Programs without null/undefined compile exactly as before. See
[null / undefined](ts-nullable.md).

## TypeScript string replacement

`s.replace(search, replacement)` and `s.replaceAll(search, replacement)` accept
exactly two string arguments. The receiver, search and replacement evaluate once,
left to right. `replace` changes the first match; `replaceAll` scans the original
input for nonoverlapping matches and never searches text inserted by replacement.
Empty prefixes/suffixes and empty replacements are supported; a missing match
returns the original string. Matching is case-sensitive and preserves numeric
text such as `007`, combining sequences and complete astral characters.

Replacement strings follow JavaScript: `$$` inserts `$`, `$&` the matched text,
`` $` `` the original input prefix, and `$'` the original input suffix. Substituted
text is not expanded again. Without regex captures, `$1`, `$01` and `$<name>` stay
literal, as do unrecognized dollar tokens and a trailing `$`. Dynamic replacement
strings support the same rules.

`replace("", replacement)` inserts once at the beginning, including empty input.
`replaceAll("", replacement)` inserts at every UTF-16 boundary, including both
ends. Since the VM cannot preserve isolated UTF-16 surrogate units, `replaceAll`
requires either a provably nonempty constant search (a literal or immutable const
alias), or a constant BMP-only receiver. A possibly empty search on a dynamic or
astral receiver produces a located compile error: use a nonempty constant search,
or a constant BMP-only receiver. This conservative rule also applies when the
replacement is empty. RegExp searches, callback replacers, coercion, spread,
missing arguments and extra arguments produce located diagnostics; use the two
string arguments instead. Nullable search/replacement arguments must be strings
at the call site: narrow them first (for example `if (a !== null)`), use `a ?? ""`,
or explicitly convert with `String(a)`. The compiler does not implicitly convert
null/undefined arguments; optional receiver short-circuiting remains supported.
Calls or writes between narrowing and a nullable argument read are conservatively
rejected, including earlier receiver/search evaluation and writes through aliases.
Capture a string in a local before those effects, or coalesce/convert the value
at its argument evaluation point. This check does not infer that a call is pure.
Explicit `String(condition ? value : fallback)` converts only the selected value,
including declared nullable values whose TS narrowing became stale. It preserves
branch short-circuiting and single evaluation. Nullable conditions, arithmetic
wrappers and logical selections inside `String` that cannot preserve the raw value domain are rejected with an if/else
or `??` alternative; ordinary numeric/string `-1` and `-2` retain their values.
If a local captures a nullable read after an intervening effect, its inferred
`string` type does not prove that it contains text. A later `String(captured)`
(including conditional wrappers and multiple capture layers) is rejected at the
original conversion. Convert or coalesce when capturing instead:
`const captured = String(value)` or `const captured = value ?? "fallback"`.
The check follows initializers and possible assignments conservatively; a stable
string captured before the effects remains supported.
For scalar bindings, calls only invalidate this proof when the source file has
an assignment that could write null/undefined to that binding (including writes
inside nested functions). Calls alone do not invalidate an unchanged binding,
and assignments of nonnullable values do not count as nullish writes. Property
and array reads retain conservative alias handling.
Isolated surrogate literals anywhere in source (also
in `let` initializers, templates and imported modules) are rejected before
lowering/JSON serialization with their original coordinates and a hint to use
complete Unicode characters. Replacement diagnostics also retain the original
call coordinates inside class methods and nullable optional calls.
The ES2020 declarations include the implemented
`replaceAll` overload for CLI, npm and browser checking.

## TypeScript strings

- `charAt(index = 0)` truncates numeric indices toward zero and returns `""`
  outside the string. `substring(start = 0, end = length)` clamps both indices,
  swaps reversed bounds and returns `""` for equal bounds. Receivers and arguments
  are evaluated once, left to right; helper state is invocation-local, including
  nested/recursive calls. NaN means zero; infinities clamp (or are out of range
  for `charAt`). Native `selectText` retains its 1-based inclusive/reversing rules.
- `startsWith(search, position = 0)`, `includes(search, position = 0)` and
  `indexOf(search, position = 0)` clamp/truncate numeric positions.
  `endsWith(search, endPosition = length)` and
  `lastIndexOf(search, position = length)` use their different JavaScript defaults;
  NaN means the end for `lastIndexOf`, zero for the other methods. Empty searches
  respect these normalized boundaries. Search arguments must be strings; regex
  and coercing overloads are not supported. Existing KN text-comparison rules
  (notably numeric-looking strings) are unchanged.
- `split(separator?, limit?)` returns a fresh array without changing its receiver.
  An omitted separator returns `[text]`; `""` splits code units. Numeric `limit`
  uses JavaScript uint32 conversion (truncate, modulo 2^32; NaN/infinities become
  zero), defaults to 2^32−1, and stops output at that many items. Regex separators
  are not supported. Omit optional arguments rather than passing `undefined`.
- `padStart`/`padEnd` truncate target length, never truncate the source, and take
  exactly the required prefix of repeated fill (default `" "`, empty fill is a
  no-op). `repeat` truncates its count toward zero. Counts, target lengths,
  receivers and fill strings can be variables, parameters, expressions or calls.
  NaN means zero. Helpers save every argument once, in order, before normalization.
- Known differences for bounded runtime growth: dynamic negative repeat counts
  (after truncation) and either infinity return `""` instead of throwing RangeError;
  invalid literal counts are compile errors. Repeat reduces its count to fit at
  most 65536 UTF-16 units, retaining whole copies. Padding clamps its target to
  `[0,65536]` (positive infinity becomes 65536), never truncates the receiver,
  and returns the receiver for empty fill. These limits apply at runtime, not as
  a requirement to prove bounds at compile time. Helpers grow by doubling.
- Lengths/indices count UTF-16 code units. Constant results containing isolated
  surrogates are rejected. Dynamic padding with a non-BMP fill returns the receiver
  if padding would require a partial fill copy; complete copies remain supported.
  This conservative runtime fallback avoids splitting a surrogate pair. Complete Chinese/emoji
  strings and whole-character padding/repeat are supported; arbitrary isolated
  UTF-16 surrogates and `s[i]` returning `undefined` are not represented.
- Runtime `charAt`/`substring`, `indexOf`/`lastIndexOf`/`endsWith`, and
  `includes`/`startsWith` with an explicit position require a provably BMP-only
  receiver for an unguarded fast path. The proof follows lexical initializers, all assignments, visible
  function returns and direct call arguments, not just a `string` annotation.
  A shared symbol-based write analysis includes wrapped/destructured targets,
  compound assignments, updates, and nondeclaration `for-of`/`for-in` targets.
  Loop, destructuring and update writes conservatively invalidate the proof for
  variables and parameters, even for BMP-looking loop sources; simple `=`/`+=`
  writes can preserve a variable's proof when their values are provably BMP.
  Declaration writes are included: merged/repeated `var` declarations (including
  C-style `for` initializers and parameter/`var` merges), destructuring declarations,
  and declaration-style `for-of`/`for-in` targets invalidate these safety proofs.
  A fresh simple declaration keeps its first initializer as its producer; a
  same-spelled binding in another lexical scope does not invalidate it.
  Unknown parameters, array elements, class fields and rewritten bindings now
  compile through a runtime guard: ASCII/Chinese/BMP text uses the normal helper.
  A non-BMP receiver is replaced with `""` before code-unit selection/search;
  that method then has the empty receiver's result (e.g. charAt/substring `""`,
  indexOf `-1` for a nonempty needle). This documented difference prevents a VM
  isolated-surrogate failure without rejecting common dynamic BMP programs.
  Arguments still evaluate once in source order. Constants fold with exact JS semantics.
- `includes(search)` without position and `startsWith(search)` without position
  use native containment/splitting rather than code-unit scanning, so full emoji
  receivers (including variables and parameters) are safe. `split` uses native
  splitting followed by a fresh limited copy; a provably nonempty separator is
  safe with full emoji and with a limit. Empty/unknown separators use the same
  runtime BMP guard when safety is unknown. Prefer a nonempty literal separator
  when preserving a full emoji receiver is required.
- Only the actual symbol bound by a `sprite` callback is a DSL receiver; naming
  an ordinary variable/parameter `self`, or asserting `any`, does not exempt it
  from growth validation. Any write (including loops/destructuring/updates) also
  invalidates a DSL receiver exemption or a static producer proof.
  Dynamic growth is lowered immediately into a runtime-bounded helper;
  any remaining string repeat/padding at final lowering fails
  closed instead of generating an unchecked loop.
- String methods reject extra/spread arguments instead of silently discarding
  them. Existing string `slice` keeps its constant-index subset, negative-index
  normalization and half-open empty ranges; it does not swap bounds.

## TypeScript arrays

- `a[i]` reads the zero-based element with the share-player `list_item` block.
  Statically invalid numeric indices and out-of-range reads on stable dense
  literal arrays are compile errors (core-162). Dynamic missing entries and
  `at()` still yield Kitten N's empty value (`NaN`), not JavaScript `undefined`.
- `a[i] = value`, `+=`, `-=`, `*=`, `/=`, `%=`, `**=` are supported for existing
  elements. Compound assignments evaluate the target, index and old value once.
  User writes require a dense literal initializer (including direct aliases) and
  a provably in-range nonnegative integer index: constants, stable numeric locals,
  or bounded increasing `for` indices and their `+`/`-` expressions. Unknown,
  negative, fractional and sparse writes produce a located compile error.
  `+=` preserves statically known string elements or string right operands;
  unknown/mixed element types without a string right operand are rejected.
  Element `++`/`--` requires known numeric elements. Length-changing calls,
  escapes and element-type-changing mutations can invalidate these proofs;
  these checks are conservative, not a general TypeScript flow analysis.
  Deferred function bodies can invalidate the proof regardless of declaration
  order. Parentheses, `as`, `!` and `satisfies` do not hide mutation or escape.
- `a.length = 0` clears the same list, including aliases. Other length/property
  assignments are rejected; sparse array writes are not supported.
- `reverse()` mutates and returns the same array. Default `sort()` is stable,
  in-place and compares string representations lexicographically; custom inline
  comparators remain supported. Sparse arrays and undefined sort keys have not
  been verified.
- `const [head, ...tail] = value` evaluates `value` once and copies the remaining
  elements into a new list (shallow: array/object/instance elements keep their
  reference identity). Top-level array bindings are registered globally, then
  initialized at their source position in the implicit startup script, before
  explicit root `onStart` handlers. Omitted bindings (`[head, , third]`) and other
  declarations in the same statement are supported. Nested/default patterns
  remain rejected. Shallow object variable bindings and standalone array-literal
  destructuring assignments are also supported; see [destructuring boundaries](ts-r2-destructuring.md).
  Sparse/missing elements do not gain JavaScript `undefined` semantics.
- `a.at(index)` supports negative indices and truncates fractional indices.
  The ES2020 declaration set includes this frontend-supported method.
- Array `slice(start?, end?)` evaluates its receiver once, then each explicit
  numeric boundary once from left to right, before reading the saved receiver's
  length. Fractions truncate toward zero, NaN becomes zero, negative bounds
  count from the end, and both bounds clamp to `[0, length]` (including
  infinities). Omitted start/end mean zero/length, even when a module shadows
  the global `Infinity` binding; reversed or empty ranges
  produce an empty list. The new dense list is a shallow copy: source structure
  is unchanged, object/instance/nested-list elements retain reference identity.
  Non-numeric or explicit null/undefined bounds are rejected with a location
  and a conversion/omission hint. This does not add sparse arrays or change
  ordinary out-of-bounds element reads or native list indexing.
- Statement calls to `push`, `unshift` and `splice` evaluate the receiver once,
  then every argument once from left to right, before changing the list. Saved
  references and values are invocation-local, including recursive argument calls.
  Statement `splice` reads length after all arguments and fixes the insertion
  position before mutation. Numeric start/deleteCount truncate toward zero and
  clamp to the original remaining range; negative starts count from the end,
  NaN means zero, infinities use the respective boundary, and negative deleteCount
  means zero. Omitted deleteCount deletes to the end; no arguments is a no-op.
  Multiple inserted references retain their order and identity. Non-numeric or
  explicit undefined bounds are diagnosed with conversion/omission hints.
  Numeric type parameter constraints (including constraint chains such as
  `T extends number, U extends T`) and numeric intersections such as
  `number & { readonly brand?: "index" }` are accepted for start and deleteCount,
  both directly and through generic constraints;
  unconstrained or mixed number/string parameters still require narrowing.
  This does not add the deleted-items return value, sparse arrays or coercion.
- Array `includes`, `indexOf` and `lastIndexOf` accept a numeric `fromIndex`.
  Fractions truncate toward zero, negatives count from the end, NaN starts at
  zero, and out-of-range starts follow each method's direction. Omitted
  `lastIndexOf` starts at the last item. Explicit `undefined` is rejected with a
  source location and a suggestion to omit the optional argument. Numeric NaN
  matches in `includes`, but never in `indexOf`/`lastIndexOf`. Existing Kitten N
  equality limitations for mixed types remain.
- Array `concat()` accepts zero or more statically known arrays or scalar values.
  All arguments evaluate before copying; arrays flatten one level, scalar values
  append once, and object/list references keep their identity. Array/scalar
  unions and unknown arguments require narrowing first. Spread and unsupported
  array-method overloads (including callback `thisArg`) produce diagnostics;
  extra arguments are never silently discarded.
- These argument/type rules also apply inside relative imported modules,
  including annotated array parameters and functions returning arrays. All
  modules are loaded before helper synthesis and type validation.
- `map`, `filter`, `forEach`, `reduce`, `some`, `every`, `find` and `findIndex`
  snapshot their initial length, then fetch each current value. Appending does
  not extend traversal; changing an unvisited element is visible. `filter`,
  `forEach`, `reduce`, `some` and `every` skip positions removed by shrinking.
  Since sparse map results and missing-item `undefined` reads are unavailable,
  `map`/`find`/`findIndex` conservatively reject callbacks that shrink arrays,
  including through aliases or called functions, or yield/dispatch events.
  This includes named-list `deleteListItem` / `self.deleteListItem`,
  `self.list(...).delete/remove`, and replacement via `copyList` /
  `self.list(...).copyTo`: `getList` shares the named list's identity. The
  check conservatively rejects these operations even on unrelated lists.
  Effects propagate through literal-target `callProc` / `callReporter` (also
  with a `self` prefix), nested DSL procedures/reporters and ordinary function
  wrappers. Recursive calls are checked without repeatedly visiting the same
  body. If the target or body cannot be resolved statically, these three array
  methods reject the call: use a literal target with a visible definition,
  move it after traversal, or use an explicit loop. Known nonshrinking,
  nonyielding DSL procedures remain supported.
  Move removals after traversal or use an explicit loop. Ordinary `for...of`
  continues to observe the live length and can visit appended items.
- `Array.isArray(value)` folds statically known arrays and primitive literals;
  unknown types and arguments whose evaluation would have side effects are
  rejected (store the result in a variable first).
- Inline array callbacks can read and update enclosing event/timer-local variables through
  the current invocation frame, including nested synchronous callbacks. Locals
  survive cooperative waits in overlapping event invocations. Array/object
  bindings are isolated without copying their referenced contents. Capturing
  enclosing inline-function parameters or locals is rejected; use an event-local
  or top-level variable instead.
  Captured string declarations and aliases retain their type before helper
  compilation. Property names and callback-local bindings are not captures.
  Callback parameters and locals shadow outer string type information.
  Captured string declarations may be reassigned with provably string-valued
  `=` / `+=` operands; unknown or type-changing updates are rejected.
  Inline explicit arguments retain their caller's type context even when a
  callee parameter or local has the same name. Named function-expression
  callbacks bind their own name, not a same-named enclosing variable.
- `reduce(callback)` uses the first item as its initial accumulator and starts
  callback indices at 1. A nonempty literal initializer must be provable and
  must not escape through aliases or mutating calls; otherwise supply an initial
  value. This prevents empty-input TypeErrors from becoming silent wrong values.
- `flat()` / `flat(1)` supports an array literal (or a variable initialized with
  one) containing only arrays, preserving one level of elements. Other input
  shapes/depths produce a compile error instead of a wrong result.
  Parentheses and array type assertions do not change these shape checks.

For standard JavaScript expression/method support (including static formatting,
UTF-16 constants and constant-folded `JSON.stringify(value)`), see
[Additional expressions and methods](syntax.md#additional-expressions-and-methods).
These use the standard TypeScript library signatures, not additional NekoC globals.
Dynamic `JSON.stringify` is a compile error because the share player has no
corresponding block. Local bindings and parameters receive unique names, so
caller/callee shadowing preserves lexical identity, including caller-safe
defaults. Recursive scalar locals use per-call frames; recursive captures and
function-argument specialization remain compile errors.

## Global Events

Kitten N callbacks with local state run in suspendable statement procedures.
Every invocation gets a fresh list frame, so broadcasts, timers and overlapping
sprite/clone callbacks keep their own locals across `wait`. Synchronous nested
callbacks share that invocation's captured frame. Top-level variables and
`setVar`/`changeVar` remain shared; array/object bindings keep reference identity
without deep copies. Restart cancels old tasks and starts with new frames.
An early `return` exits only that callback; a returned expression is evaluated
for its side effects and its result is ignored.
Timer callbacks cannot capture outer invocation locals across scheduling; move
that state to a top-level binding or use explicit event state instead.

### TypeScript timers and asynchronous boundaries

`setTimeout(callback, ms?)` and `setInterval(callback, ms?)` accept ordinary
inline callbacks without parameters in the root workspace. Numeric milliseconds
are normalized before conversion to seconds: omitted delays, values below 1,
above 2147483647 and NaN become 1; other fractional values truncate toward zero.
The delay expression evaluates once, when scheduling. Non-numeric/unknown delays
are compile errors even without type checking; omit explicit `undefined` or use
`Number(value)`. `clearTimeout(handle)` and `clearInterval(handle)` cancel either
kind of NekoTimer. Handles are opaque references; their readonly `delay` is in
seconds and `active` records whether another callback may start.
The numeric bounds/truncation follow the [Node timer API](https://nodejs.org/api/timers.html#scheduling-timers),
not the browser timer overflow conversion algorithm.

Timers lower to broadcast/receive, wait, list-backed state and custom procedures,
not native JS timer blocks. Scheduling is frame-quantized; an interval waits
again after its callback finishes, including cooperative waits. This does not
promise Node event-loop timing or microtask ordering. Event registration is a
compile-time declaration, not a general runtime event-listener API.
Native TypeScript `for`, `for...of`, `for...in`, `while` and `do...while` loops
cannot coexist with timers anywhere in the same import graph, including unused
functions and loops before scheduling. Kitten loops implicitly yield, allowing
a timer to observe intermediate state or fire before synchronous cancellation.
Until run-to-return scheduling is implemented, this conservative combination is
a compile error with the original loop location; use an explicit cooperative
event state machine instead. No automatic atomic wrapper is added around waits.

`async`/`await`, generators (including callbacks), global runtime `Promise` and
`queueMicrotask` references are rejected before lowering, including unused code
and imported modules. Type-only Promise annotations and locally shadowed names
do not by themselves invoke Promise scheduling. Use ordinary synchronous
functions or explicit event state machines; `wait(seconds)` cooperatively pauses
the current block task and is not a Promise. See `tests/ts-r3-async.test.mjs` for
Node-backed regression cases and the boundaries of the scheduling oracle.
Official native timer evidence is recorded separately in
[KN async services](kn-async-services.md#timer块转换运行时不是同一件事): native
callback statement execution is not established by the mere presence of sockets.
Editor import checks for generated works do not prove general scheduler equivalence.

### `onStart(body)`

Runs when the project starts.

```ts
onStart(() => {
  console.log("Project started");
});
```

### `onClick(body)`

Runs when the stage is clicked.

```ts
onClick(() => {
  console.log("Clicked!");
});
```

### `onKey(key, state?, body?)`

Runs when a key is pressed or released. State defaults to `"down"`.

```ts
onKey("space", () => {
  console.log("Space pressed");
});

onKey("up", "down", () => {
  console.log("Up arrow pressed");
});

onKey("a", "up", () => {
  console.log("A released");
});
```

### `onMessage(message, body)`

Runs when a broadcast message is received.

```ts
onMessage("game-over", () => {
  console.log("Game over!");
});
```

### `when(condition, body)`

Runs repeatedly while condition is true.

```ts
when(() => getVar("score") > 100, () => {
  console.log("High score!");
});
```

### `onBumpActor(phase, target, actor, body)`

Runs when the script's actor bumps into `target`; `phase` is `"start"`,
`"move"` or `"end"`. `actor` names the contact reporter used by
`bumpActorValue(actor, attribute)`.

```ts
onBumpActor("start", "enemy", "contact", () => {
  console.log("Hit enemy!");
});
```

For Kitten N, this target menu accepts only actors in the owner's scene:
use a unique actor name or an actual actor ID. Names are resolved after final
resource allocation; existing IDs take precedence. `"--self"` is a compiler
alias for a definite actor owner/caller's ID, not a persisted menu option.
Scene-owned scripts and unused procedures cannot infer `self`. Shared procedures
must resolve to the same ID in every caller's scene, and global procedure
dropdowns must remain selectable in every editor scene. Otherwise move the
action to its owning sprite event or an inline function. Unknown/ambiguous names,
cross-scene IDs, mouse/random/edge and scene targets produce source diagnostics.
Imported `.bcmkn` files must already contain selectable IDs (`nekoc check`
checks this). These rules do **not** describe the other sensing or tell menus.
See [the target resolution evidence](kn-actor-targets.md) for official fixtures
and the known Engine orbit-angle direction difference.

## Control Flow

### `wait(seconds)`

Pauses execution for the specified number of seconds.

```ts
wait(1.5);
```

### `waitUntil(condition)`

Pauses until condition becomes true.

```ts
waitUntil(() => getVar("ready") === true);
```

### `forever(body)`

Loops forever.

```ts
forever(() => {
  changeVar("tick", 1);
});
```

### `repeatTimes(times, body)`

Repeats a fixed number of times.

```ts
repeatTimes(10, () => {
  moveSteps(10);
  turn(36);
});
```

### `repeatUntil(condition, body)`

Repeats until condition is true.

```ts
repeatUntil(() => getVar("done"), () => {
  changeVar("x", 1);
});
```

### `forRange(variable, from, to, by, body)`

Iterates over a numeric range.

```ts
forRange("i", 1, 10, 1, () => {
  console.log(rangeValue("i"));
});
```

### `breakLoop()`

Exits the innermost loop.

```ts
forever(() => {
  if (getVar("x") > 100) {
    breakLoop();
  }
  changeVar("x", 1);
});
```

### `stop()`

Stops the current script.

`stop` has a next socket in Kitten N; its dynamic scope behavior is unchanged.

### `restart()`

Restarts the work and starts its startup scripts again. The official Kitten N
`restart` block has no next socket. It must end its block stack; a direct
following statement (including after an inline helper that ends in `restart`)
is a `NEKOC_TERMINAL_NEXT` compile error with a source location. Place it last
in an explicit branch/loop/procedure body when that structure is intended.
The enclosing container may still have a legal next connection.

### `warp(body)`

Runs body without screen refresh (instant mode).

```ts
warp(() => {
  setVar("x", 0);
  setVar("y", 0);
});
```

### `tell(target, body)`

Runs body as if called by another actor.

### `tellAndWait(target, body)`

Runs body as another actor and waits for completion.

## Broadcasting

### `broadcast(message, value?)`

Sends a broadcast message.

```ts
broadcast("reset");
broadcast("score-change", 100);
```

### `broadcastAndWait(message)`

Sends a broadcast and waits for all listeners to finish.

```ts
await broadcastAndWait("save");
```

## Variables

### `setVar(name, value)`

Sets a variable.

```ts
setVar("score", 0);
setVar("name", "player1");
```

### `changeVar(name, delta)`

Changes a variable by a numeric delta.

```ts
changeVar("score", 10);
changeVar("lives", -1);
```

### `getVar<T>(name)`

The default value type is `any`. For `+` / `+=`, supply a known primitive type
(`getVar<number>("score")` or `getVar("score") as number`) or use explicit
`String(...)` concatenation; ambiguous dynamic addition is a compile error.

Gets a variable value.

```ts
const score = getVar("score");
if (getVar("lives") <= 0) { ... }
```

### `showVariable(name)` / `hideVariable(name)`

Shows or hides a variable in the editor.

## Lists

### `appendList(name, value)`

Adds an item to the end of a list.

```ts
appendList("items", "hello");
```

### `insertList(name, index, value)`

Inserts an item at the specified index.

```ts
insertList("items", 1, "first");
```

### `replaceListItem(name, mode, index, value)`

Replaces an item. Mode: `"any"`, `"last"`, or `"first"`.

```ts
replaceListItem("items", "any", 1, "updated");
```

### `deleteListItem(name, mode, index)`

Deletes an item.

```ts
deleteListItem("items", "any", 1);
deleteListItem("items", "all"); // Clear all
```

### `copyList(name, targetName)`

Copies a list to another list.

```ts
copyList("source", "backup");
```

### `showList(name)` / `hideList(name)`

Shows or hides a list in the editor.

### `getList<T>(name)`

Gets the entire list as an array expression.

### `listItem<T>(name, mode, index)`

Gets a specific item from the list.

### `listLength(name)`

Gets the length of a list.

### `listIndexOf(name, value)`

Gets the index of a value in the list (1-based).

### `listContains(name, value)`

Checks if the list contains a value.

## Motion

### `moveSteps(steps)`

Moves forward by the specified number of steps.

```ts
moveSteps(10);
```

### `moveTo(x, y)` / `glideTo(x, y)`

Moves or glides to the specified position.

```ts
moveTo(100, 200);
glideTo(0, 0);
```

### `setX(value)` / `setY(value)`

Sets the X or Y coordinate.

### `changeX(delta)` / `changeY(delta)`

Changes the X or Y coordinate by delta.

### `glideChangeX(delta)` / `glideChangeY(delta)`

Glides by changing X or Y coordinate.

### `turn(degrees)`

Turns right by the specified degrees.

```ts
turn(90);
```

### `pointTowards(degrees)`

Points towards the specified angle.

```ts
pointTowards(0); // Face right
```

### `rotateAround(target, degrees)`

Rotates around a current-scene actor. The global and `self.rotateAround` APIs
use the same name/ID/`"--self"` resolution rules as `onBumpActor` above.
For `rotateAround` specifically, `"--self"` lowers to a turn of the current
executing instance: position stays fixed and direction increases by `degrees`,
evaluated once. This preserves clone identity and supports shared procedures
without a static actor dropdown.

### `faceTo(target)` / `setFaceTo(target)`

Faces towards another actor.

### `moveToTarget(target)` / `moveToTargetSprite(target)`

Moves towards another actor.

### `bounceOffEdge()`

Bounces off the stage edge.

### `setRotationType(type)`

Sets rotation style (`"all around"`, `"left-right"`, `"don't rotate"`).

## Appearance

### `show()` / `hide()`

Shows or hides the actor.

```ts
show();
hide();
```

### `setScale(value)`

Sets the actor's scale.

```ts
setScale(150);
```

### `changeScale(delta)`

Changes the scale by delta.

### `setSize(type, value)`

Sets width or height.

### `changeSize(type, delta)`

Changes width or height.

### `say(text, seconds?)` / `think(text, seconds?)`

Shows a speech or thought bubble. Seconds defaults to 2.

```ts
say("Hello!");
think("Hmm...", 3);
```

### `ask(text)`

Asks a question.

```ts
ask("What is your name?");
```

### `closeDialog()`

Closes the current dialog.

### `stageDialog(sprite, text)`

Shows a dialog on another sprite.

## Style

### `nextStyle()` / `prevStyle()`

Switches to the next or previous style.

```ts
nextStyle();
prevStyle();
```

### `setStyle(name)`

Sets the current style by name.

```ts
setStyle("costume2");
```

## Effects

### `setEffect(scope, value)`

Sets a visual effect.

```ts
setEffect("color", 50);
setEffect("ghost", 100);
```

### `changeEffect(scope, delta)`

Changes a visual effect.

### `clearEffects()`

Resets all visual effects.

## Pen

### `penDown()` / `penUp()`

Starts or stops drawing.

```ts
penDown();
moveSteps(100);
penUp();
```

### `setPenColor(color)`

Sets the pen color.

```ts
setPenColor("#ff0000");
```

### `setPenSize(size)` / `changePenSize(delta)`

Sets or changes the pen size.

### `setPenEffect(scope, value)` / `changePenEffect(scope, delta)`

Sets or changes pen color properties.

### `clearDrawing()`

Clears all pen strokes and stamps.

### `stampText(text)` / `imageStamp()`

Stamps text or the current costume.

### `setPenLayer(layer, target)`

Sets pen layer.

## Drag

### `setDraggable(value)`

Makes the actor draggable.

```ts
setDraggable("true");
```

## Clones

### `createClone(sprite?)`

Creates a clone of the specified sprite (or self).

```ts
createClone();
createClone("enemy");
```

### `deleteClone()`

Deletes the current clone.

The official Kitten N `dispose_clone` block has no next socket. Like `restart`,
`deleteClone()` (also `self.deleteClone()`) must end its block stack; direct
following code is rejected with `NEKOC_TERMINAL_NEXT`, never silently dropped.
An explicit `if`/loop/procedure body may end with it while the enclosing
container/call still connects to later code. On the original actor deletion
does nothing and that enclosing continuation still runs; on a clone deletion
cancels that clone's tasks. This physical socket rule does not make deletion
equivalent to a function return. `nekoc check` reports
`terminal_block_has_next` for existing works with either known illegal edge.
The `NORMAL` form of `procedures_2_return_value` also has no next socket;
event returns end the current path before loop increment/condition handling.

### `cloneCount(sprite)`

Gets the number of clones.

### `currentCloneIndex()`

Gets the current clone's index.

### `cloneProperty(sprite, index, attribute)`

Gets a property (`"x"`, `"y"`, …) of the clone at `index`.

## Screen

### `switchScreen(name)`

Switches to another screen.

```ts
switchScreen("game");
```

### `setScreenTransition(direction, type)`

Sets screen transition effect.

## Timer

### `timerStart()` / `timerStop()` / `timerReset()`

Controls the timer.

### `showTimer()` / `hideTimer()`

Shows or hides the timer display.

## Sensing

### `keyPressed(key, state?)`

Checks if a key is pressed.

```ts
if (keyPressed("space", "down")) { ... }
```

### `mouseX()` / `mouseY()`

Gets mouse position.

### `answer()`

Gets the answer to an ask block.

### `choiceValue(type)`

Gets the choice value or index from askChoice.

### `timerValue()`

Gets the timer value.

### `timeNow(unit)`

Gets the current time.

```ts
timeNow("hour");
timeNow("minute");
```

### `stageInfo(type)`

Gets stage width or height.

```ts
stageInfo("width"); // 562
stageInfo("height"); // 900
```

### `touching(sprite, target)`

Checks if an actor is touching another.

```ts
if (touching("--self", "enemy")) { ... }
```

### `touchingColor(sprite, color)`

Checks if an actor is touching a color.

### `outOfBoundary(boundary)`

Checks if an actor is out of bounds.

### `distanceTo(target)`

Gets distance to another actor.

### `xOf(sprite)` / `yOf(sprite)`

Gets the position of another actor.

### `orientation(target)`

Gets the orientation of another actor.

### `styleOf(sprite)`

Gets the current style of another actor.

### `appearanceOf(sprite, appearance)`

Gets appearance property of another actor.

### `effectOf(sprite, effect)`

Gets effect value of another actor.

### `bumpActorValue(sprite, attribute)`

Gets attribute of bumped actor.

## Data Expressions

### `scriptVar<T>(name)`

Gets a script-local variable.

### `messageValue<T>(name)`

Gets the value passed with a broadcast message.

### `param<T>(name)`

Gets a procedure parameter.

### `actorParam<T>(name, attribute)`

Gets an actor parameter.

### `callReporter<T>(name, ...args)`

Calls a reporter procedure.

### `receivedBroadcast(message)`

Checks if a broadcast was received.

## Procedures

### `defineProc(name, params, body)`

Defines a statement procedure.

```ts
defineProc("moveAndSay", ["steps", "msg"], (steps, msg) => {
  moveSteps(steps);
  say(msg);
});
```

### `defineReporter(name, params, body)`

Defines a reporter procedure.

```ts
defineReporter("double", ["n"], (n) => {
  return n * 2;
});
```

## Resources

### `stage(options)`

Declares stage settings.

```ts
stage({
  name: "main",
  backdrop: "https://example.com/bg.png",
});
```

### `sprite(name, options, body?)`

Declares a sprite. `nekoc build` turns each declaration into an actor with
its costumes, position, scale and rotation, so no template work is needed.

```ts
const IDLE = "https://example.com/idle.png";

sprite("player", {
  costumes: [
    { name: "idle", url: IDLE, centerX: 64, centerY: 64 },
    "https://example.com/walk.png", // named player2
  ],
  x: 0,
  y: 0,
  scale: 100,
  rotation: 90,
  visible: true,
}, (self) => {
  self.onStart(() => { self.nextStyle(); });
});
```

| Option | Meaning |
|--------|---------|
| `costume` | One costume URL (named after the sprite). |
| `costumes` | Costume list: URL strings or `{ name?, url, centerX?, centerY? }`. Unnamed entries get the sprite name, then `name2`, `name3`… Names must be unique. The first costume is the starting one. |
| `centerX`, `centerY` | Default rotation center for costumes that do not set their own. |
| `x`, `y`, `scale`, `rotation`, `visible` | Initial state. `rotation` is the starting direction in degrees (radians in the saved work). |

Resource strings must be literals or top-level `const` string literals.

Inside the body, `self.<api>(...)` calls the same API as the global name, for
example `self.nextStyle()`, `self.changeX(10)` or `self.stop()`.

### `screen(name, options, body)`

Declares a screen.

```ts
screen("menu", { backdrop: "https://example.com/menu.png" }, () => {
  sprite("start", { ... }, () => { ... });
});
```

## Testing

### `test(name, body)`

Defines a compile-time unit test.

```ts
test("double", () => {
  expect(double(21)).toBe(42);
});
```

### `expect<T>(actual)`

Creates an assertion.

```ts
expect(value).toBe(42);
expect(value).toBeTruthy();
expect(value).toContain("hello");
```

# Plain data objects

TypeScript data objects compile to opaque numeric handles in a hidden list heap,
not `_object_*` blocks, so they can run in the official share player. Read/write
initialized properties with `obj.x` or a compile-time constant key; aliases,
nested objects, arrays of objects and function arguments/returns share identity.
Optional properties declared in the type may be omitted and read as `undefined`
([null / undefined](ts-nullable.md)). Dynamic or undeclared keys, object
coercion/logging/JSON, `delete`, methods, spread and value-producing property
updates are rejected. Use scalar properties
for output and separate update statements. See [object compilation and official
source evidence](ts-share-objects.md) for the full support boundary.

# Map / Set

原生 ES2020 类型声明适用于 `Map<K,V>` / `Set<T>`。前端支持 string/number 键、set/get/has/delete/clear/size、add、直接 for-of 的 keys/values/entries 与内联 forEach；get 返回 `V | undefined`，可用 `??` 或判空。支持引用字段与别名，明确标注的跨文件参数和返回值。forEach 回调局部变量使用显式初始化的 `let/const`，`var` 报错；可空集合方法先保存 receiver 并显式判空，可选方法调用报错（`?.size` 支持）。限制和复杂度见 [ts-map-set.md](ts-map-set.md)。
