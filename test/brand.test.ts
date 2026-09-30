import { expect, test } from 'vitest';
import { brandClass, sharedKey } from '../src/core/brand.js';
import { VERSION } from '../src/version.js';

/** Two unrelated classes branded under one name — what two copies of the package hold. */
function copies(): { One: new () => object; Two: new () => object } {
  class One {}
  class Two {}
  brandClass(One, 'BrandTest');
  brandClass(Two, 'BrandTest');
  return { One, Two };
}

test('an instance of one copy of a branded class is instanceof the other copy', () => {
  const { One, Two } = copies();
  expect(new One() instanceof Two).toBe(true);
  expect(new Two() instanceof One).toBe(true);
});

test('a class branded under another name, a plain object, a primitive and null are not instances', () => {
  const { One } = copies();
  class Other {}
  brandClass(Other, 'BrandTestOther');
  for (const value of [new Other(), {}, Object.create(null), 'text', 42, null, undefined]) {
    expect(value instanceof One).toBe(false);
  }
});

test('a subclass keeps the ordinary check: only its own instances pass it, and they pass the base of either copy', () => {
  const { One, Two } = copies();
  class Sub extends One {}
  expect(new Sub() instanceof Sub).toBe(true);
  expect(new Sub() instanceof One).toBe(true);
  expect(new Sub() instanceof Two).toBe(true);
  expect(new One() instanceof Sub).toBe(false);
  expect(new Two() instanceof Sub).toBe(false);
});

test('a prototype is not an instance of its own class, as with an ordinary instanceof', () => {
  const { One, Two } = copies();
  expect(One.prototype instanceof One).toBe(false);
  expect(Two.prototype instanceof One).toBe(false);
});

test('the shared key is the symbol Symbol.for registers under the package version, the same in every copy of that version', () => {
  expect(sharedKey('defaultClient')).toBe(
    Symbol.for(`firefly-audio-video@${VERSION}.defaultClient`),
  );
});
