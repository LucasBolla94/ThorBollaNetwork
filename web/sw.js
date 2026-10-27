// =========================================================================
// Service worker do Thor.
//
// Deliberadamente conservador. Um service worker agressivo e a forma mais
// rapida de quebrar um PWA de forma permanente: ele passa a servir a versao
// velha para sempre e o usuario nao tem como saber. Por isso aqui:
//
//   - a rede vem primeiro em tudo; o cache e so rede de seguranca offline
//   - /api e /ws nunca passam por cache
//   - trocar VERSION limpa todo cache antigo e assume o controle na hora
// =========================================================================

const VERSION = '__VERSAO__';
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/hud.js',
  '/neural.js',
  '/voz.js',
  '/voz-captura.js',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // Navegacao: rede primeiro, casca do cache se estiver offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html').then((r) => r ?? new Response('offline', { status: 503 })),
      ),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r ?? new Response('', { status: 504 }))),
  );
});
