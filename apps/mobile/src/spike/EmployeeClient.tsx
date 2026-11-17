import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import TcpSocket from 'react-native-tcp-socket';

import { SPIKE_PORT, createLineReader, encode, fakeSale } from './protocol';

const SALES = 500;
const BATCH = 50;

export function EmployeeClient() {
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const add = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));

  const run = () => {
    const t0 = Date.now();
    add(`Connexion à ${host}:${SPIKE_PORT}…`);
    const socket = TcpSocket.createConnection({ host: host.trim(), port: SPIKE_PORT }, () => {
      add(`Connecté en ${Date.now() - t0} ms`);
      socket.write(encode({ type: 'hello', token: token.trim().toUpperCase(), device: 'Téléphone employé' }));
    });
    socket.setEncoding('utf8');
    let tSend = 0;
    let seq = 0;
    const sendNext = () => {
      if (seq * BATCH >= SALES) {
        add(`${SALES} ventes envoyées et confirmées en ${Date.now() - tSend} ms`);
        socket.write(encode({ type: 'bye' }));
        return;
      }
      const items = Array.from({ length: BATCH }, (_, i) => fakeSale(seq * BATCH + i));
      socket.write(encode({ type: 'batch', seq: seq++, items }));
    };
    const read = createLineReader((m) => {
      if (m.type === 'welcome') {
        add(`Accepté par ${m.boss}. Envoi de ${SALES} ventes…`);
        tSend = Date.now();
        sendNext();
      } else if (m.type === 'rejected') {
        add(`Refusé : ${m.reason}`);
      } else if (m.type === 'ack') {
        sendNext();
      }
    });
    socket.on('data', (d) => read(String(d)));
    socket.on('error', (e) => add(`Erreur : ${e.message}`));
    socket.on('close', () => add('Connexion fermée'));
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Employé — lancer une synchro</Text>
      <Text>Adresse du boss</Text>
      <TextInput style={styles.input} value={host} onChangeText={setHost} placeholder="192.168.1.20" keyboardType="numbers-and-punctuation" autoCapitalize="none" />
      <Text>Jeton</Text>
      <TextInput style={styles.input} value={token} onChangeText={setToken} placeholder="AB12CD" autoCapitalize="characters" />
      <Button title={`Envoyer ${SALES} ventes de test`} onPress={run} disabled={!host || !token} />
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
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 8, fontFamily: 'monospace' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
});
