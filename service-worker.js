const CACHE_NAME = 'ailabs-cache-v2'; // Naikkan versi cache agar cache lama dihapus
const urlsToCache = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/manifest.json',
  '/logo.png' // Tambahkan aset penting lainnya di sini
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  // 1. Biarkan API calls dan Firebase lolos dari cache agar tetap real-time
  if (event.request.url.includes('/api/') || event.request.url.includes('firestore') || event.request.url.includes('googleapis')) {
    return;
  }
  
  // 2. STRATEGI NETWORK-FIRST KHUSUS UNTUK INDEX.HTML (Navigasi)
  // Artinya: Selalu ambil versi terbaru dari Vercel. Jika offline (gagal), baru ambil dari Cache.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }

  // 3. STRATEGI CACHE-FIRST UNTUK ASET LAIN (Gambar, CSS, dll agar loading cepat)
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('PWA: Menghapus cache versi lama:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// PENTING: Menerima perintah dari index.html untuk langsung mengaktifkan versi baru (Update Otomatis)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('PWA: Memaksa pembaruan Service Worker...');
    self.skipWaiting();
  }
});
