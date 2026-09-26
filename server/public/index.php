<?php
// Proxy léger RomVault : ajoute les clés IGDB / TheGamesDB / SteamGridDB côté serveur pour qu'elles ne soient jamais dans l'app.
//   POST /igdb            corps Apicalypse -> https://api.igdb.com/v4/games (jeton Twitch mis en cache)
//   GET  /tgdb/<chemin>   -> https://api.thegamesdb.net/<chemin>?apikey=...
//   GET  /sgdb/<chemin>   -> https://www.steamgriddb.com/api/v2/<chemin> (Bearer)
$cfg = require __DIR__ . '/../config.php';
$cache = __DIR__ . '/../cache';
@mkdir($cache, 0700, true);

function fail(int $code, string $msg): never { http_response_code($code); header('Content-Type: text/plain'); echo $msg; exit; }

if (($_SERVER['HTTP_X_RV_TOKEN'] ?? '') !== $cfg['app_token']) fail(403, 'forbidden');

// Limite par IP et par minute (fichier compteur, sans dépendance).
$rf = $cache . '/rate-' . md5($_SERVER['REMOTE_ADDR'] ?? '') . '-' . intdiv(time(), 60);
$n = (int)@file_get_contents($rf) + 1;
@file_put_contents($rf, (string)$n, LOCK_EX);
if ($n > $cfg['rate_per_minute']) fail(429, 'rate limited');
if (mt_rand(1, 200) === 1) foreach (glob($cache . '/rate-*') ?: [] as $f) if (filemtime($f) < time() - 120) @unlink($f);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!preg_match('#^/(igdb|tgdb|sgdb)(/[A-Za-z0-9_./-]*)?$#', $path, $m) || str_contains($path, '..')) fail(404, 'not found');
$svc = $m[1];
$sub = $m[2] ?? '';

function call(string $url, array $headers, ?string $body = null): void {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_HTTPHEADER => $headers, CURLOPT_FOLLOWLOCATION => false]);
    if ($body !== null) { curl_setopt($ch, CURLOPT_POST, true); curl_setopt($ch, CURLOPT_POSTFIELDS, $body); }
    $out = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if ($out === false) fail(502, 'upstream error');
    http_response_code($code ?: 502);
    header('Content-Type: ' . (curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/json'));
    echo $out; exit;
}

if ($svc === 'igdb') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST' || $sub !== '') fail(405, 'POST /igdb');
    $tf = $cache . '/igdb-token.json';
    $tok = is_file($tf) ? json_decode((string)file_get_contents($tf), true) : null;
    if (!$tok || $tok['expires'] < time() + 60) {
        $ch = curl_init('https://id.twitch.tv/oauth2/token?client_id=' . urlencode($cfg['igdb_client_id']) . '&client_secret=' . urlencode($cfg['igdb_secret']) . '&grant_type=client_credentials');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_TIMEOUT => 20]);
        $j = json_decode((string)curl_exec($ch), true);
        if (empty($j['access_token'])) fail(502, 'twitch auth failed');
        $tok = ['value' => $j['access_token'], 'expires' => time() + (int)$j['expires_in']];
        file_put_contents($tf, json_encode($tok), LOCK_EX);
    }
    call('https://api.igdb.com/v4/games', ['Client-ID: ' . $cfg['igdb_client_id'], 'Authorization: Bearer ' . $tok['value']], file_get_contents('php://input'));
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') fail(405, 'GET only');
$qs = $_GET; unset($qs['apikey']);
if ($svc === 'tgdb') {
    $qs['apikey'] = $cfg['tgdb_key'];
    call('https://api.thegamesdb.net' . $sub . '?' . http_build_query($qs), []);
}
$q = $qs ? '?' . http_build_query($qs) : '';
call('https://www.steamgriddb.com/api/v2' . $sub . $q, ['Authorization: Bearer ' . $cfg['sgdb_key']]);
