# Test A — synchro directe entre téléphones

## But

Vérifier, avant d'écrire l'application, que le téléphone du boss peut **recevoir une connexion** d'un autre appareil
sur le réseau local, sans internet :

1. sur un Wi-Fi ordinaire (box, routeur) ;
2. sur le **partage de connexion** activé sur le téléphone du boss ;

et que l'on sait **trouver l'adresse du boss** dans les deux cas (pour la mettre dans le QR code).

Le code du test est jetable : `apps/mobile/src/spike/`, le module natif `apps/mobile/modules/link-net/`
(liste des adresses réseau du téléphone) et le client PC `tools/spike-client.mjs`.

## Matériel

Un seul téléphone (Poco M6 Pro) suffit pour commencer :
- **téléphone = boss** (serveur) ;
- **PC = employé** (client), avec `tools/spike-client.mjs`.

L'émulateur Android ou un second téléphone pourront jouer l'employé ensuite.
**iOS ne peut pas être testé sans iPhone ni Mac** : à faire dès qu'un iPhone est disponible.

## Déroulé

1. Installer l'app sur le téléphone : `cd apps/mobile && npx expo run:android`.
2. Dans l'app : « Je suis le boss » → noter les adresses affichées (module LinkNet **et** expo-network) → « Démarrer le serveur ».
3. Sur le PC, connecté au même réseau :
   ```bash
   node tools/spike-client.mjs <adresse-du-téléphone> <jeton> 500
   ```
4. Recommencer avec le PC connecté au **partage de connexion** du téléphone (Wi-Fi du téléphone désactivé).

## Résultats

| # | Réseau | Adresses LinkNet (interface → IP) | expo-network | Connexion OK ? | Temps de connexion | 500 ventes en | Remarques |
|---|--------|-----------------------------------|--------------|----------------|--------------------|---------------|-----------|
| 1 | Wi-Fi box | | | | | | |
| 2 | Partage de connexion du boss (PC connecté au Poco) — 16/11/2026 | `ap0` → 10.227.85.214 | **0.0.0.0** (inutilisable) | ✅ | 32 à 55 ms | 312 ms (5000 ventes : 3,9 s, ≈ 1 300 ventes/s) | Jeton invalide bien refusé, mais le message « rejected » n'arrive pas avant la fermeture (voir constats) |
| 3 | Wi-Fi public / isolé (facultatif) | | | | | | |
| 4 | Émulateur ou 2ᵉ téléphone comme employé | | | | | | |

## Constats

- **Le cas le plus incertain fonctionne** : un appareil connecté au partage de connexion du Poco joint le serveur ouvert par l'app, sans internet.
- **expo-network ne suffit pas** : il renvoie `0.0.0.0` quand le téléphone partage sa connexion. Le module `link-net` trouve la bonne adresse (interface `ap0`). Le QR code doit donc contenir les adresses de `link-net`.
- **Débit largement suffisant** : environ 1 300 ventes/s en JSON non chiffré. Une journée d'un salon (quelques dizaines de ventes) passe en une fraction de seconde. Le chiffrement ajoutera un coût à mesurer au test B.
- **À corriger dans le vrai protocole** : fermer la connexion seulement après l'envoi effectif du dernier message (callback de `write`), sinon le message de refus peut se perdre.

## Décision

- On garde l'approche **« serveur sur le téléphone du boss + QR code »**.
- Le QR code contient **toutes les adresses IPv4 renvoyées par `link-net`** ; le téléphone de l'employé les essaie dans l'ordre.
- Restent à tester : Wi-Fi ordinaire (cas le plus simple), Wi-Fi public isolé, et iOS (pas d'iPhone).
