/**
 * Contexte de test : base SQLite en mémoire migrée, horloge contrôlable et identifiants
 * déterministes. Non exporté par `@link/core`.
 */
import type { Clock, CoreContext } from '../context';
import { prepareDatabase } from '../db/migrate';
import { createIdGenerator } from '../ids';
import { ensureSyncState } from '../sync/seq';
import { openNodeSqlite } from './node-sqlite';

export interface TestClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
}

export function createTestClock(startIso = '2026-01-05T08:00:00.000Z'): TestClock {
  let current = Date.parse(startIso);
  return {
    now: () => current,
    set: (iso) => {
      current = Date.parse(iso);
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Octets « aléatoires » reproductibles : un compteur. Suffisant pour des identifiants uniques en test. */
export function counterRandomBytes() {
  let n = 0;
  return (length: number) => {
    n++;
    const bytes = new Uint8Array(length);
    let v = n;
    for (let i = length - 1; i >= 0 && v > 0; i--) {
      bytes[i] = v % 256;
      v = Math.floor(v / 256);
    }
    return bytes;
  };
}

export interface TestContext extends CoreContext {
  clock: TestClock;
}

export async function createTestContext(options: { isBoss?: boolean; deviceId?: string } = {}): Promise<TestContext> {
  const db = openNodeSqlite();
  await prepareDatabase(db);
  const clock = createTestClock();
  const ids = createIdGenerator(clock.now, counterRandomBytes());
  const device = { id: options.deviceId ?? ids.newId(), isBoss: options.isBoss ?? true };
  await db.transaction((tx) => ensureSyncState(tx, device.id, clock.now()));
  return { db, clock, ids, device };
}
