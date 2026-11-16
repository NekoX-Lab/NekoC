// Shared host-only declarations for collection inference in the lowering passes.
export const collectionTypes = `
declare const NaN: number;
declare function Number(value?: string | number | boolean): number;
interface Array<T> { [Symbol.iterator](): MapIterator<T>; }
interface String { split(separator: string): string[]; }
interface SymbolConstructor { readonly iterator: unique symbol; }
declare var Symbol: SymbolConstructor;
interface IteratorResult<T> { done?: boolean; value: T; }
interface Iterable<T> { [Symbol.iterator](): MapIterator<T>; }
interface Map<K, V> {
  [Symbol.iterator](): MapIterator<[K, V]>;
  readonly size: number;
  set(key: K, value: V): Map<K, V>; get(key: K): V | undefined;
  has(key: K): boolean; delete(key: K): boolean; clear(): void;
  keys(): MapIterator<K>; values(): MapIterator<V>; entries(): MapIterator<[K, V]>;
  forEach(callback: (value: V, key: K, map: Map<K, V>) => void): void;
}
interface MapConstructor {
  new<K, V>(entries?: readonly (readonly [K, V])[]): Map<K, V>;
  new(): Map<any, any>;
}
declare var Map: MapConstructor;
interface Set<T> {
  [Symbol.iterator](): MapIterator<T>;
  readonly size: number; add(value: T): Set<T>; has(value: T): boolean;
  delete(value: T): boolean; clear(): void;
  keys(): MapIterator<T>; values(): MapIterator<T>; entries(): MapIterator<[T, T]>;
  forEach(callback: (value: T, key: T, set: Set<T>) => void): void;
}
interface SetConstructor { new<T>(values?: readonly T[]): Set<T>; new(): Set<any>; }
declare var Set: SetConstructor;
interface MapIterator<T> { next(): IteratorResult<T>; [Symbol.iterator](): MapIterator<T>; }
`;
