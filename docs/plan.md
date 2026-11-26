# Link — plan de réalisation

Document de suivi : ce qui est fait, ce qui vient, et les décisions prises en chemin.
La conception détaillée est dans [`specs/`](specs/) ; les comptes rendus des tests techniques dans [`spikes/`](spikes/).

## Vue d'ensemble

| Phase | Contenu | État |
|---|---|---|
| 0 | Tests techniques : synchro directe entre téléphones (A), sécurité et performances (B) | ✅ Fait |
| 1 | Cœur métier `packages/core` : toutes les règles de gestion, testées sur ordinateur | ✅ Fait (252 tests) |
| **2** | **Application du boss seul : écrans, base chiffrée, utilisable dans un vrai commerce** | **En cours** |
| 3 | Comptes employés, appairage par QR code, synchronisation locale chiffrée, modes conservation / disparition, copie de secours, révocation | À venir |
| 4 | Sauvegarde (fichier local, Drive, iCloud) et restauration avec récupération des copies des employés | À venir |
| 5 | Serveur relais (complément facultatif) | À venir |
| 6 | Logo et photos, anglais, exports, notifications push, finitions, publication | À venir |

Fin de phase 2 : confier l'application à un vrai commerce (pilote) pendant la phase 3.

## Méthode

- Une branche par phase (ex. `phase-2/application-boss`), fusionnée dans `main` à la fin de la phase.
- La documentation va directement sur `main`.
- La CI (tests et typage) tourne à chaque push, sur toutes les branches.
- Le cœur métier garde des tests automatiques ; pour les écrans : typage et liste de vérifications sur téléphone à chaque étape.

## Phase 1 — cœur métier (terminée)

| Étape | Contenu |
|---|---|
| 1.1 | Fondations : accès à la base, schéma v1, migrations, UUID v7, compteur de synchro `seq`, CI |
| 1.2 | Entreprise et comptes, connexion hors ligne (un téléphone = un utilisateur) |
| 1.3 | Exercices : ouverture, clôture, « clôturer et ouvrir », lecture seule des exercices clos |
| 1.4 | Catalogue, prix d'achat (boss seulement), modes de paiement, clients |
| 1.5 | Ventes : création, prix négocié, ajustement, finalisation chez le boss, corrections, annulation |
| 1.6 | Stock calculé à partir des mouvements datés, alertes |
| 1.7 | Dépenses |
| 1.8 | Mode rafale |
| 1.9 | Indicateurs du tableau de bord |
| 1.10 | Journal d'audit |

## Phase 2 — application du boss seul

### Principes

- **Interface complète dès maintenant** : tout ce que montre la maquette est construit. Ce qui dépend d'une phase future est affiché avec une mention « Bientôt disponible » (implémentation à venir), jamais masqué.
- **Maquette** (`maquettes/stitch_link_mobile_app.zip`) : repère visuel, pas une spécification. Couleurs, police Plus Jakarta Sans, cartes arrondies, boutons en pilule, puces de filtre.
- **Navigation à 3 onglets** : Dashboard · Activités · Paramètres, avec un en-tête « LINK · TPE », le nom de l'entreprise, une cloche (alertes) et un avatar (profil).
- **Thème** : palettes claire et sombre (Material 3) générées à partir d'une couleur d'accentuation.
  - 4 préréglages : Orange `#FC6018`, Caramel `#8B3A0F`, Atelier Noir `#33302D`, Ambre `#8A3C00`, plus une couleur personnalisée (grille de couleurs et code `#RRGGBB`).
  - Mode d'affichage Clair / Sombre / Auto.
  - La couleur d'accentuation est un réglage de l'entreprise (diffusé aux employés en phase 3) ; le mode d'affichage est propre à chaque téléphone.
- **« + Vente » et « + Service »** sont deux entrées distinctes : la première présente d'abord les produits, la seconde d'abord les services. Chacune propose un lien pour ajouter l'autre type, dans la même opération. Le mode rafale est accessible depuis les deux, et ses modèles peuvent mélanger produits et services.

### Choix techniques

Expo Router (navigation), TanStack Query (données à l'écran), `StyleSheet` avec les jetons de la maquette (pas de bibliothèque de style), `@expo/vector-icons`, i18next (français d'abord), `@material/material-color-utilities` (génération des palettes), op-sqlite + SQLCipher, libsodium (Argon2id), coffre sécurisé du téléphone pour la clé de la base. Un seul nouveau build EAS en début de phase.

### Étapes

| # | Étape | Contenu |
|---|---|---|
| 2.1 | Socle technique | Suppression des écrans de test, navigation 3 onglets et en-tête, cœur métier branché sur la vraie base, moteur de thème, police, composants de base, montants en FCFA, messages d'erreur en français, build EAS |
| 2.2 | Premier lancement et connexion | Création de l'entreprise et du compte boss, connexion, changement de mot de passe, premier exercice guidé |
| 2.3 | Catalogue (Activités) | Produits, services, catégories, prix d'achat, favoris, archivage ; modes de paiement ; clients |
| 2.4 | Saisie : « + Vente » et « + Service » | Favoris, recherche, panier mixte, prix négociable, ajustement du total, client, mode de paiement, note |
| 2.5 | Historique et corrections | Liste filtrable, détail, correction avec motif, annulation |
| 2.6 | Mode rafale | Modèles mixtes, gros bouton, compteur, « annuler la dernière vente », client facultatif |
| 2.7 | Stock et alertes | Activation, entrées, pertes, comptages, mouvements, valeur du stock ; écran des alertes (cloche), « Réapprovisionner » |
| 2.8 | Dépenses et exercices | Dépenses (Activités) ; exercices dans Paramètres (en cours, « Clôturer et ouvrir », historique) |
| 2.9 | Dashboard | Périodes, carte du chiffre d'affaires, actions rapides, synchroniser, alertes, meilleurs articles, activité récente, bénéfice indicatif |
| 2.10 | Paramètres et pilote | Entreprise, couleur d'accentuation et mode d'affichage (aperçu immédiat), mot de passe, journal d'audit, APK de démonstration |

### Affiché mais pas encore actif (« Bientôt disponible »)

| Élément | Activation prévue |
|---|---|
| Bouton Synchroniser (Dashboard) | Phase 3 |
| Raccourci Employés (Activités) | Phase 3 |
| Réglage « Suppression après synchronisation » | Phase 3 |
| Interrupteur « Notifications push » (le choix est mémorisé ; les alertes restent sous la cloche) | Plus tard, à décider |
| Sauvegarde, export, langue anglaise, support | Phases 4 et 6 |
| Logo de l'entreprise, photos des produits (emplacement avec l'initiale) | Phase 6 |

### Écarts assumés avec la maquette

- Montants en FCFA (pas d'euros).
- Pas de devis, d'interventions, de plannings ni de commissions, ni d'export FEC : hors conception.
- Ajouts absents de la maquette, dans Activités : historique des ventes, dépenses, clients, modes de paiement, modèles de rafale.
- « Valeur du stock » (stock × prix d'achat) ajoutée, sans variation mensuelle.
