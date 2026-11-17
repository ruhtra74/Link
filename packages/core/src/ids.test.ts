import { describe, expect, it } from 'vitest';

import { createIdGenerator, uuidv7, UUID_V7_PATTERN } from './ids';
import { counterRandomBytes } from './testing/context';

describe('uuidv7', () => {
  it('respecte le format UUID v7 (version 7, variante RFC 9562)', () => {
    const id = uuidv7(Date.parse('2026-11-17T10:00:00Z'), new Uint8Array(10).fill(0xff));
    expect(id).toMatch(UUID_V7_PATTERN);
  });

  it("encode l'horodatage dans les 48 premiers bits", () => {
    const ms = Date.parse('2026-11-17T10:00:00.123Z');
    const id = uuidv7(ms, new Uint8Array(10));
    const encoded = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(encoded).toBe(ms);
  });

  it('se trie dans l’ordre chronologique', () => {
    const random = counterRandomBytes();
    const ids = [0, 1, 1000, 60_000, 86_400_000].map((offset) => uuidv7(Date.parse('2026-01-01T00:00:00Z') + offset, random(10)));
    expect([...ids].sort()).toEqual(ids);
  });

  it('refuse moins de 10 octets aléatoires', () => {
    expect(() => uuidv7(0, new Uint8Array(9))).toThrow();
  });
});

describe('createIdGenerator', () => {
  it('produit des identifiants uniques à horloge figée', () => {
    const gen = createIdGenerator(() => 1_700_000_000_000, counterRandomBytes());
    const ids = new Set(Array.from({ length: 1000 }, () => gen.newId()));
    expect(ids.size).toBe(1000);
  });
});
