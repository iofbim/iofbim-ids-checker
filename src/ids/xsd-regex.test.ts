import { describe, expect, it } from 'vitest';
import { hasClassSubtraction, xsdToJs, xsdToRe2 } from './xsd-regex.js';
import { restrictionToSql } from './facet-sql.js';

const full = (pattern: string, value: string) => new RegExp(`^(?:${xsdToJs(pattern)})$`, 'u').test(value);

describe('XSD class subtraction', () => {
  it('leaves patterns without subtraction as written', () => {
    for (const p of ['MK-HVM-[^-]+', '(K[0-9]{2}|B[0-9]{2})_[\\p{Lu}\\p{N}]{3}_[0-9]{3}', '[a\\-z]', '\\[-[x]']) {
      expect(xsdToJs(p)).toBe(p);
      expect(xsdToRe2(p)).toBe(p);
      expect(hasClassSubtraction(p)).toBe(false);
    }
  });

  it('spells a subtracted class out exactly', () => {
    const p = 'deneme-[\\p{Lu}\\p{N}]{3}-[\\p{L}\\p{N}\\p{P}\\s-[_]]+';
    expect(hasClassSubtraction(p)).toBe(true);
    expect(full(p, 'deneme-123-abc. def')).toBe(true);
    expect(full(p, 'deneme-123-a_b')).toBe(false);
    expect(full('[a-z-[aeiou]]+', 'xyz')).toBe(true);
    expect(full('[a-z-[aeiou]]+', 'xaz')).toBe(false);
    // nested: a-z without vowels, but "e" put back
    expect(full('[a-z-[aeiou-[e]]]', 'e')).toBe(true);
    expect(full('[a-z-[aeiou-[e]]]', 'a')).toBe(false);
  });

  it('writes RE2 code points', () => {
    expect(xsdToRe2('[a-c-[b]]')).toBe('[\\x{61}\\x{63}]');
    expect(xsdToJs('[a-c-[b]]')).toBe('[\\u{61}\\u{63}]');
    expect(xsdToRe2('[a-[a]]')).toBe('[^\\x{0}-\\x{10FFFF}]');
  });

  it('is what the SQL gets', () => {
    expect(restrictionToSql('e.name', { kind: 'pattern', pattern: 'X[a-c-[b]]' }).params).toEqual(['X[\\x{61}\\x{63}]']);
  });

  it('is fast enough for a large class', () => {
    const t0 = performance.now();
    xsdToRe2('[\\p{L}\\p{N}\\p{P}\\s-[_]]');
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
