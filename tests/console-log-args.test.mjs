import test from "node:test";
import { assertJsLogs } from "./ts-runtime.mjs";

// console.log(a, b) 在 JS 里用单个空格拼接所有参数；以前只输出第一个参数。
test("console.log joins multiple arguments with a space like JS", () => {
  assertJsLogs("let a = 1; let b = 2; console.log(a, b);");
});

test("console.log joins object properties and mixed values like JS", () => {
  assertJsLogs(`const player = { x: 3, score: 10 };
let name = "cat";
let alive = true;
onStart(() => {
  console.log(player.x, player.score);
  console.log("pos", player.x, name, alive, 1.5);
  console.log(a2(), "", "end");
});
function a2() { return player.score * 2; }`);
});

test("single-argument console.log is unchanged", () => {
  assertJsLogs('let a = 1; console.log(a); console.log("x");');
});
