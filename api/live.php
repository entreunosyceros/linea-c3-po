<?php
// Llegadas en tiempo real de la C3 en un conjunto de paradas de control.
// El navegador proyecta los metros que faltan sobre el trazado para situar cada bus.

const UPSTREAM = 'https://datos.vigo.org/vci_api_app/api2.jsp?tipo=TRANSPORTE-ESTIMACION-PARADA&id=';
const TTL = 20;
const PROBE_GAP = 2000;
const LINES = ['C3d', 'C3i'];

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$cacheFile = sys_get_temp_dir() . '/c3-live.json';
$lockFile = sys_get_temp_dir() . '/c3-live.lock';

function readCache(string $file): ?array
{
    if (!is_file($file)) return null;
    $data = json_decode((string) @file_get_contents($file), true);
    return is_array($data) ? $data : null;
}

function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
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
    $handles = [];
    foreach ($probes as $code => $stopId) {
        $ch = curl_init(UPSTREAM . $code);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_USERAGENT => 'linea-c3-po/1.0',
        ]);
        curl_multi_add_handle($multi, $ch);
        $handles[$code] = $ch;
    }
    do {
        $status = curl_multi_exec($multi, $running);
        if ($running) curl_multi_select($multi, 1.0);
    } while ($running && $status === CURLM_OK);

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
    return $out;
}

$cached = readCache($cacheFile);
if ($cached && time() - $cached['at'] < TTL) respond($cached);

$lock = fopen($lockFile, 'c');
flock($lock, LOCK_EX);
$cached = readCache($cacheFile);
if ($cached && time() - $cached['at'] < TTL) {
    flock($lock, LOCK_UN);
    respond($cached);
}

$probes = probeStops();
$results = fetchProbes($probes);
if (!$results) {
    flock($lock, LOCK_UN);
    if ($cached) respond($cached + ['stale' => true]);
    respond(['error' => 'Sin respuesta de la API de Vigo'], 502);
}

$payload = ['at' => time(), 'asked' => count($probes), 'probes' => $results];
$tmp = $cacheFile . '.' . getmypid();
file_put_contents($tmp, json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
rename($tmp, $cacheFile);
flock($lock, LOCK_UN);
respond($payload);
