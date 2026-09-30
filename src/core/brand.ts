/**
 * Class identity that holds across copies of this package in one process. The
 * package ships an ESM build and a CommonJS build, and a process that loads
 * both — an ESM application with a CommonJS dependency, say — holds two copies
 * of every class, so a plain `instanceof` is false for an instance the other
 * copy made. A branded class marks its prototype with a `Symbol.for` key,
 * which every copy resolves to the same symbol, and answers `instanceof` by
 * that mark.
 */

/**
 * @internal The `Symbol.for` key this package registers under `name`, the
 * same symbol in every copy of the package a process loads.
 */
export function sharedKey(name: string): symbol {
  return Symbol.for(`firefly-audio-video.${name}`);
}

/**
 * @internal Brands `ctor` as `name`: an instance of it that any copy of this
 * package made passes `instanceof ctor`. A subclass keeps the ordinary
 * prototype-chain check, so `instanceof Subclass` still passes only for
 * instances of that subclass, and a prototype is never an instance of its own
 * class.
 */
export function brandClass(ctor: abstract new (...args: never[]) => unknown, name: string): void {
  const mark = sharedKey(name);
  Object.defineProperty(ctor.prototype, mark, { value: true });
  Object.defineProperty(ctor, Symbol.hasInstance, {
    value(this: unknown, value: unknown): boolean {
      if (this !== ctor) return Function.prototype[Symbol.hasInstance].call(this, value);
      return carriesMark(value, mark);
    },
  });
}

/** True for an object whose prototype chain carries `mark`, and which is not itself the prototype that does. */
function carriesMark(value: unknown, mark: symbol): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return mark in value && !Object.prototype.hasOwnProperty.call(value, mark);
}
