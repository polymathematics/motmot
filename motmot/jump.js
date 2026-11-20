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

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
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
        newTab: event.metaKey || event.ctrlKey,
        timer: setTimeout(fire, HOLD_MS),
        fired: false,
      };
    },
    true
  );

  document.addEventListener(
    'pointermove',
    (event) => {
      if (!press || press.fired) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE) cancel();
    },
    true
  );

  // A drag to select text, a scroll or a lifted finger before the hold
  // completes all mean "not a long press".
  for (const type of ['pointerup', 'pointercancel', 'dragstart']) {
    document.addEventListener(type, () => press && !press.fired && cancel(), true);
  }
  window.addEventListener('scroll', () => press && !press.fired && cancel(), true);
  window.addEventListener('blur', cancel);

  // Releasing after a completed hold would otherwise open the Tweet, and on
  // touch devices the hold also raises the context menu. Swallow both.
  for (const type of ['click', 'contextmenu']) {
    document.addEventListener(
      type,
      (event) => {
        if (!press?.fired) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === 'click') press = null;
      },
      true
    );
  }

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

  const hashId = (location.hash.match(/^#motmot=(\d{1,20})$/) || [])[1];
  const pathMatch = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/with_replies)?\/?$/);

  if (hashId && pathMatch) startRewind(pathMatch[1], hashId, Boolean(pathMatch[2]), { soft: false });

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
