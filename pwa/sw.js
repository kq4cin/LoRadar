/* LoRadar Service Worker
 * Handles PWA offline asset caching for the app shell (HTML/JS/CSS/Leaflet).
 * Map tiles are cached separately in IndexedDB by app.js (TileDB), NOT here,
 * since tiles need custom key-based lookup/versioning independent of the
 * Cache API's URL matching.
 */

const CACHE_NAME = "loradar-shell-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://esm.sh/@liamcottle/meshcore.js@1.15.0",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache each asset individually so a single failure (e.g. offline
      // first install with no network) doesn't abort the whole install.
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn("[SW] failed to cache", url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never intercept OSM tile requests or Nominatim/weather API calls — those
  // are handled explicitly by app.js via IndexedDB + fetch fallbacks.
  if (
    req.url.includes("tile.openstreetmap.org") ||
    req.url.includes("nominatim.openstreetmap.org") ||
    req.url.includes("api.weather.gov")
  ) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          // Opportunistically cache successfully fetched app-shell assets.
          if (resp && resp.status === 200 && req.method === "GET") {
            const respClone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, respClone));
          }
          return resp;
        })
        .catch(() => {
          // Offline and not cached: for navigations, fall back to the
          // cached app shell root so the SPA still boots.
          if (req.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("", { status: 504, statusText: "Offline" });
        });
    })
  );
});
