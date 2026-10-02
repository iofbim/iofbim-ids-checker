import { describe, it, expect } from 'vitest';
import { STRING, LABEL, REF, ENUM } from 'web-ifc';
import { argsToString } from './ifc-loader.js';
import { splitArgs, decodeArg } from './tokenizer.js';

// web-ifc decodes string/label values WITHOUT their STEP quotes. The loader must
// re-quote and escape them so splitArgs treats each value as a single atom — a
// value containing a comma must not be shredded into multiple args.
describe('argsToString — web-ifc value re-encoding', () => {
  it('quotes a STRING value containing a comma so splitArgs keeps it whole', () => {
    // IfcPropertySingleValue('COBie.Component.Space', $, 'Corridor Space,Terrace Space', $)
    const args = argsToString([
      { type: STRING, value: 'COBie.Component.Space' },
      null,
      { type: STRING, value: 'Corridor Space,Terrace Space' },
      null,
    ]);
    const parts = splitArgs(args);
    expect(parts).toHaveLength(4);
    expect(decodeArg(parts[2]!)).toBe('Corridor Space,Terrace Space');
    expect(parts[3]).toBe('$'); // unit slot stays null, not stolen by a fragment
  });

  it('quotes a bare LABEL value containing a comma', () => {
    const args = argsToString([
      { type: LABEL, value: 'Name' },
      { type: LABEL, value: 'a,b,c' },
    ]);
    const parts = splitArgs(args);
    expect(parts).toHaveLength(2);
    expect(decodeArg(parts[1]!)).toBe('a,b,c');
  });

  it('escapes embedded single-quotes per ISO-10303-21', () => {
    const args = argsToString([{ type: STRING, value: "O'Brien" }]);
    expect(args).toBe("'O''Brien'");
    expect(decodeArg(splitArgs(args)[0]!)).toBe("O'Brien");
  });

  it('leaves refs and enums untouched', () => {
    const args = argsToString([
      { type: REF, value: 18 },
      { type: ENUM, value: 'CLADDING' },
    ]);
    expect(splitArgs(args)).toEqual(['#18', '.CLADDING.']);
  });
});
