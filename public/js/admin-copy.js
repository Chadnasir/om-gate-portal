(function () {
  document.querySelectorAll('.copy-link').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var url = btn.getAttribute('data-url');
      if (!url) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = 'Copy share link'; }, 1500);
        });
      } else {
        prompt('Copy share link:', url);
      }
    });
  });
})();
