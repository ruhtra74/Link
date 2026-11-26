import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';

import { BossServer } from './src/spike/BossServer';
import { CryptoBench } from './src/spike/CryptoBench';
import { EmployeeClient } from './src/spike/EmployeeClient';

/**
 * Écran temporaire des tests techniques A (synchro locale) et B (sécurité).
 * Il sera remplacé par l'application réelle (Expo Router) en phase 2.
 */
export default function App() {
  const [mode, setMode] = useState<'boss' | 'employee' | 'bench' | null>(null);

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      {mode === null ? (
        <View style={styles.menu}>
          <Text style={styles.title}>Link — tests techniques</Text>
          <Button title="Je suis le boss (serveur)" onPress={() => setMode('boss')} />
          <Button title="Je suis un employé (client)" onPress={() => setMode('employee')} />
          <Button title="Test B : sécurité et performances" onPress={() => setMode('bench')} />
        </View>
      ) : (
        <>
          <Button title="← Retour" onPress={() => setMode(null)} />
          {mode === 'boss' ? <BossServer /> : mode === 'employee' ? <EmployeeClient /> : <CryptoBench />}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff', paddingTop: 48 },
  menu: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
});
