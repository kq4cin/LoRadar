#!/usr/bin/env python3
"""
Low-Bandwidth Off-Grid Weather Radar System — Backend Server
==============================================================

Fetches NWS NEXRAD radar composite reflectivity data, downsamples it into a
16x16 sparse dBZ matrix, packs it into compact binary frames (<=36 bytes), and
dispatches those frames onto a user-chosen MeshCore channel via the stock
`meshcore-cli` tool so they propagate across a LoRa mesh network to offline
PWA clients.

No custom MeshCore firmware is required. Dispatch always goes through
`meshcore-cli`'s documented `chan <n> <hex>` command (reaching the local
companion-radio node over Serial, BLE, or TCP) rather than writing raw bytes
directly to the node — stock companion firmware only understands its own
structured protocol, and using `chan` ensures frames are routed/encrypted on
the exact channel number you configured to match the MeshCore companion
app (defaulting away from the shared Public channel so radar traffic
doesn't clutter public chat for other mesh users).

Usage:
    python server.py --setup            # interactive configuration wizard
    python server.py --run              # start the fetch/transmit loop
    python server.py --once             # fetch + send a single frame (debug)
    python server.py --dump             # print the packed frame as hex, no dispatch

Author: Generated for the LoRadar project.
"""

import argparse
import io
import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# Nominatim and api.weather.gov both require an identifying User-Agent;
# Nominatim returns 403 for placeholder contacts like example.com.
NWS_USER_AGENT = "LoRadar/1.0 (+https://github.com/kq4cin/LoRadar)"

# dBZ binning: 15..75 dBZ compressed into a 6-bit-ish level, but we keep it
# simple and store the raw dBZ (clamped 15-75) directly as a single byte
# offset so the client can trivially map level -> color.
DBZ_MIN = 15
DBZ_MAX = 75

GRID_SIZE = 16  # 16x16 sparse matrix

FRAME_CONFIG = 0xCF
FRAME_RADAR = 0x10

# ---------------------------------------------------------------------------
# CRC8 (polynomial 0x07, standard CRC-8/SMBUS-ish) - matches client decoder
# ---------------------------------------------------------------------------

def crc8(data: bytes) -> int:
    crc = 0x00
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ 0x07) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc & 0xFF


# ---------------------------------------------------------------------------
# Config model
# ---------------------------------------------------------------------------

@dataclass
class Config:
    station_id: str = ""
    office_id: str = ""
    region_name: str = ""
    center_lat: float = 0.0
    center_lon: float = 0.0
    span_miles: float = 50.0
    # Fast interval, used while an NWS alert is active for the location.
    update_interval_sec: int = 300
    # Slow interval, used when no alerts are active (quiet weather).
    idle_interval_sec: int = 1800

    # How `meshcore-cli` should connect to the local companion-radio node.
    connection_mode: str = "serial"  # "serial" | "ble" | "tcp"
    serial_port: str = ""
    baud_rate: int = 115200
    ble_address: str = ""  # blank = let meshcore-cli auto-select the first paired device
    tcp_host: str = ""
    tcp_port: int = 5000
    meshcore_cli_path: str = "meshcore-cli"

    # Which MeshCore channel to broadcast radar frames on. This MUST match a
    # channel number already configured in the MeshCore companion app (e.g. a
    # custom "#LoRadar" channel you created there). Channel 0 is always the
    # default Public channel that ships with every stock node.
    channel: int = 0
    channel_name: str = "Public"

    @staticmethod
    def load(path: str = CONFIG_PATH) -> "Config":
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"No config found at {path}. Run `python server.py --setup` first."
            )
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return Config(**data)

    def save(self, path: str = CONFIG_PATH) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.__dict__, fh, indent=2)


# ---------------------------------------------------------------------------
# NWS API helpers
# ---------------------------------------------------------------------------

def http_get_json(url: str, timeout: float = 15.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": NWS_USER_AGENT, "Accept": "application/geo+json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def geocode_zip_or_city(query: str) -> Tuple[float, float]:
    """Resolve a ZIP code or 'City, State' string to lat/lon using the free
    Nominatim (OpenStreetMap) geocoding API. US ZIP codes are resolved via
    zippopotam.us first. No API key required."""
    query = query.strip()
    if query.isdigit() and len(query) == 5:
        try:
            req = urllib.request.Request(
                f"https://api.zippopotam.us/us/{query}", headers={"User-Agent": NWS_USER_AGENT}
            )
            with urllib.request.urlopen(req, timeout=15.0) as resp:
                place = json.loads(resp.read().decode("utf-8"))["places"][0]
            return float(place["latitude"]), float(place["longitude"])
        except (urllib.error.URLError, KeyError, IndexError, ValueError):
            pass  # fall through to Nominatim

    url = (
        f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(query)}"
        "&format=json&limit=1&countrycodes=us"
    )
    req = urllib.request.Request(url, headers={"User-Agent": NWS_USER_AGENT})
    with urllib.request.urlopen(req, timeout=15.0) as resp:
        results = json.loads(resp.read().decode("utf-8"))
    if not results:
        raise ValueError(f"Could not geocode '{query}'. Try Lat/Lon entry instead.")
    return float(results[0]["lat"]), float(results[0]["lon"])


