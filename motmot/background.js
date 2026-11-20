// mot mot — service worker. Manifest V3 restarts this file on every event, so
// nothing here may rely on state surviving between calls.

importScripts('tweet.js');

// Classic scripts share one global scope, so these stay namespaced rather
// than destructured — plain consts here would collide with tweet.js's own
// declarations and throw before a single listener is registered.
const mm = self.motmot;

const X_PAGES = [
  'https://x.com/*',
  'https://twitter.com/*',
  'https://mobile.x.com/*',
  'https://mobile.twitter.com/*',
];

const MENUS = [
  { id: 'tweetSelection', title: 'Tweet "%s"', contexts: ['selection'] },
  { id: 'tweetPage', title: 'Tweet this page', contexts: ['page'] },
  { id: 'copySelection', title: 'Copy selection with source', contexts: ['selection'] },
  // Only on X. jump.js renames it to the author's @handle as the right
  // button goes down on a Tweet, and hides it everywhere else.
  {
    id: 'randomOldTweet',
    title: 'Random old Tweet from this author',
    contexts: ['all'],
    documentUrlPatterns: X_PAGES,
  },
];

// Menus persist across worker restarts, so creating them on every wake would
// throw duplicate-id errors. onInstalled is the one place they belong.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const menu of MENUS) chrome.contextMenus.create(menu);
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tweetSelection') {
    await tweet(info.selectionText, tab);
  } else if (info.menuItemId === 'tweetPage') {
    await tweet(tab?.title || '', tab);
  } else if (info.menuItemId === 'copySelection') {
    await copyWithSource(info.selectionText, tab);
  } else if (info.menuItemId === 'randomOldTweet' && tab?.id) {
    // jump.js remembers which Tweet was right-clicked and does the rest.
    chrome.tabs.sendMessage(tab.id, { type: 'randomOldTweet' }, { frameId: info.frameId ?? 0 }).catch(() => {});
  }
});

// The keyboard shortcut has no selection handed to it, so we go and read it
// off the page. A command counts as a user gesture, which is what grants
// activeTab here.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'tweet-selection') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const selection = await readSelection(tab.id);
  if (!selection) {
    notify('Nothing highlighted', 'Select some text on the page, then try again.');
    return;
  }
  await tweet(selection, tab);
});

// The popup hands off here rather than opening the tab itself, so that the
// counter and the tab-placement rules live in exactly one place.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'tweet') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await tweet(message.text, message.useTabUrl ? tab : null);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // The right button just went down on X: name the Tweet's author in the
  // menu, or hide the item if it wasn't on a Tweet.
  if (message?.type === 'contextTweet') {
    const handle = typeof message.handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(message.handle) ? message.handle : null;
    chrome.contextMenus.update(
      'randomOldTweet',
      handle ? { visible: true, title: `Random old Tweet from @${handle}` } : { visible: false },
      () => void chrome.runtime.lastError
    );
    return false;
  }

  if (message?.type === 'pick' || message?.type === 'prefetch' || message?.type === 'pickerEvent') {
    // One at a time: each reads and rewrites the saved state.
    pickerChain = pickerChain.then(() => onPickerMessage(message, sender)).catch(() => {});
    return false;
  }

  if (message?.type === 'readSelection') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse({
        selection: tab?.id ? await readSelection(tab.id) : '',
        url: tab?.url || '',
        title: tab?.title || '',
      });
    })();
    return true;
  }

  return false;
});

async function readSelection(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => String(window.getSelection() || ''),
    });
    return mm.normalize(result?.result || '');
  } catch {
    // Chrome's own pages and the web store reject injection — nothing to
    // recover from, the caller just sees an empty selection.
    return '';
  }
}

async function tweet(rawText, tab) {
  const text = mm.normalize(rawText);
  if (!text) {
    notify('Nothing to Tweet', 'There was no text to send.');
    return;
  }

  const settings = await mm.getSettings();
  const url = tab?.url && /^https?:/.test(tab.url) ? tab.url : '';

  await chrome.tabs.create({
    url: mm.intentUrl(text, url),
    index: tab ? tab.index + 1 : undefined,
  });

  await chrome.storage.sync.set({ tweetCount: (settings.tweetCount || 0) + 1 });
  flashBadge('✓', '#2d6bc4');
}

async function copyWithSource(rawText, tab) {
  const text = mm.normalize(rawText);
  if (!text || !tab?.id) return;

  const payload = tab.url && /^https?:/.test(tab.url) ? `${text}\n${tab.url}` : text;

  try {
    // navigator.clipboard does not exist in a service worker, so the write has
    // to happen in the page, where a textarea + execCommand still works even
    // when the document is not focused.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (value) => {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      },
      args: [payload],
    });
    flashBadge('✓', '#5abfb0');
  } catch {
    notify('Could not copy', 'This page does not allow extensions to run on it.');
  }
}

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  // The badge is confirmation, not status — it should not linger.
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'motmot128.jpg',
    title,
    message,
  });
}

