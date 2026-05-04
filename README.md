# Backend paiements

Ce backend remplace la logique actuelle `paypal.me` par un flux serveur propre :

- creation de commande cote serveur
- recalcul du total depuis le catalogue
- creation de l'ordre PayPal via l'API Orders v2
- capture du paiement cote serveur
- retour vers le site
- generation de facture HTML
- envoi des emails client/vendeur apres paiement
- traitement des webhooks PayPal

## Lancer le backend

Le backend n'a pas de dependances npm externes. Il necessite seulement Node 18+.

```bash
node ./backend/src/server.mjs
```

Ou depuis le dossier `backend` :

```bash
node ./src/server.mjs
```

## Variables d'environnement

Copier `backend/.env.example` vers `backend/.env` et renseigner au minimum :

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`
- `SITE_BASE_URL`
- `APP_BASE_URL`
- `SELLER_EMAIL`
- `CATALOG_SOURCE_URL`

Pour les emails :

- `EMAIL_MODE=log` : aucun envoi reel, les emails sont journalises
- `EMAIL_PROVIDER=resend` : envoi reel via l'API Resend si `RESEND_API_KEY` est defini

## Mise a jour automatique du stock CSV

Le backend peut marquer automatiquement un article comme `indisponible` apres paiement confirme.

Pour cela :

- `CATALOG_SOURCE_URL` reste la source lue par le backend
- `CATALOG_WRITE_FILE` doit pointer vers un fichier CSV local modifiable

Exemple de test local :

```bash
CATALOG_SOURCE_URL=http://127.0.0.1:5500/assets/data/products.csv
CATALOG_WRITE_FILE=../assets/data/products.csv
```

Important :

- si `CATALOG_SOURCE_URL` pointe vers un Google Sheets publie en CSV, le backend ne peut pas le reecrire directement
- dans ce cas, la mise a jour automatique ne sera visible sur le site que si le front lit le meme fichier CSV local, ou plus tard si on connecte une vraie ecriture Google Sheets ou une base de donnees

## Protection anti double-vente

Meme si le catalogue principal reste gere dans un CSV ou un Google Sheet publie :

- le backend conserve les commandes payees dans `backend/data/orders.json`
- l'endpoint `GET /api/catalog/availability` expose la liste des articles deja vendus
- le front fusionne cette liste avec le CSV et force ces articles en `indisponible`
- le backend refuse aussi la creation d'une nouvelle commande si un article a deja ete paye
- si la colonne `reactiver` vaut `oui` dans le CSV, l'article est retire de cette liste et peut etre remis en vente

Cela permet de continuer a gerer la boutique via CSV tout en empechant qu'un article unique soit achete une seconde fois.

## Endpoints principaux

- `GET /api/health`
- `POST /api/checkout/paypal/order`
- `POST /api/checkout/paypal/order/:paypalOrderId/capture`
- `POST /api/paypal/webhooks`
- `GET /api/orders/:orderNumber`
- `GET /payment/success`
- `GET /payment/cancel`

## Integration front recommandee

Le front ne doit plus construire l'URL de paiement lui-meme.

Flux recommande :

1. le panier envoie `cart + customer` a `POST /api/checkout/paypal/order`
2. le backend cree l'ordre PayPal
3. le front ouvre PayPal :
   - soit avec le bouton PayPal JS SDK
   - soit avec `approvalUrl` en redirection de secours
4. apres approbation, le front appelle `POST /api/checkout/paypal/order/:paypalOrderId/capture`
5. le backend marque la commande payee, genere la facture, envoie les emails et met le produit en `indisponible` si `CATALOG_WRITE_FILE` est configure
6. le webhook PayPal securise la synchronisation finale

## Stockage

Les commandes sont conservees dans `backend/data/orders.json`.

Pour une vraie mise en production long terme, remplace ce stockage fichier par une base SQL. La structure metier a deja ete isolee pour faciliter ce remplacement.
