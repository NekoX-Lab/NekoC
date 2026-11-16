import { search, scalar, annotated, returned, callback } from "./tsarrayfix-module-methods";
console.log(search());
console.log(scalar().join(","), annotated([6, 7]).join(","), returned().join(","));
console.log(callback().join(","));
