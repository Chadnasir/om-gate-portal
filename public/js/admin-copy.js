/**
 * Clipboard helper for admin "Copy share link" buttons.
 */
(function () {
  document.querySelectorAll('.copy-link').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var url = btn.getAttribute('data-url');
      if (!url) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          var prev = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = prev; }, 1500);
        });
      } else {
        window.prompt('Copy share link:', url);
      }
    });
  });
})();
