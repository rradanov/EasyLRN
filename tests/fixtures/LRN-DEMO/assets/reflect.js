/* LRN-DEMO reflection exercise (synthetic test course).
   <div class="reflect" data-name="..."> with <label for=id> + <textarea id=id> pairs.
   Adds a button that joins the answers into one text and tries to copy it. */
(function () {
  'use strict';
  Array.prototype.forEach.call(document.querySelectorAll('.reflect'), function (box) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn reflect-collect';
    button.textContent = 'Събери отговорите';
    var status = document.createElement('p');
    status.className = 'reflect-status';
    var output = document.createElement('pre');
    output.className = 'reflect-output';
    output.hidden = true;
    box.appendChild(button);
    box.appendChild(status);
    box.appendChild(output);
    button.addEventListener('click', function () {
      var parts = [box.getAttribute('data-name') || 'Отговори'];
      Array.prototype.forEach.call(box.querySelectorAll('textarea'), function (field) {
        var label = box.querySelector('label[for="' + field.id + '"]');
        parts.push((label ? label.textContent : field.id) + ': ' + (field.value.trim() || '—'));
      });
      output.textContent = parts.join('\n');
      output.hidden = false;
      var done = function (ok) { status.textContent = ok ? 'Копирано.' : 'Копирай текста ръчно.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(output.textContent).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  });
})();
