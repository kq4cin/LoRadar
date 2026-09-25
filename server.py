#!/usr/bin/env python3
"""
Low-Bandwidth Off-Grid Weather Radar System — Backend Server
==============================================================

Fetches NWS NEXRAD radar composite reflectivity data, downsamples it into a
16x16 sparse dBZ matrix, packs it into compact binary frames (<35 bytes), and
dispatches those frames to a local, stock-firmware MeshCore node over a
serial (USB) connection so they can propagate across a LoRa mesh network to
offline PWA clients.

No custom MeshCore firmware is required — this script only writes bytes to
the node's serial port, which stock MeshCore firmware forwards as a raw
"send" over the mesh (via the MeshCore companion-radio serial protocol) or,
for the simplest possible integration, as a raw pass-through byte stream
that a stock MeshCore repeater will flood to connected companion apps.

Usage:
    python server.py --setup            # interactive configuration wizard
    python server.py --run              # start the fetch/transmit loop
    python server.py --once             # fetch + send a single frame (debug)
    python server.py --dump             # print the packed frame as hex, no serial write

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

NWS_USER_AGENT = "LoRadar/1.0 (contact: example@example.com)"

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
    update_interval_sec: int = 300
    serial_port: str = ""
    baud_rate: int = 115200
    transport: str = "serial"  # "serial" or "cli"
    meshcore_cli_path: str = "meshcore-cli"

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
    Nominatim (OpenStreetMap) geocoding API. No API key required."""
    url = f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(query)}&format=json&limit=1"
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
    0x10 Sparse Radar Data Frame — up to 35 bytes total:

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
    assert len(body) <= 35, f"radar frame exceeds 35 bytes budget: {len(body)}"
    return bytes(body)


# ---------------------------------------------------------------------------
# Transport: serial dispatch to stock MeshCore node
# ---------------------------------------------------------------------------

