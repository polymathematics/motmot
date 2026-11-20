// mot mot — service worker. Manifest V3 restarts this file on every event, so
// nothing here may rely on state surviving between calls.

importScripts('tweet.js');

// Classic scripts share one global scope, so these stay namespaced rather
// than destructured — plain consts here would collide with tweet.js's own
// declarations and throw before a single listener is registered.
const mm = self.motmot;

const MENUS = [
  { id: 'tweetSelection', title: 'Tweet "%s"', contexts: ['selection'] },
  { id: 'tweetPage', title: 'Tweet this page', contexts: ['page'] },
  { id: 'copySelection', title: 'Copy selection with source', contexts: ['selection'] },
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
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'tweet') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await tweet(message.text, message.useTabUrl ? tab : null);
      sendResponse({ ok: true });
    })();
    return true;
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
