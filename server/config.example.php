<?php
// Copier en config.php (jamais versionné) et renseigner les clés. Ce fichier vit hors de public/.
return [
    'app_token'       => 'rv-app-token',   // même valeur que PROXY_TOKEN dans src/shared/proxy.ts (filtre anti-curieux, pas un secret)
    'igdb_client_id'  => '',
    'igdb_secret'     => '',
    'tgdb_key'        => '',
    'sgdb_key'        => '',
    'rate_per_minute' => 600,              // requêtes par IP et par minute
];
