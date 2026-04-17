if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    const self = document.querySelector('script[src$="shared/js/pwa.js"]');
    if (!self) return;
    const swUrl = new URL('../../sw.js', self.src).href;
    const scope = new URL('../../', self.src).href;
    navigator.serviceWorker.register(swUrl, { scope }).catch(() => {});
  });
}