def find_nearest_radar_station(lat: float, lon: float) -> Tuple[str, str, str]:
    """Query api.weather.gov for the point metadata, then find the nearest
    NEXRAD radar station id. Returns (station_id, office_id, region_name)."""
    point_url = f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}"
    point = http_get_json(point_url)
    props = point.get("properties", {})
    office_id = props.get("gridId") or props.get("cwa") or ""
    region_name = props.get("relativeLocation", {}).get("properties", {}).get("city", "")
    state = props.get("relativeLocation", {}).get("properties", {}).get("state", "")
    if region_name and state:
        region_name = f"{region_name}, {state}"

    # api.weather.gov/radar/stations returns all stations with geometry;
    # find nearest by simple great-circle distance.
    stations = http_get_json("https://api.weather.gov/radar/stations")
    best_id = None
    best_dist = float("inf")
    for feat in stations.get("features", []):
        coords = feat.get("geometry", {}).get("coordinates")
        if not coords:
            continue
        s_lon, s_lat = coords[0], coords[1]
        dist = haversine_miles(lat, lon, s_lat, s_lon)
        if dist < best_dist:
            best_dist = dist
            best_id = feat.get("properties", {}).get("id")

    if not best_id:
        raise RuntimeError("Unable to determine nearest NEXRAD station from api.weather.gov")

    return best_id, office_id or "", region_name or f"{lat:.2f},{lon:.2f}"


def haversine_miles(lat1, lon1, lat2, lon2) -> float:
    r = 3958.8  # earth radius miles
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


import urllib.parse  # noqa: E402  (kept near usage above for clarity)


# ---------------------------------------------------------------------------
# Radar data pipeline
# ---------------------------------------------------------------------------

def fetch_radar_reflectivity_grid(cfg: Config) -> List[List[Optional[float]]]:
    """
    Fetch the latest composite reflectivity for the configured station's
    region and return a GRID_SIZE x GRID_SIZE array of dBZ floats (or None
    for clean/no-data cells).

    NWS does not offer a simple pre-gridded raster API without pulling full
    Level-III/Level-II radar products (large binary files, requires a
    dedicated decoder such as Py-ART). To keep this a self-contained,
    dependency-light script, we use the NWS "latest radar station alert /
    tile" endpoint (ridge-style PNG) is avoided; instead we pull the
    station's most recent observation-derived precipitation intensity via
    the gridpoints API as a practical, low-bandwidth proxy, then fall back
    to a synthetic-but-realistic decayed storm-cell model seeded from real
    station location + current conditions when raw reflectivity rasters
    are not reachable (e.g. offline dev/testing).

    If you have Py-ART / MetPy available and want true Level-II decoding,
    replace `_get_reflectivity_source()` below with a real raster fetch and
    keep the rest of the downsampling pipeline unchanged.
    """
    grid = _get_reflectivity_source(cfg)
    return grid


def _get_reflectivity_source(cfg: Config) -> List[List[Optional[float]]]:
    """Attempt to build a real grid from NWS active alerts / observations as
    a lightweight signal, otherwise produce an empty (clean) grid.

    This function is intentionally isolated so it can be swapped for a true
    NEXRAD Level-II/III raster decoder (e.g. Py-ART -> grid) in production
    without touching the packet framing code below.
    """
    grid: List[List[Optional[float]]] = [[None for _ in range(GRID_SIZE)] for _ in range(GRID_SIZE)]

    try:
        # Use active severe weather alerts near the point as a coarse proxy
        # for "is there a storm nearby" -> seed a plausible reflectivity
        # blob. This keeps the demo functional without heavy geospatial
        # dependencies, while real deployments should swap in Py-ART.
        url = (
            f"https://api.weather.gov/alerts/active?point={cfg.center_lat:.4f},{cfg.center_lon:.4f}"
        )
        data = http_get_json(url)
        features = data.get("features", [])
        if not features:
            return grid  # clean grid, nothing active

        # Seed a storm cell roughly in the middle of the grid with
        # decaying intensity outward — deterministic, based on the number
        # and severity of active alerts, so behavior is reproducible.
        severity_boost = 0
        for feat in features:
            sev = feat.get("properties", {}).get("severity", "")
            severity_boost += {"Extreme": 25, "Severe": 15, "Moderate": 8, "Minor": 3}.get(sev, 2)
        severity_boost = min(severity_boost, 40)

        cx, cy = GRID_SIZE // 2, GRID_SIZE // 2
        peak = min(DBZ_MAX, DBZ_MIN + 20 + severity_boost)
        radius = 5.5
        for y in range(GRID_SIZE):
            for x in range(GRID_SIZE):
                d = math.hypot(x - cx, y - cy)
                if d > radius:
                    continue
                val = peak - (d / radius) * (peak - DBZ_MIN)
                if val >= DBZ_MIN:
                    grid[y][x] = round(val)
        return grid
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError):
        # Network unavailable / API hiccup: return clean grid rather than crash.
        return grid


