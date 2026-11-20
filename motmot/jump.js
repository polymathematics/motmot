// mot mot — long-press a Tweet to open the author's own profile, rewound to
// the moment they posted it.
//
// Everything needed is already on the page:
//
//   1. The Tweet's permalink (/<handle>/status/<id>) gives the author.
//   2. The ID is a Snowflake: its top bits are the millisecond it was posted.
//
// rewind.js (running in X's own JavaScript world) slips a forged cursor into
// X's first timeline request for the profile so the feed starts at that
// Tweet, and reports back here how it went:
//
//   ok       — the Tweet is in the feed: mark it and scroll to it.
//   missing  — the cursor worked but the Tweet isn't on this tab (it was a
//              reply): retry on /with_replies.
//   ignored  — X didn't honour the cursor: scroll the real profile back in
//              time ourselves, using Snowflake times to steer and show
//              progress.
//
// For speed, the switch to the profile happens inside X's app (no reload).
// A full load of /<handle>#motmot=<id> is the backup, and X search the last
// resort.

(() => {
  const HOLD_MS = 550;
  const MOVE_TOLERANCE = 8; // px of drift allowed before it counts as a drag
  const X_EPOCH = 1288834974657n;
  const SEARCH_KEY = 'motmot:jump';
  const SOFT_TIMEOUT_MS = 2500; // in-app switch didn't load a timeline: reload
  const SCROLL_TICK_MS = 250; // steady pace when nothing is happening
  const REACT_MS = 40; // pause after X renders something, before the next step

  // ---- Snowflake ---------------------------------------------------------

  // IDs from before Nov 2010 are plain sequence numbers with no time in them.
  // They still sort correctly, which is all the rewind needs.
  function snowflakeTime(id) {
    try {
      const date = new Date(Number((BigInt(id) >> 22n) + X_EPOCH));
      return date.getUTCFullYear() >= 2010 ? date : null;
    } catch {
      return null;
    }
  }

  function formatWhen(date, withTime = true) {
    if (!date) return 'an early Tweet';
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    });
  }

  function statusLinks(root = document) {
    return root.querySelectorAll('article a[href*="/status/"] time');
  }

  function idFromTime(time) {
    return (time.closest('a')?.getAttribute('href') || '').match(/\/status\/(\d+)/)?.[1] || null;
  }

  function toPage(message) {
    window.postMessage({ source: 'motmot-jump', ...message }, location.origin);
  }

  // ---- Finding the Tweet under the pointer -------------------------------

  // The timestamp link is the Tweet's own permalink. Quoted Tweets render
  // their timestamp without a link, and a retweet's permalink points at the
  // original author — which is the poster we want.
  function tweetFromTarget(target) {
    // A loaded random-old-Tweet card stands in for the Tweet it shows.
    const card = target.closest('.motmot-card');
    if (card?.dataset.id) return { article: card, handle: card.dataset.handle, id: card.dataset.id };
    if (card) target = card.__motmotArticle || card;

    const article = target.closest('article');
    if (!article) return null;

    const time = article.querySelector('a[href*="/status/"] time');
    const href = time?.closest('a')?.getAttribute('href') || '';
    const match = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (!match) return null;

    return { article, handle: match[1], id: match[2] };
  }

  // A long press on these already means something, or should be left alone.
  function isExcluded(target) {
    return Boolean(
      target.closest(
        'button, [role="button"], input, textarea, [contenteditable="true"], video, [data-testid="videoPlayer"], [data-testid="videoComponent"], .motmot-banner'
      )
    );
  }

  // ---- The long press ----------------------------------------------------

  let press = null;

  function cancel() {
    if (!press) return;
    clearTimeout(press.timer);
    press.article.classList.remove('motmot-pressing');
    press = null;
  }

  // On a Mac, Control-click is a right-click: the browser reports it as a
  // left press with Control held, then opens the context menu. It must never
  // start a hold, and Control is not the new-tab key there (⌘ is).
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');

  document.addEventListener(
    'pointerdown',
    (event) => {
      // A finished long press whose release never produced a click: any new
      // press starts afresh rather than being swallowed.
      if (press?.fired && press.released) press = null;
      if (event.button !== 0 || !event.isPrimary) return;
      if (IS_MAC && event.ctrlKey && event.pointerType === 'mouse') return;
      if (isExcluded(event.target)) return;

      const tweet = tweetFromTarget(event.target);
      if (!tweet) return;

      cancel();
      tweet.article.classList.add('motmot-pressing');
      tweet.article.style.setProperty('--motmot-hold', `${HOLD_MS}ms`);

      press = {
        ...tweet,
        x: event.clientX,
        y: event.clientY,
        pointerType: event.pointerType,
        newTab: event.metaKey || (!IS_MAC && event.ctrlKey),
        timer: setTimeout(fire, HOLD_MS),
        fired: false,
        released: false,
      };
    },
    true
  );

  document.addEventListener(
    'pointermove',
    (event) => {
      if (!press || press.fired) return;
      // Another button joining in mid-hold (pressing right while holding
      // left) arrives as a move with more buttons down, not a new press.
      if (event.pointerType === 'mouse' && event.buttons !== 1) return cancel();
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE) cancel();
    },
    true
  );

  // Any other mouse button going down means this isn't a long press.
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 && press && !press.fired) cancel();
  }, true);

  // A drag to select text, a scroll or a lifted finger before the hold
  // completes all mean "not a long press". Once it has fired, note the
  // release: anything after that is a new gesture, not this one.
  for (const type of ['pointerup', 'pointercancel', 'dragstart']) {
    document.addEventListener(
      type,
      () => {
        if (!press) return;
        if (!press.fired) cancel();
        else press.released = true;
      },
      true
    );
  }
  window.addEventListener('scroll', () => press && !press.fired && cancel(), true);
  window.addEventListener('blur', cancel);

  // The context menu and the long press, kept apart:
  //  - mid-hold, a mouse context menu (right button, or Control-click) means
  //    the user wants the menu, so the hold is called off;
  //  - mid-hold on a touchscreen, the browser raises its menu as part of the
  //    same long press, so the menu is suppressed and the hold carries on;
  //  - after the hold has fired, a menu from that same gesture is
  //    suppressed, but once the button is up, a right-click is the user's
  //    own and goes through untouched.
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!press) return;
      const sameGesture = !press.released;
      if (!press.fired) {
        if (press.pointerType === 'mouse') return cancel();
      } else if (!sameGesture) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );

  // Releasing after a completed hold would otherwise open the Tweet.
  document.addEventListener(
    'click',
    (event) => {
      if (!press?.fired) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      press = null;
    },
    true
  );

  function profilePath(handle, replies) {
    return `/${handle}${replies ? '/with_replies' : ''}`;
  }

  function rewindUrl(handle, id, replies = false) {
    return `${location.origin}${profilePath(handle, replies)}#motmot=${id}`;
  }

  // Load the rewind URL for real. If only the #fragment would change, the
  // browser treats it as a jump within the page and doesn't reload at all,
  // which would leave the rewind stranded; so in that case, swap the URL in
  // place and reload explicitly.
  function reloadTo(url) {
    const next = new URL(url, location.href);
    if (next.pathname === location.pathname && next.search === location.search) {
      history.replaceState(null, '', next.href);
      location.reload();
    } else {
      location.assign(next.href);
    }
  }

  function fire() {
    if (!press) return;
    press.fired = true;
    press.article.classList.remove('motmot-pressing');
    navigator.vibrate?.(15);

    if (press.newTab) window.open(rewindUrl(press.handle, press.id), '_blank');
    else go(press.handle, press.id, false);

    // The release may land off-page and never produce a click; don't let a
    // stale press swallow the next real one.
    setTimeout(() => {
      if (press?.fired) press = null;
    }, 1000);
  }

  // Switch to the profile inside X's app: arm rewind.js, then move X's router
  // the way the back button would. This skips reloading all of X, which is
  // most of the wait. If we're already on that exact page the router has
  // nothing to do, so reload instead.
  function go(handle, id, replies) {
    const path = profilePath(handle, replies);
    if (location.pathname.toLowerCase() === path.toLowerCase()) {
      showGlow();
      reloadTo(rewindUrl(handle, id, replies));
      return;
    }

    // Tweets on screen now belong to the page we're leaving; never mistake
    // one of them for having arrived.
    const stale = new WeakSet(document.querySelectorAll('article'));

    toPage({ type: 'arm', id });
    history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    startRewind(handle, id, replies, { soft: true, stale });
  }

  // ---- Right-click: random old Tweet --------------------------------------

  // The context menu item lives in the background script, which can't see
  // the page. So as the right button goes down we note which Tweet it's on
  // (if any), and have the menu renamed for its author or hidden. When the
  // item is chosen, the background script tells us, and we take it from here.
  let contextTweet = null;

  function noteContextTweet(target) {
    const tweet = target instanceof Element ? tweetFromTarget(target) : null;
    contextTweet = tweet;
    // If the picker window is open, it fetches this author's Tweets now,
    // while the menu is still opening.
    if (tweet?.handle) prefetch(tweet.handle);
    try {
      chrome.runtime.sendMessage({ type: 'contextTweet', handle: tweet?.handle || null }).catch(() => {});
    } catch {
      // The extension was reloaded under this page; nothing to update.
    }
  }

  document.addEventListener('pointerdown', (event) => {
    if (event.button === 2) noteContextTweet(event.target);
  }, true);
  // The keyboard's menu key opens the menu with no pointer involved.
  document.addEventListener('contextmenu', (event) => {
    if (event.button !== 2) noteContextTweet(event.target);
  }, true);

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'randomOldTweet') return;
      const tweet = contextTweet;
      // X may have swapped the Tweet's element since the right-click.
      const article = tweet?.article?.isConnected
        ? tweet.article
        : tweet && document.querySelector(`article a[href$="/status/${tweet.id}"] time`)?.closest('article');
      if (tweet && article) {
        showRandomCard(tweet.handle, article);
      } else {
        showBanner('Right-click a Tweet to get a random old one from its author');
        fadeBannerAfter(3000);
      }
    });
  } catch {}

  // The old Tweet is shown right where the right-clicked Tweet is: an overlay
  // lies over it, the Tweet blurred underneath while the pick is made, and
  // then the old Tweet takes its place. ✕ gives the original back.
  function showRandomCard(handle, target) {
    let card = target.classList.contains('motmot-card') ? target : null;
    const article = card ? card.__motmotArticle : target;
    if (!card) {
      const cell = article.closest('[data-testid="cellInnerDiv"]') || article.parentElement;
      card = cell.querySelector(':scope > .motmot-card');
      if (!card) card = makeOverlay(article, cell);
    }
    if (!card) return;
    card.dataset.theme = pageTheme();
    pickInto(card, handle);
  }

  function makeOverlay(article, cell) {
    if (getComputedStyle(cell).position === 'static') cell.style.position = 'relative';
    const card = document.createElement('div');
    card.className = 'motmot-card';
    card.__motmotArticle = article;
    // Room below the Tweet when the old one is taller, so X's list moves the
    // Tweets below down instead of being covered.
    const room = document.createElement('div');
    room.className = 'motmot-card-room';
    cell.append(card, room);

    // Clicks inside the overlay are ours; X must not take them as a click on
    // the Tweet underneath (which would open it).
    card.addEventListener('click', (event) => event.stopPropagation());

    const place = () => {
      if (!card.isConnected) return;
      if (!article.isConnected) return closeOverlay(card);
      const top = article.offsetTop;
      const height = article.offsetHeight;
      card.style.top = `${top}px`;
      card.style.minHeight = `${height}px`;
      room.style.height = `${Math.max(0, card.offsetHeight - height)}px`;
    };
    const watch = new ResizeObserver(place);
    watch.observe(article);
    watch.observe(card);
    card.__motmotClose = () => {
      watch.disconnect();
      room.remove();
    };
    place();
    return card;
  }

  function closeOverlay(card) {
    card.__motmotCancel?.();
    card.__motmotClose?.();
    card.remove();
  }

  // X's three backgrounds: Default (white), Dim (navy), Lights out (black).
  function pageTheme() {
    const rgb = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255]).map(Number);
    const light = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    if (light > 128) return 'light';
    return rgb[2] > rgb[0] + 10 ? 'dim' : 'dark';
  }

  // ---- Asking for a pick ----------------------------------------------------
  //
  // Finding an old Tweet needs X's own app: its requests carry login and
  // signing we can't reproduce. The background script keeps X open in a
  // small minimized window, on a search for the author's Tweets from a
  // random month of the last two years; rewind.js there reads the results.
  // We ask through the background script, and the Tweet comes back as data.
  //
  // The first pick opens that window (a few seconds). It is then kept for
  // ten minutes: later picks move it to another search in a moment, and a
  // right-press on a Tweet gets that author's Tweets fetched before the menu
  // item is even chosen.
  const PICK_TIMEOUT_MS = 25000;
  const picks = new Map(); // req → hear(data)

  function note(...args) {
    console.log('[mot mot]', ...args);
  }

  function toBackground(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      return Promise.resolve(); // the extension was reloaded under this page
    }
  }

  // A hint: if the picker window is open, have it fetch this author's Tweets.
  const prefetched = new Map(); // handle → when
  function prefetch(handle) {
    handle = handle.toLowerCase();
    if (Date.now() - (prefetched.get(handle) || 0) < 60000) return;
    prefetched.set(handle, Date.now());
    toBackground({ type: 'prefetch', handle });
  }

  // Ask for a pick. `on(status, data)` hears 'seeking', 'collecting', 'done'
  // and 'failed'. Returns a function that cancels it.
  function requestPick(handle, on) {
    const req = Math.random().toString(36).slice(2, 12);
    const asked = Date.now();
    let retried = false;
    let over = false;

    const finish = (status, data) => {
      if (over) return;
      over = true;
      clearTimeout(timeout);
      picks.delete(req);
      note(`pick ${status} after ${((Date.now() - asked) / 1000).toFixed(1)}s`);
      on(status, data);
    };
    picks.set(req, (data) => {
      if (data.status === 'reload' && !retried) {
        // The picker window couldn't carry on: once more, in a fresh one.
        note('picker window asked for a fresh start', data.nonav ? '(it can’t move between searches)' : '');
        retried = true;
        toBackground({ type: 'pick', req, handle, fresh: true });
      } else if (data.status === 'done' || data.status === 'failed' || data.status === 'reload') {
        finish(data.status === 'reload' ? 'failed' : data.status, data);
      } else {
        on(data.status, data);
      }
    });
    const timeout = setTimeout(() => {
      note(`no answer from the picker window in ${PICK_TIMEOUT_MS / 1000}s; giving up`);
      finish('failed');
    }, PICK_TIMEOUT_MS);
    note('asking for a random old Tweet from', `@${handle}`);
    toBackground({ type: 'pick', req, handle });
    return () => {
      over = true;
      clearTimeout(timeout);
      picks.delete(req);
    };
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'pickEvent' && message.data) picks.get(message.data.req)?.(message.data);
    });
  } catch {}

  // In the picker window itself: carry messages between rewind.js (in the
  // page) and the background script.
  if (/^#motmot-pick=[A-Za-z0-9]{1,40}$/.test(location.hash) && window === window.top) {
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.source !== 'motmot-pick') return;
      toBackground({ type: 'pickerEvent', data });
    });
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type !== 'pickerCmd' || !message.cmd) return;
        window.postMessage({ source: 'motmot-picker', ...message.cmd }, location.origin);
      });
    } catch {}
    window.postMessage({ source: 'motmot-picker', type: 'ping' }, location.origin);
  }

  function pickInto(card, handle) {
    card.__motmotCancel?.();
    renderLoading(card, handle);

    const started = Date.now();
    let progress = 0.03;
    let ended = false;

    const fill = card.querySelector('.motmot-card-fill');
    const status = card.querySelector('.motmot-card-status');
    const setProgress = (fraction) => {
      progress = Math.max(progress, Math.min(0.97, fraction));
      if (fill) fill.style.transform = `scaleX(${progress})`;
    };
    // Creep on its own until the frame tells us more, so it is always moving.
    const creep = setInterval(() => {
      setProgress(0.4 * (1 - Math.exp(-(Date.now() - started) / 2500)));
    }, 100);

    function end() {
      ended = true;
      clearInterval(creep);
      card.__motmotCancel = null;
    }

    const cancelPick = requestPick(handle, (state, data) => {
      if (ended) return;
      if (state === 'seeking') {
        setProgress(0.45);
        if (status) status.textContent = `Picking a moment from @${handle}'s last two years…`;
      } else if (state === 'collecting' && data?.goal) {
        setProgress(0.45 + 0.5 * (data.count / data.goal));
        if (status) status.textContent = `Quiet stretch — looking wider in @${handle}'s last two years…`;
      } else if (state === 'done' && data?.tweet) {
        if (fill) fill.style.transform = 'scaleX(1)';
        end();
        setTimeout(() => {
          if (card.isConnected) renderTweet(card, handle, data.tweet);
        }, 200);
      } else if (state === 'failed') {
        end();
        renderError(card, handle, data?.reason === 'none' ? `No Tweets from @${handle} in the last two years.` : null);
      }
    });

    card.__motmotCancel = () => {
      end();
      cancelPick();
    };
  }

  // ---- Drawing the card ------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function cardHead(card, handle, label, { another = true } = {}) {
    const head = el('div', 'motmot-card-head');
    head.appendChild(el('span', 'motmot-card-label', label));
    if (another) {
      const again = el('button', 'motmot-card-btn', 'Another');
      again.type = 'button';
      again.addEventListener('click', () => pickInto(card, handle));
      head.appendChild(again);
    }
    const close = el('button', 'motmot-card-btn motmot-card-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => closeOverlay(card));
    head.appendChild(close);
    return head;
  }

  function renderLoading(card, handle) {
    card.classList.remove('motmot-card-shine', 'motmot-card-loaded');
    delete card.dataset.id;
    card.replaceChildren(
      cardHead(card, handle, 'Random old Tweet', { another: false }),
      (() => {
        const track = el('div', 'motmot-card-track');
        track.appendChild(el('div', 'motmot-card-fill'));
        return track;
      })(),
      el('div', 'motmot-card-status', `Digging up a random old Tweet from @${handle}…`)
    );
  }

  function renderError(card, handle, message = null) {
    if (!card.isConnected) return;
    card.classList.add('motmot-card-loaded');
    card.replaceChildren(
      cardHead(card, handle, 'Random old Tweet'),
      el('div', 'motmot-card-status', message || `Couldn't reach @${handle}'s old Tweets just now.`)
    );
  }

  // Text with its links made clickable. Built from text nodes and anchors
  // only — Tweet text never goes anywhere near innerHTML.
  function linkedText(text) {
    const box = el('div', 'motmot-card-text');
    for (const part of text.split(/(https?:\/\/[^\s]+)/)) {
      if (/^https?:\/\//.test(part)) {
        const a = el('a', null, part.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) + (part.length > 48 ? '…' : ''));
        a.href = part;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        box.appendChild(a);
      } else if (part) {
        box.appendChild(document.createTextNode(part));
      }
    }
    return box;
  }

  function compact(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
    return String(n);
  }

  // Only images from X's own image host make it into the card.
  function safeImage(src) {
    try {
      const url = new URL(src);
      return url.protocol === 'https:' && /(^|\.)twimg\.com$/.test(url.hostname) ? url.href : null;
    } catch {
      return null;
    }
  }

  function renderTweet(card, handle, tweet) {
    const id = /^\d{1,20}$/.test(tweet.id) ? tweet.id : null;
    const author = /^[A-Za-z0-9_]{1,15}$/.test(tweet.user?.handle || '') ? tweet.user.handle : handle;
    const posted = new Date(Date.parse(tweet.createdAt) || (id ? snowflakeTime(id) : 0));
    const permalink = id ? `/${author}/status/${id}` : null;

    const body = el('div', 'motmot-card-tweet');
    const avatarSrc = safeImage(tweet.user?.avatar || '');
    const avatar = el(avatarSrc ? 'img' : 'div', 'motmot-card-avatar');
    if (avatarSrc) {
      avatar.src = avatarSrc;
      avatar.alt = '';
    }
    body.appendChild(avatar);

    const main = el('div', 'motmot-card-main');
    const meta = el('div', 'motmot-card-meta');
    meta.appendChild(el('span', 'motmot-card-name', tweet.user?.name || author));
    if (tweet.user?.verified) meta.appendChild(el('span', 'motmot-card-verified', '✓'));
    meta.appendChild(el('span', 'motmot-card-handle', `@${author} · ${formatWhen(posted, false)}`));
    main.appendChild(meta);

    if (tweet.replyTo) main.appendChild(el('div', 'motmot-card-reply', `Replying to @${tweet.replyTo}`));
    if (tweet.text) main.appendChild(linkedText(tweet.text));

    const photos = (tweet.media || []).map((m) => ({ ...m, src: safeImage(m.src) })).filter((m) => m.src);
    if (photos.length) {
      const grid = el('div', `motmot-card-media motmot-card-media-${photos.length}`);
      for (const m of photos) {
        const cellBox = el('div', 'motmot-card-photo');
        const img = el('img');
        img.src = `${m.src}?name=small`;
        img.alt = '';
        img.loading = 'lazy';
        cellBox.appendChild(img);
        if (m.type !== 'photo') cellBox.appendChild(el('span', 'motmot-card-play', '▶'));
        grid.appendChild(cellBox);
      }
      main.appendChild(grid);
    }

    const counts = el('div', 'motmot-card-counts');
    counts.appendChild(el('span', null, `${compact(tweet.counts?.replies || 0)} replies`));
    counts.appendChild(el('span', null, `${compact(tweet.counts?.retweets || 0)} reposts`));
    counts.appendChild(el('span', null, `${compact(tweet.counts?.likes || 0)} likes`));
    main.appendChild(counts);
    body.appendChild(main);

    const foot = el('div', 'motmot-card-foot');
    if (permalink) {
      const open = el('a', 'motmot-card-open', 'Open on X');
      open.href = permalink;
      foot.appendChild(open);
      foot.appendChild(el('span', 'motmot-card-hint', 'Hold to rewind their profile to this moment'));
    }

    card.classList.add('motmot-card-loaded');
    card.replaceChildren(cardHead(card, handle, `Random old Tweet · ${formatWhen(posted, false)}`), body, foot);
    if (id) {
      // Lets a long press on the card rewind their profile to this Tweet.
      card.dataset.handle = author;
      card.dataset.id = id;
    }

    // The same arrival light as a rewind; the card is our own element, so the
    // class is safe on it.
    card.classList.remove('motmot-card-shine');
    void card.offsetWidth; // restart the animation for "Another"
    card.classList.add('motmot-card-shine');
    setTimeout(() => card.classList.remove('motmot-card-shine'), SHINE_MS + 100);

    // Bring the whole card into view if it isn't, without yanking the page.
    const rect = card.getBoundingClientRect();
    if (rect.bottom > window.innerHeight || rect.top < 0) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---- The glow ------------------------------------------------------------

  // A faint, colour-cycling wash over the whole screen while we rewind. It
  // ignores the pointer entirely, so the page stays usable underneath.
  let glow = null;

  function showGlow() {
    if (glow) return;
    glow = document.createElement('div');
    glow.className = 'motmot-glow';
    glow.setAttribute('aria-hidden', 'true');
    // At document_start there is no <body> yet, but <html> is always there.
    (document.body || document.documentElement).appendChild(glow);
    requestAnimationFrame(() => requestAnimationFrame(() => glow?.classList.add('motmot-glow-on')));
  }

  function hideGlow() {
    glow = null;
    // Every copy, not just the one we're tracking: nothing may be left on.
    for (const node of document.querySelectorAll('.motmot-glow')) {
      node.classList.remove('motmot-glow-on');
      setTimeout(() => node.remove(), 500);
    }
  }

  // ---- Telling the user's scrolling from ours ---------------------------

  // Our own scrolling never produces wheel, touch or key events, so those
  // mean the user wants control back. But a single stray event is not
  // intent: trackpad momentum from before the long press can still be
  // arriving as we land. So wheel and touch only count after a grace period
  // and once they add up to a deliberate amount; navigation keys count at
  // once. Returns a function that removes the listeners.
  function onUserScroll(callback, graceMs) {
    const start = performance.now();
    let sum = 0;
    let last = 0;
    const KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Escape'];

    const wheel = (event) => {
      const now = performance.now();
      if (now - start < graceMs) return;
      if (now - last > 300) sum = 0;
      last = now;
      sum += Math.abs(event.deltaY) + Math.abs(event.deltaX);
      if (sum >= 120) fire();
    };
    const touch = () => {
      if (performance.now() - start >= graceMs) fire();
    };
    const key = (event) => {
      if (KEYS.includes(event.key)) fire();
    };

    function off() {
      window.removeEventListener('wheel', wheel);
      window.removeEventListener('touchmove', touch);
      window.removeEventListener('keydown', key, true);
    }
    function fire() {
      off();
      callback();
    }

    window.addEventListener('wheel', wheel, { passive: true });
    window.addEventListener('touchmove', touch, { passive: true });
    window.addEventListener('keydown', key, true);
    return off;
  }

  // ---- Progress bar --------------------------------------------------------

  // A coloured bar across the top of the screen that fills as the rewind
  // closes in on the Tweet. It only ever moves forward, and eases toward its
  // goal every frame, so it is always visibly alive.
  let bar = null;

  function showBar() {
    if (bar) return bar;
    const track = document.createElement('div');
    track.className = 'motmot-progress';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div');
    fill.className = 'motmot-progress-fill';
    track.appendChild(fill);
    (document.body || document.documentElement).appendChild(track);
    bar = { track, fill, shown: 0 };
    setBar(0.02);
    return bar;
  }

  function setBar(fraction) {
    if (!bar) return;
    bar.shown = Math.max(bar.shown, Math.min(1, fraction));
    bar.fill.style.transform = `scaleX(${bar.shown})`;
  }

  // On arrival the bar runs the rest of the way to full (CSS animates it),
  // holds there a moment so you see it complete, then fades. Otherwise it
  // just fades where it is.
  function finishBar(success) {
    const current = bar;
    bar = null;
    for (const track of document.querySelectorAll('.motmot-progress')) {
      if (track === current?.track && success) {
        track.classList.add('motmot-progress-finishing');
        current.fill.style.transform = 'scaleX(1)';
        setTimeout(() => track.classList.add('motmot-progress-done'), 550);
        setTimeout(() => track.remove(), 1300);
      } else {
        track.classList.add('motmot-progress-done');
        setTimeout(() => track.remove(), 700);
      }
    }
  }

  // ---- Arrival: centre the Tweet, then light it up ----------------------

  const SHINE_MS = 2600; // keep in step with motmot-swell in jump.css
  const STEADY_FRAMES = 8; // frames on-centre before we call it settled

  // The part of the screen the timeline is actually visible in: between
  // whatever X pins to the top (the profile's sticky name bar) and the
  // bottom (the tab bar on narrow screens). Found by asking what sits at the
  // top and bottom edges above the Tweet's column, and looking for a fixed
  // or sticky bar there. Our own overlays are skipped.
  function visibleBand(x) {
    const view = window.innerHeight;
    let top = 0;
    let bottom = view;
    if (!document.elementsFromPoint) return { top, bottom };
    for (const y of [1, view - 1]) {
      for (const hit of document.elementsFromPoint(x, y)) {
        if (hit.closest('.motmot-banner, .motmot-progress, .motmot-glow, .motmot-halo')) continue;
        for (let node = hit; node && node !== document.body; node = node.parentElement) {
          const position = getComputedStyle(node).position;
          if (position !== 'fixed' && position !== 'sticky') continue;
          const rect = node.getBoundingClientRect();
          if (rect.height > view / 3) break; // a column, not a bar
          if (y < view / 2 && rect.top <= 1) top = Math.max(top, rect.bottom);
          if (y > view / 2 && rect.bottom >= view - 1) bottom = Math.min(bottom, rect.top);
          break;
        }
      }
    }
    return { top, bottom };
  }

  // Getting the Tweet centred once is easy; keeping it there is the hard
  // part. After the scroll stops, X keeps moving things — images load, Tweets
  // above re-measure, and its virtualised list may swap the Tweet's element
  // for a fresh one. So a per-frame loop re-finds the Tweet by ID (ignoring
  // any hidden copy left on the page we came from), glides it to the centre
  // of the visible area, and once it has held still for a few frames, the
  // light starts. It keeps correcting drift until the light has faded, and
  // lets go if the user scrolls.
  //
  // The light is our own element laid over the Tweet, not a class on X's
  // element: X's React rewrites its elements' classes whenever it
  // re-renders them, which would wipe (and restart) an effect set there.
  function spotlight(id, initial, stale = new WeakSet()) {
    const visible = (node) => node?.isConnected && node.getClientRects().length > 0;
    const find = () => {
      for (const time of document.querySelectorAll(`article a[href$="/status/${id}"] time`)) {
        const article = time.closest('article');
        if (article && !stale.has(article) && visible(article)) return article;
      }
      return null;
    };

    for (const old of document.querySelectorAll('.motmot-halo')) old.remove();

    let el = initial;
    let steady = 0;
    let shineUntil = 0;
    let released = false;
    let band = null;
    let frames = 0;
    let halo = null;
    const giveUpAt = performance.now() + 4000; // never chase forever
    const stopListening = onUserScroll(() => {
      released = true;
    }, 300);

    // If the Tweet is among the last loaded, there may not be half a screen
    // of page below it to scroll into. This strip supplies it, then shrinks
    // away as X loads more below or the user scrolls back up.
    let room = null;
    function needRoom(px) {
      if (!document.body) return;
      if (!room) {
        room = document.createElement('div');
        room.className = 'motmot-spacer';
        room.setAttribute('aria-hidden', 'true');
        document.body.appendChild(room);
        window.addEventListener('scroll', shrinkRoom, { passive: true });
      }
      room.style.height = `${room.offsetHeight + px}px`;
    }
    function shrinkRoom() {
      if (!room) return;
      const doc = document.documentElement;
      const contentBottom = doc.scrollHeight - room.offsetHeight;
      const needed = Math.max(0, Math.ceil(window.scrollY + window.innerHeight - contentBottom));
      if (needed === 0) {
        room.remove();
        room = null;
        window.removeEventListener('scroll', shrinkRoom);
      } else if (needed < room.offsetHeight) {
        room.style.height = `${needed}px`;
      }
    }

    // Keep the halo exactly over the Tweet, in page coordinates, so it moves
    // with the page between frames as well.
    function placeHalo(rect) {
      if (!halo) return;
      halo.style.left = `${rect.left + window.scrollX}px`;
      halo.style.top = `${rect.top + window.scrollY}px`;
      halo.style.width = `${rect.width}px`;
      halo.style.height = `${rect.height}px`;
    }

    function shine(rect) {
      shineUntil = performance.now() + SHINE_MS;
      halo = document.createElement('div');
      halo.className = 'motmot-halo';
      halo.setAttribute('aria-hidden', 'true');
      placeHalo(rect);
      document.body.appendChild(halo);
      const leaving = halo;
      setTimeout(() => leaving.remove(), SHINE_MS + 100);
    }

    function finish() {
      stopListening();
      shrinkRoom();
    }

    (function frame() {
      const now = performance.now();
      const current = find();
      if (current) el = current;

      if (!visible(el)) {
        if (now < giveUpAt) requestAnimationFrame(frame);
        else finish();
        return;
      }
      // Best effort: X may wipe this on re-render, so it's renewed each frame.
      el.classList.add('motmot-origin');

      const rect = el.getBoundingClientRect();
      // Re-measure X's bars now and then; they don't move often.
      if (!band || frames++ % 15 === 0) band = visibleBand(rect.left + rect.width / 2);

      if (!released && !(shineUntil && now > shineUntil)) {
        const space = band.bottom - band.top;
        // A Tweet taller than most of the visible area is shown from its top
        // instead, so you start reading at the beginning.
        const goal = rect.height > space * 0.8 ? band.top + space * 0.08 : band.top + (space - rect.height) / 2;
        const offset = rect.top - goal;

        const below = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
        if (offset > below + 1) needRoom(Math.ceil(offset - below) + 2);

        if (Math.abs(offset) > 1) {
          // Ease in: a third of the way per frame reads as a soft glide,
          // finishing with whole pixels so it lands exactly.
          const move = Math.abs(offset) < 3 ? Math.round(offset) || Math.sign(offset) : offset * 0.35;
          const before = window.scrollY;
          window.scrollBy(0, move);
          // Pinned against the top of the page: as centred as it can be.
          if (Math.abs(window.scrollY - before) < 0.5) steady++;
          else steady = 0;
        } else {
          steady++;
        }
      }

      const settledRect = el.getBoundingClientRect();
      if (!shineUntil && (steady >= STEADY_FRAMES || released || now > giveUpAt)) shine(settledRect);
      placeHalo(settledRect);

      if (shineUntil && now > shineUntil) return finish();
      requestAnimationFrame(frame);
    })();
  }

  // ---- The banner --------------------------------------------------------

  let banner = null;

  function showBanner(text, actions = []) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => showBanner(text, actions), { once: true });
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'motmot-banner';
      banner.setAttribute('role', 'status');
      document.body.appendChild(banner);
    }
    banner.replaceChildren();
    const label = document.createElement('span');
    label.textContent = text;
    banner.appendChild(label);
    for (const { label: name, onClick } of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.addEventListener('click', onClick);
      banner.appendChild(button);
    }
  }

  function hideBanner() {
    clearInterval(leaveWatch);
    banner?.remove();
    banner = null;
  }

  // Fade the banner out, then remove it.
  function fadeBanner() {
    clearInterval(leaveWatch);
    const leaving = banner;
    banner = null;
    if (!leaving) return;
    leaving.classList.add('motmot-banner-leaving');
    setTimeout(() => leaving.remove(), 400);
  }

  // Once a rewind has finished, the banner belongs to this page: as soon as
  // the user goes anywhere else (Home, another profile, a Tweet), it fades
  // away. X changes pages inside its own app without telling us, so we
  // watch the address.
  function fadeBannerAfter(ms) {
    const shown = banner;
    setTimeout(() => {
      if (banner === shown) fadeBanner();
    }, ms);
  }

  let leaveWatch = null;
  function fadeBannerOnLeave() {
    clearInterval(leaveWatch);
    const here = location.pathname;
    leaveWatch = setInterval(() => {
      if (!banner) return clearInterval(leaveWatch);
      if (location.pathname !== here) fadeBanner();
    }, 200);
  }

  // ---- Rewinding a profile -----------------------------------------------

  // One rewind at a time; a new long press supersedes whatever was running.
  let active = null;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'motmot-rewind') return;
    if (active && event.data.id === active.id) active.onReport(event.data.status);
  });

  const hashMatch = location.hash.match(/^#motmot=(\d{1,20})$/);
  const pathMatch = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/with_replies)?\/?$/);

  if (hashMatch && pathMatch) startRewind(pathMatch[1], hashMatch[1], Boolean(pathMatch[2]), { soft: false });

  function startRewind(handle, id, replies, { soft, stale = new WeakSet() }) {
    active?.stop();
    clearInterval(leaveWatch); // a new rewind owns the banner now

    const target = BigInt(id);
    const when = snowflakeTime(id);
    const prefix = `/${handle.toLowerCase()}/`;
    let settled = false;
    let tick = null;
    let reached = null; // furthest back we've got: the bottom-most of their Tweets
    let lastProgress = Date.now();
    let heard = false; // rewind.js has reported on the profile's timeline
    const startedAt = Date.now();

    const nowAction = { label: 'Back to now', onClick: () => location.assign(`/${handle}`) };
    const searchAction = { label: 'Try search', onClick: () => openSearch(handle, id) };
    const closeAction = { label: '✕', onClick: () => { stop(); finishBar(false); hideBanner(); } };

    showGlow();
    showBar();
    showBanner(`Rewinding @${handle} to ${formatWhen(when)}…`, [closeAction]);

    // Every time X adds to the page, take a step straight away. If the forged
    // cursor worked, the very first step finds the Tweet and we're done.
    const observer = new MutationObserver(() => soon(REACT_MS));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // The user scrolling for themselves means "stop driving".
    const stopListening = onUserScroll(() => {
      if (settled) return;
      stop();
      finishBar(false);
      showBanner(`Stopped rewinding @${handle}`, [searchAction, closeAction]);
      fadeBannerOnLeave();
    }, 1000);

    // ---- Motion ------------------------------------------------------------
    //
    // Scrolling is its own loop, one step per frame, running from the very
    // first frame of the rewind; it never waits on X, and it runs until we
    // arrive. Deciding which Tweets count (step(), below) is separate and
    // stays strict.
    //
    // Until the author's Tweets are on the page there is nothing to scroll
    // through, so an empty strip at the foot of the page grows just ahead of
    // the scroll, giving it room to keep moving. It goes the moment real
    // Tweets render, so X's own "load more" sees the true bottom.
    const CRUISE_PX = 14; // per frame while waiting for content (~840px/s)
    let spacer = null;
    let frame = requestAnimationFrame(drive);

    function drive() {
      if (settled) return;
      const waiting = reached === null;
      const view = window.innerHeight;

      if (waiting && document.body) {
        if (!spacer || !spacer.isConnected) {
          spacer = document.createElement('div');
          spacer.className = 'motmot-spacer';
          spacer.setAttribute('aria-hidden', 'true');
          document.body.appendChild(spacer);
        }
        // Keep at least a screen of room below the current position.
        const room = document.documentElement.scrollHeight - (window.scrollY + view);
        if (room < view) spacer.style.height = `${spacer.offsetHeight + (view - room)}px`;
      } else if (!waiting && spacer) {
        spacer.remove();
        spacer = null;
      }

      const gap = document.documentElement.scrollHeight - view - window.scrollY;
      if (gap > 1) {
        // Glide while waiting; once there's content, close on the bottom
        // fast so X starts loading the next page as soon as possible.
        const move = waiting ? CRUISE_PX : Math.max(CRUISE_PX, gap * 0.25);
        window.scrollTo(0, window.scrollY + Math.min(gap, move));
      }

      updateBar();
      frame = requestAnimationFrame(drive);
    }

    // The bar's goal is how far back in time we've got, as a share of the way
    // from now to the Tweet. Before anything has loaded it creeps up on its
    // own, so it is moving from the first frame. Each frame it eases toward
    // the goal, never past 97% until we actually arrive.
    function updateBar() {
      if (!bar) return;
      const elapsed = Date.now() - startedAt;
      let goal = 0.12 * (1 - Math.exp(-elapsed / 2500));
      const at = reached !== null ? snowflakeTime(reached.toString()) : null;
      if (when && at) goal = Math.max(goal, (startedAt - at) / (startedAt - when));
      else if (reached !== null) goal = Math.max(goal, 0.5 * (1 - Math.exp(-elapsed / 8000)));
      goal = Math.min(goal, 0.97);
      setBar(bar.shown + (goal - bar.shown) * 0.08);
    }

    function stop() {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      spacer?.remove();
      spacer = null;
      clearTimeout(tick);
      clearTimeout(watchdog);
      observer.disconnect();
      stopListening();
      toPage({ type: 'calm' });
      hideGlow();
      if (active === self) active = null;
    }

    // Drop the marker from the address bar once we're done with it, keeping
    // X's router state intact.
    function clearHash() {
      if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
    }

    function arrived(article) {
      stop();
      finishBar(true);
      spotlight(id, article, stale);
      clearHash();
      showBanner(`@${handle} as of ${formatWhen(when)}`, [nowAction, closeAction]);
      fadeBannerOnLeave();
    }

    function failed(reason) {
      stop();
      finishBar(false);
      clearHash();
      showBanner(reason, [searchAction, closeAction]);
      fadeBannerOnLeave();
    }

    function tryReplies() {
      stop();
      if (soft) go(handle, id, true);
      else location.replace(rewindUrl(handle, id, true));
    }

    // X's profile header carries data-testid="UserName" (Tweets use
    // "User-Name"), and shows the @handle.
    function profileShown() {
      const at = `@${handle.toLowerCase()}`;
      for (const node of document.querySelectorAll('[data-testid="UserName"]')) {
        if ((node.textContent || '').toLowerCase().includes(at)) return true;
      }
      return false;
    }

    // Schedule the next step, keeping whichever is sooner.
    let tickAt = Infinity;
    function soon(ms) {
      if (settled) return;
      const at = Date.now() + ms;
      if (at >= tickAt) return;
      clearTimeout(tick);
      tickAt = at;
      tick = setTimeout(step, ms);
    }

    function step() {
      tickAt = Infinity;
      if (settled) return;

      // In-app, the page we're leaving lingers after the switch, and the
      // scroll (already running) can load more of it. Any of the author's
      // older Tweets on it would look like we'd gone past the target. So
      // while the old page is still up, every Tweet on the page is treated
      // as its and never counted. That ends as soon as either X has drawn
      // this profile's header (which comes before its Tweets, so none of
      // them can be mistaken for the old page's) or X has asked for the
      // profile's timeline. The scrolling carries on regardless.
      if (soft && !heard && !profileShown()) {
        for (const article of document.querySelectorAll('article')) stale.add(article);
        return soon(REACT_MS);
      }

      // Each live Tweet on the page, by its own permalink (the first status
      // link in it; quoted Tweets' links come later or not at all).
      const theirs = []; // the author's own, as [top, id]
      for (const article of document.querySelectorAll('article')) {
        if (stale.has(article)) continue;
        const time = article.querySelector('a[href*="/status/"] time');
        if (!time) continue;
        const tid = idFromTime(time);
        if (tid === id && article.getClientRects().length) return arrived(article);
        const href = (time.closest('a').getAttribute('href') || '').toLowerCase();
        if (tid && href.startsWith(prefix)) theirs.push([article.getBoundingClientRect().top, BigInt(tid)]);
      }

      // Progress is read from the bottom of the timeline, not from the oldest
      // Tweet anywhere on it: a pinned Tweet, or the earlier posts of a
      // thread shown above its reply, can be far older than where the
      // timeline has actually got to.
      theirs.sort((a, b) => a[0] - b[0]);
      if (theirs.length) {
        const bottom = theirs[theirs.length - 1][1];
        if (reached === null || bottom < reached) {
          reached = bottom;
          lastProgress = Date.now();
        }
      }

      // Passed it: the bottom two of their Tweets are both older than the
      // target, and it never appeared.
      if (theirs.length >= 2 && theirs[theirs.length - 1][1] < target && theirs[theirs.length - 2][1] < target) {
        if (!replies) return tryReplies();
        return failed(`Couldn't find that Tweet in @${handle}'s feed`);
      }

      if (Date.now() - lastProgress > 15000) {
        return failed(`X stops loading @${handle}'s profile before ${formatWhen(when, false)}`);
      }

      const at = reached !== null ? snowflakeTime(reached.toString()) : null;
      if (when && at) {
        const pct = Math.min(99, Math.max(0, Math.round(((startedAt - at) / (startedAt - when)) * 100)));
        showBanner(`Rewinding @${handle} to ${formatWhen(when)} — at ${formatWhen(at, false)} (${pct}%)`, [closeAction]);
      }

      soon(SCROLL_TICK_MS);
    }

    // ---- Hearing back from rewind.js ------------------------------------

    function onReport(status) {
      if (settled) return;
      // Only the verdict on X's first timeline request means the profile has
      // taken over; 'page' can come from the old page loading more.
      if (status !== 'page') heard = true;
      lastProgress = Date.now();
      clearTimeout(watchdog);
      if (status === 'missing' && !replies) tryReplies();
      else if (status === 'missing') failed(`Couldn't find that Tweet in @${handle}'s feed`);
      else soon(REACT_MS); // ok / ignored / page: X is about to render
    }

    // In-app, no timeline request at all usually means X reused a cached
    // copy of the profile: reload for real.
    const watchdog = soft
      ? setTimeout(() => {
          if (settled || heard) return;
          toPage({ type: 'disarm' });
          stop();
          showGlow();
          reloadTo(rewindUrl(handle, id, replies));
        }, SOFT_TIMEOUT_MS)
      : null;


    const self = { id, onReport, stop };
    active = self;
    step();
  }

  // ---- Last resort: X search ---------------------------------------------

  function searchUrl(query) {
    const params = new URLSearchParams({ q: query, src: 'typed_query', f: 'live' });
    return `${location.origin}/search?${params}`;
  }

  // Most precise first: the ID and Unix-time operators are exact but
  // undocumented; `until:` is documented but only has day resolution.
  function candidateQueries(handle, id) {
    const queries = [`from:${handle} max_id:${id}`];
    const time = snowflakeTime(id);
    if (time) {
      queries.push(`from:${handle} until_time:${Math.floor(time.getTime() / 1000) + 1}`);
      // until: is exclusive, so the day after keeps the Tweet's own day in.
      queries.push(`from:${handle} until:${new Date(time.getTime() + 86400000).toISOString().slice(0, 10)}`);
    }
    return queries;
  }

  function openSearch(handle, id) {
    const queries = candidateQueries(handle, id);
    sessionStorage.setItem(SEARCH_KEY, JSON.stringify({ id, queries, step: 0, at: Date.now() }));
    location.assign(searchUrl(queries[0]));
  }

  // On the search page, either the Tweet shows up (mark it) or X shows its
  // empty state (operator not understood: try the next query).
  function resumeSearch() {
    let plan;
    try {
      plan = JSON.parse(sessionStorage.getItem(SEARCH_KEY) || 'null');
    } catch {
      plan = null;
    }
    if (!plan || !location.pathname.startsWith('/search')) return;
    if (Date.now() - plan.at > 60000) return sessionStorage.removeItem(SEARCH_KEY);

    const deadline = Date.now() + 15000;
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();

    function done() {
      observer.disconnect();
      sessionStorage.removeItem(SEARCH_KEY);
    }

    function check() {
      if (Date.now() > deadline) return done();

      const time = document.querySelector(`article a[href$="/status/${plan.id}"] time`);
      if (time) {
        spotlight(plan.id, time.closest('article'));
        return done();
      }

      if (document.querySelector('[data-testid="emptyState"]')) {
        const next = plan.step + 1;
        if (next >= plan.queries.length) return done();
        observer.disconnect();
        sessionStorage.setItem(SEARCH_KEY, JSON.stringify({ ...plan, step: next, at: Date.now() }));
        location.replace(searchUrl(plan.queries[next]));
      }
    }
  }

  if (document.body) resumeSearch();
  else document.addEventListener('DOMContentLoaded', resumeSearch, { once: true });
})();
