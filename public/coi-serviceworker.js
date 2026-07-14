/* coi-serviceworker v0.1.7 — Guido Zuidhof et al, MIT License
 * https://github.com/gzuidhof/coi-serviceworker
 *
 * Adds Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
 * to every response so that SharedArrayBuffer (required by Pyodide) works on
 * GitHub Pages, which does not allow custom response headers.
 */
if (typeof window === 'undefined') {
  // ── Service worker side ──────────────────────────────────────────────────
  self.addEventListener('install',  () => self.skipWaiting());
  self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    e.respondWith(
      fetch(req).then(r => {
        if (r.status === 0) return r;
        const h = new Headers(r.headers);
        h.set('Cross-Origin-Opener-Policy',   'same-origin');
        h.set('Cross-Origin-Embedder-Policy', 'credentialless');
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
      })
    );
  });
} else {
  // ── Page side ────────────────────────────────────────────────────────────
  (async () => {
    if (window.crossOriginIsolated !== false) return; // already isolated — nothing to do
    const reg = await navigator.serviceWorker.register(document.currentScript.src);
    await navigator.serviceWorker.ready;
    // If the SW was just installed it needs a reload to intercept this page's responses.
    if (!reg.active || !window.crossOriginIsolated) window.location.reload();
  })();
}
