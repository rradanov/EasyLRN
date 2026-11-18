// Lesson guard (T-045-fix: T046-S1, T046-D1, D-029).
//
// Runs INSIDE the lesson, as the very first script of the document: the
// Service Worker puts it (as a classic inline <script>) right after the
// doctype, before any script of the lesson. Rules for this file: a classic
// script (no `import`/`export`), never a closing script tag in its text,
// nothing outside the function below.
//
// 1. WebRTC (T046-S1). CSP `connect-src 'none'` does not cover WebRTC in
//    Chromium and there is no CSP/Permissions Policy that blocks it, so a
//    lesson could send what it knows (text typed into it, reflect answers) to
//    any host over UDP/TCP (TURN/STUN) or DNS. Every RTC* interface is
//    replaced by `undefined` with a non-configurable, non-writable property,
//    before the lesson runs: the lesson can neither use nor restore it.
//    A nested frame of the lesson cannot hand out fresh constructors: `frame-src
//    'none'` blocks every URL (blob:, data:, same site), srcdoc/about:blank
//    frames inherit the sandbox and get their own opaque origin (no access from
//    the lesson), and `frameElement.contentWindow` of such frames is guarded
//    here too (see lockFrames) in case a browser lets it through.
// 2. The bridge's own references (T046-D1). `parent`, `self`, `scrollY`… are
//    [Replaceable]: an ordinary `var parent = …` in a lesson replaces them. The
//    guard keeps the real ones in this closure and exposes them, frozen and
//    non-configurable, as `window.__easylrn` for src/lesson-bridge.js.
// 3. `lrn:hello` after the document's `load` (and once more 1 s later): every
//    document of ours speaks, even if the lesson breaks the bridge. The app
//    takes only a document that never speaks after its load for a
//    self-navigation; a document that speaks but never gets ready falls back
//    to an inner scroll (LESSON-ISOLATION §5.3).
(function lrnGuard(w) {
  'use strict';
  var defineProperty = Object.defineProperty;
  var getOwnPropertyNames = Object.getOwnPropertyNames;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var getPrototypeOf = Object.getPrototypeOf;
  var freeze = Object.freeze;

  // --- 1. WebRTC -------------------------------------------------------------
  var RTC_NAMES = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel',
    'RTCIceCandidate', 'RTCSessionDescription', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport',
    'RTCRtpTransceiver', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCCertificate', 'RTCDTMFSender',
    'RTCPeerConnectionIceEvent', 'RTCPeerConnectionIceErrorEvent', 'RTCDataChannelEvent', 'RTCTrackEvent',
    'RTCErrorEvent', 'RTCError', 'RTCDTMFToneChangeEvent', 'RTCStatsReport', 'RTCEncodedAudioFrame',
    'RTCEncodedVideoFrame', 'RTCRtpScriptTransform', 'RTCIdentityAssertion'];
  var RTC_NAME = /^(webkit|moz)?RTC/;

  function lockName(target, name) {
    try {
      defineProperty(target, name, { value: undefined, writable: false, enumerable: false, configurable: false });
    } catch (e) { /* already locked */ }
  }
  function lockRtc(win) {
    var names = RTC_NAMES.slice();
    try {
      // Every RTC* interface this browser has, also future ones.
      for (var o = win; o && o !== Object.prototype; o = getPrototypeOf(o)) {
        var own = getOwnPropertyNames(o);
        for (var i = 0; i < own.length; i++) if (RTC_NAME.test(own[i])) names.push(own[i]);
      }
    } catch (e) { /* a cross-origin window: nothing to do there */ }
    for (var j = 0; j < names.length; j++) lockName(win, names[j]);
  }
  lockRtc(w);

  // A nested frame of the lesson (if a browser ever gives the lesson access to
  // one): lock it before the lesson gets its window.
  function lockFrames(proto, prop) {
    try {
      var d = getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get || !d.configurable) return;
      var get = d.get;
      defineProperty(proto, prop, {
        configurable: false,
        enumerable: d.enumerable,
        get: function () {
          var v = get.call(this);
          try {
            var win = prop === 'contentDocument' ? (v && v.defaultView) : v;
            if (win) lockRtc(win);
          } catch (e) { /* cross-origin: unreachable anyway */ }
          return v;
        },
      });
    } catch (e) { /* ignore */ }
  }
  try {
    lockFrames(w.HTMLIFrameElement.prototype, 'contentWindow');
    lockFrames(w.HTMLIFrameElement.prototype, 'contentDocument');
    lockFrames(w.HTMLFrameElement.prototype, 'contentWindow');
    lockFrames(w.HTMLObjectElement.prototype, 'contentWindow');
    lockFrames(w.HTMLObjectElement.prototype, 'contentDocument');
  } catch (e) { /* ignore */ }

  // --- 1b. No nested browsing contexts at all (D-034, T046-S1) -----------------
  // A nested frame of the lesson runs its own scripts in a fresh realm with a
  // fresh RTCPeerConnection. The renderer removes static frames from the lesson;
  // here every way to create one at runtime is blocked. A frame only loads once
  // it is connected to the live document, so a MutationObserver that removes it
  // in the microtask after it is inserted stops its document before it can run
  // (microtasks run before the frame's load task). createElement is also
  // neutralised, so the lesson cannot even get a frame element.
  var FRAME_TAGS = { iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, portal: 1 };
  function stripFrames(node) {
    try {
      if (node.nodeType === 1 && FRAME_TAGS[node.localName]) { node.remove(); return; }
      if (node.querySelectorAll) {
        var found = node.querySelectorAll('iframe,frame,frameset,object,embed,portal');
        for (var i = 0; i < found.length; i++) found[i].remove();
      }
    } catch (e) { /* ignore */ }
  }
  try {
    var observer = new w.MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) stripFrames(added[j]);
      }
    });
    observer.observe(w.document.documentElement || w.document, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }

  function neuter(create) {
    return function (tagName) {
      var el = create.apply(this, arguments);
      try {
        if (el && el.nodeType === 1 && FRAME_TAGS[String(el.localName).toLowerCase()]) {
          // A harmless inert element instead; its content never becomes a frame.
          return create.call(this, 'template');
        }
      } catch (e) { /* ignore */ }
      return el;
    };
  }
  function lockMethod(obj, name, wrap) {
    try {
      var orig = obj[name];
      if (typeof orig !== 'function') return;
      defineProperty(obj, name, { value: wrap(orig), writable: false, enumerable: false, configurable: false });
    } catch (e) { /* ignore */ }
  }
  lockMethod(w.Document.prototype, 'createElement', neuter);
  lockMethod(w.Document.prototype, 'createElementNS', function (create) {
    return function (ns, tagName) {
      var el = create.apply(this, arguments);
      try {
        if (el && el.nodeType === 1 && FRAME_TAGS[String(el.localName).toLowerCase()]) return create.call(this, ns, 'span');
      } catch (e) { /* ignore */ }
      return el;
    };
  });
  // Parser paths that build a frame directly: strip the result once it lands.
  lockMethod(w.Element.prototype, 'insertAdjacentHTML', function (orig) {
    return function () { var r = orig.apply(this, arguments); try { stripFrames(this.parentNode || this); } catch (e) { /* ignore */ } return r; };
  });
  lockMethod(w.Document.prototype, 'write', function (orig) {
    return function () { var r = orig.apply(this, arguments); stripFrames(w.document.documentElement || w.document); return r; };
  });
  lockMethod(w.Document.prototype, 'writeln', function (orig) {
    return function () { var r = orig.apply(this, arguments); stripFrames(w.document.documentElement || w.document); return r; };
  });

  // --- 2. The bridge's own references ------------------------------------------
  var parentWindow = w.parent;
  var topWindow = w.top;
  var scrollYGet = null;
  for (var o = w; o && !scrollYGet; o = getPrototypeOf(o)) {
    var d = getOwnPropertyDescriptor(o, 'scrollY');
    if (d && d.get) scrollYGet = d.get;
  }
  var bind = function (fn) { return typeof fn === 'function' ? fn.bind(w) : null; };
  var setTimeoutFn = bind(w.setTimeout);
  var refs = freeze({
    parent: parentWindow,
    top: topWindow,
    setTimeout: setTimeoutFn,
    clearTimeout: bind(w.clearTimeout),
    requestAnimationFrame: bind(w.requestAnimationFrame),
    getComputedStyle: bind(w.getComputedStyle),
    scrollY: function () { try { return scrollYGet ? scrollYGet.call(w) : 0; } catch (e) { return 0; } },
  });
  try {
    defineProperty(w, '__easylrn', { value: refs, writable: false, enumerable: false, configurable: false });
  } catch (e) { /* the bridge falls back to the window's own names */ }

  // --- 3. lrn:hello after load ---------------------------------------------------
  if (parentWindow === w) return; // not in a frame (a lesson opened directly)
  var hello = function () {
    try { parentWindow.postMessage({ lrn: 1, type: 'lrn:hello', v: 1 }, '*'); } catch (e) { /* ignore */ }
  };
  try {
    w.addEventListener('load', function () {
      setTimeoutFn(hello, 0);
      setTimeoutFn(hello, 1000);
    }, true);
  } catch (e) { /* ignore */ }
})(window);
