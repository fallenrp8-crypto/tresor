# 🏴‍☠️ Chasse au trésor GPS

Jeu multijoueur sur une vraie carte : les **trésors** se cachent, les **chercheurs** les traquent, et une **zone** se resserre au fil du temps.

## Lancer en local

Il faut seulement **Node.js 18+**, sans `npm install` (aucune dépendance).

```bash
node server.js
```

Ensuite, ouvre :
- `http://localhost:3000` pour le jeu normal (GPS),
- `http://localhost:3000/?sim=1` pour le **mode test sans GPS** : touche la carte pour déplacer ton joueur. Ouvre plusieurs onglets (ou une fenêtre privée) pour simuler plusieurs joueurs.

## ⚠️ HTTPS obligatoire

Sur téléphone, le GPS du navigateur **ne fonctionne qu'en HTTPS**. Pour jouer dehors, héberge le site chez un service qui fournit le HTTPS :

| Hébergeur | Comment faire |
|---|---|
| **Render** (gratuit) | New → Web Service → relie ton dépôt GitHub → Start command : `node server.js`. HTTPS automatique. |
| **Railway / Fly.io** | Même principe : la commande de démarrage est `node server.js`, et le port est lu dans `PORT`. |
| **VPS / Raspberry Pi** | `node server.js` derrière **Caddy** (HTTPS automatique), voir ci-dessous. |

Caddyfile minimal pour un VPS :
```
mon-domaine.fr {
    reverse_proxy localhost:3000
}
```

Les parties sont gardées en mémoire : un redémarrage du serveur les efface. Il faut aussi **une seule instance** du serveur, sans répartition de charge sur plusieurs machines.
Sur Render gratuit, le serveur s'endort après 15 min d'inactivité : ouvre le site une minute avant de jouer.

## Règles

1. **Salon** : l'hôte choisit **4 trésors** (réglable), et tous les autres joueurs sont chercheurs. Au salon, chacun ne voit que sa propre position.
2. **Phase de cache (10 min)** : les trésors partent se cacher pendant que les chercheurs attendent au point de départ. Les trésors voient déjà les chercheurs, et personne ne peut capturer.
3. **Chasse (2 h)** : chaque trésor reçoit **sa propre zone de 3 km**, créée autour de sa cachette et **jamais centrée sur lui** (il est toujours entre 30 % et 80 % du rayon depuis le centre). **Toutes les 20 min**, les zones rétrécissent : 3 km → 1,6 km → 905 m → 497 m → 273 m → 150 m. Chaque nouvelle zone est recalculée autour du trésor.
   - Les **trésors** voient les chercheurs en temps réel. Ils doivent rester dans leur zone (sinon ils sont révélés au bout de 30 s) et garder leur GPS allumé (sinon ils sont révélés à leur dernière position au bout de 90 s).
   - Les **chercheurs** ne voient que les zones (📍 = « je suis dans cette zone »), sans aucun indice chaud/froid. Ils capturent à moins de 20 m, avec une petite tolérance selon la précision du GPS. **Un essai raté coûte 10 s**, pour que le bouton ne serve pas de détecteur.
4. **Fin** : les chercheurs gagnent s'ils capturent les 4 trésors, et les trésors gagnent s'il en reste un à la fin du chrono. L'écran de fin affiche les récompenses (meilleur chasseur, marathonien), le temps de survie et la distance parcourue par chacun.

Tous les réglages se modifient par l'hôte dans le salon. Des sons et des vibrations accompagnent les rétrécissements, les captures et les révélations, avec un compte à rebours sur les 10 dernières secondes. On peut couper les sons dans 📜.

## Conseils pour jouer

- **Garder l'écran allumé** : l'appli l'empêche de se mettre en veille. Si un trésor verrouille son téléphone, le GPS s'arrête et il finit par être révélé.
- Prévoir une batterie externe pour une partie de 2 h.
- Sur Render gratuit, ouvrir le site une minute avant de jouer pour le réveiller.

## Ce qui est optimisé

- **Anti-triche** : le serveur décide de tout. Un chercheur ne reçoit jamais la position d'un trésor tant que celui-ci est caché dans sa zone avec le GPS actif.
- **Réseau léger** : la position n'est envoyée que si le joueur a bougé de plus de 4 m (au maximum toutes les 1,5 s). Le serveur ne renvoie une vue que si elle a changé.
- **Robuste sur mobile** : reconnexion automatique après une mise en veille ou une coupure réseau, et un rechargement de page ne fait pas perdre sa partie. Le compteur de distance ignore le bruit et les sauts du GPS.

## Structure

```
server.js          serveur HTTP + temps réel (SSE) + logique de jeu
public/index.html  interface
public/app.js      carte Leaflet, GPS, affichage
public/style.css   style
```

Carte : © OpenStreetMap (gratuit pour un usage modéré).