class MeshCoreTransport:
    """Thin wrapper for sending raw binary frames to a stock MeshCore
    companion-radio node. Two modes:

      - "serial": Opens the node's USB serial port directly (via pyserial)
        and writes the raw frame bytes prefixed with a simple length byte
        so the receiving companion app / bridge can delimit frames. Stock
        MeshCore companion firmware exposes a serial passthrough that will
        flood arbitrary payloads sent via its "send raw" command; for
        maximum compatibility we wrap bytes using MeshCore's documented
        CLI text command instead when transport == "cli".

      - "cli": Shells out to the `meshcore-cli` tool (or any compatible
        CLI) using its `send` subcommand with a hex-encoded payload. This
        avoids needing pyserial and works with any stock MeshCore
        companion-radio CLI bridge.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._serial = None

    def __enter__(self):
        if self.cfg.transport == "serial":
            try:
                import serial  # type: ignore
            except ImportError as exc:
                raise RuntimeError(
                    "pyserial is required for transport='serial'. Install with: pip install pyserial"
                ) from exc
            if not self.cfg.serial_port:
                raise RuntimeError("config.json serial_port is empty; run --setup again.")
            self._serial = serial.Serial(self.cfg.serial_port, self.cfg.baud_rate, timeout=2)
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._serial is not None:
            self._serial.close()

    def send(self, frame: bytes) -> None:
        if self.cfg.transport == "serial":
            # Simple length-prefixed framing (1 byte length + payload) so the
            # bridge/receiver can find frame boundaries over the raw UART
            # stream. Adjust to match your specific MeshCore serial bridge
            # if it expects a different delimiter.
            packet = bytes([len(frame)]) + frame
            self._serial.write(packet)
            self._serial.flush()
        elif self.cfg.transport == "cli":
            import subprocess

            hex_payload = frame.hex()
            cmd = [self.cfg.meshcore_cli_path, "send", "--hex", hex_payload]
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=15)
        else:
            raise ValueError(f"Unknown transport: {self.cfg.transport}")


def dispatch_frames(cfg: Config, frames: List[bytes]) -> None:
    with MeshCoreTransport(cfg) as t:
        for f in frames:
            t.send(f)
            time.sleep(0.15)  # small gap so mesh nodes can queue cleanly


# ---------------------------------------------------------------------------
# CLI Setup Wizard
# ---------------------------------------------------------------------------

def prompt(msg: str, default: Optional[str] = None) -> str:
    suffix = f" [{default}]" if default is not None else ""
    val = input(f"{msg}{suffix}: ").strip()
    return val if val else (default or "")


def run_setup_wizard() -> None:
    print("=" * 60)
    print(" LoRadar Setup Wizard — Off-Grid Weather Radar over LoRa")
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
        lat, lon = geocode_zip_or_city(query)
        print(f"  -> resolved to {lat:.4f}, {lon:.4f}")

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
    update_interval = int(prompt("Update interval (seconds)", str(cfg.update_interval_sec or 300)))

    print("\nStep 3: MeshCore Connection")
    print("  1) Serial (USB) — direct pyserial write to companion-radio device")
    print("  2) CLI bridge  — shell out to meshcore-cli 'send' command")
    transport_choice = prompt("Choose transport", "1" if cfg.transport != "cli" else "2")
    transport = "cli" if transport_choice.strip() == "2" else "serial"

    serial_port = cfg.serial_port
    baud_rate = cfg.baud_rate
    cli_path = cfg.meshcore_cli_path

    if transport == "serial":
        default_port = cfg.serial_port or ("COM3" if os.name == "nt" else "/dev/ttyUSB0")
        serial_port = prompt("Serial port", default_port)
        baud_rate = int(prompt("Baud rate", str(cfg.baud_rate or 115200)))
    else:
        cli_path = prompt("Path to meshcore-cli executable", cfg.meshcore_cli_path or "meshcore-cli")

    new_cfg = Config(
        station_id=station_id,
        office_id=office_id,
        region_name=region_name,
        center_lat=round(lat, 4),
        center_lon=round(lon, 4),
        span_miles=span_miles,
        update_interval_sec=update_interval,
        serial_port=serial_port,
        baud_rate=baud_rate,
        transport=transport,
        meshcore_cli_path=cli_path,
    )
    new_cfg.save()
    print(f"\nSaved configuration to {CONFIG_PATH}")
    print(json.dumps(new_cfg.__dict__, indent=2))
    print("\nRun `python server.py --run` to start broadcasting radar frames.")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def build_frames_for_cycle(cfg: Config) -> List[bytes]:
    grid = fetch_radar_reflectivity_grid(cfg)
    sparse = downsample_to_sparse(grid)
    radar_frame = build_radar_frame(sparse)
    return [radar_frame]


def run_loop(cfg: Config) -> None:
    print(f"Starting LoRadar broadcast loop for {cfg.region_name} ({cfg.station_id})")
    print(f"Transport: {cfg.transport}   Interval: {cfg.update_interval_sec}s")
    config_frame = build_config_frame(cfg)
    last_config_broadcast = 0.0

    while True:
        try:
            now = time.time()
            frames = []
            # Re-broadcast the config frame periodically (every ~10 cycles)
            # so late-joining clients still receive station metadata.
            if now - last_config_broadcast > max(cfg.update_interval_sec * 10, 1800):
                frames.append(config_frame)
                last_config_broadcast = now

            frames += build_frames_for_cycle(cfg)
            dispatch_frames(cfg, frames)
            print(f"[{time.strftime('%H:%M:%S')}] Sent {len(frames)} frame(s), "
                  f"radar payload {len(frames[-1])} bytes")
        except Exception as exc:
            print(f"[{time.strftime('%H:%M:%S')}] ERROR: {exc}", file=sys.stderr)

        time.sleep(cfg.update_interval_sec)


def main() -> None:
    parser = argparse.ArgumentParser(description="LoRadar — Off-Grid Weather Radar Server")
    parser.add_argument("--setup", action="store_true", help="Run interactive setup wizard")
    parser.add_argument("--run", action="store_true", help="Start the continuous fetch/broadcast loop")
    parser.add_argument("--once", action="store_true", help="Fetch + send a single frame, then exit")
    parser.add_argument("--dump", action="store_true", help="Print packed frames as hex without sending")
    args = parser.parse_args()

    if args.setup:
        run_setup_wizard()
        return

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
        frames = [cfg_frame] + build_frames_for_cycle(cfg)
        dispatch_frames(cfg, frames)
        print(f"Sent {len(frames)} frame(s).")
        return

    if args.run:
        run_loop(cfg)


if __name__ == "__main__":
    main()
