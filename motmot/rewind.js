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
// The same file also serves "random old Tweet", from a hidden frame jump.js
// keeps on the page: see "the picker" below.
//
// Nothing here talks to any server except X, as X's own app would.

(() => {
  const TIMELINE_OP = /\/(UserTweets|UserTweetsAndReplies)$/;
  const TEMPLATE_KEY = 'motmot:cursorTemplate';
  const SNOWFLAKE_MIN = 2n ** 50n; // i64s at least this big are tweet IDs
  const BOOST_COUNT = 100;
  const ARM_WINDOW_MS = 4000; // an in-page arm only applies to the very next load
  const SEARCH_OP = /\/SearchTimeline$/;
  const X_EPOCH_MS = 1288834974657;
  const PICK_WINDOW_MS = 2 * 365.25 * 86400000; // random picks: the last two years

  const fromHash = location.hash.match(/^#motmot=(\d{1,20})$/);
  let target = fromHash ? fromHash[1] : null;
  let armedUntil = target ? Date.now() + 20000 : 0;

  // Bigger pages for the whole rewind, starting with the forged first one:
  // fewer round trips before the Tweet is on screen.
  let boost = Boolean(target);

  // jump.js (the isolated content script) talks to us by postMessage:
  //   arm    — a long press is about to switch to a profile in-app, without
  //            reloading; forge the cursor on the next timeline load.
  //   disarm — that switch didn't happen; don't touch a later load.
  //   calm   — the rewind is over; back to X's normal page size.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'motmot-jump') return;
    const { type, id } = event.data;
    if (type === 'arm' && /^\d{1,20}$/.test(id)) {
      target = id;
      armedUntil = Date.now() + ARM_WINDOW_MS;
      boost = true;
    } else if (type === 'disarm') {
      armedUntil = 0;
    } else if (type === 'calm') {
      boost = false;
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
    return forgeCursorAt(BigInt(tweetId) + 1n); // cursors are exclusive
  }

  // The same, for a position given directly: everything older than it.
  function forgeCursorAt(position) {
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
    // Nothing at all means X didn't accept the forged cursor — not that the
    // Tweet is missing.
    if (!ids.length) return 'rejected';
    const newest = ids.reduce((a, b) => (a > b ? a : b));
    // Everything is older than the target: the cursor worked, the Tweet just
    // isn't on this tab (a reply, say). Anything newer: cursor ignored.
    return newest <= t ? 'missing' : 'ignored';
  }

  function report(status, extra = {}) {
    window.postMessage({ source: 'motmot-rewind', status, id: target, ...extra }, location.origin);
  }

  // ---- Random old Tweet: the picker ---------------------------------------
  //
  // This part runs in the background script's minimized picker window
  // (#motmot-pick=<id>): a full copy of X's app, with its own login and
  // request signing, opened on an X search for one author's Tweets in a date
  // window. (A hidden frame would be lighter, but X won't load in one.)
  //
  //   from:alice since:2025-03-01 until:2025-04-01
  //
  // Search jumps straight to any stretch of time, so one request lands on a
  // random month of someone's history, and X makes that request itself. We
  // read the Tweets out of its response and pass one on as data. For the
  // next pick, the window moves to another window the way X's own links do
  // (no reload), and spare Tweets from each page are kept so "Another" is
  // often instant.

  const DAY_MS = 86400000;

  function tweetTime(tweet) {
    return Number(BigInt(tweet.id) >> 22n) + X_EPOCH_MS;
  }

  // Everything the page needs to draw a Tweet, taken from X's own data.
  function tweetData(result) {
    if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet;
    const legacy = result?.legacy;
    if (!legacy) return null;
    const user = result.core?.user_results?.result || {};
    const note = result.note_tweet?.note_tweet_results?.result;

    let text = note?.text || legacy.full_text || '';
    // Photo links are shown as photos, not as text; other short links are
    // spelled out in full.
    for (const m of legacy.entities?.media || []) text = text.split(m.url).join('');
    for (const u of note?.entity_set?.urls || legacy.entities?.urls || []) {
      if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
    }
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

    return {
      id: String(result.rest_id || legacy.id_str || ''),
      text,
      createdAt: legacy.created_at || '',
      replyTo: legacy.in_reply_to_screen_name || null,
      retweet: Boolean(legacy.retweeted_status_result),
      counts: {
        replies: legacy.reply_count || 0,
        retweets: legacy.retweet_count || 0,
        likes: legacy.favorite_count || 0,
      },
      user: {
        name: user.legacy?.name || user.core?.name || '',
        handle: user.legacy?.screen_name || user.core?.screen_name || '',
        avatar: user.legacy?.profile_image_url_https || user.avatar?.image_url || '',
        verified: Boolean(user.is_blue_verified),
      },
      media: (legacy.extended_entities?.media || []).slice(0, 4).map((m) => ({
        type: m.type,
        src: m.media_url_https,
      })),
    };
  }

  // The Tweets in a timeline response (a profile or a search), as data.
  function pageTweets(json) {
    const tweets = [];
    for (const node of walkJson(json)) {
      if (!Array.isArray(node.entries)) continue;
      for (const entry of node.entries) {
        const entryId = String(entry.entryId || '');
        const results = [];
        if (/^tweet-\d+$/.test(entryId)) results.push(entry.content?.itemContent?.tweet_results?.result);
        if (/^(profile-conversation|search-grid|home-conversation)/.test(entryId)) {
          for (const item of entry.content?.items || []) results.push(item.item?.itemContent?.tweet_results?.result);
        }
        for (const result of results) {
          const tweet = tweetData(result);
          if (tweet?.id) tweets.push(tweet);
        }
      }
    }
    return tweets;
  }

  // Theirs, in their own words (not a retweet), and in the last two years.
  function ownTweets(tweets, handle) {
    const oldest = Date.now() - PICK_WINDOW_MS - DAY_MS;
    return tweets.filter((t) => !t.retweet && t.user.handle.toLowerCase() === handle && tweetTime(t) >= oldest);
  }

  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  function searchPath(handle, lo, hi) {
    const q = `from:${handle} since:${day(lo)} until:${day(hi + DAY_MS)}`;
    return `/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
  }

  // A window of `span` days around a random moment in the last two years.
  function randomWindow(span) {
    const end = Date.now();
    const start = end - PICK_WINDOW_MS;
    if (!span) return { lo: start, hi: end };
    const width = span * DAY_MS;
    const lo = start + Math.random() * Math.max(0, end - start - width);
    return { lo, hi: Math.min(end, lo + width) };
  }

  // The window the frame was opened on, read back from its own URL.
  function windowFromUrl() {
    const q = new URLSearchParams(location.search).get('q') || '';
    const m = q.match(/^from:([A-Za-z0-9_]{1,15}) since:(\d{4}-\d\d-\d\d) until:(\d{4}-\d\d-\d\d)$/);
    if (!m) return null;
    return { handle: m[1].toLowerCase(), lo: Date.parse(m[2]), hi: Date.parse(m[3]) - DAY_MS };
  }

  const pickHash = window === window.top ? location.hash.match(/^#motmot-pick=([A-Za-z0-9]{1,40})$/) : null;
  const picker = pickHash
    ? {
        frame: pickHash[1],
        booted: false, // X has made its first search: in-app moves will work
        waiting: null, // the search we're waiting on: { handle, lo, hi, resolve }
        pools: new Map(), // handle → unshown Tweets from searches already made
        shown: new Set(), // IDs already shown, never shown twice
        batch: 0, // each search's Tweets are one batch (one stretch of time)
        lastBatch: new Map(), // handle → the batch last shown from
        queue: [],
        busy: false,
        searchedAt: 0, // when X last sent a search request
        stuck: false, // X didn't follow us to a new search: this frame can't move
      }
    : null;

  // Step-by-step notes in the console, to see where a pick stops. They
  // appear in the page's own console (the frame's lines are marked).
  const started = Date.now();
  function note(...args) {
    console.log(`[mot mot · picker window +${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
  }
  if (picker) {
    note('picker window started at', location.pathname + location.search);
    setTimeout(() => {
      if (!picker.booted) {
        note('6s in and X has made no search here. Page:', document.title, '|', location.href, '| text:', (document.body?.innerText || '').slice(0, 160).replace(/\s+/g, ' '));
      }
    }, 6000);
  }

  function tell(req, message) {
    note('→ page:', message.status, req || '', message.reason || '', message.tweet ? `@${message.tweet.user.handle} ${message.tweet.createdAt}` : '');
    window.postMessage({ source: 'motmot-pick', frame: picker.frame, req, ...message }, location.origin);
  }

  function addToPool(handle, tweets) {
    const pool = picker.pools.get(handle) || [];
    const batch = ++picker.batch;
    for (const t of tweets) {
      if (!picker.shown.has(t.id) && !pool.some((p) => p.tweet.id === t.id)) pool.push({ tweet: t, batch });
    }
    picker.pools.set(handle, pool);
  }

  // A random unshown Tweet, from a different stretch of time than the last
  // one if there's a choice, so "Another" really does jump around.
  function takeFromPool(handle) {
    const pool = picker.pools.get(handle) || [];
    if (!pool.length) return null;
    const fresh = pool.filter((p) => p.batch !== picker.lastBatch.get(handle));
    const from = fresh.length ? fresh : pool;
    const chosen = from[Math.floor(Math.random() * from.length)];
    pool.splice(pool.indexOf(chosen), 1);
    picker.shown.add(chosen.tweet.id);
    picker.lastBatch.set(handle, chosen.batch);
    return chosen.tweet;
  }

  // Every search response X gets in this frame.
  function onSearch(json) {
    picker.booted = true;
    const tweets = pageTweets(json);
    const w = picker.waiting;
    note('X search answered:', tweets.length, 'Tweets', json?.errors ? `errors: ${JSON.stringify(json.errors).slice(0, 200)}` : '', w ? `(waiting on @${w.handle})` : '(not waiting)');
    if (w) {
      picker.waiting = null;
      const inWindow = ownTweets(tweets, w.handle).filter((t) => {
        const at = tweetTime(t);
        return at >= w.lo - DAY_MS && at <= w.hi + 2 * DAY_MS;
      });
      w.resolve(inWindow);
    } else if (picker.lastHandle) {
      // A further page X loaded by itself: more to pick from.
      addToPool(picker.lastHandle, ownTweets(tweets, picker.lastHandle));
    }
  }

  // The author's Tweets in a window: X's own search, by moving the frame to
  // it the way X's links do. Null if X didn't answer in time; 'stuck' if X
  // didn't even start the search, which we know within a couple of seconds.
  function search(handle, { lo, hi }, navigate = true) {
    if (navigate && picker.stuck) return Promise.resolve('stuck');
    return new Promise((resolve) => {
      const asked = Date.now();
      const settle = (value) => {
        clearTimeout(timer);
        clearTimeout(check);
        if (picker.waiting?.resolve === done) picker.waiting = null;
        resolve(value);
      };
      const done = (tweets) => settle(tweets);
      const timer = setTimeout(() => settle(null), 9000);
      const check = navigate
        ? setTimeout(() => {
            if (picker.searchedAt < asked) {
              picker.stuck = true;
              note('X did not start a search after we moved the window: window is stuck');
              settle('stuck');
            }
          }, 2000)
        : null;
      picker.waiting = { handle, lo, hi, resolve: done };
      picker.lastHandle = handle;
      note(navigate ? 'moving window to search' : 'waiting on first search', `@${handle}`, day(lo), '→', day(hi));
      if (navigate) {
        // Replace, not push: a frame's history entries would land in the
        // tab's Back button.
        history.replaceState(null, '', searchPath(handle, lo, hi) + location.hash);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      }
    });
  }

  if (picker) {
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.source !== 'motmot-picker') return;
      // jump.js in this window may load after us: it asks, we say again.
      if (data.type === 'ping') return tell(null, { status: 'ready' });
      if (!/^[A-Za-z0-9_]{1,15}$/.test(data.handle || '')) return;
      const handle = data.handle.toLowerCase();
      if (data.type === 'pick' && /^[A-Za-z0-9]{1,40}$/.test(data.req)) {
        picker.queue.push({ req: data.req, handle });
      } else if (data.type === 'prefetch') {
        // Only if there's nothing new of theirs in hand or on the way.
        if (hasFresh(handle) || picker.queue.some((j) => j.handle === handle)) return;
        picker.queue.push({ handle });
      } else {
        return;
      }
      pump();
    });

    // The frame opened on a search window: that first search is X's own page
    // load, already under way. Its Tweets go straight into the pool.
    const first = windowFromUrl();
    if (first) {
      picker.busy = true;
      search(first.handle, first, false).then((tweets) => {
        if (tweets) addToPool(first.handle, tweets);
        picker.busy = false;
        pump();
      });
    }
    tell(null, { status: 'ready' });
  }

  function pump() {
    if (picker.busy) return;
    const next = picker.queue.shift();
    if (!next) return;
    picker.busy = true;
    const job = next.req ? runPick(next) : refill(next.handle);
    job
      .catch(() => next.req && tell(next.req, { status: 'reload' }))
      .finally(() => {
        picker.busy = false;
        pump();
      });
  }

  function hasFresh(handle) {
    return (picker.pools.get(handle) || []).some((p) => p.batch !== picker.lastBatch.get(handle));
  }

  async function runPick({ req, handle }) {
    tell(req, { status: 'seeking' });
    let tweet = takeFromPool(handle);

    // Nothing in hand: search a random month, then wider stretches for
    // someone who posts rarely.
    const spans = [30, 180, 0];
    for (let i = 0; !tweet && i < spans.length; i++) {
      if (!picker.booted) return tell(req, { status: 'reload' });
      const tweets = await search(handle, randomWindow(spans[i]));
      if (tweets === 'stuck') return tell(req, { status: 'reload', nonav: true });
      if (!tweets) return tell(req, { status: 'reload' });
      addToPool(handle, tweets);
      tweet = takeFromPool(handle);
      if (!tweet) tell(req, { status: 'collecting', count: i + 1, goal: spans.length });
    }
    if (!tweet) return tell(req, { status: 'failed', reason: 'none' });
    tell(req, { status: 'done', tweet });

    // Get the next one ready: Tweets from another random month, so the next
    // "Another" is instant and from a different time.
    picker.queue.push({ handle });
  }

  // Fetch ahead: a random month of theirs, widening (as a pick would) for
  // someone who rarely posts. Gives way as soon as a real pick is waiting.
  async function refill(handle) {
    for (const span of [30, 180, 0]) {
      if (!picker.booted || picker.stuck || picker.queue.some((j) => j.req)) return;
      const tweets = await search(handle, randomWindow(span));
      if (!Array.isArray(tweets)) return;
      addToPool(handle, tweets);
      if (tweets.length) return;
    }
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
    let plain = rawUrl;
    try {
      const variables = JSON.parse(url.searchParams.get('variables'));
      if (boost && typeof variables.count === 'number') {
        variables.count = Math.max(variables.count, BOOST_COUNT);
      }
      url.searchParams.set('variables', JSON.stringify(variables));
      plain = url.toString(); // what X would get without our cursor
      if (Date.now() < armedUntil && !variables.cursor) {
        variables.cursor = forgeCursor(target);
        armedUntil = 0;
        check = true;
      }
      url.searchParams.set('variables', JSON.stringify(variables));
      return { url: url.toString(), plain, check, userId: variables.userId };
    } catch {
      return { url: rawUrl, plain: rawUrl, check: false };
    }
  }

  // A forged cursor X wouldn't take was built from the saved template; drop
  // it so the next attempt starts from the default shape again.
  function forgetTemplate() {
    try {
      localStorage.removeItem(TEMPLATE_KEY);
    } catch {}
  }

  function inspect(text, check, hit = null) {
    let json;
    try {
      json = typeof text === 'string' ? JSON.parse(text) : text;
    } catch {
      if (check) report('ignored');
      return;
    }
    if (check) {
      const result = verdict(json);
      if (result === 'rejected') forgetTemplate();
      report(result === 'rejected' ? 'ignored' : result);
    } else {
      learn(json);
    } // never learn from our own forged request
    // While rewinding, each page landing is the cue to step again — much
    // faster than waiting on a timer.
    if (boost && !check) report('page');
  }

  const nativeFetch = window.fetch;
  let opsNoted = 0;
  function noteOp(raw) {
    if (!picker || opsNoted >= 12) return;
    const op = String(raw).match(/\/graphql\/[^/]+\/(\w+)/)?.[1];
    if (op) {
      opsNoted++;
      note('X request:', op);
    }
  }

  window.fetch = function (input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    noteOp(raw);
    const hit = intercept(raw);
    if (!hit) {
      const promise = nativeFetch.call(this, input, init);
      if (picker && isSearch(raw)) {
        picker.searchedAt = Date.now();
        note('X sent a search request (fetch)');
        promise.then((r) => r.ok || note('search request failed: HTTP', r.status), () => note('search request failed: network'));
        promise.then((r) => r.clone().json().then(onSearch, () => {}), () => {});
      }
      return promise;
    }

    const make = (u) => (input instanceof Request ? new Request(u, input) : u);

    // A page X couldn't serve: an HTTP error, or GraphQL errors with no data.
    const unusable = async (response) => {
      if (!response.ok) return true;
      try {
        const json = JSON.parse(await response.clone().text());
        return Boolean(json?.errors) && !json?.data;
      } catch {
        return true;
      }
    };

    if (!hit.check) {
      const boosted = hit.url !== raw;
      return nativeFetch.call(this, make(hit.url), init).then(async (response) => {
        // If X won't serve our bigger page size, quietly fall back to X's own
        // request, and stop asking — a stalled page would stall the rewind.
        if (boosted && (await unusable(response))) {
          boost = false;
          response = await nativeFetch.call(window, make(raw), init);
        }
        response.clone().text().then((t) => inspect(t, false), () => {});
        return response;
      });
    }

    // The forged request: look before X does. If X rejected the cursor (or
    // the page size), hand X exactly the request it made itself, so the
    // profile isn't left blank.
    return nativeFetch.call(this, make(hit.url), init).then(async (response) => {
      let result = 'rejected';
      try {
        if (!(await unusable(response))) result = verdict(JSON.parse(await response.clone().text()));
      } catch {}
      if (result !== 'rejected') {
        report(result);
        return response;
      }
      forgetTemplate();
      report('ignored');
      return nativeFetch.call(window, make(raw), init);
    });
  };

  function isSearch(rawUrl) {
    try {
      return SEARCH_OP.test(new URL(rawUrl, location.href).pathname);
    } catch {
      return false;
    }
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    noteOp(url);
    const get = String(method).toUpperCase() === 'GET';
    const hit = get ? intercept(String(url)) : null;
    if (hit) {
      this.addEventListener('load', () => {
        try {
          const body = this.responseType === 'json' ? this.response : this.responseText;
          inspect(body, hit.check, hit);
        } catch {
          if (hit.check) report('ignored');
        }
      });
      url = hit.url;
    } else if (picker && isSearch(String(url))) {
      picker.searchedAt = Date.now();
      note('X sent a search request (XHR)');
      this.addEventListener('load', () => {
        try {
          onSearch(this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
        } catch {}
      });
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
})();
