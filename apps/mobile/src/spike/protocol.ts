/**
 * TEST A — synchronisation directe entre deux téléphones (code jetable).
 *
 * Protocole volontairement minimal : des messages JSON, un par ligne, sur TCP.
 * Il sert seulement à vérifier qu'un téléphone peut joindre celui du boss
 * (Wi-Fi, partage de connexion) et à mesurer les temps. Le vrai protocole
 * (chiffré, avec accusés et curseurs) sera écrit dans packages/core.
 *
 * Le client Node `tools/spike-client.mjs` utilise le même format.
 */

export const SPIKE_PORT = 47420;

/** Contenu du QR code affiché par le boss. */
export type SyncInvite = {
  v: 1;
  hosts: string[];
  port: number;
  token: string;
};

export type Message =
  | { type: 'hello'; token: string; device: string }
  | { type: 'welcome'; boss: string }
  | { type: 'rejected'; reason: string }
  | { type: 'batch'; seq: number; items: unknown[] }
  | { type: 'ack'; seq: number; count: number }
  | { type: 'bye' };

export const encode = (m: Message) => JSON.stringify(m) + '\n';

/** Recompose les messages : TCP ne garantit pas qu'un paquet = un message. */
export function createLineReader(onMessage: (m: Message) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) onMessage(JSON.parse(line) as Message);
    }
  };
}

/** Une fausse vente, de taille réaliste, pour mesurer le débit. */
export function fakeSale(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    occurred_at: new Date().toISOString(),
    total_amount: 2500 + n,
    lines: [
      { item_name: 'Coupe homme', quantity: 1, unit_price: 2000 },
      { item_name: 'Shampoing', quantity: 1, unit_price: 500 + n },
    ],
    note: 'test de synchronisation',
  };
}

/** Jeton de session. Math.random suffit pour ce test ; le vrai utilisera libsodium. */
export const randomToken = () => Math.random().toString(36).slice(2, 8).toUpperCase();
