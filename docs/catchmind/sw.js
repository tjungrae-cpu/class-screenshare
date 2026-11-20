/* 햇반 그림퀴즈 — 오프라인 대비 (네트워크 우선, 안 되면 저장해 둔 화면) */
const CACHE = 'hcm-1.0.0';
const CORE = [
  './', './index.html', './teacher.html', './student.html', './style.css',
  './common.js', './teacher.js', './student.js', './words.js',
  './vendor/peerjs.min.js', './vendor/qrcode.js', './icon.svg', './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin', signal: ctrl.signal });
      clearTimeout(timer);
      if (res && res.ok) {
        const copy = res.clone();
        const key = url.origin + url.pathname;
        caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      const hit = await caches.match(url.origin + url.pathname) || await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
