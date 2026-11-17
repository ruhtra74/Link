# Test B — sécurité et performances sur téléphone

## But

Vérifier, sur un téléphone de milieu de gamme, que les briques de sécurité prévues dans la conception
fonctionnent et sont assez rapides :

- **Argon2id** pour les mots de passe (connexion hors ligne) ;
- **coffre sécurisé** du téléphone (Keystore / Keychain) pour la clé de la base ;
- **SQLCipher** (via op-sqlite) pour la base locale chiffrée ;
- **crypto_box_seal** pour la copie de secours lisible par le boss seul ;
- **XChaCha20-Poly1305** pour chiffrer les messages de synchronisation.

Code du test (jetable) : `apps/mobile/src/spike/CryptoBench.tsx`.

## Conditions

- Téléphone : Poco M6 Pro (Android), dev client EAS, Expo SDK 58, React Native 0.88 (nouvelle architecture).
- Bibliothèques : `@op-engineering/op-sqlite` 19.0.5 (SQLCipher activé), `react-native-libsodium` 1.7.0, `expo-secure-store` 58.
- 17/11/2026, 5 séries de mesures ; valeurs ci-dessous = fourchette observée.

## Résultats

| Brique | Mesure | Verdict |
|---|---|---|
| Argon2id INTERACTIVE (2 passes, 64 Mo) | 252 à 282 ms | ✅ |
| Argon2id 3 passes, 64 Mo | 352 à 384 ms | ✅ |
| Argon2id 2 passes, 128 Mo | 491 à 538 ms | ✅ |
| Coffre sécurisé : écriture / lecture de la clé | 26–70 ms / 14–24 ms, clé relue identique | ✅ |
| op-sqlite compilé avec SQLCipher | oui | ✅ |
| Ouverture de la base chiffrée | 1 à 21 ms | ✅ |
| 1 000 ventes + 2 000 lignes, une transaction, insertions une par une | 1,9 à 3,2 s | ✅ (voir constats) |
| Agrégat « CA par jour » sur 1 000 ventes | 17 à 25 ms | ✅ |
| Ouverture avec une mauvaise clé | refusée | ✅ |
| Réouverture avec la bonne clé | 1 000 ventes relues | ✅ |
| Copie de secours : chiffrer 500 ventes (clé publique du boss) | 158 à 174 ms | ✅ |
| Copie de secours : déchiffrer 500 ventes (boss) | 122 à 138 ms, données intactes | ✅ |
| Copie de secours lue avec une autre clé (employé) | impossible | ✅ |
| XChaCha20-Poly1305 : 100 lots de 50 ventes (13 Ko) chiffrés + déchiffrés | 25 ms | ✅ |
| Message rejoué avec d'autres données associées | refusé | ✅ |

## Constats et décisions

- **Argon2id : 3 passes, 64 Mo** (≈ 0,36 s à la connexion). Plus fort que le réglage standard pour un coût imperceptible.
- **SQLCipher est rapide** : ouverture et requêtes du tableau de bord instantanées. Les insertions coûtent ≈ 1 ms par ligne ;
  sans importance pour la saisie (1 à 3 lignes par vente). Pour la réception d'un gros lot en synchro, utiliser
  `executeBatch` plutôt que des insertions une par une.
- **Le chiffrement n'est pas un goulot** : 5 000 ventes chiffrées et déchiffrées en 25 ms, contre ≈ 1 300 ventes/s pour le
  transport réseau (test A).
- **Limites de `react-native-libsodium` 1.7.0** à respecter dans tout le code :
  - pas de `crypto_kx` ni de `secretstream` → sessions de synchro chiffrées avec `crypto_box` (échange de clés) + XChaCha20-Poly1305 ;
  - la sortie `'text'` n'est **pas implémentée** (elle lève toujours `ERR_ENCODING_INVALID_ENCODED_DATA`) → récupérer
    des octets puis convertir avec `to_string` ;
  - les **données associées** de XChaCha20-Poly1305 doivent être une **chaîne** (`null` non implémenté) → y mettre
    l'identifiant de session et le numéro du message, ce qui empêche aussi de rejouer ou déplacer un message.
- **iOS non testé** (pas d'iPhone).

## Décision

Les briques de sécurité prévues sont retenues telles quelles. Feu vert pour la phase 1.
