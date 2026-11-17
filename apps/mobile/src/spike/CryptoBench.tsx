/**
 * TEST B — base chiffrée, libsodium et Argon2id sur un vrai téléphone (code jetable).
 *
 * Mesure les temps des briques de sécurité prévues dans la conception :
 * - Argon2id (mots de passe, connexion hors ligne) ;
 * - coffre sécurisé du téléphone (clé de la base) ;
 * - SQLCipher via op-sqlite (base locale chiffrée) ;
 * - crypto_box_seal (copie de secours lisible par le boss seul) ;
 * - XChaCha20-Poly1305 (chiffrement des messages de synchro).
 *
 * Chaque résultat est aussi écrit dans la console (visible dans les journaux Metro).
 */
import { isSQLCipher, open } from '@op-engineering/op-sqlite';
import * as SecureStore from 'expo-secure-store';
import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text } from 'react-native';
import {
  crypto_aead_xchacha20poly1305_ietf_decrypt,
  crypto_aead_xchacha20poly1305_ietf_encrypt,
  crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  crypto_box_keypair,
  crypto_box_seal,
  crypto_box_seal_open,
  crypto_pwhash,
  crypto_pwhash_ALG_ARGON2ID13,
  crypto_pwhash_MEMLIMIT_INTERACTIVE,
  crypto_pwhash_OPSLIMIT_INTERACTIVE,
  crypto_pwhash_SALTBYTES,
  randombytes_buf,
  to_base64,
  to_string,
} from 'react-native-libsodium';

import { fakeSale } from './protocol';

const MB = 1024 * 1024;
const SALES = 1000;

/** Laisse l'écran se rafraîchir entre deux mesures. */
const tick = () => new Promise((r) => setTimeout(r, 30));

async function time<T>(fn: () => T | Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - t0)];
}