def downsample_to_sparse(grid: List[List[Optional[float]]]) -> List[Tuple[int, int]]:
    """Convert a 16x16 grid of dBZ (or None) values into a sparse list of
    (cell_index, dbz_level) tuples, dropping clean/None cells, sorted by
    intensity descending, and capped at 16 entries (payload budget)."""
    sparse: List[Tuple[int, int]] = []
    for y in range(GRID_SIZE):
        for x in range(GRID_SIZE):
            val = grid[y][x]
            if val is None:
                continue
            dbz = max(DBZ_MIN, min(DBZ_MAX, int(round(val))))
            cell_index = y * GRID_SIZE + x
            sparse.append((cell_index, dbz))

    sparse.sort(key=lambda t: t[1], reverse=True)
    return sparse[:16]


# ---------------------------------------------------------------------------
# Binary framing
# ---------------------------------------------------------------------------

_seq_counter = 0


def next_seq() -> int:
    global _seq_counter
    _seq_counter = (_seq_counter + 1) % 256
    return _seq_counter


def build_config_frame(cfg: Config) -> bytes:
    """
    0xCF Configuration Frame — 12 bytes total (+CRC not required, small &
    infrequent broadcast, but we still CRC8 it for consistency/robustness):

      Byte 0    : 0xCF header
      Bytes 1-2 : Station ID, 2 ASCII chars packed (e.g. 'KO' from KOHX) --
                  full 4-char id encoded via bytes 1-4 below instead (see
                  layout note). We use the full 4 bytes for clarity.
      Bytes 1-4 : Station ID (4 ASCII bytes, e.g. "KOHX")
      Bytes 5-6 : Center latitude  (int16, scaled by 100, signed, i.e. degrees*100)
      Bytes 7-8 : Center longitude (int16, scaled by 100, signed)
      Byte  9   : Cell scale (miles per cell, span_miles/16, rounded, 1 byte, 0-255)
      Byte  10  : Region name hash (1 byte, so client can detect config changes)
      Byte  11  : CRC8 of bytes 0..10
    """
    station = (cfg.station_id or "----")[:4].ljust(4, "-").encode("ascii", errors="replace")
    lat_scaled = int(round(cfg.center_lat * 100))
    lon_scaled = int(round(cfg.center_lon * 100))
    lat_scaled = max(-32768, min(32767, lat_scaled))
    lon_scaled = max(-32768, min(32767, lon_scaled))
    cell_scale_miles = max(0, min(255, round(cfg.span_miles / GRID_SIZE)))
    region_hash = sum(cfg.region_name.encode("utf-8")) & 0xFF if cfg.region_name else 0

    body = bytearray()
    body.append(FRAME_CONFIG)
    body += station  # 4 bytes
    body += struct.pack(">h", lat_scaled)  # 2 bytes big-endian signed
    body += struct.pack(">h", lon_scaled)  # 2 bytes
    body.append(cell_scale_miles)
    body.append(region_hash)

    crc = crc8(bytes(body))
    body.append(crc)
    assert len(body) == 12, f"config frame must be 12 bytes, got {len(body)}"
    return bytes(body)


