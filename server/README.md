# Proxy des clés de catalogue (Cloudflare Worker)

Déploiement : `cd server && npx wrangler deploy`, puis un secret par variable (`npx wrangler secret put NOM`) :
`APP_TOKEN` (= `PROXY_TOKEN` de `src/shared/proxy.ts`), `IGDB_CLIENT_ID`, `IGDB_SECRET`, `TGDB_KEY`, `SGDB_KEY`.
Si Wrangler refuse le sous-domaine workers.dev (nom de dossier pris), déployer depuis un dossier au nom voulu. URL actuelle : romvault-proxy.mathc83.workers.dev (`PROXY_URL` dans `src/shared/proxy.ts`). Les clés ne sont jamais dans le dépôt.
