// Shared tweet-building logic. Loaded by both the service worker
// (importScripts) and the popup (<script>), so it must not touch `window`
// or the DOM.

const MOTMOT_DEFAULTS = {
  tweetCount: 0,
};

const MOTMOT_CREDIT = 'tweeted via mot mot!';

// X counts every link as 23 characters no matter how long it really is.
const URL_WEIGHT = 23;
const TWEET_LIMIT = 280;

function getSettings() {
  return chrome.storage.sync.get(MOTMOT_DEFAULTS);
}

// X's weighted character count: most CJK and emoji code points count double.
// This is an approximation of twitter-text, close enough to keep us from
// handing X a tweet it will reject.
function weightedLength(text) {
  let total = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      cp >= 0x1f000;
    total += isWide ? 2 : 1;
  }
  return total;
}

// A selection dragged across a paragraph break arrives full of stray
// indentation and hard-wrapped newlines. The tweet is a single sentence now,
// so everything collapses to one line.
function normalize(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// What the tweet will weigh once X has shortened the link to a t.co.
function weigh(composed, url) {
  const raw = weightedLength(composed);
  if (!url) return raw;
  return raw - weightedLength(url) + URL_WEIGHT;
}

// The one template, assembled in one place:
//
//   "<quote>" from <source>. tweeted via mot mot!
//
// On a page with no usable URL — a local file, a chrome:// tab — the source
// clause drops out rather than leaving a dangling "from .".
function compose(body, url) {
  const parts = [`“${body}”`];
  if (url) parts.push(`from ${url}.`);
  parts.push(MOTMOT_CREDIT);
  return parts.join(' ');
}

// Trim to `budget` weighted characters, breaking on a word boundary when one
// is close enough that we are not lopping off half the final sentence.
function truncate(text, budget) {
  if (weightedLength(text) <= budget) return { text, truncated: false };

  const room = budget - 1; // the ellipsis needs a character too
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = weightedLength(char);
    if (used + w > room) break;
    out += char;
    used += w;
  }

  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > room * 0.7) out = out.slice(0, lastSpace);

  return { text: out.replace(/[\s,;:.!?-]+$/, '') + '…', truncated: true };
}

// The single source of truth for what a tweet looks like. The popup uses it to
// render its live preview; the service worker uses it to build the real
// intent URL — so what you see in the popup is what gets sent.
function buildTweet(rawText, url) {
  const text = normalize(rawText);

  // Measuring the empty template is what reserves room for the quote marks,
  // the source clause and the credit — no hand-counted constant to drift out
  // of sync with compose().
  const overhead = weigh(compose('', url), url);
  const budget = Math.max(TWEET_LIMIT - overhead, 20);

  const { text: body, truncated } = truncate(text, budget);
  const composed = compose(body, url);
  const used = weigh(composed, url);

  return {
    text: composed,
    truncated,
    used,
    remaining: TWEET_LIMIT - used,
    limit: TWEET_LIMIT,
  };
}

// X's web intent takes the whole tweet as `text`. The source deliberately is
// not passed as the intent's `url` param: X appends that param at the end,
// which would put the link after the credit instead of mid-sentence.
function intentUrl(rawText, url) {
  const params = new URLSearchParams({ text: buildTweet(rawText, url).text });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

if (typeof self !== 'undefined') {
  self.motmot = {
    MOTMOT_DEFAULTS,
    MOTMOT_CREDIT,
    TWEET_LIMIT,
    getSettings,
    weightedLength,
    normalize,
    buildTweet,
    intentUrl,
  };
}