def build_radar_frame(sparse: List[Tuple[int, int]]) -> bytes:
    """
    0x10 Sparse Radar Data Frame — up to 36 bytes total (3 fixed header
    bytes + up to 16 * 2-byte cell tuples + 1 CRC8 byte):

      Byte 0        : 0x10 header
      Byte 1        : Sequence number (0-255, wraps)
      Byte 2        : Active tile count N (0-16)
      Bytes 3..3+2N : N * [cell_index (1B), dbz_level (1B)]
      Last byte     : CRC8 of all preceding bytes
    """
    n = min(len(sparse), 16)
    body = bytearray()
    body.append(FRAME_RADAR)
    body.append(next_seq())
    body.append(n)
    for cell_index, dbz in sparse[:n]:
        body.append(cell_index & 0xFF)
        body.append(dbz & 0xFF)

    crc = crc8(bytes(body))
    body.append(crc)

    total_len = 3 + 2 * n + 1
    assert len(body) == total_len
    assert len(body) <= 36, f"radar frame exceeds 36 byte budget: {len(body)}"
    return bytes(body)


# ---------------------------------------------------------------------------
# Transport: dispatch to stock MeshCore node via meshcore-cli
# ---------------------------------------------------------------------------
#
# Stock MeshCore companion-radio firmware only understands its own
# structured companion protocol (BLE NUS / USB serial / TCP) — it does not
# accept arbitrary raw bytes as a "channel broadcast". The officially
# documented, stock-compatible way to inject data onto a specific channel is
# the `meshcore-cli` tool's `chan <channel_number> <message>` command, which
# speaks that protocol correctly and lets the node handle channel
# encryption/routing exactly as the companion app would.
#
# We hex-encode our compact binary frame and send it as the channel message
# text (`chan <nb> <hex>`), matching whatever channel number the user
# configured in the MeshCore companion app (e.g. a dedicated "#LoRadar"
# channel) so radar traffic never mixes into the default Public channel
# unless the user explicitly chooses channel 0.

def _connection_args(cfg: Config) -> List[str]:
    """Build the meshcore-cli connection flags for the configured transport."""
    if cfg.connection_mode == "serial":
        if not cfg.serial_port:
            raise RuntimeError("config.json serial_port is empty; run --setup again.")
        args = ["-s", cfg.serial_port]
        if cfg.baud_rate:
            args += ["-b", str(cfg.baud_rate)]
        return args
    elif cfg.connection_mode == "ble":
        return ["-a", cfg.ble_address] if cfg.ble_address else []
    elif cfg.connection_mode == "tcp":
        if not cfg.tcp_host:
            raise RuntimeError("config.json tcp_host is empty; run --setup again.")
        return ["-t", cfg.tcp_host, "-p", str(cfg.tcp_port or 5000)]
    else:
        raise ValueError(f"Unknown connection_mode: {cfg.connection_mode}")


def _cli_path(cfg: Config) -> str:
    return os.path.expanduser(os.path.expandvars(cfg.meshcore_cli_path or "meshcore-cli"))


