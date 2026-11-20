// mot mot — "rewind" a profile to a moment in time. Runs in the page's own
// JavaScript world (manifest: "world": "MAIN") at document_start, so it is in
// place before X's app makes its first request.
//
// How it works: X's web app fills a profile from an internal GraphQL call,
// UserTweets, and pages through it with an opaque `cursor`. That cursor is
// not really opaque — it is a base64'd Thrift struct whose payload is the
// tweet ID to continue from. So when the profile was opened by a mot mot long
// press (URL ends in #motmot=<tweet id>), we hand X's very first UserTweets
// request a cursor pointing just past that Tweet. X then serves, and its own
// UI renders, the author's real feed starting at that moment. Scrolling on
// from there pages back in time on X's own cursors, untouched.
//
// Nothing here talks to any server except X, as X's own app would.

(() => {
  const TIMELINE_OP = /\/(UserTweets|UserTweetsAndReplies)$/;
  const TEMPLATE_KEY = 'motmot:cursorTemplate';
  const SNOWFLAKE_MIN = 2n ** 50n; // i64s at least this big are tweet IDs
  const BOOST_COUNT = 50;

  const target = (location.hash.match(/^#motmot=(\d{1,20})$/) || [])[1] || null;
  let armed = Boolean(target);
  let boost = false;

  // jump.js (the isolated content script) asks for bigger pages when it has
  // to fall back to scrolling.
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === 'motmot-jump' && event.data.type === 'boost') {
      boost = true;
    }
  });

  // ---- Thrift binary protocol, just enough to find the i64s -------------

  function readI32(b, p) {
    if (p + 4 > b.length) throw new Error('truncated');
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  }

  function skipValue(b, p, type, onI64) {
    switch (type) {
      case 2: case 3: return p + 1; // bool, byte
      case 6: return p + 2; // i16
      case 8: return p + 4; // i32
      case 4: return p + 8; // double
      case 10: onI64(p); return p + 8; // i64
      case 11: return p + 4 + readI32(b, p); // string / binary
      case 12: return walkStruct(b, p, onI64);
      case 13: { // map
        const kt = b[p], vt = b[p + 1], n = readI32(b, p + 2);
        p += 6;
        for (let i = 0; i < n; i++) p = skipValue(b, skipValue(b, p, kt, onI64), vt, onI64);
        return p;
      }
      case 14: case 15: { // set, list
        const et = b[p], n = readI32(b, p + 1);
        p += 5;
        for (let i = 0; i < n; i++) p = skipValue(b, p, et, onI64);
        return p;
      }
      default: throw new Error(`unknown thrift type ${type}`);
    }
  }

  function walkStruct(b, p, onI64) {
    for (;;) {
      // Some cursors arrive without their final STOP bytes; running out of
      // input at a field boundary is as good as one.
      if (p >= b.length) return p;
      const type = b[p++];
      if (type === 0) return p; // STOP
      p = skipValue(b, p + 2, type, onI64); // +2 skips the field id
      if (p > b.length) throw new Error('truncated');
    }
  }

  function decodeBase64(s) {
    const std = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  function encodeBase64Url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Positions of every tweet-ID-sized i64 in a cursor, or null if the bytes
  // are not a cursor we understand.
  function snowflakeSlots(bytes) {
    const slots = [];
    const view = new DataView(bytes.buffer);
    try {
      walkStruct(bytes, 0, (p) => {
        if (view.getBigUint64(p) >= SNOWFLAKE_MIN) slots.push(p);
      });
    } catch {
      return null;
    }
    return slots.length ? slots : null;
  }

  // The shape X's bottom cursors have had for years, used until we have seen
  // a live one to copy:  struct { i64 top, i64 bottom, i32 direction=2 }.
  function defaultTemplate() {
    const b = new Uint8Array(34);
    const v = new DataView(b.buffer);
    let p = 0;
    b[p++] = 0x0c; v.setUint16(p, 1); p += 2; // field 1: struct
    b[p++] = 0x0a; v.setUint16(p, 1); p += 2; v.setBigUint64(p, SNOWFLAKE_MIN); p += 8;
    b[p++] = 0x0a; v.setUint16(p, 2); p += 2; v.setBigUint64(p, SNOWFLAKE_MIN); p += 8;
    b[p++] = 0x08; v.setUint16(p, 3); p += 2; v.setUint32(p, 2); p += 4;
    b[p++] = 0x00; // end inner struct
    b[p++] = 0x00; // end outer struct
    return b.slice(0, p);
  }

  // Take a real cursor X gave us earlier (or the default shape) and point
  // every position in it at the moment just after the target Tweet.
  function forgeCursor(tweetId) {
    let bytes = null;
    try {
      const saved = localStorage.getItem(TEMPLATE_KEY);
      if (saved) bytes = decodeBase64(saved);
    } catch {}
    let slots = bytes && snowflakeSlots(bytes);
    if (!slots) {
      bytes = defaultTemplate();
      slots = snowflakeSlots(bytes);
    }
    const view = new DataView(bytes.buffer);
    const position = BigInt(tweetId) + 1n; // cursors are exclusive
    for (const p of slots) view.setBigUint64(p, position);
    return encodeBase64Url(bytes);
  }

  // ---- Reading X's responses --------------------------------------------

  function* walkJson(node) {
    if (!node || typeof node !== 'object') return;
    yield node;
    for (const value of Object.values(node)) yield* walkJson(value);
  }

  // Every real bottom cursor we see is kept as the template for next time, so
  // if X ever changes the cursor layout, the forgery follows it automatically.
  function learn(json) {
    for (const node of walkJson(json)) {
      if (node.cursorType === 'Bottom' && typeof node.value === 'string') {
        try {
          if (snowflakeSlots(decodeBase64(node.value))) localStorage.setItem(TEMPLATE_KEY, node.value);
        } catch {}
        return;
      }
    }
  }

  // Did X honour the cursor? Look at the IDs of the timeline entries it sent
  // back (the pinned Tweet arrives under a separate instruction, so it does
  // not count).
  function verdict(json) {
    const ids = [];
    for (const node of walkJson(json)) {
      if (node.type === 'TimelineAddEntries' && Array.isArray(node.entries)) {
        for (const entry of node.entries) {
          for (const m of JSON.stringify(entry.entryId || '').matchAll(/tweet-(\d+)/g)) ids.push(BigInt(m[1]));
          if (String(entry.entryId).startsWith('profile-conversation')) {
            for (const m of JSON.stringify(entry).matchAll(/"entryId":"[^"]*tweet-(\d+)"/g)) ids.push(BigInt(m[1]));
          }
        }
      }
    }
    const t = BigInt(target);
    if (ids.some((id) => id === t)) return 'ok';
    if (!ids.length) return 'missing';
    const newest = ids.reduce((a, b) => (a > b ? a : b));
    // Everything is older than the target: the cursor worked, the Tweet just
    // isn't on this tab (a reply, say). Anything newer: cursor ignored.
    return newest <= t ? 'missing' : 'ignored';
  }

  function report(status) {
    window.postMessage({ source: 'motmot-rewind', status, id: target }, location.origin);
  }

  // ---- Rewriting the request --------------------------------------------

  // Returns { url, check } if this is a profile-timeline request, else null.
  function intercept(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return null;
    }
    if (!TIMELINE_OP.test(url.pathname) || !url.searchParams.has('variables')) return null;

    let check = false;
    try {
      const variables = JSON.parse(url.searchParams.get('variables'));
      if (armed && !variables.cursor) {
        variables.cursor = forgeCursor(target);
        armed = false;
        check = true;
      }
      if (boost && typeof variables.count === 'number') {
        variables.count = Math.max(variables.count, BOOST_COUNT);
      }
      url.searchParams.set('variables', JSON.stringify(variables));
    } catch {
      return { url: rawUrl, check: false };
    }
    return { url: url.toString(), check };
  }

  function inspect(text, check) {
    let json;
    try {
      json = typeof text === 'string' ? JSON.parse(text) : text;
    } catch {
      if (check) report('ignored');
      return;
    }
    if (check) report(verdict(json));
    else learn(json); // never learn from our own forged request
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    const hit = intercept(raw);
    if (!hit) return nativeFetch.call(this, input, init);

    const request = input instanceof Request ? new Request(hit.url, input) : hit.url;
    return nativeFetch.call(this, request, init).then((response) => {
      response.clone().text().then((t) => inspect(t, hit.check), () => {});
      return response;
    });
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const hit = String(method).toUpperCase() === 'GET' ? intercept(String(url)) : null;
    if (hit) {
      this.addEventListener('load', () => {
        try {
          const body = this.responseType === 'json' ? this.response : this.responseText;
          inspect(body, hit.check);
        } catch {
          if (hit.check) report('ignored');
        }
      });
      url = hit.url;
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
})();
