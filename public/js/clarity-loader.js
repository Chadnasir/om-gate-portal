/**
 * Microsoft Clarity — inject only when window.__UX_CLARITY_ID or meta[name=ux-clarity-id] is set.
 * Never enable on pages serving raw confidential document bytes without a consent gate.
 */
(function () {
  var id =
    (typeof window !== "undefined" && window.__UX_CLARITY_ID) ||
    (typeof document !== "undefined" &&
      document.querySelector('meta[name="ux-clarity-id"]') &&
      document.querySelector('meta[name="ux-clarity-id"]').content) ||
    "";
  if (!id || typeof document === "undefined") return;
  if (document.getElementById("ux-clarity-script")) return;
  (function (c, l, a, r, i, t, y) {
    c[a] =
      c[a] ||
      function () {
        (c[a].q = c[a].q || []).push(arguments);
      };
    t = l.createElement(r);
    t.async = 1;
    t.src = "https://www.clarity.ms/tag/" + i;
    t.id = "ux-clarity-script";
    y = l.getElementsByTagName(r)[0];
    y.parentNode.insertBefore(t, y);
  })(window, document, "clarity", "script", id);
})();
