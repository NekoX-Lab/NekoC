// POSIX virtual paths for browser hosts. Node keeps its native path semantics.
function resolve(...parts) {
  const output = [];
  for (const part of parts) {
    if (part.startsWith("/")) output.length = 0;
    for (const item of part.replaceAll("\\", "/").split("/")) {
      if (item === "..") output.pop();
      else if (item && item !== ".") output.push(item);
    }
  }
  return `/${output.join("/")}`;
}
export const portablePath = {
  isAbsolute: name => name.startsWith("/"),
  resolve,
  join: (...parts) => resolve(...parts),
  dirname: (name) => resolve(name, ".."),
  relative: (from, to) => {
    const left = resolve(from).split("/").filter(Boolean);
    const right = resolve(to).split("/").filter(Boolean);
    let common = 0;
    while (common < left.length && common < right.length && left[common] === right[common]) common++;
    return [...left.slice(common).map(() => ".."), ...right.slice(common)].join("/");
  },
};
