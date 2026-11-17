/**
 * Identifiants UUID v7 (RFC 9562) : 48 bits d'horodatage en millisecondes, puis de l'aléatoire.
 * Ils sont uniques sans coordination entre téléphones et se trient par date de création,
 * ce qui garde les index de la base compacts.
 */

/** Fournit des octets aléatoires sûrs (crypto.getRandomValues, libsodium…). */
export type RandomBytes = (length: number) => Uint8Array;

export interface IdGenerator {
  newId(): string;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Construit un UUID v7 à partir d'un instant (ms) et de 10 octets aléatoires. */
export function uuidv7(timestampMs: number, random: Uint8Array): string {
  if (random.length < 10) throw new Error('uuidv7 : 10 octets aléatoires sont nécessaires');
  const b = new Uint8Array(16);
  let ts = Math.floor(timestampMs);
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = 0x70 | (random[0]! & 0x0f); // version 7
  b[7] = random[1]!;
  b[8] = 0x80 | (random[2]! & 0x3f); // variante RFC 9562
  b.set(random.subarray(3, 10), 9);
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createIdGenerator(now: () => number, randomBytes: RandomBytes): IdGenerator {
  return { newId: () => uuidv7(now(), randomBytes(10)) };
}

export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
