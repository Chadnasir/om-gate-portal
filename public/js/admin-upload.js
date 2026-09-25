/**
 * Admin drag-and-drop upload for OM PDFs.
 */
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
  file.addEventListener('change', function () { setName(file.files && file.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
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
})();