// ---- Random old Tweet: the picker window --------------------------------
//
// Picking an old Tweet takes X's own app: only it can make X's search
// requests (they carry login and per-request signing). X refuses to load in
// a frame, so it runs in a small minimized window of its own, opened on a
// search for the author's Tweets from a random month. rewind.js in that
// window reads the results; jump.js there passes them to us, and we pass
// them on to the tab that asked. The window is reused for later picks — X
// moves to a new search in a moment, without reloading — and closed after
// ten minutes unused.
//
// This worker can be stopped between events, so what it must remember lives
// in session storage.

const PICKER_IDLE_MINUTES = 10;
let pickerChain = Promise.resolve();
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const REQ = /^[A-Za-z0-9]{1,40}$/;

async function pickerState() {
  const { picker } = await chrome.storage.session.get('picker');
  return picker || null; // { windowId, tabId, id, ready, queue: [cmd], owners: { req: tabId } }
}

async function savePicker(picker) {
  if (picker) await chrome.storage.session.set({ picker });
  else await chrome.storage.session.remove('picker');
}

function randomSearchPath(handle) {
  const day = 86400000;
  const end = Date.now();
  const lo = end - 2 * 365.25 * day + Math.random() * (2 * 365.25 * day - 30 * day);
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  const q = `from:${handle} since:${ymd(lo)} until:${ymd(lo + 31 * day)}`;
  return `/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
}

async function openPicker(handle) {
  const id = Math.random().toString(36).slice(2, 12);
  const url = `https://x.com${randomSearchPath(handle)}#motmot-pick=${id}`;
  let win;
  try {
    win = await chrome.windows.create({ url, state: 'minimized', focused: false });
  } catch {
    win = await chrome.windows.create({ url, focused: false, width: 500, height: 700 });
  }
  const picker = { windowId: win.id, tabId: win.tabs[0].id, id, ready: false, queue: [], owners: {} };
  await savePicker(picker);
  // If the window's scripts already said "ready" before we'd saved it, ask
  // again. (If they haven't loaded yet, they'll say so themselves.)
  sendToPicker(picker, { type: 'ping' });
  return picker;
}

async function closePicker() {
  const picker = await pickerState();
  await savePicker(null);
  if (picker) chrome.windows.remove(picker.windowId).catch(() => {});
}

// Is the window still there? (The user may have closed it.)
async function livePicker() {
  const picker = await pickerState();
  if (!picker) return null;
  try {
    await chrome.tabs.get(picker.tabId);
    return picker;
  } catch {
    await savePicker(null);
    return null;
  }
}

function sendToPicker(picker, cmd) {
  return chrome.tabs.sendMessage(picker.tabId, { type: 'pickerCmd', cmd }).catch(() => {});
}

async function onPickerMessage(message, sender) {
  // From X's tab: a pick, or a hint that one may be coming.
  if (message.type === 'pick' || message.type === 'prefetch') {
    if (!HANDLE.test(message.handle || '') || !sender.tab?.id) return;
    let picker = await livePicker();
    if (message.type === 'prefetch' && !picker) return; // never open a window on a hint
    if (message.type === 'pick' && !REQ.test(message.req || '')) return;
    if (message.fresh && picker) {
      await closePicker();
      picker = null;
    }
    if (!picker) picker = await openPicker(message.handle);
    const cmd = { type: message.type, handle: message.handle, req: message.req };
    if (message.type === 'pick') picker.owners[message.req] = sender.tab.id;
    if (picker.ready) sendToPicker(picker, cmd);
    else picker.queue.push(cmd);
    await savePicker(picker);
    chrome.alarms.create('pickerIdle', { delayInMinutes: PICKER_IDLE_MINUTES });
    return;
  }

  // From the picker window: pass it on to whoever asked.
  const picker = await pickerState();
  if (!picker || sender.tab?.id !== picker.tabId) return;
  const data = message.data || {};
  if (data.status === 'ready') {
    if (picker.ready) return;
    picker.ready = true;
    for (const cmd of picker.queue) sendToPicker(picker, cmd);
    picker.queue = [];
    await savePicker(picker);
    return;
  }
  const owner = picker.owners[data.req];
  if (!owner) return;
  chrome.tabs.sendMessage(owner, { type: 'pickEvent', data }).catch(() => {});
  if (['done', 'failed', 'reload'].includes(data.status)) {
    delete picker.owners[data.req];
    await savePicker(picker);
    if (data.status === 'reload') await closePicker();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pickerIdle') closePicker();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const picker = await pickerState();
  if (picker?.windowId === windowId) await savePicker(null);
});
