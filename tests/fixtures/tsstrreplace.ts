const basic: string = "abc";
console.log(basic.replace("a", "X"));
console.log(basic.replace("c", "X"));
console.log(basic.replace("", "-"));
console.log(basic.replace("b", "[$&]"));

console.log(basic.replace("b", "X"));
console.log(basic.replace("abc", "X"));
console.log(basic.replace("x", "X"));
console.log("".replace("x", "X"));
console.log("".replace("", "X"));
console.log("".replace("", ""));
console.log(basic.replace("a", ""));
console.log(basic.replace("c", ""));
console.log(basic.replace("abc", ""));
console.log(basic.replace("", ""));
console.log("aaabaaa".replace("aa", "X"));
console.log(basic.replace("b", "$$/$&/$`/$'/$1/$01/$<name>/$"));
console.log(basic.replace("a", "$`[$&]$'"));
console.log(basic.replace("c", "$`[$&]$'"));
console.log(basic.replace("", "$`[$&]$'"));
console.log(basic.replace("b", "$$& $$$& $$$$ $$$` $$$'"));
console.log(basic.replace("b", "$😀$&😀"));
console.log("😀甲😀乙😀".replace("😀", "[$&][$`][$']"));
console.log("😀甲😀乙😀".replace("乙", "[$&][$`][$']"));
console.log("😀甲😀乙😀".replace("不存在", "X"));
console.log("😀甲".replace("", "🙂"));
console.log("é甲é".replace("é", "🙂"));
console.log("007x008".replace("x", "-"));
console.log("~!foo~!".replace("~!", "X"));
console.log("!~foo!~".replace("!~", "X"));

console.log(basic.replaceAll("a", "X"));
console.log(basic.replaceAll("c", "X"));
console.log(basic.replaceAll("b", "X"));
console.log(basic.replaceAll("abc", "X"));
console.log(basic.replaceAll("x", "X"));
console.log("".replaceAll("x", "X"));
console.log("".replaceAll("", "X"));
console.log("".replaceAll("", ""));
console.log(basic.replaceAll("", "-"));
console.log(basic.replaceAll("", ""));
console.log("甲乙".replaceAll("", "[$`][$&][$']"));
console.log("aaaaa".replaceAll("aa", "X"));
console.log("aaaa".replaceAll("a", ""));
console.log("abab".replaceAll("ab", ""));
console.log("aaabaaa".replaceAll("aa", "X"));
console.log("aba".replaceAll("a", "$$/$&/$`/$'/$1/$<x>"));
console.log("a".replaceAll("a", "aa"));
console.log("😀甲😀乙😀".replaceAll("😀", "[$&][$`][$']🙂"));
console.log("😀甲😀乙😀".replaceAll("乙", "[$&][$`][$']"));
console.log("é甲é".replaceAll("é", "🙂"));
console.log("007x008x009".replaceAll("x", "-"));
console.log("~!foo~!".replaceAll("~!", "X"));
console.log("!~foo!~".replaceAll("!~", "X"));
const emojiSearch = "😀";
console.log("😀😀".replaceAll(emojiSearch, "🙂"));
console.log("10".replaceAll("1.0", "X"));
console.log("AaA".replaceAll("a", "X"));
console.log("x$$x".replaceAll("x", "$$$&$`$'"));

let order = "";
let live = "abc";
function receiver(): string { order += "R"; return live; }
function search(): string { order += "S"; live = "changed"; return "b"; }
function replacement(): string { order += "B"; return "$&X"; }
console.log(receiver().replace(search(), replacement()));
console.log(order);
order = "";
live = "abc";
console.log(receiver().replaceAll("b", replacement()));
console.log(order);
order = "";
console.log("abc".replaceAll(search(), replacement()));
console.log(order);

function nested(value: string): string { return value.replace("b", "[$&]"); }
console.log(nested(nested("abc")));
let dynamicSearch = "";
let dynamicReplacement = "$&-$`-$'";
console.log("abc".replaceAll(dynamicSearch, dynamicReplacement));
