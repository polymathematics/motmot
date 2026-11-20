// mot mot popup. Opening it pulls in whatever is highlighted on the page, so
// the usual path is: highlight, click, Tweet.

// Namespaced, not destructured: popup.js and tweet.js are both classic
// scripts sharing one global scope, and plain consts would redeclare them.
const mm = self.motmot;

const el = {
  text: document.getElementById('text'),
  counter: document.getElementById('counter'),
  preview: document.getElementById('preview'),
  send: document.getElementById('send'),
  count: document.getElementById('count'),
  shortcut: document.getElementById('shortcut'),
};

let pageUrl = '';

init();

async function init() {
  const settings = await chrome.storage.sync.get(mm.MOTMOT_DEFAULTS);
  renderCount(settings.tweetCount || 0);

  const page = await chrome.runtime.sendMessage({ type: 'readSelection' });
  pageUrl = page?.url && /^https?:/.test(page.url) ? page.url : '';
  el.text.value = page?.selection || '';
  render();

  el.text.focus();
  // Put the caret at the end rather than selecting the pulled-in text, so a
  // keystroke adds to the quote instead of wiping it.
  el.text.setSelectionRange(el.text.value.length, el.text.value.length);

  el.text.addEventListener('input', render);
  el.send.addEventListener('click', send);

  // ⌘/Ctrl+Enter sends, the convention every other composer uses.
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      send();
    }
  });

  el.shortcut.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

function render() {
  const raw = el.text.value;
  const built = mm.buildTweet(raw, pageUrl);

  el.counter.textContent = String(built.remaining);
  el.counter.classList.toggle('warn', built.remaining <= 40 && built.remaining >= 0);
  el.counter.classList.toggle('over', built.truncated);
  el.counter.title = built.truncated
    ? 'Longer than X allows — mot mot will trim the quote to fit.'
    : `${built.used} of ${mm.TWEET_LIMIT} characters`;

  // The preview is the composed tweet itself, so the trailing "from … tweeted
  // via mot mot!" never comes as a surprise.
  el.preview.textContent = raw.trim()
    ? built.text
    : 'Your highlight, then the source and the sign-off.';
  el.preview.classList.toggle('empty', !raw.trim());
  el.preview.classList.toggle('trimmed', built.truncated);

  el.send.disabled = !raw.trim();
}

function renderCount(n) {
  el.count.textContent =
    n === 0 ? 'no Tweets sent yet' : `${n} Tweet${n === 1 ? '' : 's'} sent`;
}

async function send() {
  if (el.send.disabled) return;
  el.send.disabled = true;
  await chrome.runtime.sendMessage({
    type: 'tweet',
    text: el.text.value,
    useTabUrl: true,
  });
  window.close();
}
