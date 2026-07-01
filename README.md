# Site Microservices Polyglotte (3 services)

Ce projet contient exactement 3 microservices avec des langages differents:

- user-service: Python + FastAPI (port 8001)
- product-service: Go + Gin (port 8002)
- order-service: Node.js + Express (port 8003)

Un 4e conteneur "site" (Nginx) sert l interface web sur le port 8080 et proxy les appels vers les 3 APIs.

## Lancer tout ensemble

```bash
docker compose build --no-cache
docker compose up -d
```

## Ouvrir le site

- http://localhost:8080

Depuis cette page, tu peux:

- Creer/lister des users
- Creer/lister des produits
- Creer/lister des commandes

## Test API direct

```bash
curl http://localhost:8001/health
curl http://localhost:8002/health
curl http://localhost:8003/health
```