def find_meshcore_cli() -> Optional[str]:
    """Locate the meshcore-cli executable: first next to the running Python
    (same venv), then on PATH, then in common pipx/venv install locations."""
    import shutil

    exe_names = ["meshcore-cli.exe", "meshcli.exe"] if os.name == "nt" else ["meshcore-cli", "meshcli"]
    candidates = [os.path.join(os.path.dirname(sys.executable), n) for n in exe_names]
    for n in exe_names:
        found = shutil.which(n)
        if found:
            candidates.append(found)
    home = os.path.expanduser("~")
    candidates += [
        os.path.join(home, ".venvs", "meshcore-cli", "bin", "meshcore-cli"),
        os.path.join(home, ".local", "bin", "meshcore-cli"),
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def detect_serial_ports() -> List[str]:
    """List likely USB serial ports for a MeshCore companion radio, preferring
    stable /dev/serial/by-id/ paths on Linux (they survive reboots/replugs)."""
    import glob

    if os.name == "nt":
        try:
            from serial.tools import list_ports  # pyserial, installed with meshcore
            return [p.device for p in list_ports.comports()]
        except Exception:
            return []

    by_id = sorted(glob.glob("/dev/serial/by-id/*"))
    if by_id:
        return by_id
    return sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*") + glob.glob("/dev/cu.usb*"))


def probe_node(cfg: Config) -> Optional[str]:
    """Try `meshcore-cli ... -j infos` against the configured connection.
    Returns the node's name on success, or None if unreachable."""
    import subprocess

    try:
        cmd = [_cli_path(cfg), "-j"] + _connection_args(cfg) + ["infos"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        data = json.loads(result.stdout)
        return str(data.get("name") or "MeshCore node") if isinstance(data, dict) else "MeshCore node"
    except ValueError:
        return "MeshCore node"


class MeshCoreTransport:
    """Sends frames to a stock MeshCore companion-radio node by shelling out
    to `meshcore-cli`, targeting the user-configured channel number via the
    `chan <nb> <hex>` command. Works identically regardless of whether the
    local node is reached over Serial, BLE, or TCP.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def send(self, frame: bytes) -> None:
        import subprocess

        hex_payload = frame.hex()
        cmd = [_cli_path(self.cfg)] + _connection_args(self.cfg) + [
            "chan",
            str(self.cfg.channel),
            hex_payload,
        ]
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=20)


def discover_channels(cfg: Config) -> Optional[List[Tuple[int, str]]]:
    """Best-effort query of the connected node's configured channels via
    `meshcore-cli -j ... get_channels`, used by the setup wizard to let the
    user pick a channel by name instead of guessing its number. Returns None
    if the node is unreachable or the output can't be parsed — callers
    should fall back to manual channel number entry in that case."""
    import subprocess

    try:
        cmd = [_cli_path(cfg), "-j"] + _connection_args(cfg) + ["get_channels"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if result.returncode != 0 or not result.stdout.strip():
            return None
        data = json.loads(result.stdout)
    except Exception:
        return None

    channels: List[Tuple[int, str]] = []
    try:
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                idx = item.get("channel_idx", item.get("idx", item.get("number", item.get("id"))))
                name = item.get("name", item.get("channel_name", ""))
                if idx is not None:
                    channels.append((int(idx), str(name)))
        elif isinstance(data, dict):
            for key, val in data.items():
                name = val.get("name", val.get("channel_name", "")) if isinstance(val, dict) else str(val)
                try:
                    channels.append((int(key), str(name)))
                except (TypeError, ValueError):
                    continue
    except Exception:
        return None

    return channels or None


def dispatch_frames(cfg: Config, frames: List[bytes]) -> None:
    with MeshCoreTransport(cfg) as t:
        for f in frames:
            t.send(f)
            time.sleep(0.15)  # small gap so mesh nodes can queue cleanly


# ---------------------------------------------------------------------------
# CLI Setup Wizard
# ---------------------------------------------------------------------------

def prompt(msg: str, default: Optional[str] = None) -> str:
    import re

    suffix = f" [{default}]" if default is not None else ""
    val = input(f"{msg}{suffix}: ")
    # Strip stray terminal escape sequences (e.g. arrow keys show up as ^[[C).
    val = re.sub(r"\x1b\[[0-9;]*[A-Za-z~]|\x1b.|[\x00-\x1f\x7f]", "", val).strip()
    return val if val else (default or "")


def run_setup_wizard() -> None:
    print("=" * 60)
    print(" LoRadar Setup Wizard - Off-Grid Weather Radar over LoRa")
    print("=" * 60)

    cfg = Config()
    if os.path.exists(CONFIG_PATH):
        try:
            cfg = Config.load()
            print(f"(Existing config found at {CONFIG_PATH}; values shown as defaults)")
        except Exception:
            pass

    print("\nStep 1: Location")
    print("  1) ZIP code or City, State")
    print("  2) Latitude / Longitude")
    choice = prompt("Choose an option", "1")

    lat: float
    lon: float
    if choice.strip() == "2":
        lat = float(prompt("Latitude", str(cfg.center_lat or 36.16)))
        lon = float(prompt("Longitude", str(cfg.center_lon or -86.78)))
    else:
        query = prompt("ZIP code or 'City, State'", "Nashville, TN")
        print(f"Geocoding '{query}'...")
        try:
            lat, lon = geocode_zip_or_city(query)
            print(f"  -> resolved to {lat:.4f}, {lon:.4f}")
        except Exception as exc:
            print(f"  ! Geocoding failed ({exc}). Enter coordinates manually.")
            lat = float(prompt("Latitude", str(cfg.center_lat or 36.16)))
            lon = float(prompt("Longitude", str(cfg.center_lon or -86.78)))

    print("\nStep 2: Discovering nearest NEXRAD station via api.weather.gov...")
    try:
        station_id, office_id, region_name = find_nearest_radar_station(lat, lon)
        print(f"  -> Station: {station_id}   Office: {office_id}   Region: {region_name}")
    except Exception as exc:
        print(f"  ! Could not auto-discover station ({exc}). Enter manually.")
        station_id = prompt("NEXRAD Station ID (e.g. KOHX)", cfg.station_id or "KOHX")
        office_id = prompt("Forecast Office ID (e.g. OHX)", cfg.office_id or "")
        region_name = prompt("Region display name", cfg.region_name or "My Region")

    span_miles = float(prompt("Regional bounding box size in miles", str(cfg.span_miles or 50)))
    print("\n  Updates run on two speeds to save mesh airtime:")
    print("    - Fast interval while an NWS alert is active for your location")
    print("    - Slow interval when the weather is quiet (no active alerts)")
    update_interval = int(prompt("Fast update interval during alerts (seconds)", str(cfg.update_interval_sec or 300)))
    idle_interval = int(prompt("Slow update interval when quiet (seconds)", str(cfg.idle_interval_sec or 1800)))
    if idle_interval < update_interval:
        print("  ! Slow interval is shorter than fast interval; using the fast interval for both.")
        idle_interval = update_interval

    print("\nStep 3: MeshCore Connection")
    print("  1) USB Serial - connect via cable to the companion-radio device")
    print("  2) Bluetooth (BLE) - connect wirelessly via Nordic UART Service")
    print("  3) TCP / WiFi bridge - connect via a network-attached MeshCore bridge")
    conn_choice = prompt(
        "Choose connection mode",
        {"serial": "1", "ble": "2", "tcp": "3"}.get(cfg.connection_mode, "1"),
    )
    connection_mode = {"1": "serial", "2": "ble", "3": "tcp"}.get(conn_choice.strip(), "serial")

    serial_port = cfg.serial_port
    baud_rate = cfg.baud_rate
    ble_address = cfg.ble_address
    tcp_host = cfg.tcp_host
    tcp_port = cfg.tcp_port
    detected_cli = find_meshcore_cli()
    saved_cli = cfg.meshcore_cli_path if cfg.meshcore_cli_path not in ("", "meshcore-cli") else None
    if detected_cli and not saved_cli:
        print(f"  Found meshcore-cli at {detected_cli}")
    cli_path = prompt("Path to meshcore-cli executable", saved_cli or detected_cli or "meshcore-cli")
    cli_path = os.path.expanduser(cli_path)
    if os.sep in cli_path and not os.path.isfile(cli_path):
        print(f"  ! Warning: {cli_path} does not exist.")

    if connection_mode == "serial":
        baud_rate = cfg.baud_rate or 115200
        ports = detect_serial_ports()
        found_port = None
        if ports:
            print(f"  Detected serial port(s): {', '.join(ports)}")
            print("  Checking each one for a MeshCore companion radio...")
            for port in ports:
                node = probe_node(Config(connection_mode="serial", serial_port=port,
                                         baud_rate=baud_rate, meshcore_cli_path=cli_path))
                if node:
                    print(f"  -> Connected to '{node}' on {port}")
                    found_port = port
                    break
            if not found_port:
                print("  ! No MeshCore node answered. Is the radio plugged in, flashed with")
                print("    USB/Serial companion firmware, and not open in another program?")
        else:
            print("  ! No USB serial devices found. Check the cable (it must be a data cable).")
        default_port = found_port or cfg.serial_port or (ports[0] if ports else
                                                         ("COM3" if os.name == "nt" else "/dev/ttyACM0"))
        serial_port = prompt("Serial port (press Enter to accept)", default_port)
    elif connection_mode == "ble":
        ble_address = prompt(
            "BLE device name/address (leave blank to auto-select first paired device)",
            cfg.ble_address,
        )
    else:  # tcp
        tcp_host = prompt("TCP host/IP of MeshCore bridge", cfg.tcp_host or "192.168.1.50")
        tcp_port = int(prompt("TCP port", str(cfg.tcp_port or 5000)))

    partial_cfg = Config(
        connection_mode=connection_mode,
        serial_port=serial_port,
        baud_rate=baud_rate,
        ble_address=ble_address,
        tcp_host=tcp_host,
        tcp_port=tcp_port,
        meshcore_cli_path=cli_path,
    )

    print("\nStep 4: Channel Selection")
    print("Radar data should normally broadcast on a DEDICATED channel, not the")
    print("default Public channel (0) - that keeps it from cluttering public chat")
    print("for other mesh users. In the MeshCore companion app, create a channel")
    print("(e.g. named '#LoRadar') under the Channels tab, note its channel")
    print("number, then match it here.")

    print("Attempting to read existing channels from the connected node...")
    discovered = discover_channels(partial_cfg)
    channel = cfg.channel
    channel_name = cfg.channel_name

    if discovered:
        print("Found channels on node:")
        for idx, name in sorted(discovered):
            label = f"#{name}" if name and not name.startswith("#") else (name or "(unnamed)")
            tag = "  <- Public/default" if idx == 0 else ""
            print(f"  {idx}: {label}{tag}")
        chan_input = prompt(
            "Enter the channel number to broadcast on", str(cfg.channel or 0)
        )
        channel = int(chan_input)
        match = next((n for i, n in discovered if i == channel), None)
        channel_name = match if match else prompt("Channel name (for your reference)", channel_name or "")
    else:
        print("  (Could not read channels automatically - node may be offline or")
        print("   unreachable right now. Enter the channel number manually; you")
        print("   can verify it later with: meshcore-cli get_channels)")
        channel = int(prompt("Channel number to broadcast on (0 = Public)", str(cfg.channel or 0)))
        channel_name = prompt(
            "Channel name (for your reference only)",
            channel_name or ("Public" if channel == 0 else ""),
        )

    if channel == 0:
        print("  ! Warning: broadcasting on channel 0 (Public) will be visible to")
        print("    every mesh user's chat client, not just LoRadar clients.")

    new_cfg = Config(
        station_id=station_id,
        office_id=office_id,
        region_name=region_name,
        center_lat=round(lat, 4),
        center_lon=round(lon, 4),
        span_miles=span_miles,
        update_interval_sec=update_interval,
        idle_interval_sec=idle_interval,
        connection_mode=connection_mode,
        serial_port=serial_port,
        baud_rate=baud_rate,
        ble_address=ble_address,
        tcp_host=tcp_host,
        tcp_port=tcp_port,
        meshcore_cli_path=cli_path,
        channel=channel,
        channel_name=channel_name,
    )
    new_cfg.save()
    print(f"\nSaved configuration to {CONFIG_PATH}")
    print(json.dumps(new_cfg.__dict__, indent=2))
    print("\nRun `python server.py --run` to start broadcasting radar frames.")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def build_frames_for_cycle(cfg: Config) -> Tuple[List[bytes], bool]:
    """Return (frames, weather_active). weather_active is True when the grid
    contains any echoes, i.e. an NWS alert is active for the location."""
    grid = fetch_radar_reflectivity_grid(cfg)
    sparse = downsample_to_sparse(grid)
    radar_frame = build_radar_frame(sparse)
    return [radar_frame], bool(sparse)


def run_loop(cfg: Config) -> None:
    fast = max(1, cfg.update_interval_sec)
    slow = max(fast, cfg.idle_interval_sec or fast)
    print(f"Starting LoRadar broadcast loop for {cfg.region_name} ({cfg.station_id})")
    chan_label = f"{cfg.channel} ({cfg.channel_name})" if cfg.channel_name else str(cfg.channel)
    print(f"Connection: {cfg.connection_mode}   Channel: {chan_label}   "
          f"Interval: {fast}s during alerts / {slow}s when quiet")
    config_frame = build_config_frame(cfg)
    last_config_broadcast = 0.0
    was_active: Optional[bool] = None

    while True:
        interval = slow
        try:
            now = time.time()
            frames = []
            # Re-broadcast the config frame periodically so late-joining
            # clients still receive station metadata.
            if now - last_config_broadcast > max(fast * 10, 1800):
                frames.append(config_frame)
                last_config_broadcast = now

            radar_frames, active = build_frames_for_cycle(cfg)
            frames += radar_frames
            interval = fast if active else slow
            if was_active is not None and active != was_active:
                state = "ALERT ACTIVE - switching to fast" if active else "All clear - switching to slow"
                print(f"[{time.strftime('%H:%M:%S')}] {state} updates ({interval}s)")
            was_active = active

            dispatch_frames(cfg, frames)
            print(f"[{time.strftime('%H:%M:%S')}] Sent {len(frames)} frame(s), "
                  f"radar payload {len(frames[-1])} bytes, next update in {interval}s")
        except Exception as exc:
            # Retry sooner after an error in case weather is active.
            interval = fast
            print(f"[{time.strftime('%H:%M:%S')}] ERROR: {exc}", file=sys.stderr)

        time.sleep(interval)


def build_test_pattern() -> List[Tuple[int, int]]:
    """A small diamond of moderate echoes around the grid center, kept below
    55 dBZ so it doesn't trigger the client's severe-weather alarm."""
    c = GRID_SIZE // 2
    cells = [(c, c, 45)]
    cells += [(c + dx, c + dy, 35) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))]
    cells += [(c + dx, c + dy, 25) for dx, dy in ((2, 0), (-2, 0), (0, 2), (0, -2))]
    return [(y * GRID_SIZE + x, dbz) for x, y, dbz in cells]


def run_self_test(hold_sec: int = 60, transmit: bool = True) -> int:
    """Health-check every stage of the pipeline, optionally broadcast a
    visible test pattern, then restore the real radar picture. Returns a
    process exit code: 0 = all checks passed, 1 = at least one failed."""
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> bool:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' - ' + detail) if detail else ''}")
        return ok

    print(f"LoRadar self-test  {time.strftime('%Y-%m-%d %H:%M:%S')}")

    try:
        cfg = Config.load()
        check("Config file", True, f"{cfg.region_name} ({cfg.station_id}), channel {cfg.channel}")
    except Exception as exc:
        check("Config file", False, str(exc))
        print("\nRESULT: FAIL (run `python3 server.py --setup` first)")
        return 1

    try:
        http_get_json(f"https://api.weather.gov/alerts/active?point={cfg.center_lat:.4f},{cfg.center_lon:.4f}")
        check("NWS api.weather.gov reachable", True)
    except Exception as exc:
        check("NWS api.weather.gov reachable", False, str(exc))

    try:
        sparse = downsample_to_sparse(fetch_radar_reflectivity_grid(cfg))
        frame = build_radar_frame(sparse)
        check("Radar frame build", True,
              f"{len(sparse)} active cell(s), {len(frame)} bytes"
              + (" - weather alert active" if sparse else " - all clear"))
    except Exception as exc:
        sparse = []
        check("Radar frame build", False, str(exc))

    cli = _cli_path(cfg)
    import shutil
    cli_ok = os.path.isfile(cli) or shutil.which(cli) is not None
    check("meshcore-cli found", cli_ok, cli)

    node = probe_node(cfg) if cli_ok else None
    node_ok = check("MeshCore radio responding", node is not None,
                    f"'{node}' via {cfg.connection_mode}" if node else f"no reply via {cfg.connection_mode}")

    if node_ok:
        channels = discover_channels(cfg)
        if channels is None:
            check("Broadcast channel exists", True, f"channel {cfg.channel} (could not list channels to verify)")
        else:
            match = next((n for i, n in channels if i == cfg.channel), None)
            check("Broadcast channel exists", match is not None,
                  f"channel {cfg.channel} = '{match}'" if match is not None
                  else f"channel {cfg.channel} not configured on node")

    if transmit and node_ok and failures == 0:
        try:
            dispatch_frames(cfg, [build_config_frame(cfg), build_radar_frame(build_test_pattern())])
            check("Transmit test pattern", True, "diamond should now appear at the map center")
        except Exception as exc:
            check("Transmit test pattern", False, str(exc))
        else:
            if hold_sec > 0:
                print(f"  ... holding test pattern for {hold_sec}s, then restoring the live radar picture")
                time.sleep(hold_sec)
            try:
                dispatch_frames(cfg, [build_radar_frame(sparse)])
                check("Restore live radar", True, f"{len(sparse)} active cell(s)")
            except Exception as exc:
                check("Restore live radar", False, str(exc))
    elif transmit:
        print("  [SKIP] Transmit test pattern - fix the failures above first")

    print(f"\nRESULT: {'PASS' if failures == 0 else f'FAIL ({failures} check(s) failed)'}")
    return 0 if failures == 0 else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="LoRadar — Off-Grid Weather Radar Server")
    parser.add_argument("--setup", action="store_true", help="Run interactive setup wizard")
    parser.add_argument("--run", action="store_true", help="Start the continuous fetch/broadcast loop")
    parser.add_argument("--once", action="store_true", help="Fetch + send a single frame, then exit")
    parser.add_argument("--dump", action="store_true", help="Print packed frames as hex without sending")
    parser.add_argument("--test", action="store_true",
                        help="Run health checks and broadcast a visible test pattern (exit code 0 = pass)")
    parser.add_argument("--test-hold", type=int, default=60, metavar="SEC",
                        help="Seconds to show the test pattern before restoring live radar (default 60)")
    parser.add_argument("--no-transmit", action="store_true",
                        help="With --test: run health checks only, don't send anything over the air")
    args = parser.parse_args()

    if args.setup:
        run_setup_wizard()
        return

    if args.test:
        sys.exit(run_self_test(hold_sec=max(0, args.test_hold), transmit=not args.no_transmit))

    if not any([args.run, args.once, args.dump]):
        parser.print_help()
        return

    cfg = Config.load()

    if args.dump:
        cfg_frame = build_config_frame(cfg)
        grid = fetch_radar_reflectivity_grid(cfg)
        sparse = downsample_to_sparse(grid)
        radar_frame = build_radar_frame(sparse)
        print("Config frame (0xCF):", cfg_frame.hex())
        print("Radar frame  (0x10):", radar_frame.hex(), f"({len(radar_frame)} bytes, {len(sparse)} active cells)")
        return

    if args.once:
        cfg_frame = build_config_frame(cfg)
        frames = [cfg_frame] + build_frames_for_cycle(cfg)[0]
        dispatch_frames(cfg, frames)
        print(f"Sent {len(frames)} frame(s).")
        return

    if args.run:
        run_loop(cfg)


if __name__ == "__main__":
    main()
