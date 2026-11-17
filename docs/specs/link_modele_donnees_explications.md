# Link : guide du modèle de données (v1.2)

Ce fichier explique chaque table du diagramme `link_modele_donnees.mermaid` et ses attributs clés. Les tables sont groupées par thème.

**Repères**
- Toutes les tables portent `company_id` (l'entreprise) et un identifiant UUID.
- Tous les montants sont en **FCFA, en nombres entiers** (pas de virgule). Les quantités sont entières aussi.
- 🔒 = table présente **uniquement sur le téléphone du boss** (jamais envoyée aux employés).
- 📱 = table **locale à chaque appareil**, jamais transférée.
- Les autres tables sont synchronisées (les employés ne reçoivent que ce qui les concerne).
- `seq` : compteur de modification attribué par le boss sur chaque table partagée. Voir [§ 8](#8-synchronisation-audit-sauvegarde-et-alertes).

---

## 1. Entreprise, comptes et appareils

### COMPANY
L'entreprise. Une seule par installation pour l'instant.
- `name`, `logo`, `primary_color`, `secondary_color` : l'apparence, diffusée aux employés.
- `currency` : **XOF (FCFA)**, fixe pour l'instant.
- `history_retention_mode` : **KEEP** (l'employé garde ses propres opérations après synchronisation) ou **DISAPPEAR** (tout disparaît après synchronisation). Réglage unique pour tous les employés.
- `backup_copy_retention_days` : durée pendant laquelle chaque téléphone d'employé garde la copie de secours chiffrée (30 jours par défaut).
- `boss_public_key` : clé publique du boss, transmise à l'appairage. Elle sert à chiffrer la copie de secours, que seul le boss peut lire.
- `settings_updated_at` : date de dernière modification des réglages.
- `stock_enabled` : le suivi de stock est-il actif globalement ?

### USER
Un compte (boss ou employé). Jamais supprimé, seulement désactivé.
- `role` : **BOSS** ou **EMPLOYEE**.
- `login` : identifiant, unique dans l'entreprise.
- `password_hash` : mot de passe haché avec **Argon2id**. Il est présent sur les appareils pour permettre la connexion hors ligne, d'où un algorithme lent.
- `must_change_password` : vrai avec un mot de passe provisoire. Bloque l'accès tant que le mot de passe n'est pas changé.
- `is_active` : faux = compte désactivé (l'historique reste). Désactiver un compte révoque tous ses appareils.
- Un utilisateur peut avoir plusieurs appareils. Le compte **BOSS** n'est utilisable que sur le téléphone du boss.
- Profil ou mot de passe modifié sur un appareil : la modification passe par le boss avant d'atteindre les autres appareils de l'utilisateur. Si deux appareils l'ont modifié, la dernière version reçue par le boss l'emporte.

### DEVICE
Un téléphone appairé à l'entreprise par QR code. **Un appareil appartient à un seul utilisateur** : pas de téléphone partagé entre employés.
- `user_id` : le propriétaire, choisi par le boss au moment de l'appairage. C'est le seul compte qui peut se connecter sur l'appareil, et le seul que l'appareil reçoit : aucun appareil ne contient les identifiants d'un autre employé.
- `paired_at` : date d'appairage, début de l'historique conservé sur cet appareil.
- `last_login_at` : dernière connexion du propriétaire sur cet appareil.
- Pour changer de propriétaire, l'appareil est révoqué puis ré-appairé.
- `public_key` : clé publique de l'appareil, utilisée pour chiffrer ce que le boss lui dépose sur le relais.
- `status` : **ACTIVE** ou **REVOKED**.
- `wipe_pending` : l'appareil doit effacer **toutes** ses données locales, copie de secours comprise, à sa prochaine synchronisation (téléphone perdu, employé parti). `wipe_confirmed_at` indique que c'est fait.
- `last_sync_at` : dernière synchronisation de cet appareil. Affichée au boss avant une clôture d'exercice.

---

## 2. Exercices

### FISCAL_YEAR (exercice)
Période d'activité, créée et clôturée manuellement par le boss.
- `name`, `description` : nom (ex. « Exercice 2026 ») et description facultative.
- `status` : **OPEN** ou **CLOSED**. Un seul exercice ouvert à la fois.
- `opened_at`, `closed_at`, `closed_by` : ouverture, clôture et auteur de la clôture.
- Un exercice clos est **strictement en lecture seule** : il ne reçoit plus aucune opération.
- **Rattachement :** une vente reçue par le boss rejoint l'exercice **ouvert au moment de la réception**. Une vente ou une dépense saisie par le boss rejoint l'exercice ouvert au moment de la saisie. La date de l'opération ne compte pas.
- Sans exercice ouvert, le boss ne peut ni vendre, ni saisir de dépense, ni accepter une synchronisation.
- Les employés reçoivent uniquement le nom et l'état des exercices, pour ranger leur propre historique en mode KEEP. Le contenu complet des exercices clos reste chez le boss.
- Le catalogue, les comptes, les clients, les paramètres et le stock ne dépendent pas des exercices.

---

## 3. Catalogue et stock

### CATEGORY
Classement des produits et services.
- `applies_to` : **PRODUCT**, **SERVICE** ou **BOTH**.

### ITEM
Un article du catalogue : produit **ou** service.
- `type` : **PRODUCT** ou **SERVICE**.
- `reference_price` : prix de vente de référence, pré-rempli à la saisie mais modifiable.
- `is_archived` : l'article disparaît de la saisie mais reste dans l'historique.
- `is_favorite` : accès direct dans la saisie rapide.
- `internal_ref` (produits) et `duration_minutes` (services) : champs propres à chaque type.
- `is_stock_tracked` : le stock est-il suivi pour ce produit ? (toujours faux pour un service)
- `stock_quantity` : quantité en stock. **Chez le boss, c'est une valeur en cache**, recalculée à partir de `STOCK_MOVEMENT` à chaque nouveau mouvement. Elle est envoyée aux employés, qui ne la modifient jamais. Peut devenir négative : la vente n'est jamais bloquée.
- `stock_alert_threshold` : seuil de l'alerte de stock bas. Utilisé par le boss seulement, non envoyé aux employés : **les alertes de stock ne vont qu'au boss**.
- **Stock affiché chez l'employé** = `stock_quantity` reçue du boss − quantités des ventes saisies sur cet appareil et non encore confirmées (`SALE.synced_at` vide). C'est un calcul à l'affichage, pas une modification.

### ITEM_COST 🔒
Le prix d'achat d'un produit, séparé d'`ITEM` pour ne jamais partir chez les employés.
- `purchase_price` : prix d'achat actuel (facultatif, une seule valeur par produit).
- Pas de ligne pour les services.

### STOCK_MOVEMENT 🔒
Chaque événement qui fait varier le stock d'un produit, daté. **C'est la source de vérité du stock.**
- `type` :
  - **SALE** : une vente (`quantity_delta` négatif). Créé par le boss à la réception de la vente, ou à sa saisie s'il vend lui-même.
  - **SALE_CORRECTION** : correction ou annulation d'une vente (mouvement inverse ou différence).
  - **ENTRY** : entrée de marchandise (positif).
  - **LOSS** : perte, casse, vol (négatif).
  - **INVENTORY** : comptage physique. `counted_quantity` fixe la quantité à l'heure `occurred_at`. La quantité de départ, à l'activation du stock d'un produit, est un INVENTORY.
- `occurred_at` : heure réelle de l'événement (pour une vente, l'heure de l'appareil de l'employé). C'est elle qui compte dans le calcul, pas l'heure d'arrivée.
- `sale_line_id` : la ligne de vente à l'origine du mouvement, s'il y en a une. Garantit qu'une même vente reçue deux fois (renvoi, copie de secours) ne crée pas deux mouvements.
- `user_id`, `reason` : qui a saisi le mouvement et pourquoi. Les mouvements saisis à la main sont aussi tracés dans `AUDIT_LOG`.

**Calcul :** stock = `counted_quantity` du dernier INVENTORY (selon `occurred_at`) + somme des `quantity_delta` dont `occurred_at` est postérieur à cet inventaire.

**Pourquoi :** une vente faite hors ligne avant un comptage, mais reçue après, est déjà incluse dans le comptage : la règle ne la retire pas une seconde fois. Le résultat ne dépend pas de l'ordre de synchronisation.

**Limite :** le calcul s'appuie sur l'heure des appareils. Avant un comptage, l'application conseille au boss de synchroniser tous les employés.

---

## 4. Clients et paiement

### CUSTOMER
Un client, toujours facultatif. Une vente sans `customer_id` est une vente à un client anonyme.
- `name`, `phone`.
- Peut être créé rapidement depuis la saisie, y compris en mode rafale.
- Deux employés hors ligne peuvent créer le même client : la fusion des doublons est **reportée** à une version ultérieure.

### PAYMENT_METHOD
Liste des modes de paiement définie par le boss (espèces, mobile money, carte…).
- `name`, `is_active`.
- Une vente n'a qu'un seul mode de paiement (paiement fractionné reporté).

---

## 5. Ventes (le cœur du modèle)

### SALE
Une opération de vente ou de service, indépendante des autres.
- `fiscal_year_id` : exercice **attribué par le boss à la réception** (l'exercice ouvert à ce moment). Il est vide sur le téléphone de l'employé tant que la vente n'a pas été reçue. En mode KEEP, le boss renvoie la vente avec son exercice.
- `customer_id` : le client, **facultatif**. Il est choisi à la saisie (y compris à chaque clic en rafale) ou ajouté après coup. Vide = client anonyme.
- `employee_id` : l'employé **à qui la vente est attribuée** (le boss si le champ était vide).
- `entered_by_id` : la personne **qui a saisi** la vente. Différent de `employee_id` quand le boss saisit pour un employé.
- `occurred_at` : heure de l'appareil au moment de la saisie. Sert à l'historique, aux statistiques par période et au calcul du stock, **pas** au choix de l'exercice.
- `reference_total`, `adjustment`, `total_amount` : total de référence, ajustement global et total réellement encaissé.
- `entry_mode` : **MANUAL** ou **BURST** (créée en mode rafale).
- `status` : **ACTIVE** ou **CANCELLED**. Une annulation exige un `cancel_reason` et n'efface jamais la vente.
- `synced_at` : rempli à l'accusé de réception du boss. **Vide = en attente** : l'employé peut encore corriger. **Rempli** : l'employé ne peut plus rien modifier, seul le boss le peut.
- `version` : augmente à chaque correction. Avec l'`id`, permet au boss d'ignorer ce qu'il a déjà reçu.

### SALE_LINE
Une ligne d'une vente (un article, une quantité, un prix).
- `item_name`, `item_type`, `reference_price` : **copies figées** au moment de la vente, pour que l'historique ne change pas si le catalogue est modifié.
- `unit_price` : prix réellement pratiqué (plus ou moins que la référence).
- `price_gap` : écart total, c'est-à-dire la remise ou la majoration, utilisé pour les statistiques.
- `unit_cost` 🔒 : coût d'achat fixé par le **boss à la réception** de la vente, avec le prix d'achat en vigueur à ce moment. Jamais visible d'un employé. Zéro si le produit n'a pas de prix d'achat.

### Ce que voit l'employé
L'employé ne voit **jamais que ce qu'il a fait lui-même**.
- Avant synchronisation : toutes ses ventes en attente.
- Mode **KEEP** : sur chaque appareil, les ventes saisies sur cet appareil depuis son appairage, plus celles saisies par le boss à son nom, rangées par exercice, en lecture seule une fois synchronisées, avec les corrections du boss et les ventes saisies par le boss à son nom.
- Mode **DISAPPEAR** : après l'accusé du boss, `SALE` et `SALE_LINE` sont supprimées de son téléphone, **absolument tout**. Il ne reste que son `SYNC_LOG` et la copie chiffrée dans `CHANGE_LOG`, qu'il ne peut ni lire ni voir.

---

## 6. Mode rafale

### BURST_TEMPLATE 📱
Le modèle de rafale d'un utilisateur : ce qu'un clic enregistre.
- `user_id`, `name`.
- `payment_method_id` : mode de paiement par défaut.

### BURST_TEMPLATE_LINE 📱
Les articles du modèle.
- `item_id`, `quantity`, `unit_price` (prix de référence par défaut, modifiable).

> Chaque clic crée une vraie `SALE` (avec ses `SALE_LINE`) à partir du modèle. Les ventes d'une rafale ne sont pas liées entre elles.
>
> **Client en rafale :** le modèle ne contient pas de client, car chaque vente a en général un client différent. Avant ou après un clic, l'utilisateur peut désigner le client : il est alors écrit dans `SALE.customer_id` de la vente créée. Sans choix, la vente reste anonyme.

---

## 7. Dépenses

### EXPENSE 🔒
Une dépense de l'entreprise (loyer, électricité, chaise cassée…), saisie par le boss.
- `name`, `description`, `amount`, `expense_date` (aujourd'hui par défaut, informative).
- `fiscal_year_id` : exercice **ouvert au moment de la saisie**.
- `status` : **ACTIVE** ou **CANCELLED** (avec `cancel_reason`). Modifiable et annulable par le boss, avec trace dans l'audit.

---

## 8. Synchronisation, audit, sauvegarde et alertes

La synchronisation est **toujours lancée à la main**, au premier plan. Canal principal : le réseau local (Wi-Fi ou partage de connexion du boss), session ouverte par un QR code affiché chez le boss (adresse, port, jeton à usage unique). Le relais est un complément facultatif.

### Employés → boss : CHANGE_LOG 📱
Journal des changements à envoyer au boss, en ajout seul. Utilisé sur les téléphones des employés.
- `entity_type`, `entity_id` : ce qui a changé (une vente, un client, un profil…).
- `operation` : **INSERT**, **UPDATE** ou **CANCEL**.
- `version`, `payload` : le contenu, **chiffré avec la clé publique du boss**. L'employé ne peut pas le relire.
- `acked_at` : écrit **seulement pour les éléments que le boss a confirmés**. Vide = à renvoyer à la prochaine synchronisation.
- Pas d'état « en cours » enregistré en base : si la synchro coupe ou si l'application plante, tout ce qui n'a pas de `acked_at` est simplement renvoyé, et le boss ignore ce qu'il a déjà (même `entity_id` et même `version`).
- `purge_after` : après l'accusé, la ligne est gardée jusqu'à `acked_at + backup_copy_retention_days`. C'est la **copie de secours** : si le boss perd son téléphone et restaure une sauvegarde, les employés lui renvoient ces lignes à la synchronisation suivante, et il récupère ce qu'il avait reçu après sa sauvegarde.

### Boss → employés : `seq` et SYNC_STATE 📱
- Chez le boss, chaque modification d'une ligne partagée lui donne un nouveau `seq`, pris dans un compteur qui ne fait qu'augmenter.
- `SYNC_STATE.last_seq` : chez le boss, la dernière valeur attribuée ; chez l'employé, le dernier `seq` reçu.
- À la synchronisation, l'employé annonce son `last_seq`. Le boss renvoie toutes les lignes avec un `seq` supérieur, filtrées selon les droits de l'employé, puis la nouvelle valeur. L'employé l'enregistre **dans la même transaction** que les données reçues.
- Le boss n'a donc rien à retenir par employé.
- **Nouvel appareil** : copie complète, puis `last_seq` courant.
- **Boss restauré depuis une sauvegarde** : si un employé annonce un `last_seq` supérieur à celui du boss, il reçoit une copie complète.

### SYNC_LOG 📱
Journal des synchronisations, **tenu sur chaque appareil**. Un employé voit ses propres synchronisations (date, nombre d'éléments, résultat). Le boss voit dans son propre journal celles de tous les employés.
- `user_id` : l'utilisateur concerné.
- `channel` : **LAN** (réseau local) ou **RELAY** (serveur relais).
- `items_sent`, `items_received`, `result` (**SUCCESS**, **PARTIAL**, **FAILED**).

### AUDIT_LOG 🔒
Qui a fait quoi et quand.
- `actor_id` : qui a agi.
- `on_behalf_of_id` : pour le compte de qui (ex. l'employé d'une vente saisie par le boss).
- `action` : `SALE_CREATE`, `SALE_EDIT`, `SALE_CANCEL`, `STOCK_ENTRY`, `STOCK_LOSS`, `STOCK_INVENTORY`, `EXPENSE_CREATE`, `YEAR_CLOSE`, `YEAR_OPEN`…
- `entity_type`, `entity_id`, `reason`.
- `before_json`, `after_json` : état avant et après.

### BACKUP 🔒
Historique des sauvegardes chiffrées du boss.
- `destination` : **GOOGLE_DRIVE**, **ICLOUD** ou **LOCAL_FILE**.
- `is_automatic`, `status`, `created_at`.
- Le fichier de sauvegarde contient aussi la **clé privée du boss**, chiffrée. Sans elle, la copie de secours des employés serait illisible après une restauration.
- La clé de récupération n'est **jamais** stockée dans la base.

### ALERT 🔒
Alertes affichées au boss.
- `type` : **LOW_STOCK**, **NEGATIVE_STOCK**, **STALE_SYNC** (employé qui ne synchronise plus), **CANCELLED_SALE**.
- `entity_type`, `entity_id` : élément concerné.
- `read_at` : vide = pas encore lue.

---

## Règles à retenir (non exprimables dans le diagramme)

- Un seul exercice **OPEN** par entreprise.
- Chez le boss, aucune vente ni dépense sans exercice, et aucune synchronisation sans exercice ouvert.
- Une vente reçue rejoint l'exercice ouvert **à la réception**. Un exercice clos est strictement en lecture seule.
- `USER.login` unique par entreprise.
- Un appareil = un seul utilisateur. Un utilisateur peut avoir plusieurs appareils, qui ne se synchronisent jamais entre eux. Le compte boss reste sur le téléphone du boss.
- Montants et quantités en entiers (FCFA).
- Le prix d'achat (`ITEM_COST`, `SALE_LINE.unit_cost`) et les mouvements de stock (`STOCK_MOVEMENT`) ne quittent jamais le téléphone du boss.
- Les employés voient le stock (`ITEM.stock_quantity`) mais seul le boss le modifie, par des mouvements, et reçoit les alertes de stock.
- Un employé ne voit que ses propres opérations ; en mode DISAPPEAR, plus rien après l'accusé du boss.
- Le bénéfice se calcule ainsi : **somme des `total_amount` des ventes actives − somme des `unit_cost × quantity` − somme des dépenses actives**, sur l'exercice courant.

---

## Mis de côté pour l'instant

**Reportés :** fusion des clients en double ; autres devises et montants à virgule ; quantités décimales (vente au poids, au mètre) ; paiement fractionné.

**Écartés volontairement :** synchronisation automatique ou en arrière-plan ; découverte automatique des appareils sur le réseau (remplacée par le QR code de session) ; relais comme canal principal ; rattachement d'une vente à l'exercice de sa date (et ventes « tardives » dans un exercice clos) ; stock modifié directement par une quantité ; téléphone partagé entre plusieurs employés ; connexion du boss sur un autre appareil que le sien.
