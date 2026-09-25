(function () {
  var dz = document.getElementById('dz');
  var file = document.getElementById('file');
  var nameEl = document.getElementById('dzName');
  if (!dz || !file) return;

  function setName(f) {
    if (!nameEl) return;
    nameEl.textContent = f ? f.name + ' (' + Math.round(f.size / 1024) + ' KB)' : '';
  }

  dz.addEventListener('click', function () { file.click(); });
  file.addEventListener('change', function () {
    setName(file.files && file.files[0]);
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault();
      dz.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault();
      dz.classList.remove('dragover');
    });
  });
  dz.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
      if (nameEl) nameEl.textContent = 'Only PDF files are accepted.';
      return;
    }
    var dt = new DataTransfer();
    dt.items.add(f);
    file.files = dt.files;
    setName(f);
  });

  // Empty-listings CTA lands on ?tab=upload#dz — scroll + focus above the fold
  // (inline script blocked by CSP script-src 'self')
  var shouldFocus = location.hash === '#dz' || /(?:[?&])focus=dz(?:&|$)/.test(location.search);
  if (shouldFocus) {
    function activate() {
      dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
      dz.classList.add('dropzone-focus');
      dz.setAttribute('tabindex', '-1');
      try {
        file.focus({ preventScroll: true });
      } catch (e) {
        try { dz.focus({ preventScroll: true }); } catch (e2) {}
      }
    }
    requestAnimationFrame(activate);
    setTimeout(activate, 50);
    setTimeout(activate, 250);
  }
})();
