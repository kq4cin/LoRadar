/* ==========================================================================
   LoRadar PWA Client — app.js
   Off-grid weather radar renderer for MeshCore LoRa mesh networks.
   ==========================================================================
   Responsibilities:
     - First-run onboarding wizard (transport, channel, location, offline
       tiles, audio)
     - IndexedDB-backed offline map tile cache + custom Leaflet TileLayer
     - Real MeshCore companion-radio protocol (via the official meshcore.js
       library) over WebBluetooth (BLE/NUS) or WebSerial, listening for
       channel text messages on a user-selected channel
     - Binary frame parsing: 0xCF (config) and 0x10 (sparse radar) frames,
       hex-decoded out of the channel message text sent by server.py
     - Canvas overlay rendering of the 16x16 reflectivity grid
     - Live GPS "You Are Here" pulsing marker
   ========================================================================== */

import {
  WebBleConnection,
  WebSerialConnection,
  Constants as MeshCoreConstants,
} from "https://esm.sh/@liamcottle/meshcore.js@1.15.0";

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

  function hexToBytes(hex) {
    const clean = (hex || "").trim();
    if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
      return null;
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
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
    channel: 0, // MeshCore channel index radar frames are expected on
    mcConnection: null, // active meshcore.js Connection instance
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
  // MeshCore channel text message -> LoRadar frame bridge
  // ------------------------------------------------------------------
  // server.py sends frames as hex-encoded text on a specific MeshCore
  // channel via `meshcore-cli chan <n> <hex>`. We only accept messages on
  // the channel the user configured in the wizard.
  //
  // IMPORTANT: stock MeshCore companion firmware (BaseChatMesh::sendGroupMessage)
  // always prepends "<sender node name>: " to the text of every channel
  // message it sends — this is baked into the firmware, not something
  // server.py can disable. So the text we receive looks like
  // "MyBaseNode: cf4b4f4858..." rather than a bare hex string. We extract
  // the trailing run of hex characters (the sender-name prefix always ends
  // in a non-hex ": " separator) before hex-decoding, then CRC8-validate
  // the result — this also guards against accidentally parsing unrelated
  // human chat text on the same channel.
  const TRAILING_HEX_RUN = /[0-9a-fA-F]+$/;

  function handleChannelMessage(channelMessage) {
    if (channelMessage.channelIdx !== state.channel) {
      return; // not our configured LoRadar channel; ignore (e.g. Public chat)
    }
    const match = (channelMessage.text || "").match(TRAILING_HEX_RUN);
    if (!match) {
      return; // no hex payload found (probably a human chat message)
    }
    const bytes = hexToBytes(match[0]);
    if (!bytes || bytes.length < 2) {
      return; // not a valid hex-encoded LoRadar frame
    }
    handleIncomingFrame(bytes);
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
  // Transport: real MeshCore companion protocol via meshcore.js
  // ------------------------------------------------------------------
  // We use the official meshcore.js library (WebBleConnection /
  // WebSerialConnection) instead of hand-parsing raw NUS/serial bytes,
  // since stock MeshCore companion firmware speaks its own structured
  // command/response protocol, not a raw byte pipe. This also gives us
  // proper per-channel message delivery matching whatever channel the user
  // configured in the wizard (see handleChannelMessage above).
  function setConnected(isConnected) {
    state.connected = isConnected;
    $("#connDot").classList.toggle("connected", isConnected);
    $("#reconnectBtn").textContent = isConnected ? "Disconnect" : "Connect";
  }

  const RC = MeshCoreConstants.ResponseCodes;

  // The companion protocol has no request IDs: replies (ChannelInfo, Ok, Err,
  // ...) are matched to requests purely by arrival order. Running two
  // command sequences at once (e.g. the message pump and channel discovery)
  // lets one steal the other's replies, so every command sequence we issue
  // goes through this single-flight queue.
  let radioQueue = Promise.resolve();
  function withRadio(fn) {
    const run = radioQueue.then(fn, fn);
    radioQueue = run.catch(() => {});
    return run;
  }

  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // Drains any messages queued on the node (contact msgs, channel msgs,
  // channel data) via the companion protocol's sync-next-message command,
  // routing channel text messages into handleChannelMessage. Called once
  // right after connecting, and again whenever the node pushes a
  // "message waiting" notification.
  let pumpPending = false;
  function pumpMessages(connection) {
    if (pumpPending) return; // a queued pump will pick up the new message too
    pumpPending = true;
    return withRadio(async () => {
      pumpPending = false;
      try {
        for (let i = 0; i < 256; i++) {
          const msg = await withTimeout(connection.syncNextMessage(), 5000, "SyncNextMessage");
          if (!msg) break;
          if (msg.channelMessage) handleChannelMessage(msg.channelMessage);
          // contactMessage / channelData results are outside LoRadar's scope
          // (direct messages, binary datagrams) and are ignored here.
        }
      } catch (e) {
        console.warn("pumpMessages failed", e);
      }
    });
  }

  async function wireConnection(connection) {
    state.mcConnection = connection;

    connection.on("disconnected", () => {
      setConnected(false);
      toast("MeshCore node disconnected.");
    });

    connection.on(MeshCoreConstants.PushCodes.MsgWaiting, () => pumpMessages(connection));
  }

  // Resolves once the node completes its "connected" handshake (or rejects
  // on timeout), performing the one-time app-start handshake + initial
  // message drain. Registered with `.on` (not `.once`) so it also re-runs
  // correctly if the underlying transport reconnects later.
  function waitForConnected(connection, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Timed out waiting for MeshCore node handshake"));
        }
      }, timeoutMs);

      connection.on("connected", async () => {
        clearTimeout(timer);
        setConnected(true);
        await withRadio(async () => {
          try {
            await connection.getSelfInfo(8000); // required handshake (CMD_APP_START)
          } catch (e) {
            console.warn("getSelfInfo handshake failed/timed out", e);
          }
        });
        pumpMessages(connection);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  async function connectBluetooth() {
    if (!navigator.bluetooth) {
      toast("WebBluetooth not supported in this browser.");
      return false;
    }
    try {
      const connection = await WebBleConnection.open();
      if (!connection) return false;
      await wireConnection(connection);
      await waitForConnected(connection);
      toast("Connected to MeshCore node via WebBluetooth.");
      return true;
    } catch (err) {
      console.error(err);
      toast(`Bluetooth connect failed: ${err.message || err}`);
      return false;
    }
  }

  async function connectSerial() {
    if (!navigator.serial) {
      toast("WebSerial not supported in this browser.");
      return false;
    }
    try {
      const connection = await WebSerialConnection.open();
      if (!connection) return false;
      await wireConnection(connection);
      await waitForConnected(connection);
      toast("Connected to MeshCore node via WebSerial.");
      return true;
    } catch (err) {
      console.error(err);
      toast(`Serial connect failed: ${err.message || err}`);
      return false;
    }
  }

  async function disconnectTransport() {
    if (state.mcConnection) {
      try {
        await state.mcConnection.close();
      } catch (e) { /* ignore */ }
      state.mcConnection = null;
    }
    setConnected(false);
  }

  async function connectUsingSavedTransport() {
    const transport = loadLocal("loradar.transport");
    state.transport = transport;
    let ok = false;
    if (transport === "bluetooth") ok = await connectBluetooth();
    else if (transport === "serial") ok = await connectSerial();
    if (ok) verifySavedChannel(state.mcConnection);
    return ok;
  }

  // ------------------------------------------------------------------
  // MeshCore channel discovery / creation
  // ------------------------------------------------------------------
  // We talk to the channel commands directly instead of using meshcore.js's
  // getChannels(): that helper walks every slot until the node returns an
  // error, but current firmware answers for *every* slot up to
  // MAX_GROUP_CHANNELS (often 40) even when empty, it has no per-request
  // timeout, and its once()/off() pairing leaks Err listeners — which made
  // discovery routinely blow past our old 6s cap and report "no channels".
  const MAX_PROBE_CHANNELS = 64;
  const CHANNEL_NAME_MAX_BYTES = 31; // 32-byte field incl. NUL terminator

  function bytesToHex(bytes) {
    return Array.from(bytes || [], (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function isZeroBytes(bytes) {
    return !bytes || Array.prototype.every.call(bytes, (b) => b === 0);
  }

  // Sends one command and resolves with the first matching reply event.
  // Resolves null on Err (e.g. ERR_CODE_NOT_FOUND), rejects on timeout.
  function radioRequest(connection, send, successCode, timeoutMs, accept = () => true) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        connection.off(successCode, onSuccess);
        connection.off(RC.Err, onErr);
      };
      const onSuccess = (resp) => {
        if (!accept(resp)) return;
        cleanup();
        resolve(resp || {});
      };
      const onErr = () => { cleanup(); resolve(null); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Node did not respond")); }, timeoutMs);
      connection.on(successCode, onSuccess);
      connection.on(RC.Err, onErr);
      Promise.resolve(send()).catch((e) => { cleanup(); reject(e); });
    });
  }

  function readChannel(connection, idx, timeoutMs = 3000) {
    return radioRequest(
      connection,
      () => connection.sendCommandGetChannel(idx),
      RC.ChannelInfo,
      timeoutMs,
      (info) => info && info.channelIdx === idx
    );
  }

  async function writeChannel(connection, idx, name, secret) {
    const ok = await radioRequest(
      connection,
      () => connection.sendCommandSetChannel(idx, name, secret),
      RC.Ok,
      5000
    );
    if (!ok) throw new Error(`Node rejected channel slot ${idx}`);
  }

  // Firmware v3+ reports MAX_GROUP_CHANNELS in the DeviceInfo reply (the
  // byte meshcore.js exposes as reserved[1]). Returns null when unknown.
  async function queryMaxChannels(connection) {
    try {
      const info = await radioRequest(
        connection,
        () => connection.sendCommandDeviceQuery(MeshCoreConstants.SupportedCompanionProtocolVersion),
        RC.DeviceInfo,
        3000
      );
      if (info && info.firmwareVer >= 3 && info.reserved && info.reserved[1] > 0) {
        return info.reserved[1];
      }
    } catch (e) { /* fall back to probing */ }
    return null;
  }

  async function hashtagSecret(name) {
    if (!(window.crypto && crypto.subtle)) {
      throw new Error("Secure context (HTTPS) required to derive channel keys");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
    return new Uint8Array(digest).slice(0, 16);
  }

  // "#LoRadar", "LoRadar", "##LoRadar " -> "#LoRadar". Returns null if invalid.
  function normalizeHashtagName(raw) {
    const body = (raw || "").trim().replace(/^#+/, "").trim();
    if (!body || /\s/.test(body)) return null;
    const name = `#${body}`;
    if (new TextEncoder().encode(name).length > CHANNEL_NAME_MAX_BYTES) return null;
    return name;
  }

  // Reads every channel slot on the node. Returns
  // { slots: [{idx, name, secret, secretHex, empty, hashtag}], partial }
  // or null if the node didn't answer at all.
  function discoverChannels(connection, onProgress = () => {}) {
    return withRadio(async () => {
      const max = (await queryMaxChannels(connection)) || MAX_PROBE_CHANNELS;
      const slots = [];
      let partial = false;
      for (let idx = 0; idx < max; idx++) {
        onProgress(idx, max);
        let info;
        try {
          info = await readChannel(connection, idx);
        } catch (e) {
          try {
            info = await readChannel(connection, idx); // one retry for flaky BLE
          } catch (e2) {
            partial = true;
            break;
          }
        }
        if (!info) break; // ERR_CODE_NOT_FOUND => past the last slot
        const name = info.name || "";
        const secret = info.secret || new Uint8Array(16);
        const empty = !name && isZeroBytes(secret);
        let hashtag = false;
        if (name.startsWith("#")) {
          try {
            hashtag = bytesToHex(await hashtagSecret(name)) === bytesToHex(secret);
          } catch (e) { /* no crypto.subtle */ }
        }
        slots.push({ idx, name, secret, secretHex: bytesToHex(secret), empty, hashtag });
      }
      if (slots.length === 0 && partial) return null;
      return { slots, partial };
    });
  }

  function channelLabel(ch) {
    if (ch.name) return ch.name;
    return ch.idx === 0 ? "Public" : "(unnamed)";
  }

  // Finds an existing #channel on the node (matched by key, so it works even
  // if the slot was named differently) or writes it into the first free slot.
  // Returns {idx, name, secretHex, created}.
  async function ensureHashtagChannel(connection, rawName, knownSlots = null) {
    const name = normalizeHashtagName(rawName);
    if (!name) throw new Error("Enter a channel name like #LoRadar (no spaces, max 30 chars)");
    const secret = await hashtagSecret(name);
    const secretHex = bytesToHex(secret);

    let slots = knownSlots;
    if (!slots) {
      const result = await discoverChannels(connection);
      if (!result) throw new Error("Could not read channels from the node");
      slots = result.slots;
    }

    const existing = slots.find((s) => s.secretHex === secretHex);
    if (existing) return { idx: existing.idx, name: existing.name || name, secretHex, created: false };

    const free = slots.find((s) => s.empty && s.idx !== 0);
    if (!free) throw new Error("No free channel slots on the node — delete one in the MeshCore app");

    await withRadio(async () => {
      await writeChannel(connection, free.idx, name, secret);
      const check = await readChannel(connection, free.idx);
      if (!check || bytesToHex(check.secret) !== secretHex) {
        throw new Error("Node did not save the channel");
      }
    });
    return { idx: free.idx, name, secretHex, created: true };
  }

  function applyChannelSelection(ch) {
    state.channel = ch.idx;
    saveLocal("loradar.channel", ch);
    if (!state.stationConfig) {
      $("#regionLabel").textContent = `Listening on ch ${ch.idx} (${channelLabel(ch)})`;
    }
  }

  // Slot indices shift if the user deletes/reorders channels in the MeshCore
  // app, so on each (re)connect we confirm the saved channel is still where
  // we think it is, relocating (or re-adding a #channel) if it moved.
  async function verifySavedChannel(connection) {
    const saved = loadLocal("loradar.channel");
    if (!connection || !saved || !saved.secretHex) return;
    try {
      const current = await withRadio(() => readChannel(connection, saved.idx));
      if (current && bytesToHex(current.secret) === saved.secretHex) return;

      const result = await discoverChannels(connection);
      if (!result) return;
      const moved = result.slots.find((s) => s.secretHex === saved.secretHex);
      if (moved) {
        applyChannelSelection({ ...saved, idx: moved.idx });
        toast(`${channelLabel(saved)} found on ch ${moved.idx}.`);
        return;
      }
      if (saved.name && saved.name.startsWith("#")) {
        const ch = await ensureHashtagChannel(connection, saved.name, result.slots);
        applyChannelSelection({ idx: ch.idx, name: ch.name, secretHex: ch.secretHex });
        toast(`Re-added ${ch.name} to the node on ch ${ch.idx}.`);
        return;
      }
      toast(`Channel ${channelLabel(saved)} is no longer on the node — pick one in ⚙ settings.`, 5000);
    } catch (e) {
      console.warn("verifySavedChannel failed", e);
    }
  }

  // ------------------------------------------------------------------
  // Onboarding wizard
  // ------------------------------------------------------------------
  const Wizard = {
    currentStep: 1,
    chosenTransport: null,
    chosenChannel: null, // {idx, name, secretHex}
    channelSlots: null, // last discovered slots from the node
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

    // Queries the connected node for existing channels and renders them as
    // pickable buttons, plus a "join/create #channel" form; falls back to
    // manual number entry if discovery fails (e.g. node not responding).
    async loadChannelOptions() {
      const container = $("#channelListContainer");
      const statusHint = $("#channelStatusHint");
      const manualFields = $("#manualChannelFields");
      const createFields = $("#createChannelFields");
      container.innerHTML = "";
      this.chosenChannel = null;
      this.channelSlots = null;
      $("#step2Next").disabled = true;
      $("#rescanChannelsBtn").disabled = true;
      statusHint.textContent = "Reading channels from connected node...";

      if (!state.mcConnection || !state.connected) {
        statusHint.textContent = "Not connected to a node — enter the channel number manually.";
        manualFields.classList.remove("hidden");
        createFields.classList.add("hidden");
        $("#rescanChannelsBtn").disabled = false;
        return;
      }
      createFields.classList.remove("hidden");

      const result = await discoverChannels(state.mcConnection, (idx, max) => {
        statusHint.textContent = `Reading channels from connected node... (${idx + 1}/${max})`;
      });
      $("#rescanChannelsBtn").disabled = false;

      if (!result) {
        statusHint.textContent =
          "Could not read channels automatically. Join a #channel below or enter the " +
          "channel number manually (matching what you configured in the MeshCore companion app).";
        manualFields.classList.remove("hidden");
        return;
      }

      this.channelSlots = result.slots;
      const used = result.slots.filter((s) => !s.empty);
      const saved = loadLocal("loradar.channel");

      statusHint.textContent = used.length
        ? "Select the channel the LoRadar base station broadcasts on, or join a #channel below:"
        : "No channels configured on the node yet — join a #channel below.";
      if (result.partial) {
        statusHint.textContent += " (Node stopped responding part-way; list may be incomplete.)";
      }
      manualFields.classList.add("hidden");

      used.forEach((slot) => {
        const btn = document.createElement("button");
        btn.className = "channelBtn";
        btn.type = "button";
        const labelEl = document.createElement("span");
        labelEl.textContent = channelLabel(slot) + (slot.idx === 0 && slot.name === "Public" ? " (default)" : "");
        const idxEl = document.createElement("span");
        idxEl.className = "idx";
        idxEl.textContent = `ch ${slot.idx}`;
        btn.append(labelEl, idxEl);
        btn.addEventListener("click", () => this.selectChannel(btn, slot));
        container.appendChild(btn);
        if (saved && saved.secretHex && saved.secretHex === slot.secretHex) {
          this.selectChannel(btn, slot);
        }
      });

      // Still allow manual override even when discovery succeeds.
      const manualToggle = document.createElement("button");
      manualToggle.className = "btn ghost";
      manualToggle.type = "button";
      manualToggle.style.width = "100%";
      manualToggle.style.marginTop = "4px";
      manualToggle.textContent = "Enter channel number manually instead";
      manualToggle.addEventListener("click", () => {
        $all(".channelBtn").forEach((b) => b.classList.remove("selected"));
        this.chosenChannel = null;
        manualFields.classList.remove("hidden");
        $("#step2Next").disabled = false;
      });
      container.appendChild(manualToggle);
    },

    selectChannel(btn, slot) {
      $all(".channelBtn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      $("#manualChannelFields").classList.add("hidden");
      this.chosenChannel = { idx: slot.idx, name: slot.name || (slot.idx === 0 ? "Public" : ""), secretHex: slot.secretHex };
      $("#step2Next").disabled = false;
    },

    async joinHashtagChannel() {
      const btn = $("#createChannelBtn");
      const hint = $("#createChannelHint");
      if (!state.mcConnection || !state.connected) {
        hint.textContent = "Connect to a node first.";
        return;
      }
      btn.disabled = true;
      hint.textContent = "Adding channel to node...";
      try {
        const ch = await ensureHashtagChannel(state.mcConnection, $("#createChannelInput").value, this.channelSlots);
        const chosen = { idx: ch.idx, name: ch.name, secretHex: ch.secretHex };
        saveLocal("loradar.channel", chosen);
        await this.loadChannelOptions();
        if (!this.chosenChannel || this.chosenChannel.secretHex !== ch.secretHex) {
          this.chosenChannel = chosen; // list refresh failed; keep the result anyway
          $("#step2Next").disabled = false;
        }
        hint.textContent = ch.created
          ? `Added ${ch.name} to the node on ch ${ch.idx} and selected it.`
          : `${ch.name} already exists on ch ${ch.idx} — selected it.`;
      } catch (e) {
        hint.textContent = e.message || String(e);
      } finally {
        btn.disabled = false;
      }
    },

    bindEvents() {
      // Step 1: transport selection + connect
      $all("#step1 .optionBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
          $all("#step1 .optionBtn").forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          this.chosenTransport = btn.dataset.transport;
          $("#step1Next").disabled = false;
        });
      });
      $("#step1Next").addEventListener("click", async () => {
        const btn = $("#step1Next");
        const statusHint = $("#connectStatusHint");
        saveLocal("loradar.transport", this.chosenTransport);

        // Re-running setup from ⚙ while already connected: reuse the link.
        if (state.connected && state.mcConnection && state.transport === this.chosenTransport) {
          this.showStep(2);
          this.loadChannelOptions();
          return;
        }
        if (state.connected) await disconnectTransport();

        btn.disabled = true;
        statusHint.textContent = "Connecting to MeshCore node...";
        state.transport = this.chosenTransport;

        const ok = this.chosenTransport === "bluetooth" ? await connectBluetooth() : await connectSerial();
        btn.disabled = false;
        if (!ok) {
          statusHint.textContent = "Connection failed — check your device and try again.";
          return;
        }
        statusHint.textContent = "";
        this.showStep(2);
        this.loadChannelOptions();
      });

      // Step 2: channel selection / #channel creation
      $("#step2Back").addEventListener("click", () => this.showStep(1));
      $("#rescanChannelsBtn").addEventListener("click", () => this.loadChannelOptions());
      $("#createChannelBtn").addEventListener("click", () => this.joinHashtagChannel());
      $("#createChannelInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.joinHashtagChannel();
      });
      $("#channelNumberInput").addEventListener("input", () => {
        $all(".channelBtn").forEach((b) => b.classList.remove("selected"));
        this.chosenChannel = null;
        $("#step2Next").disabled = $("#channelNumberInput").value.trim() === "";
      });
      $("#step2Next").addEventListener("click", () => {
        if (!this.chosenChannel) {
          const idx = parseInt($("#channelNumberInput").value, 10);
          const maxIdx = this.channelSlots && this.channelSlots.length ? this.channelSlots.length - 1 : MAX_PROBE_CHANNELS - 1;
          if (isNaN(idx) || idx < 0 || idx > maxIdx) {
            toast(`Enter a valid channel number (0-${maxIdx}).`);
            return;
          }
          const name = $("#channelNameInput").value.trim();
          const slot = this.channelSlots && this.channelSlots.find((s) => s.idx === idx);
          this.chosenChannel = {
            idx,
            name: name || (slot && slot.name) || (idx === 0 ? "Public" : ""),
            secretHex: slot && !slot.empty ? slot.secretHex : undefined,
          };
        }
        applyChannelSelection(this.chosenChannel);
        this.showStep(3);
      });

      // Step 3: location
      $("#useGpsBtn").addEventListener("click", () => {
        $all("#step3 .optionBtn").forEach((b) => b.classList.remove("selected"));
        $("#useGpsBtn").classList.add("selected");
        $("#manualLocationFields").classList.add("hidden");
        $("#locationStatusHint").textContent = "Requesting GPS permission...";

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            this.chosenLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, source: "gps" };
            $("#locationStatusHint").textContent = `Located: ${this.chosenLocation.lat.toFixed(4)}, ${this.chosenLocation.lon.toFixed(4)}`;
            $("#step3Next").disabled = false;
          },
          (err) => {
            $("#locationStatusHint").textContent = `GPS failed: ${err.message}. Try manual entry.`;
          },
          { enableHighAccuracy: true, timeout: 15000 }
        );
      });

      $("#useManualBtn").addEventListener("click", () => {
        $all("#step3 .optionBtn").forEach((b) => b.classList.remove("selected"));
        $("#useManualBtn").classList.add("selected");
        $("#manualLocationFields").classList.remove("hidden");
        $("#step3Next").disabled = false;
      });

      $("#step3Back").addEventListener("click", () => this.showStep(2));
      $("#step3Next").addEventListener("click", async () => {
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
        this.showStep(4);
      });

      // Step 4: tile download
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
          $("#step4Next").disabled = false;
        } catch (e) {
          toast(`Tile download error: ${e.message}`);
        } finally {
          $("#downloadTilesBtn").disabled = false;
        }
      });
      $("#skipTilesBtn").addEventListener("click", () => this.showStep(5));
      $("#step4Back").addEventListener("click", () => this.showStep(3));
      $("#step4Next").addEventListener("click", () => this.showStep(5));

      // Step 5: audio test + finish
      $("#playTestSoundBtn").addEventListener("click", () => playAlertTone());
      $("#step5Back").addEventListener("click", () => this.showStep(4));
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
    const savedChannel = loadLocal("loradar.channel", { idx: 0, name: "Public" });
    const lat = savedLocation ? savedLocation.lat : 36.16;
    const lon = savedLocation ? savedLocation.lon : -86.78;

    state.channel = savedChannel.idx;

    if (savedConfig) {
      state.stationConfig = savedConfig;
      $("#regionLabel").textContent = `${savedConfig.stationId || "Unknown"} · cached config`;
    } else {
      $("#regionLabel").textContent = `Listening on ch ${savedChannel.idx} (${channelLabel(savedChannel)})`;
    }

    // Re-running the wizard from ⚙ calls this again; the map, listeners and
    // (usually) the radio link already exist, so only refresh what changed.
    if (state.map) {
      if (savedLocation && !state._userPanned) state.map.setView([savedLocation.lat, savedLocation.lon], 10);
      if (!state.connected) connectUsingSavedTransport();
      return;
    }

    initMap(lat, lon);
    startGpsWatch();

    if (savedLocation) updateGpsMarker(savedLocation.lat, savedLocation.lon);

    if (state.connected) verifySavedChannel(state.mcConnection);
    else connectUsingSavedTransport();

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
