<?php
// Llegadas en tiempo real de la C3 en un conjunto de paradas de control.
// El navegador proyecta los metros que faltan sobre el trazado para situar cada bus.

const UPSTREAM = 'https://datos.vigo.org/vci_api_app/api2.jsp?tipo=TRANSPORTE-ESTIMACION-PARADA&id=';
const TTL = 20;
const PROBE_GAP = 2800;
const FETCH_TIMEOUT = 3;
const LINES = ['C3d', 'C3i'];

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$cacheFile = sys_get_temp_dir() . '/c3-live.json';
$lockFile = sys_get_temp_dir() . '/c3-live.lock';

function readCache(string $file): ?array
{
    if (!is_file($file)) return null;
    $data = json_decode((string) @file_get_contents($file), true);
    return is_array($data) && isset($data['at']) ? $data : null;
}

function payloadJson(array $payload): string
{
    return json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo payloadJson($payload);
    exit;
}

function sendThenContinue(array $payload, int $status = 200): void
{
    $body = payloadJson($payload);
    http_response_code($status);
    header('Content-Length: ' . strlen($body));
    echo $body;
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
        return;
    }
    ignore_user_abort(true);
    while (ob_get_level() > 0) ob_end_flush();
    flush();
}

function acquireLock($lock, int $waitMs = 0): bool
{
    $deadline = microtime(true) + $waitMs / 1000;
    do {
        if (flock($lock, LOCK_EX | LOCK_NB)) return true;
        if ($waitMs <= 0) return false;
        usleep(50000);
    } while (microtime(true) < $deadline);
    return false;
}

function probeStops(): array
{
    $pack = json_decode((string) file_get_contents(__DIR__ . '/../data/c3.json'), true);
    $patterns = array_filter($pack['patterns'], fn($p) => !$p['rare']);
    usort($patterns, fn($a, $b) => count($b['L']) <=> count($a['L']));
    $chosen = [];
    foreach ($patterns as $pattern) {
        $stops = $pattern['stops'];
        $last = null;
        foreach ($stops as $i => [$stopId, $dist]) {
            if (isset($chosen[$stopId])) {
                $last = $dist;
                continue;
            }
            $isEnd = $i === count($stops) - 1;
            if ($last !== null && $dist - $last < PROBE_GAP && !$isEnd) continue;
            if (!$pack['stops'][$stopId]['code']) continue;
            $last = $dist;
            $chosen[$stopId] = true;
        }
    }
    $probes = [];
    foreach (array_keys($chosen) as $stopId) $probes[$pack['stops'][$stopId]['code']] = $stopId;
    return $probes;
}

function fetchProbes(array $probes): array
{
    $multi = curl_multi_init();
    $http2 = defined('CURL_VERSION_HTTP2') && ((curl_version()['features'] ?? 0) & CURL_VERSION_HTTP2);
    if (defined('CURLMOPT_MAX_HOST_CONNECTIONS')) {
        curl_multi_setopt($multi, CURLMOPT_MAX_HOST_CONNECTIONS, $http2 ? 1 : 8);
    }
    if (defined('CURLMOPT_MAX_TOTAL_CONNECTIONS')) {
        curl_multi_setopt($multi, CURLMOPT_MAX_TOTAL_CONNECTIONS, $http2 ? 1 : 8);
    }

    $share = curl_share_init();
    curl_share_setopt($share, CURLSHOPT_SHARE, CURL_LOCK_DATA_DNS);
    curl_share_setopt($share, CURLSHOPT_SHARE, CURL_LOCK_DATA_SSL_SESSION);

    $handles = [];
    foreach ($probes as $code => $stopId) {
        $ch = curl_init(UPSTREAM . $code . '&ttl=5');
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => FETCH_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_USERAGENT => 'linea-c3-po/1.0',
            CURLOPT_SHARE => $share,
            CURLOPT_ENCODING => '',
            CURLOPT_TCP_NODELAY => true,
        ];
        if ($http2 && defined('CURL_HTTP_VERSION_2TLS')) {
            $opts[CURLOPT_HTTP_VERSION] = CURL_HTTP_VERSION_2TLS;
        }
        curl_setopt_array($ch, $opts);
        curl_multi_add_handle($multi, $ch);
        $handles[$code] = $ch;
    }

    $started = microtime(true);
    do {
        $status = curl_multi_exec($multi, $running);
        if (!$running) break;
        $left = FETCH_TIMEOUT - (microtime(true) - $started);
        if ($left <= 0) break;
        curl_multi_select($multi, min(0.2, $left));
    } while ($status === CURLM_OK);

    $out = [];
    foreach ($handles as $code => $ch) {
        $body = curl_multi_getcontent($ch);
        $ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200 && $body;
        curl_multi_remove_handle($multi, $ch);
        curl_close($ch);
        if (!$ok) continue;
        $json = json_decode(mb_convert_encoding($body, 'UTF-8', 'ISO-8859-1'), true);
        if (!is_array($json) || !isset($json['estimaciones'])) continue;
        $est = [];
        foreach ($json['estimaciones'] as $row) {
            if (!in_array($row['linea'] ?? '', LINES, true)) continue;
            $est[] = [
                'linea' => $row['linea'],
                'ruta' => trim((string) ($row['ruta'] ?? '')),
                'minutos' => (int) ($row['minutos'] ?? -1),
                'metros' => (int) ($row['metros'] ?? -1),
            ];
        }
        $out[] = ['stop' => $probes[$code], 'code' => (int) $code, 'est' => $est];
    }
    curl_multi_close($multi);
    curl_share_close($share);
    return $out;
}

function refresh(string $cacheFile): ?array
{
    $probes = probeStops();
    $results = fetchProbes($probes);
    if (!$results) return null;
    $payload = ['at' => time(), 'asked' => count($probes), 'probes' => $results];
    $tmp = $cacheFile . '.' . getmypid();
    file_put_contents($tmp, payloadJson($payload));
    rename($tmp, $cacheFile);
    return $payload;
}

$cached = readCache($cacheFile);
if ($cached && time() - $cached['at'] < TTL) respond($cached);

$lock = fopen($lockFile, 'c');
$got = acquireLock($lock, 0);

if ($cached) {
    $stale = $cached + ['stale' => true];
    if (!$got) respond($stale);
    sendThenContinue($stale);
    $fresh = readCache($cacheFile);
    if (!$fresh || time() - $fresh['at'] >= TTL) refresh($cacheFile);
    flock($lock, LOCK_UN);
    exit;
}

if (!$got && !acquireLock($lock, 2500)) {
    respond(['error' => 'Sin respuesta de la API de Vigo'], 503);
}

$cached = readCache($cacheFile);
if ($cached && time() - $cached['at'] < TTL) {
    flock($lock, LOCK_UN);
    respond($cached);
}

$payload = refresh($cacheFile);
flock($lock, LOCK_UN);
if ($payload) respond($payload);
if ($cached) respond($cached + ['stale' => true]);
respond(['error' => 'Sin respuesta de la API de Vigo'], 502);
