# Línea C3-PO

<p align="center">
<img width="1244" height="1244" alt="Línea_ C3-PO" src="https://github.com/user-attachments/assets/0553f42f-f2e0-4301-9c08-0bc8a3c3a871" />
</p>

Atlas horario de la línea **C3 de Vitrasa** en Vigo: las variantes **C3d** (por García Barbón) y **C3i** (por Travesía de Vigo), de Bouzas, Coia y Samil a Chapela.

<p align="center">
<img width="1919" height="937" alt="2d" src="https://github.com/user-attachments/assets/f58e6a2b-8dd7-46ba-a305-52724d487cb2" />
</p>

El mapa plano y la vista 3D muestran el recorrido, las paradas y los autobuses. Con el reloj se recorre el día según el horario teórico. Con **Ahora**, cada autobús se coloca donde está circulando.

## Posición en tiempo real

<p align="center">
<img width="1922" height="936" alt="3d" src="https://github.com/user-attachments/assets/e643f257-c145-4fa3-be12-ada18c63e9b4" />
</p>

Vitrasa no publica el GPS de los vehículos. La posición es una estimación:

1. [`api/live.php`](api/live.php) consulta en paralelo unas 34 paradas de control (una cada ~2 km) en la API del Concello, [`TRANSPORTE-ESTIMACION-PARADA`](https://datos.vigo.org/vci_api_app/api2.jsp?tipo=TRANSPORTE-ESTIMACION-PARADA&id=5540).
2. Cada llegada trae los metros que faltan hasta esa parada. El navegador los resta de la distancia de la parada a lo largo del trazado y coloca el bus sobre la forma de la línea.
3. El mismo bus se ve desde varias paradas; las lecturas cercanas se fusionan en un solo vehículo y se emparejan con su salida del horario para mostrar el retraso.

La caché del proxy dura 20 segundos, así que todos los visitantes comparten una sola tanda de peticiones. Las salidas del horario sin bus asociado se dibujan como contorno discontinuo. Al mover el reloj se vuelve al horario teórico.

## Requisitos

- Un servidor web con **PHP 8** y la extensión **curl** (Apache con `mod_php` vale). El proxy no funciona abriendo `index.html` como archivo local.
- El navegador carga Leaflet y las tipografías desde sus CDNs.

## Arranque

```bash
# Desde la raíz del proyecto, por ejemplo:
php -S 127.0.0.1:8080
```

Abre `http://127.0.0.1:8080/`. Con Apache, sirve el directorio tal cual (en este equipo, `http://127.0.0.1/lineac3/`).

## Datos

[`data/c3.json`](data/c3.json) sale del GTFS municipal. Para regenerarlo, descarga y descomprime el feed en `/tmp/vitrasa-gtfs` y ejecuta el extractor (solo biblioteca estándar):

```bash
curl -L -o /tmp/gtfs_vigo.zip https://datos.vigo.org/data/transporte/gtfs_vigo.zip
rm -rf /tmp/vitrasa-gtfs && mkdir /tmp/vitrasa-gtfs
unzip -q /tmp/gtfs_vigo.zip -d /tmp/vitrasa-gtfs
python3 tools/build_c3.py
```

El JSON publicado cubre la semana del 17 al 23 de octubre de 2026 (195 paradas, 26 recorridos).

## Estructura

| Ruta | Qué es |
| --- | --- |
| `index.html` | Página única |
| `js/app.js` | Horario, mapa Leaflet, flota en vivo |
| `js/atlas3d.js` | Vista 3D con Three.js |
| `js/vendor/three.min.js` | Three.js r128 (MIT) |
| `css/app.css` | Estilos |
| `api/live.php` | Proxy con caché de las llegadas |
| `tools/build_c3.py` | GTFS → `data/c3.json` |
| `data/c3.json` | Paradas, trazados y horarios |

## Atribución

- Horarios y trazados: GTFS del Concello de Vigo, [Open Data Commons Attribution](https://datos-ckan.vigo.org/dataset/gtfs-vitrasa). Atribución: Concello de Vigo.
- Llegadas en tiempo real: API VCI+ del Concello de Vigo (`datos.vigo.org`).
- Mapa: © [OpenStreetMap](https://www.openstreetmap.org/copyright).
- Leaflet (BSD-2-Clause) y Three.js r128 (MIT).
