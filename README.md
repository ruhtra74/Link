# Link

Application mobile de suivi d'activité pour très petites entreprises (salon de coiffure, boutique, atelier…).
Un responsable (le *boss*) et ses employés enregistrent chaque vente ou service, **sans connexion**,
puis synchronisent leurs téléphones directement entre eux sur le réseau local.

## Organisation du dépôt

Le dépôt est un *monorepo* [pnpm](https://pnpm.io/workspaces) : plusieurs projets liés dans un seul dépôt git.

```
apps/mobile/      Application Expo / React Native (Android et iOS), une seule app pour le boss et les employés
packages/core/    Règles métier et protocole de synchronisation, en TypeScript pur, testés sur ordinateur
tools/            Scripts de développement
docs/             Conception (cahier des charges, modèle de données) et comptes rendus de tests techniques
```

## Technologies

- **TypeScript** partout.
- **React Native + Expo (SDK 58)** pour l'application.
- **Dev client compilé avec EAS Build** : l'app utilise des modules natifs, elle ne tourne donc pas dans Expo Go.
  Aucun SDK Android ni Xcode n'est nécessaire sur la machine de développement.
- **pnpm workspaces** pour le monorepo, **Vitest** pour les tests de `packages/core`.

## Prérequis

- Node.js ≥ 20 et pnpm
- Un compte Expo (gratuit) pour EAS Build
- Un téléphone Android (et plus tard un iPhone)

## Démarrer

```bash
pnpm install
pnpm test                                   # tests de packages/core
```

### Installer le dev client sur le téléphone

À faire une première fois, puis à chaque ajout ou modification d'un module natif :

```bash
cd apps/mobile
npx eas-cli@latest login
npx eas-cli@latest build --profile development --platform android
```

EAS fournit un lien vers un APK à installer sur le téléphone.

### Développer

```bash
cd apps/mobile
npx expo start
```

Ouvrir l'app **Link** (le dev client) sur le téléphone, connecté au même réseau que le PC.
Les modifications du code JavaScript/TypeScript s'affichent sans recompiler.
