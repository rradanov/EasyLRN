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
  var create = Object.create;
  var apply = Reflect.apply;

  // T050-I1: after this point the guard calls nothing through a prototype the
  // lesson can replace (String#toLowerCase, Array#push, RegExp#test (which
  // reads RegExp#exec), Function#call…): strings are compared character by
  // character, lists are null-prototype objects with a counter (an Array
  // could hit a setter on Array.prototype[0]), functions run with the saved
  // Reflect.apply.
  function list() { var l = create(null); l.n = 0; return l; }
  function add(l, v) { l[l.n] = v; l.n = l.n + 1; }
  var UPPER = create(null);
  (function () {
    var up = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lo = 'abcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i < 26; i++) UPPER[up[i]] = lo[i];
  })();
  /** ASCII lower case of a primitive string, without String.prototype. */
  function lower(s) {
    if (typeof s !== 'string') return '';
    var out = '';
    for (var i = 0; i < s.length; i++) { var c = s[i]; out += UPPER[c] || c; }
    return out;
  }
  function startsWith(s, p) {
    if (typeof s !== 'string' || s.length < p.length) return false;
    for (var i = 0; i < p.length; i++) if (s[i] !== p[i]) return false;
    return true;
  }

  // --- 1. WebRTC -------------------------------------------------------------
  var RTC_NAMES = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel',
    'RTCIceCandidate', 'RTCSessionDescription', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport',
    'RTCRtpTransceiver', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCCertificate', 'RTCDTMFSender',
    'RTCPeerConnectionIceEvent', 'RTCPeerConnectionIceErrorEvent', 'RTCDataChannelEvent', 'RTCTrackEvent',
    'RTCErrorEvent', 'RTCError', 'RTCDTMFToneChangeEvent', 'RTCStatsReport', 'RTCEncodedAudioFrame',
    'RTCEncodedVideoFrame', 'RTCRtpScriptTransform', 'RTCIdentityAssertion'];
  function isRtcName(n) { return startsWith(n, 'RTC') || startsWith(n, 'webkitRTC') || startsWith(n, 'mozRTC'); }

  function lockName(target, name) {
    try {
      defineProperty(target, name, { value: undefined, writable: false, enumerable: false, configurable: false });
    } catch (e) { /* already locked */ }
  }
  var ObjectProto = Object.prototype;
  function lockRtc(win) {
    var names = list();
    for (var k = 0; k < RTC_NAMES.length; k++) add(names, RTC_NAMES[k]);
    try {
      // Every RTC* interface this browser has, also future ones.
      for (var o = win; o && o !== ObjectProto; o = getPrototypeOf(o)) {
        var own = getOwnPropertyNames(o);
        for (var i = 0; i < own.length; i++) if (isRtcName(own[i])) add(names, own[i]);
      }
    } catch (e) { /* a cross-origin window: nothing to do there */ }
    for (var j = 0; j < names.n; j++) lockName(win, names[j]);
  }
  lockRtc(w);

  // A nested frame of the lesson (if a browser ever gives the lesson access to
  // one): lock it before the lesson gets its window.
  var defaultViewGet = null;
  try { defaultViewGet = getOwnPropertyDescriptor(w.Document.prototype, 'defaultView').get; } catch (e) { defaultViewGet = null; }
  function lockFrames(proto, prop) {
    try {
      var d = getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get || !d.configurable) return;
      var get = d.get;
      defineProperty(proto, prop, {
        configurable: false,
        enumerable: d.enumerable,
        get: function () {
          var v = apply(get, this, []);
          try {
            var win = prop === 'contentDocument' ? (v && defaultViewGet ? apply(defaultViewGet, v, []) : null) : v;
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

  // --- 1b. No nested browsing contexts at all (D-034, T046-S1, T048-S1) ---------
  // A nested frame of the lesson runs its own scripts in a fresh realm with a
  // fresh RTCPeerConnection. The renderer removes static frames from the lesson
  // (with a real HTML parser); here every way to create one at runtime is
  // blocked. A frame only loads once it is connected to the live document, so a
  // MutationObserver that removes it in the microtask after it is inserted stops
  // its document before it can run (microtasks run before the frame's load
  // task). createElement is also neutralised, so the lesson cannot even get a
  // frame element.
  // T048-S1a: every DOM method the guard needs is taken here, before the
  // lesson runs, and called with a saved Reflect.apply: a lesson that replaces
  // Element.prototype.remove, Function.prototype.call, NodeList#length… does
  // not change what the guard does. T048-S1b: the observer watches the
  // document itself (a new documentElement is seen too) and every shadow root.
  // If a frame stays anyway, the guard tells the app (`lrn:violation`), which
  // stops the lesson; the app also checks the frame count from outside.
  var FRAME_TAGS = create(null);
  FRAME_TAGS.iframe = 1; FRAME_TAGS.frame = 1; FRAME_TAGS.frameset = 1;
  FRAME_TAGS.object = 1; FRAME_TAGS.embed = 1; FRAME_TAGS.portal = 1;
  var FRAME_SELECTOR = 'iframe,frame,frameset,object,embed,portal';
  function getter(proto, name) {
    for (var o = proto; o; o = getPrototypeOf(o)) {
      var dd = getOwnPropertyDescriptor(o, name);
      if (dd) return dd.get || null;
    }
    return null;
  }
  function method(proto, name) {
    try { var f = proto && proto[name]; return typeof f === 'function' ? f : null; } catch (e) { return null; }
  }
  var NodeP = w.Node.prototype;
  var get = {
    nodeType: getter(NodeP, 'nodeType'),
    localName: getter(w.Element.prototype, 'localName'),
    parentNode: getter(NodeP, 'parentNode'),
    listLength: getter(w.NodeList.prototype, 'length'),
    addedNodes: getter(w.MutationRecord.prototype, 'addedNodes'),
    shadowRoot: getter(w.Element.prototype, 'shadowRoot'),
    winLength: getter(w, 'length'),
  };
  var fn = {
    removeChild: method(NodeP, 'removeChild'),
    qsaElement: method(w.Element.prototype, 'querySelectorAll'),
    qsaDocument: method(w.Document.prototype, 'querySelectorAll'),
    qsaFragment: method(w.DocumentFragment.prototype, 'querySelectorAll'),
    observe: method(w.MutationObserver && w.MutationObserver.prototype, 'observe'),
    takeRecords: method(w.MutationObserver && w.MutationObserver.prototype, 'takeRecords'),
    attachShadow: method(w.Element.prototype, 'attachShadow'),
  };
  var MO = w.MutationObserver;
  var violated = false;
  function prop(g, obj, fallback) { try { return g ? apply(g, obj, []) : fallback; } catch (e) { return fallback; } }
  function qsa(node, type) {
    var f = type === 9 ? fn.qsaDocument : type === 11 ? fn.qsaFragment : type === 1 ? fn.qsaElement : null;
    if (!f) return null;
    try { return apply(f, node, [FRAME_SELECTOR]); } catch (e) { return null; }
  }
  function removeNode(node) {
    var parent = prop(get.parentNode, node, null);
    if (!parent) return true;
    try { apply(fn.removeChild, parent, [node]); } catch (e) { /* ignore */ }
    return !prop(get.parentNode, node, null);
  }
  var reportViolation = function () {}; // set in section 3 (needs the parent window)
  function isFrame(node) {
    return prop(get.nodeType, node, 0) === 1 && FRAME_TAGS[lower(prop(get.localName, node, ''))] === 1;
  }
  // Every shadow root the guard has seen (attachShadow, open roots found in a
  // sweep): also the closed ones, which no query from outside can reach and
  // whose frames window.length does not count (T050-I1).
  var roots = list();
  function remember(root) {
    for (var i = 0; i < roots.n; i++) if (roots[i] === root) return;
    add(roots, root);
    watch(root);
  }
  /** Remove every frame in `node` (and in open shadow roots inside); returns how many were found. */
  function stripFrames(node, deep) {
    var type = prop(get.nodeType, node, 0);
    if (type === 1 && isFrame(node)) {
      if (!removeNode(node)) reportViolation('frame');
      return 1;
    }
    var found = qsa(node, type);
    if (!found) return 0;
    var n = prop(get.listLength, found, 0);
    var all = list();
    for (var i = 0; i < n; i++) add(all, found[i]);
    for (var k = 0; k < all.n; k++) if (!removeNode(all[k])) reportViolation('frame');
    var count = all.n;
    // Open shadow roots inside (closed ones are remembered since attachShadow, below).
    if (deep !== false && (type === 1 || type === 9 || type === 11)) {
      var hosts = null;
      try { hosts = apply(type === 9 ? fn.qsaDocument : type === 11 ? fn.qsaFragment : fn.qsaElement, node, ['*']); } catch (e) { hosts = null; }
      var m = hosts ? prop(get.listLength, hosts, 0) : 0;
      var srs = list();
      for (var j = 0; j < m; j++) {
        var sr = prop(get.shadowRoot, hosts[j], null);
        if (sr) add(srs, sr);
      }
      for (var q = 0; q < srs.n; q++) { remember(srs[q]); count += stripFrames(srs[q]); }
    }
    return count;
  }
  function onRecords(records) {
    for (var i = 0; i < records.length; i++) {
      var added = prop(get.addedNodes, records[i], null);
      var n = added ? prop(get.listLength, added, 0) : 0;
      for (var j = 0; j < n; j++) stripFrames(added[j]);
    }
  }
  var observer = null;
  try { observer = new MO(onRecords); } catch (e) { observer = null; }
  // The options are a null-prototype object: observe() reads absent members
  // too (attributes, characterDataOldValue…), and a lesson could otherwise set
  // them on Object.prototype so that observe() throws for a later shadow root.
  var OBSERVE = create(null);
  OBSERVE.childList = true; OBSERVE.subtree = true;
  function watch(root) {
    try { apply(fn.observe, observer, [root, OBSERVE]); } catch (e) { /* ignore */ }
  }
  var docNode = w.document;
  watch(docNode);

  function neuter(create) {
    return function (tagName) {
      var el = apply(create, this, arguments);
      try {
        if (el && isFrame(el)) {
          // A harmless inert element instead; its content never becomes a frame.
          return apply(create, this, ['template']);
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
  function lockAway(obj, name) {
    try { defineProperty(obj, name, { value: undefined, writable: false, enumerable: false, configurable: false }); } catch (e) { /* ignore */ }
  }
  lockMethod(w.Document.prototype, 'createElement', neuter);
  lockMethod(w.Document.prototype, 'createElementNS', function (create) {
    return function (ns, tagName) {
      var el = apply(create, this, arguments);
      try {
        if (el && isFrame(el)) return apply(create, this, [ns, 'span']);
      } catch (e) { /* ignore */ }
      return el;
    };
  });
  // Shadow roots (also closed ones) are watched like the document.
  if (fn.attachShadow) {
    lockMethod(w.Element.prototype, 'attachShadow', function (orig) {
      return function () { var root = apply(orig, this, arguments); remember(root); stripFrames(root); return root; };
    });
  }
  // Parsers that can build declarative shadow roots the observer cannot see
  // (lessons from lrn-teach never use them). T051-I1: not a list of names but
  // every member with "HTML" in its name, on every interface of the window
  // (prototype and static side), also future ones: setHTML, setHTMLUnsafe,
  // append/prepend/before/after/replaceWithHTMLUnsafe, stream…HTML(Unsafe),
  // Document.parseHTML(Unsafe)… Kept: innerHTML and outerHTML (they never
  // build a declarative shadow root; the observer sees what they insert),
  // insertAdjacentHTML (wrapped below), getHTML (only serialises), and the
  // Trusted Types interfaces (they only make strings).
  var HTML_KEEP = create(null);
  HTML_KEEP.innerHTML = 1; HTML_KEEP.outerHTML = 1; HTML_KEEP.insertAdjacentHTML = 1; HTML_KEEP.getHTML = 1;
  function hasHTML(name) {
    if (typeof name !== 'string') return false;
    for (var i = 0; i + 3 < name.length; i++) {
      if (name[i] === 'H' && name[i + 1] === 'T' && name[i + 2] === 'M' && name[i + 3] === 'L') return true;
    }
    return false;
  }
  function lockHTMLMembers(obj) {
    var own;
    try { own = getOwnPropertyNames(obj); } catch (e) { return; }
    for (var i = 0; i < own.length; i++) {
      var n = own[i];
      if (hasHTML(n) && HTML_KEEP[n] !== 1) lockAway(obj, n);
    }
  }
  (function lockHTMLParsers() {
    var seen = list();
    var names = list();
    try {
      for (var o = w; o && o !== ObjectProto; o = getPrototypeOf(o)) {
        var own = getOwnPropertyNames(o);
        for (var i = 0; i < own.length; i++) add(names, own[i]);
      }
    } catch (e) { /* ignore */ }
    for (var k = 0; k < names.n; k++) {
      var n = names[k];
      // Interfaces are capitalised; HTMLElement, HTMLDocument… are names of
      // interfaces, not members: their members are checked like any other.
      if (typeof n !== 'string' || !n.length || !UPPER[n[0]] || startsWith(n, 'Trusted')) continue;
      var dd = null;
      try { dd = getOwnPropertyDescriptor(w, n); } catch (e) { dd = null; }
      var ctor = dd && dd.value; // only data properties: no getter of the window is run
      if (typeof ctor !== 'function') continue;
      var dup = false;
      for (var j = 0; j < seen.n; j++) if (seen[j] === ctor) { dup = true; break; }
      if (dup) continue;
      add(seen, ctor);
      lockHTMLMembers(ctor);
      var pd = null;
      try { pd = getOwnPropertyDescriptor(ctor, 'prototype'); } catch (e) { pd = null; }
      if (pd && pd.value && typeof pd.value === 'object') lockHTMLMembers(pd.value);
    }
    // The ones named in T051-I1, also if a browser keeps them off the window's names.
    lockAway(w.Element.prototype, 'setHTMLUnsafe');
    lockAway(w.Element.prototype, 'setHTML');
    if (w.ShadowRoot) { lockAway(w.ShadowRoot.prototype, 'setHTMLUnsafe'); lockAway(w.ShadowRoot.prototype, 'setHTML'); }
    lockAway(w.Document, 'parseHTMLUnsafe');
    lockAway(w.Document, 'parseHTML');
  })();
  // ElementInternals#shadowRoot hands a custom element its (also closed)
  // root, also a declarative one the guard never attached: every root it
  // returns is remembered (observed, swept) and its frames removed.
  try {
    if (w.ElementInternals) {
      var EIP = w.ElementInternals.prototype;
      var eiDesc = getOwnPropertyDescriptor(EIP, 'shadowRoot');
      if (eiDesc && eiDesc.get && eiDesc.configurable) {
        var eiGet = eiDesc.get;
        defineProperty(EIP, 'shadowRoot', {
          configurable: false,
          enumerable: eiDesc.enumerable,
          get: function () {
            var root = apply(eiGet, this, []);
            if (root) { remember(root); stripFrames(root); }
            return root;
          },
        });
      }
    }
  } catch (e) { /* ignore */ }
  // Parser paths that build a frame directly: strip the result once it lands.
  lockMethod(w.Element.prototype, 'insertAdjacentHTML', function (orig) {
    return function () {
      var r = apply(orig, this, arguments);
      stripFrames(prop(get.parentNode, this, null) || this);
      return r;
    };
  });
  // document.write/writeln: the parser they feed builds declarative shadow
  // roots (also closed ones, which no observer sees), and a tag can be split
  // over several calls. Lessons do not need them: they do nothing here.
  var noWrite = function () { return function () { try { w.console.warn('EasyLRN: document.write is not available in lessons.'); } catch (e) { /* ignore */ } }; };
  lockMethod(w.Document.prototype, 'write', noWrite);
  lockMethod(w.Document.prototype, 'writeln', noWrite);

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
    scrollY: function () { try { return scrollYGet ? apply(scrollYGet, w, []) : 0; } catch (e) { return 0; } },
  });
  try {
    defineProperty(w, '__easylrn', { value: refs, writable: false, enumerable: false, configurable: false });
  } catch (e) { /* the bridge falls back to the window's own names */ }

  // --- 3. lrn:hello after load; lrn:violation -------------------------------------
  if (parentWindow === w) return; // not in a frame (a lesson opened directly)
  reportViolation = function (what) {
    if (violated) return;
    violated = true;
    try { parentWindow.postMessage({ lrn: 1, type: 'lrn:violation', v: 1, what: what }, '*'); } catch (e) { /* ignore */ }
  };
  // A frame that stays in the document (not removable, or out of the
  // observer's sight): the window's own frame count, read with a saved getter,
  // and a sweep of the document and of every shadow root seen (window.length
  // does not count frames in shadow trees, T050-I1). A frame found by a sweep
  // got past the observer: it is removed and the lesson is stopped.
  var ticks = 0;
  var checkCount = function () {
    try {
      var records = fn.takeRecords && observer ? apply(fn.takeRecords, observer, []) : [];
      if (records && records.length) onRecords(records);
    } catch (e) { /* ignore */ }
    var found = 0;
    for (var i = 0; i < roots.n; i++) found += stripFrames(roots[i], false);
    // The whole document (and open shadow roots in it) once a second.
    if (ticks % 4 === 0) found += stripFrames(docNode);
    ticks++;
    if (found > 0 || prop(get.winLength, w, 0) > 0) reportViolation('frame');
    if (!violated) setTimeoutFn(checkCount, 250);
  };
  setTimeoutFn(checkCount, 0);
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
