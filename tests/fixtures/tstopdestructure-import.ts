import { values, local } from "./tstopdestructure-module";
console.log("before import call");
const [a, ...tail] = values(), b = local(tail);
console.log(a, tail.join(","), b);
