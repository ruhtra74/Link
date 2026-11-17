#!/usr/bin/env node
// TEST A — joue le rôle d'un téléphone employé depuis le PC.
// Usage : node tools/spike-client.mjs <adresse-du-boss> <jeton> [nombre-de-ventes]
// Le PC doit être sur le même réseau que le téléphone du boss
// (même Wi-Fi, ou connecté au partage de connexion du téléphone).
import net from 'node:net';

const [host, token, salesArg] = process.argv.slice(2);
if (!host || !token) {
  console.error('Usage : node tools/spike-client.mjs <adresse-du-boss> <jeton> [nombre-de-ventes]');
  process.exit(1);
}
const PORT = 47420;
const SALES = Number(salesArg ?? 500);
const BATCH = 50;

const fakeSale = (n) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  occurred_at: new Date().toISOString(),
  total_amount: 2500 + n,
  lines: [
    { item_name: 'Coupe homme', quantity: 1, unit_price: 2000 },
    { item_name: 'Shampoing', quantity: 1, unit_price: 500 + n },
  ],
  note: 'test de synchronisation',
});
const send = (m) => socket.write(JSON.stringify(m) + '\n');

const t0 = Date.now();
let tSend = 0;
let seq = 0;
let buffer = '';

const socket = net.createConnection({ host, port: PORT, timeout: 5000 }, () => {
  console.log(`Connecté à ${host}:${PORT} en ${Date.now() - t0} ms (adresse locale ${socket.localAddress})`);
  send({ type: 'hello', token: token.toUpperCase(), device: 'PC (client de test)' });
});
socket.setEncoding('utf8');

function sendNext() {
  if (seq * BATCH >= SALES) {
    const ms = Date.now() - tSend;
    console.log(`${SALES} ventes envoyées et confirmées en ${ms} ms (${Math.round((SALES / ms) * 1000)} ventes/s)`);
    send({ type: 'bye' });
    return;
  }
  const count = Math.min(BATCH, SALES - seq * BATCH);
  const items = Array.from({ length: count }, (_, i) => fakeSale(seq * BATCH + i));
  send({ type: 'batch', seq: seq++, items });
}

socket.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (m.type === 'welcome') {
      console.log(`Accepté par « ${m.boss} ». Envoi de ${SALES} ventes…`);
      tSend = Date.now();
      sendNext();
    } else if (m.type === 'rejected') {
      console.log(`Refusé : ${m.reason}`);
    } else if (m.type === 'ack') {
      sendNext();
    }
  }
});
socket.on('timeout', () => {
  console.error(`Pas de réponse de ${host}:${PORT} après 5 s. Le téléphone est-il joignable sur ce réseau ?`);
  socket.destroy();
  process.exitCode = 1;
});
socket.on('error', (e) => {
  console.error(`Erreur : ${e.message}`);
  process.exitCode = 1;
});
socket.on('close', () => console.log('Connexion fermée'));
