/**
 * Hotjar — inject only when window.__UX_HOTJAR_ID is set.
 */
(function () {
  var metaId = typeof document !== 'undefined' && document.querySelector('meta[name="ux-hotjar-id"]');
  var metaVersion = typeof document !== 'undefined' && document.querySelector('meta[name="ux-hotjar-version"]');
  var hjid = (typeof window !== 'undefined' ? window.__UX_HOTJAR_ID : null) || (metaId && metaId.content) || null;
  var hjsv = (typeof window !== 'undefined' && window.__UX_HOTJAR_SV) || (metaVersion && metaVersion.content) || 6;
  if (!hjid || typeof document === 'undefined') return;
  if (document.getElementById('ux-hotjar-script')) return;
  (function (h, o, t, j, a, r) {
    h.hj =
      h.hj ||
      function () {
        (h.hj.q = h.hj.q || []).push(arguments);
      };
    h._hjSettings = { hjid: hjid, hjsv: hjsv };
    a = o.getElementsByTagName('head')[0];
    r = o.createElement('script');
    r.async = 1;
    r.id = 'ux-hotjar-script';
    r.src = t + h._hjSettings.hjid + j + h._hjSettings.hjsv;
    a.appendChild(r);
  })(window, document, 'https://static.hotjar.com/c/hotjar-', '.js?sv=');
})();
