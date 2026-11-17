import { migrations as allMigrations, type Migration } from './migrations';
import type { Database } from './types';

/**
 * Prépare une connexion et applique les migrations manquantes.
 * À appeler à chaque ouverture de la base, avant toute autre requête.
 *
 * - Active les clés étrangères (réglage propre à chaque connexion, sans effet dans une transaction).
 * - Applique chaque migration dans sa propre transaction et met à jour `PRAGMA user_version`.
 *   Si une migration échoue, elle est entièrement annulée et la base reste à la version précédente.
 *
 * Renvoie la version du schéma après migration.
 */
export async function prepareDatabase(
  db: Database,
  migrations: readonly Migration[] = allMigrations,
): Promise<number> {
  await db.execute('PRAGMA foreign_keys = ON');

  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations mal numérotées : ${m.version} à la position ${i + 1}`);
  });

  let current = await schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `La base est en version ${current}, plus récente que l'application (${migrations.length}). Mettre l'application à jour.`,
    );
  }

  for (const m of migrations.slice(current)) {
    await db.transaction(async (tx) => {
      for (const sql of m.statements) await tx.execute(sql);
      await tx.execute(`PRAGMA user_version = ${m.version}`);
    });
    current = m.version;
  }
  return current;
}

export async function schemaVersion(db: Database): Promise<number> {
  const { rows } = await db.execute('PRAGMA user_version');
  return Number(rows[0]?.user_version ?? 0);
}
