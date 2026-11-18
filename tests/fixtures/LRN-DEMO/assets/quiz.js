/* LRN-DEMO quiz (synthetic test course).
   Markup: <section class="quiz" data-src="quiz-id"></section> and a
   <script type="application/json" id="quiz-id"> block with
   { "title": "...", "items": [ { "text": "...", "choices": ["..."], "right": 0, "note": "..." } ] }.
   Every step throws the old markup away and builds the card again (innerHTML),
   like the real teach-skill component does. */
(function () {
  'use strict';
  var styles = '.quiz-box{font-family:var(--ui);border:1px solid var(--line);border-radius:8px;padding:1rem;background:var(--card)}'
    + '.quiz-head{font-size:.75rem;color:var(--muted);display:flex;justify-content:space-between}'
    + '.quiz-choice{display:block;width:100%;text-align:left;margin:.4rem 0;padding:.55rem .75rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;cursor:pointer}'
    + '.quiz-choice.is-right{background:var(--leaf-soft);border-color:var(--leaf)}'
    + '.quiz-choice.is-wrong{background:var(--rust-soft);border-color:var(--rust)}'
    + '.quiz-note{margin:.75rem 0;font-size:.9rem}';
  var tag = document.createElement('style');
  tag.textContent = styles;
  document.head.appendChild(tag);

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function start(box) {
    var data = JSON.parse(document.getElementById(box.getAttribute('data-src')).textContent);
    var step = 0;
    var score = 0;
    var picked = null;

    function draw() {
      if (step >= data.items.length) {
        box.innerHTML = '<div class="quiz-box"><p class="quiz-result">Резултат: ' + score + ' от ' + data.items.length + '</p>'
          + '<button type="button" class="btn quiz-again">Отначало</button></div>';
        box.querySelector('.quiz-again').onclick = function () { step = 0; score = 0; picked = null; draw(); };
        return;
      }
      var item = data.items[step];
      var html = '<div class="quiz-box"><div class="quiz-head"><span>' + esc(data.title) + '</span><span>'
        + (step + 1) + ' / ' + data.items.length + '</span></div><p class="quiz-text">' + esc(item.text) + '</p>';
      item.choices.forEach(function (c, i) {
        var cls = 'quiz-choice';
        if (picked !== null && i === item.right) cls += ' is-right';
        if (picked === i && i !== item.right) cls += ' is-wrong';
        html += '<button type="button" class="' + cls + '" data-i="' + i + '"' + (picked !== null ? ' disabled' : '') + '>' + esc(c) + '</button>';
      });
      if (picked !== null) {
        html += '<p class="quiz-note">' + (picked === item.right ? 'Вярно. ' : 'Не е вярно. ') + esc(item.note) + '</p>'
          + '<button type="button" class="btn quiz-next">' + (step + 1 < data.items.length ? 'Напред' : 'Виж резултата') + '</button>';
      }
      box.innerHTML = html + '</div>';
      Array.prototype.forEach.call(box.querySelectorAll('.quiz-choice'), function (b) {
        b.onclick = function () {
          picked = Number(b.getAttribute('data-i'));
          if (picked === item.right) score++;
          draw();
        };
      });
      var next = box.querySelector('.quiz-next');
      if (next) next.onclick = function () { step++; picked = null; draw(); };
    }
    draw();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.quiz[data-src]'), start);
})();
