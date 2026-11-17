# NekoC API Reference

Complete reference for all functions and APIs available in NekoC TypeScript projects.

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
  no-op). `repeat` truncates its count toward zero. For safe generation, counts
  and target lengths must be provably finite constants or functions returning
  bounded literal values, at most 65536; repeat counts must truncate to a
  nonnegative number, and receiver/count must prove a result of at most 65536
  UTF-16 code units. Padding accepts a literal fill or a function returning
  literal fills. Unknown dynamic inputs, negative repeat counts, non-finites and
  excessive growth produce located diagnostics with alternatives. This is a
  deliberate supported subset, not JavaScript's maximum string size or RangeError.
- Lengths/indices count UTF-16 code units. Constant results containing isolated
  surrogates are rejected. Padding with astral fills additionally requires known
  receiver/length bounds proving complete characters. Complete Chinese/emoji
  strings and whole-character padding/repeat are supported; arbitrary isolated
  UTF-16 surrogates and `s[i]` returning `undefined` are not represented.
- Runtime `charAt`/`substring`, `indexOf`/`lastIndexOf`/`endsWith`, and
  `includes`/`startsWith` with an explicit position require a provably BMP-only
  receiver. The proof follows lexical initializers, all assignments, visible
  function returns and direct call arguments, not just a `string` annotation.
  Unknown parameters, array elements and class fields are conservatively
  rejected for these paths, with a source location and alternative. This avoids
  constructing isolated surrogate temporaries even when a search's final result
  would be boolean/numeric. Constants still fold with exact JS semantics.
- `includes(search)` without position and `startsWith(search)` without position
  use native containment/splitting rather than code-unit scanning, so full emoji
  receivers (including variables and parameters) are safe. `split` uses native
  splitting followed by a fresh limited copy; a provably nonempty separator is
  safe with full emoji and with a limit. An empty or unknown separator requires a
  provably BMP-only receiver, since splitting an astral character into code units
  would itself produce unrepresentable strings. Use a nonempty literal separator
  or keep complete characters instead.
- Only the actual symbol bound by a `sprite` callback is a DSL receiver; naming
  an ordinary variable/parameter `self`, or asserting `any`, does not exempt it
  from growth validation. Validated dynamic growth is lowered immediately into
  a bounded helper; any remaining string repeat/padding at final lowering fails
  closed instead of generating an unchecked loop.
- String methods reject extra/spread arguments instead of silently discarding
  them. Existing string `slice` keeps its constant-index subset, negative-index
  normalization and half-open empty ranges; it does not swap bounds.

## TypeScript arrays

- `a[i]` reads the zero-based element with the share-player `list_item` block.
  A missing entry yields Kitten N's empty value (`NaN`), not JavaScript
  `undefined` (known difference core-162).
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
  elements into a new list. Nested/default destructuring is rejected.
- `a.at(index)` supports negative indices and truncates fractional indices.
  The ES2020 declaration set includes this frontend-supported method.
- Statement calls to `push`, `unshift` and `splice` evaluate the receiver once,
  then every argument once from left to right, before changing the list. Saved
  references and values are invocation-local, including recursive argument calls.
  `splice` retains the existing nonnegative-start subset; this does not add sparse
  arrays or general JavaScript boundary/coercion semantics.
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
- Inline array callbacks can read enclosing event-local variables. Capturing
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

### `onBumpActor(target, body)`

Runs when the actor bumps into another actor.

```ts
onBumpActor("enemy", () => {
  console.log("Hit enemy!");
});
```

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

### `restart()`

Restarts the current script.

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

Rotates around another sprite (`target` is a sprite name, or `"--self"`).

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
