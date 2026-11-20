// mot mot — long-press a Tweet to open the author's own profile, rewound to
// the moment they posted it.
//
// Everything needed is already on the page:
//
//   1. The Tweet's permalink (/<handle>/status/<id>) gives the author.
//   2. The ID is a Snowflake: its top bits are the millisecond it was posted.
//
// The press opens /<handle>#motmot=<id>. On that page, rewind.js (running in
// X's own JavaScript world) slips a forged cursor into X's first timeline
// request so the feed starts at that Tweet, and reports back here how it went:
//
//   ok       — the Tweet is in the feed: mark it and scroll to it.
//   missing  — the cursor worked but the Tweet isn't on this tab (it was a
//              reply): retry on /with_replies.
//   ignored  — X didn't honour the cursor: scroll the real profile back in
//              time ourselves, using Snowflake times to steer and show
//              progress.
//
// If all of that fails, X search is offered as a last resort.

(() => {
  const HOLD_MS = 550;
  const MOVE_TOLERANCE = 8; // px of drift allowed before it counts as a drag
  const X_EPOCH = 1288834974657n;
  const SEARCH_KEY = 'motmot:jump';

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

  function rewindUrl(handle, id, replies = false) {
    return `${location.origin}/${handle}${replies ? '/with_replies' : ''}#motmot=${id}`;
  }

  function fire() {
    if (!press) return;
    press.fired = true;
    press.article.classList.remove('motmot-pressing');
    navigator.vibrate?.(15);

    // A full load, not X's in-app router: rewind.js has to be in place before
    // X asks for the timeline.
    const url = rewindUrl(press.handle, press.id);
    if (press.newTab) window.open(url, '_blank');
    else location.assign(url);

    // The release may land off-page and never produce a click; don't let a
    // stale press swallow the next real one.
    setTimeout(() => {
      if (press?.fired) press = null;
    }, 1000);
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
    banner?.remove();
    banner = null;
  }

  // ---- The landing page: rewinding a profile -----------------------------

  const hashId = (location.hash.match(/^#motmot=(\d{1,20})$/) || [])[1];
  const pathMatch = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/with_replies)?\/?$/);

  if (hashId && pathMatch) startRewind(pathMatch[1], hashId, Boolean(pathMatch[2]));

  function startRewind(handle, id, replies) {
    const target = BigInt(id);
    const when = snowflakeTime(id);
    let settled = false;
    let scrolling = null;

    const nowAction = { label: 'Back to now', onClick: () => location.assign(`/${handle}`) };
    const searchAction = { label: 'Try search', onClick: () => openSearch(handle, id) };
    const closeAction = { label: '✕', onClick: () => { stopScrolling(); hideBanner(); } };

    showBanner(`Rewinding @${handle} to ${formatWhen(when)}…`, [closeAction]);

    // Drop the marker from the address bar once we're done with it, keeping
    // X's router state intact.
    function clearHash() {
      history.replaceState(history.state, '', location.pathname + location.search);
    }

    function arrived(article) {
      settled = true;
      stopScrolling();
      article.classList.add('motmot-origin');
      article.scrollIntoView({ block: 'center' });
      clearHash();
      showBanner(`@${handle} as of ${formatWhen(when)}`, [nowAction, closeAction]);
    }

    function failed(reason) {
      settled = true;
      stopScrolling();
      clearHash();
      showBanner(reason, [searchAction, closeAction]);
    }

    function findTarget() {
      for (const time of statusLinks()) {
        if (idFromTime(time) === id) return time.closest('article');
      }
      return null;
    }

    function tryReplies() {
      settled = true;
      stopScrolling();
      location.replace(rewindUrl(handle, id, true));
    }

    // Wait for X to render the entry it has just been sent.
    function waitForTarget(timeoutMs, onTimeout) {
      const deadline = Date.now() + timeoutMs;
      (function poll() {
        if (settled) return;
        const article = findTarget();
        if (article) return arrived(article);
        if (Date.now() > deadline) return onTimeout();
        setTimeout(poll, 150);
      })();
    }

    // ---- Fallback: scroll the real profile back in time -----------------

    function stopScrolling() {
      if (scrolling) clearTimeout(scrolling);
      scrolling = null;
    }

    function scrollBack() {
      if (settled || scrolling) return;
      window.postMessage({ source: 'motmot-jump', type: 'boost' }, location.origin);

      const start = Date.now();
      let oldest = null;
      let lastProgress = Date.now();

      // The user taking over the scroll wheel means "stop driving".
      const takeOver = () => {
        if (!scrolling) return;
        stopScrolling();
        settled = true;
        showBanner(`Stopped rewinding @${handle}`, [searchAction, closeAction]);
      };
      window.addEventListener('wheel', takeOver, { once: true, passive: true });
      window.addEventListener('touchmove', takeOver, { once: true, passive: true });

      (function step() {
        if (settled) return;

        const article = findTarget();
        if (article) return arrived(article);

        // The oldest of this author's Tweets loaded so far tells us how far
        // back we have got.
        for (const time of statusLinks()) {
          const href = time.closest('a').getAttribute('href') || '';
          if (!href.toLowerCase().startsWith(`/${handle.toLowerCase()}/`)) continue;
          const tid = BigInt(idFromTime(time));
          if (oldest === null || tid < oldest) {
            oldest = tid;
            lastProgress = Date.now();
          }
        }

        if (oldest !== null && oldest < target) {
          // We have scrolled past where it should be without seeing it.
          if (!replies) return tryReplies();
          return failed(`Couldn't find that Tweet in @${handle}'s feed`);
        }

        if (Date.now() - lastProgress > 10000) {
          return failed(`X stops loading @${handle}'s profile before ${formatWhen(when, false)}`);
        }

        const reached = oldest !== null ? snowflakeTime(oldest.toString()) : null;
        let progress = '';
        if (when && reached) {
          const pct = Math.min(99, Math.max(0, Math.round(((start - reached) / (start - when)) * 100)));
          progress = ` — at ${formatWhen(reached, false)} (${pct}%)`;
        }
        showBanner(`Rewinding @${handle} to ${formatWhen(when)}${progress}`, [closeAction]);

        window.scrollTo(0, document.documentElement.scrollHeight);
        scrolling = setTimeout(step, 600);
      })();
    }

    // ---- Hearing back from rewind.js ------------------------------------

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.source !== 'motmot-rewind' || event.data.id !== id) return;
      if (settled) return;

      const { status } = event.data;
      if (status === 'ok') waitForTarget(8000, scrollBack);
      else if (status === 'missing' && !replies) tryReplies();
      else if (status === 'missing') failed(`Couldn't find that Tweet in @${handle}'s feed`);
      else scrollBack();
    });

    // If rewind.js never reports (X changed how it loads profiles), steer by
    // hand anyway.
    setTimeout(() => {
      if (!settled && !scrolling) scrollBack();
    }, 12000);
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
        const article = time.closest('article');
        article.classList.add('motmot-origin');
        article.scrollIntoView({ block: 'center' });
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
