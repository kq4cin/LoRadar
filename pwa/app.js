/* ==========================================================================
   LoRadar PWA Client — app.js
   Off-grid weather radar renderer for MeshCore LoRa mesh networks.
   ==========================================================================
   Responsibilities:
     - First-run onboarding wizard (transport, location, offline tiles, audio)
     - IndexedDB-backed offline map tile cache + custom Leaflet TileLayer
     - WebBluetooth (Nordic UART Service) and WebSerial transports for
       reading raw binary frames from a stock MeshCore companion node
     - Binary frame parsing: 0xCF (config) and 0x10 (sparse radar) frames
     - Canvas overlay rendering of the 16x16 reflectivity grid
     - Live GPS "You Are Here" pulsing marker
   ========================================================================== */

(() => {
  "use strict";

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  const DB_NAME = "loradar-tiles";
  const DB_VERSION = 1;
  const TILE_STORE = "tiles";
  const GRID_SIZE = 16;
  const FRAME_CONFIG = 0xcf;
  const FRAME_RADAR = 0x10;
  const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const NUS_TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // notify (node -> browser)
  const NUS_RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // write (browser -> node)

  const TILE_ZOOMS = [8, 9, 10, 11];
  const TILE_RADIUS_CELLS = 4; // tiles around center per zoom, in each direction

  // ------------------------------------------------------------------
  // Small utilities
  // ------------------------------------------------------------------
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function toast(msg, ms = 2600) {
    const el = $("#toast");
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.display = "none"; }, ms);
  }

  function saveLocal(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function loadLocal(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function crc8(bytes) {
    let crc = 0x00;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let b = 0; b < 8; b++) {
        if (crc & 0x80) {
          crc = ((crc << 1) ^ 0x07) & 0xff;
        } else {
          crc = (crc << 1) & 0xff;
        }
      }
    }
    return crc & 0xff;
  }

  // ------------------------------------------------------------------
  // IndexedDB tile cache
  // ------------------------------------------------------------------
  const TileDB = {
    _db: null,

    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(TILE_STORE)) {
            db.createObjectStore(TILE_STORE, { keyPath: "key" });
          }
        };
        req.onsuccess = () => { this._db = req.result; resolve(this._db); };
        req.onerror = () => reject(req.error);
      });
    },

    async putTile(key, blob) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(TILE_STORE, "readwrite");
        tx.objectStore(TILE_STORE).put({ key, blob, ts: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getTile(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(TILE_STORE, "readonly");
        const req = tx.objectStore(TILE_STORE).get(key);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => reject(req.error);
      });
    },

    async countTiles() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(TILE_STORE, "readonly");
        const req = tx.objectStore(TILE_STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
  };

  function lonLatToTile(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return { x, y };
  }

  function tileKey(z, x, y) { return `${z}/${x}/${y}`; }

  async function downloadTilesForLocation(lat, lon, onProgress) {
    const jobs = [];
    for (const z of TILE_ZOOMS) {
      const center = lonLatToTile(lon, lat, z);
      for (let dx = -TILE_RADIUS_CELLS; dx <= TILE_RADIUS_CELLS; dx++) {
        for (let dy = -TILE_RADIUS_CELLS; dy <= TILE_RADIUS_CELLS; dy++) {
          jobs.push({ z, x: center.x + dx, y: center.y + dy });
        }
      }
    }

    let done = 0;
    const total = jobs.length;
    onProgress(0, total);

    const CONCURRENCY = 6;
    let idx = 0;

    async function worker() {
      while (idx < jobs.length) {
        const job = jobs[idx++];
        const url = `https://tile.openstreetmap.org/${job.z}/${job.x}/${job.y}.png`;
        try {
          const resp = await fetch(url, { mode: "cors" });
          if (resp.ok) {
            const blob = await resp.blob();
            await TileDB.putTile(tileKey(job.z, job.x, job.y), blob);
          }
        } catch (e) {
          // tile fetch failures are non-fatal; continue downloading the rest
        }
        done++;
        onProgress(done, total);
      }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  // ------------------------------------------------------------------
  // Custom offline-first Leaflet tile layer
  // ------------------------------------------------------------------
  const OfflineTileLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("img");
      tile.alt = "";
      const z = coords.z, x = coords.x, y = coords.y;
      const key = tileKey(z, x, y);

      TileDB.getTile(key).then((blob) => {
        if (blob) {
          tile.src = URL.createObjectURL(blob);
          done(null, tile);
          return;
        }
        // Not cached: try network (online), else fall back to a blank tile.
        const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
        fetch(url, { mode: "cors" })
          .then((r) => {
            if (!r.ok) throw new Error("tile fetch failed");
            return r.blob();
          })
          .then((blob2) => {
            TileDB.putTile(key, blob2).catch(() => {});
            tile.src = URL.createObjectURL(blob2);
            done(null, tile);
          })
          .catch(() => {
            tile.src =
              "data:image/svg+xml;base64," +
              btoa(
                '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#0d1626"/></svg>'
              );
            done(null, tile);
          });
      });

      return tile;
    },
  });

  // ------------------------------------------------------------------
  // App state
  // ------------------------------------------------------------------
  const state = {
    map: null,
    radarCanvas: null,
    radarCtx: null,
    gpsMarker: null,
    watchId: null,
    userLocation: null, // {lat, lon}
    stationConfig: null, // parsed from 0xCF: {stationId, centerLat, centerLon, cellScaleMiles, regionHash}
    sparseCells: [], // [{cellIndex, dbz}]
    lastUpdateTs: null,
    transport: null, // "bluetooth" | "serial"
    bleDevice: null,
    bleChar: null,
    serialPort: null,
    serialReader: null,
    rxBuffer: [],
    audioCtx: null,
    connected: false,
  };

  // ------------------------------------------------------------------
  // dBZ color mapping (matches legend in index.html)
  // ------------------------------------------------------------------
  function dbzColor(dbz) {
    if (dbz < 25) return "rgba(60,255,60,0.55)";
    if (dbz < 40) return "rgba(255,255,60,0.6)";
    if (dbz < 55) return "rgba(255,154,60,0.65)";
    if (dbz < 65) return "rgba(255,60,60,0.7)";
    return "rgba(212,60,255,0.75)";
  }

  // ------------------------------------------------------------------
  // Map init
  // ------------------------------------------------------------------
  function initMap(lat, lon) {
    state.map = L.map("map", { zoomControl: true, attributionControl: false }).setView(
      [lat, lon],
      10
    );
    const layer = new OfflineTileLayer("", { maxZoom: 11, minZoom: 6 });
    layer.addTo(state.map);

    state.radarCanvas = $("#radarCanvas");
    resizeCanvas();
    state.radarCtx = state.radarCanvas.getContext("2d");

    window.addEventListener("resize", () => { resizeCanvas(); drawRadarOverlay(); });
    state.map.on("move zoom", drawRadarOverlay);
    state.map.on("moveend zoomend", drawRadarOverlay);

    drawRadarOverlay();
  }

  function resizeCanvas() {
    const c = state.radarCanvas;
    if (!c) return;
    c.width = window.innerWidth;
    c.height = window.innerHeight;
  }

  // ------------------------------------------------------------------
  // Radar overlay rendering
  // ------------------------------------------------------------------
  function drawRadarOverlay() {
    const ctx = state.radarCtx;
    if (!ctx || !state.map) return;
    ctx.clearRect(0, 0, state.radarCanvas.width, state.radarCanvas.height);

    if (!state.stationConfig || state.sparseCells.length === 0) return;

    const { centerLat, centerLon, cellScaleMiles } = state.stationConfig;
    const milesPerCell = cellScaleMiles || 3.1; // fallback ~50mi/16
    const milesToDegLat = 1 / 69.0;
    const degLatPerCell = milesPerCell * milesToDegLat;
    const degLonPerCell =
      milesPerCell / (69.172 * Math.cos((centerLat * Math.PI) / 180));

    const gridOriginLat = centerLat + (GRID_SIZE / 2) * degLatPerCell;
    const gridOriginLon = centerLon - (GRID_SIZE / 2) * degLonPerCell;

    for (const cell of state.sparseCells) {
      const gx = cell.cellIndex % GRID_SIZE;
      const gy = Math.floor(cell.cellIndex / GRID_SIZE);

      const cellLatTop = gridOriginLat - gy * degLatPerCell;
      const cellLatBottom = cellLatTop - degLatPerCell;
      const cellLonLeft = gridOriginLon + gx * degLonPerCell;
      const cellLonRight = cellLonLeft + degLonPerCell;

      const p1 = state.map.latLngToContainerPoint([cellLatTop, cellLonLeft]);
      const p2 = state.map.latLngToContainerPoint([cellLatBottom, cellLonRight]);

      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);

      ctx.fillStyle = dbzColor(cell.dbz);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.strokeRect(x, y, w, h);
    }
  }

  // ------------------------------------------------------------------
  // GPS "You Are Here" pulsing marker
  // ------------------------------------------------------------------
  function updateGpsMarker(lat, lon) {
    state.userLocation = { lat, lon };
    saveLocal("loradar.lastLocation", state.userLocation);

    if (!state.map) return;

    if (!state.gpsMarker) {
      const icon = L.divIcon({
        className: "",
        html: '<div class="gps-pulse-wrap"><div class="gps-pulse-ring"></div><div class="gps-pulse-core"></div></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      state.gpsMarker = L.marker([lat, lon], { icon, interactive: false }).addTo(state.map);
    } else {
      state.gpsMarker.setLatLng([lat, lon]);
    }
  }

  function startGpsWatch() {
    if (!("geolocation" in navigator)) {
      toast("Geolocation not supported on this device.");
      return;
    }
    if (state.watchId !== null) return;
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        updateGpsMarker(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        console.warn("GPS error", err);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  // ------------------------------------------------------------------
  // Binary frame parsing
  // ------------------------------------------------------------------
  function handleIncomingFrame(bytes) {
    if (!bytes || bytes.length < 2) return;
    const header = bytes[0];

    if (header === FRAME_CONFIG) {
      parseConfigFrame(bytes);
    } else if (header === FRAME_RADAR) {
      parseRadarFrame(bytes);
    }
    // Unknown headers are silently ignored (forward compatibility).
  }

  function parseConfigFrame(bytes) {
    // Byte 0: 0xCF | Bytes 1-4: station id ASCII | Bytes 5-6: lat*100 (int16 BE)
    // Bytes 7-8: lon*100 (int16 BE) | Byte 9: cell scale miles | Byte 10: region hash
    // Byte 11: CRC8
    if (bytes.length < 12) return;
    const body = bytes.slice(0, 11);
    const crc = bytes[11];
    if (crc8(body) !== crc) {
      console.warn("0xCF frame CRC mismatch, discarding");
      return;
    }

    const stationId = String.fromCharCode(bytes[1], bytes[2], bytes[3], bytes[4]).replace(/-+$/, "");
    const dv = new DataView(new Uint8Array(bytes).buffer);
    const latScaled = dv.getInt16(5, false);
    const lonScaled = dv.getInt16(7, false);
    const cellScaleMiles = bytes[9];
    const regionHash = bytes[10];

    state.stationConfig = {
      stationId,
      centerLat: latScaled / 100,
      centerLon: lonScaled / 100,
      cellScaleMiles,
      regionHash,
    };
    saveLocal("loradar.stationConfig", state.stationConfig);

    $("#regionLabel").textContent = `${stationId || "Unknown"} · auto-configured`;

    // Re-center map to station grid if we haven't manually panned yet.
    if (state.map && !state._userPanned) {
      state.map.setView([state.stationConfig.centerLat, state.stationConfig.centerLon], 10);
    }

    drawRadarOverlay();
  }

  function parseRadarFrame(bytes) {
    // Byte 0: 0x10 | Byte 1: seq | Byte 2: N | N*(cellIndex,dbz) | CRC8
    if (bytes.length < 4) return;
    const n = bytes[2];
    const expectedLen = 3 + 2 * n + 1;
    if (bytes.length < expectedLen) {
      console.warn("0x10 frame truncated");
      return;
    }
    const body = bytes.slice(0, expectedLen - 1);
    const crc = bytes[expectedLen - 1];
    if (crc8(body) !== crc) {
      console.warn("0x10 frame CRC mismatch, discarding");
      return;
    }

    const cells = [];
    let severeDetected = false;
    for (let i = 0; i < n; i++) {
      const cellIndex = bytes[3 + i * 2];
      const dbz = bytes[3 + i * 2 + 1];
      cells.push({ cellIndex, dbz });
      if (dbz >= 55) severeDetected = true;
    }

    state.sparseCells = cells;
    state.lastUpdateTs = Date.now();
    $("#lastUpdate").textContent = `Radar updated ${new Date(state.lastUpdateTs).toLocaleTimeString()} · ${n} active cells`;

    drawRadarOverlay();

    if (severeDetected) {
      playAlertTone();
      toast("⚠ Severe reflectivity detected nearby (55+ dBZ)");
    }
  }

  // ------------------------------------------------------------------
  // Audio alert
  // ------------------------------------------------------------------
  function ensureAudioCtx() {
    if (!state.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new Ctx();
    }
    return state.audioCtx;
  }

  function playAlertTone() {
    try {
      const ctx = ensureAudioCtx();
      const now = ctx.currentTime;
      [880, 660, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.25);
        gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.25 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.25 + 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.25);
        osc.stop(now + i * 0.25 + 0.24);
      });
    } catch (e) {
      console.warn("Audio alert failed", e);
    }
  }

  // ------------------------------------------------------------------
  // Transports: WebBluetooth (NUS) + WebSerial
  // ------------------------------------------------------------------
  function setConnected(isConnected) {
    state.connected = isConnected;
    $("#connDot").classList.toggle("connected", isConnected);
    $("#reconnectBtn").textContent = isConnected ? "Disconnect" : "Connect";
  }

  // Frames arrive as: [length_byte, ...frame_bytes] over the raw stream
  // (matches server.py's simple length-prefixed serial framing). We buffer
  // incoming bytes and slice out complete frames.
  function feedBytes(newBytes) {
    for (const b of newBytes) state.rxBuffer.push(b);

    while (state.rxBuffer.length >= 1) {
      const len = state.rxBuffer[0];
      if (len === 0 || len > 64) {
        // Not a valid length prefix — resync by dropping a byte.
        state.rxBuffer.shift();
        continue;
      }
      if (state.rxBuffer.length < 1 + len) break; // wait for more data

      const frame = state.rxBuffer.slice(1, 1 + len);
      state.rxBuffer = state.rxBuffer.slice(1 + len);
      handleIncomingFrame(frame);
    }
  }

  async function connectBluetooth() {
    if (!navigator.bluetooth) {
      toast("WebBluetooth not supported in this browser.");
      return;
    }
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE_UUID] }],
        optionalServices: [NUS_SERVICE_UUID],
      });
      state.bleDevice = device;
      device.addEventListener("gattserverdisconnected", () => {
        setConnected(false);
        toast("MeshCore node disconnected.");
      });

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE_UUID);
      const txChar = await service.getCharacteristic(NUS_TX_CHAR_UUID);
      state.bleChar = txChar;

      await txChar.startNotifications();
      txChar.addEventListener("characteristicvaluechanged", (event) => {
        const value = event.target.value; // DataView
        const bytes = new Uint8Array(value.buffer);
        feedBytes(bytes);
      });

      setConnected(true);
      toast("Connected via WebBluetooth (NUS).");
    } catch (err) {
      console.error(err);
      toast(`Bluetooth connect failed: ${err.message || err}`);
    }
  }

  async function connectSerial() {
    if (!navigator.serial) {
      toast("WebSerial not supported in this browser.");
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      state.serialPort = port;

      setConnected(true);
      toast("Connected via WebSerial (USB).");

      const reader = port.readable.getReader();
      state.serialReader = reader;

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) feedBytes(value);
          }
        } catch (e) {
          console.warn("Serial read loop ended", e);
        } finally {
          setConnected(false);
        }
      })();
    } catch (err) {
      console.error(err);
      toast(`Serial connect failed: ${err.message || err}`);
    }
  }

  async function disconnectTransport() {
    if (state.transport === "bluetooth" && state.bleDevice && state.bleDevice.gatt.connected) {
      state.bleDevice.gatt.disconnect();
    }
    if (state.transport === "serial" && state.serialPort) {
      try {
        if (state.serialReader) {
          await state.serialReader.cancel();
        }
        await state.serialPort.close();
      } catch (e) { /* ignore */ }
    }
    setConnected(false);
  }

  async function connectUsingSavedTransport() {
    const transport = loadLocal("loradar.transport");
    state.transport = transport;
    if (transport === "bluetooth") await connectBluetooth();
    else if (transport === "serial") await connectSerial();
  }

  // ------------------------------------------------------------------
  // Onboarding wizard
  // ------------------------------------------------------------------
  const Wizard = {
    currentStep: 1,
    chosenTransport: null,
    chosenLocation: null,

    init() {
      this.updateSupportHints();
      this.bindEvents();
      this.showStep(1);
    },

    updateSupportHints() {
      const hasBluetooth = !!navigator.bluetooth;
      const hasSerial = !!navigator.serial;
      const hint = $("#transportSupportHint");
      if (!hasBluetooth && !hasSerial) {
        hint.textContent = "⚠ This browser supports neither WebBluetooth nor WebSerial. Try Chrome/Edge on Android or Desktop.";
      } else {
        hint.textContent = `WebBluetooth: ${hasBluetooth ? "available" : "unavailable"} · WebSerial: ${hasSerial ? "available" : "unavailable"}`;
      }
    },

    showStep(n) {
      this.currentStep = n;
      $all(".wizStep").forEach((el) => el.classList.add("hidden"));
      $(`#step${n}`).classList.remove("hidden");
      $all("#stepDots span").forEach((dot) => {
        const step = parseInt(dot.dataset.step, 10);
        dot.classList.toggle("active", step === n);
        dot.classList.toggle("done", step < n);
      });
    },

    bindEvents() {
      // Step 1: transport selection
      $all("#step1 .optionBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
          $all("#step1 .optionBtn").forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          this.chosenTransport = btn.dataset.transport;
          $("#step1Next").disabled = false;
        });
      });
      $("#step1Next").addEventListener("click", async () => {
        saveLocal("loradar.transport", this.chosenTransport);
        state.transport = this.chosenTransport;
        if (this.chosenTransport === "bluetooth") await connectBluetooth();
        else await connectSerial();
        this.showStep(2);
      });

      // Step 2: location
      $("#useGpsBtn").addEventListener("click", () => {
        $all("#step2 .optionBtn").forEach((b) => b.classList.remove("selected"));
        $("#useGpsBtn").classList.add("selected");
        $("#manualLocationFields").classList.add("hidden");
        $("#locationStatusHint").textContent = "Requesting GPS permission...";

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            this.chosenLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, source: "gps" };
            $("#locationStatusHint").textContent = `Located: ${this.chosenLocation.lat.toFixed(4)}, ${this.chosenLocation.lon.toFixed(4)}`;
            $("#step2Next").disabled = false;
          },
          (err) => {
            $("#locationStatusHint").textContent = `GPS failed: ${err.message}. Try manual entry.`;
          },
          { enableHighAccuracy: true, timeout: 15000 }
        );
      });

      $("#useManualBtn").addEventListener("click", () => {
        $all("#step2 .optionBtn").forEach((b) => b.classList.remove("selected"));
        $("#useManualBtn").classList.add("selected");
        $("#manualLocationFields").classList.remove("hidden");
        $("#step2Next").disabled = false;
      });

      $("#step2Back").addEventListener("click", () => this.showStep(1));
      $("#step2Next").addEventListener("click", async () => {
        if (!this.chosenLocation) {
          const lat = parseFloat($("#latInput").value);
          const lon = parseFloat($("#lonInput").value);
          if (!isNaN(lat) && !isNaN(lon)) {
            this.chosenLocation = { lat, lon, source: "manual" };
          } else {
            const zip = $("#zipInput").value.trim();
            if (!zip) {
              toast("Enter a ZIP/city or lat/lon.");
              return;
            }
            try {
              $("#locationStatusHint").textContent = "Geocoding...";
              const resp = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(zip)}&format=json&limit=1`
              );
              const results = await resp.json();
              if (!results.length) throw new Error("No match found");
              this.chosenLocation = {
                lat: parseFloat(results[0].lat),
                lon: parseFloat(results[0].lon),
                source: "geocoded",
              };
            } catch (e) {
              $("#locationStatusHint").textContent = `Geocoding failed: ${e.message}`;
              return;
            }
          }
        }
        saveLocal("loradar.lastLocation", this.chosenLocation);
        this.showStep(3);
      });

      // Step 3: tile download
      $("#downloadTilesBtn").addEventListener("click", async () => {
        const loc = this.chosenLocation || loadLocal("loradar.lastLocation");
        if (!loc) { toast("No location set."); return; }
        $("#downloadTilesBtn").disabled = true;
        try {
          await downloadTilesForLocation(loc.lat, loc.lon, (done, total) => {
            $("#tileProgress").max = total;
            $("#tileProgress").value = done;
            $("#tileProgressLabel").textContent = `${done} / ${total} tiles`;
          });
          toast("Offline tiles downloaded.");
          $("#step3Next").disabled = false;
        } catch (e) {
          toast(`Tile download error: ${e.message}`);
        } finally {
          $("#downloadTilesBtn").disabled = false;
        }
      });
      $("#skipTilesBtn").addEventListener("click", () => this.showStep(4));
      $("#step3Back").addEventListener("click", () => this.showStep(2));
      $("#step3Next").addEventListener("click", () => this.showStep(4));

      // Step 4: audio test + finish
      $("#playTestSoundBtn").addEventListener("click", () => playAlertTone());
      $("#step4Back").addEventListener("click", () => this.showStep(3));
      $("#finishSetupBtn").addEventListener("click", () => this.finish());
    },

    finish() {
      saveLocal("loradar.onboarded", true);
      $("#onboarding").classList.add("hidden");
      bootMainApp();
    },
  };

  // ------------------------------------------------------------------
  // Boot sequence
  // ------------------------------------------------------------------
  function bootMainApp() {
    const savedLocation = loadLocal("loradar.lastLocation");
    const savedConfig = loadLocal("loradar.stationConfig");
    const lat = savedLocation ? savedLocation.lat : 36.16;
    const lon = savedLocation ? savedLocation.lon : -86.78;

    if (savedConfig) {
      state.stationConfig = savedConfig;
      $("#regionLabel").textContent = `${savedConfig.stationId || "Unknown"} · cached config`;
    }

    initMap(lat, lon);
    startGpsWatch();

    if (savedLocation) updateGpsMarker(savedLocation.lat, savedLocation.lon);

    connectUsingSavedTransport();

    $("#reconnectBtn").addEventListener("click", async () => {
      if (state.connected) await disconnectTransport();
      else await connectUsingSavedTransport();
    });

    $("#settingsBtn").addEventListener("click", () => {
      $("#onboarding").classList.remove("hidden");
      Wizard.showStep(1);
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const onboarded = loadLocal("loradar.onboarded", false);
    Wizard.init();
    if (onboarded) {
      $("#onboarding").classList.add("hidden");
      bootMainApp();
    }
  });
})();
