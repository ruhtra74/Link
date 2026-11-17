import * as Network from 'expo-network';
import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import TcpSocket from 'react-native-tcp-socket';

import { LinkNet, type LocalAddress } from '../../modules/link-net';
import { SPIKE_PORT, createLineReader, encode, randomToken, type SyncInvite } from './protocol';

type Server = ReturnType<typeof TcpSocket.createServer>;

export function BossServer() {
  const [addresses, setAddresses] = useState<LocalAddress[]>([]);
  const [expoIp, setExpoIp] = useState<string>('…');
  const [token, setToken] = useState(randomToken);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const server = useRef<Server | null>(null);

  const add = (line: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));

  const refreshAddresses = async () => {
    try {
      setAddresses(LinkNet.getLocalAddresses());
    } catch (e) {
      add(`Module LinkNet indisponible : ${String(e)}`);
    }
    setExpoIp(await Network.getIpAddressAsync().catch((e) => `erreur : ${String(e)}`));
  };

  useEffect(() => {
    refreshAddresses();
    return () => {
      server.current?.close();
    };
  }, []);

  const start = () => {
    const t = randomToken();
    setToken(t);
    const s = TcpSocket.createServer((socket) => {
      const who = `${socket.remoteAddress}:${socket.remotePort}`;
      add(`Connexion de ${who} (arrivée sur ${socket.localAddress})`);
      socket.setEncoding('utf8');
      let received = 0;
      let accepted = false;
      const read = createLineReader((m) => {
        if (m.type === 'hello') {
          accepted = m.token === t;
          socket.write(encode(accepted ? { type: 'welcome', boss: 'Poco du boss' } : { type: 'rejected', reason: 'jeton invalide' }));
          add(accepted ? `${m.device} accepté` : `${m.device} refusé (jeton ${m.token})`);
          if (!accepted) socket.end();
        } else if (m.type === 'batch' && accepted) {
          received += m.items.length;
          socket.write(encode({ type: 'ack', seq: m.seq, count: m.items.length }));
        } else if (m.type === 'bye') {
          add(`${who} terminé : ${received} ventes reçues`);
          socket.end();
        }
      });
      socket.on('data', (d) => read(String(d)));
      socket.on('error', (e) => add(`Erreur socket ${who} : ${e.message}`));
      socket.on('close', () => add(`${who} déconnecté`));
    });
    s.on('error', (e) => add(`Erreur serveur : ${e.message}`));
    s.listen({ port: SPIKE_PORT, host: '0.0.0.0', reuseAddress: true }, () => {
      add(`Serveur à l'écoute sur le port ${SPIKE_PORT}`);
      setRunning(true);
    });
    server.current = s;
    refreshAddresses();
  };

  const stop = () => {
    server.current?.close();
    server.current = null;
    setRunning(false);
    add('Serveur arrêté');
  };

  const invite: SyncInvite = { v: 1, hosts: addresses.map((a) => a.address), port: SPIKE_PORT, token };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Boss — recevoir une synchro</Text>

      <Text style={styles.label}>Adresses du téléphone (module LinkNet)</Text>
      {addresses.length === 0 && <Text style={styles.warn}>Aucune adresse trouvée</Text>}
      {addresses.map((a) => (
        <Text key={a.interface + a.address} style={styles.mono}>
          {a.interface.padEnd(10)} {a.address}
        </Text>
      ))}
      <Text style={styles.label}>expo-network getIpAddressAsync()</Text>
      <Text style={styles.mono}>{expoIp}</Text>
      <Button title="Rafraîchir les adresses" onPress={refreshAddresses} />

      <View style={styles.row}>
        {running ? <Button title="Arrêter" color="#b00" onPress={stop} /> : <Button title="Démarrer le serveur" onPress={start} />}
      </View>

      {running && (
        <View style={styles.qr}>
          <QRCode value={JSON.stringify(invite)} size={220} />
          <Text style={styles.big}>Jeton : {token}</Text>
          <Text style={styles.mono}>Port : {SPIKE_PORT}</Text>
        </View>
      )}

      <Text style={styles.label}>Journal</Text>
      {log.map((l, i) => (
        <Text key={i} style={styles.mono}>
          {l}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  title: { fontSize: 20, fontWeight: '700' },
  label: { marginTop: 12, fontWeight: '600' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  warn: { color: '#b00' },
  row: { marginVertical: 12 },
  qr: { alignItems: 'center', gap: 8, padding: 16, backgroundColor: '#fff' },
  big: { fontSize: 22, fontWeight: '700', letterSpacing: 2 },
});