export function CryptoBench() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const add = (line: string) => {
    console.log(`[TEST B] ${line}`);
    setLog((l) => [...l, line]);
  };

  const run = async () => {
    setRunning(true);
    setLog([]);
    try {
      // 1. Argon2id ------------------------------------------------------------
      add('— Argon2id (hachage d’un mot de passe)');
      const salt = randombytes_buf(crypto_pwhash_SALTBYTES);
      const variants: [string, number, number][] = [
        ['INTERACTIVE (ops 2, 64 Mo)', crypto_pwhash_OPSLIMIT_INTERACTIVE, crypto_pwhash_MEMLIMIT_INTERACTIVE],
        ['ops 3, 64 Mo', 3, 64 * MB],
        ['ops 2, 128 Mo', 2, 128 * MB],
      ];
      for (const [label, ops, mem] of variants) {
        await tick();
        const [, ms] = await time(() => crypto_pwhash(32, 'MotDePasse123', salt, ops, mem, crypto_pwhash_ALG_ARGON2ID13));
        add(`${label} : ${ms} ms`);
      }

      // 2. Coffre sécurisé -----------------------------------------------------
      await tick();
      add('— Coffre sécurisé (clé de la base)');
      const dbKey = to_base64(randombytes_buf(32));
      const [, wMs] = await time(() => SecureStore.setItemAsync('bench_db_key', dbKey));
      const [readKey, rMs] = await time(() => SecureStore.getItemAsync('bench_db_key'));
      add(`écriture ${wMs} ms, lecture ${rMs} ms, clé relue identique : ${readKey === dbKey ? 'oui' : 'NON'}`);

      // 3. SQLCipher -----------------------------------------------------------
      await tick();
      add(`— SQLCipher (op-sqlite compilé avec SQLCipher : ${isSQLCipher() ? 'oui' : 'NON'})`);
      const name = `bench-${Date.now()}.db`;
      const [db, openMs] = await time(() => open({ name, encryptionKey: dbKey }));
      add(`ouverture + dérivation de la clé : ${openMs} ms`);
      db.executeSync(`CREATE TABLE sale (id TEXT PRIMARY KEY, occurred_at TEXT, total_amount INTEGER, note TEXT)`);
      db.executeSync(`CREATE TABLE sale_line (id TEXT PRIMARY KEY, sale_id TEXT, item_name TEXT, quantity INTEGER, unit_price INTEGER)`);

      const [, insMs] = await time(() =>
        db.transaction(async (tx) => {
          for (let i = 0; i < SALES; i++) {
            const s = fakeSale(i);
            await tx.execute('INSERT INTO sale VALUES (?, ?, ?, ?)', [s.id, s.occurred_at, s.total_amount, s.note]);
            for (let j = 0; j < s.lines.length; j++) {
              const l = s.lines[j]!;
              await tx.execute('INSERT INTO sale_line VALUES (?, ?, ?, ?, ?)', [`${s.id}-${j}`, s.id, l.item_name, l.quantity, l.unit_price]);
            }
          }
        }),
      );
      add(`${SALES} ventes (+ ${SALES * 2} lignes) en une transaction : ${insMs} ms`);

      const [agg, qMs] = await time(() =>
        db.execute(
          `SELECT substr(s.occurred_at, 1, 10) AS jour, count(DISTINCT s.id) AS ventes, sum(l.quantity * l.unit_price) AS ca
           FROM sale s JOIN sale_line l ON l.sale_id = s.id GROUP BY jour`,
        ),
      );
      add(`agrégat (CA par jour) : ${qMs} ms → ${JSON.stringify(agg.rows[0])}`);
      db.close();

      let wrongKeyRefused = false;
      try {
        const bad = open({ name, encryptionKey: 'mauvaise-cle' });
        bad.executeSync('SELECT count(*) FROM sale');
        bad.close();
      } catch {
        wrongKeyRefused = true;
      }
      add(`ouverture avec une mauvaise clé refusée : ${wrongKeyRefused ? 'oui' : 'NON (problème !)'}`);
      const again = open({ name, encryptionKey: dbKey });
      const count = again.executeSync('SELECT count(*) AS n FROM sale').rows[0]?.n;
      again.delete();
      add(`réouverture avec la bonne clé : ${count} ventes relues`);

      // 4. Copie de secours : crypto_box_seal -----------------------------------
      await tick();
      add('— Copie de secours (crypto_box_seal, clé publique du boss)');
      const boss = crypto_box_keypair();
      const payloads = Array.from({ length: 500 }, (_, i) => JSON.stringify(fakeSale(i)));
      const [sealed, sealMs] = await time(() => payloads.map((p) => crypto_box_seal(p, boss.publicKey)));
      const [opened, openSealMs] = await time(() => // Remarque : la sortie 'text' n'est pas implémentée par react-native-libsodium (elle lève toujours une erreur).
        sealed.map((c) => to_string(crypto_box_seal_open(c, boss.publicKey, boss.privateKey))),
      );
      add(`chiffrer 500 ventes : ${sealMs} ms, les déchiffrer (côté boss) : ${openSealMs} ms, intactes : ${opened[42] === payloads[42] ? 'oui' : 'NON'}`);
      const other = crypto_box_keypair();
      let refused = false;
      try {
        crypto_box_seal_open(sealed[0]!, other.publicKey, other.privateKey);
      } catch {
        refused = true;
      }
      add(`illisible avec une autre clé (employé) : ${refused ? 'oui' : 'NON (problème !)'}`);

      // 5. Messages de synchro : XChaCha20-Poly1305 ------------------------------
      await tick();
      add('— Messages de synchro (XChaCha20-Poly1305)');
      const key = randombytes_buf(crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
      const batch = JSON.stringify(Array.from({ length: 50 }, (_, i) => fakeSale(i)));
      const [, encMs] = await time(() => {
        for (let i = 0; i < 100; i++) {
          const nonce = randombytes_buf(crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
          // Données associées : authentifiées mais non chiffrées. react-native-libsodium exige une chaîne
          // (null n'est pas implémenté). Le vrai protocole y mettra l'identifiant de session et le n° du message.
          const aad = `session-test:${i}`;
          const c = crypto_aead_xchacha20poly1305_ietf_encrypt(batch, aad, null, nonce, key);
          const clear = to_string(crypto_aead_xchacha20poly1305_ietf_decrypt(null, c, aad, nonce, key));
          if (clear !== batch) throw new Error('lot déchiffré différent de l’original');
        }
      });
      add(`100 lots de 50 ventes (${Math.round(batch.length / 1024)} Ko chacun) chiffrés et déchiffrés : ${encMs} ms`);
      let tamperRefused = false;
      try {
        const nonce = randombytes_buf(crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
        const c = crypto_aead_xchacha20poly1305_ietf_encrypt(batch, 'session-test:0', null, nonce, key);
        crypto_aead_xchacha20poly1305_ietf_decrypt(null, c, 'session-test:1', nonce, key);
      } catch {
        tamperRefused = true;
      }
      add(`message rejoué sous un autre numéro refusé : ${tamperRefused ? 'oui' : 'NON (problème !)'}`);

      add('Terminé ✅');
    } catch (e) {
      add(`ERREUR : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Test B — sécurité et performances</Text>
      <Button title={running ? 'Mesures en cours…' : 'Lancer les mesures'} onPress={run} disabled={running} />
      {log.map((l, i) => (
        <Text key={i} style={l.startsWith('—') ? styles.section : styles.mono}>
          {l}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 6 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  section: { marginTop: 12, fontWeight: '700' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
});
