'use strict';

// =============================================================================
// WhatsApp Reader – Content Script
//
// HOW TO UPDATE SELECTORS if WhatsApp changes its DOM:
//   Open DevTools on web.whatsapp.com and inspect:
//     SEL.incoming  → root element of an incoming message bubble
//     SEL.outgoing  → root element of an outgoing message bubble (used to skip)
//     SEL.msgList   → the scrollable container that holds all message rows
//     SEL.msgText   → the element whose textContent is the message body
//     SEL.systemMsg → elements that are system notifications (not real messages)
//     SEL.chatTitle → the chat header element that shows contact/group name
//
// The most stable attributes WhatsApp uses are data-testid and
// data-pre-plain-text – prefer those over class names.
// =============================================================================

const SEL = {
  // Scrollable message list container (tried in order, first match wins)
  // NOTE: conversation-panel-messages testid no longer present; #main is reliable
  msgList: [
    '#main',
    '[data-testid="conversation-panel-messages"]',
    'body',
  ],

  // Incoming / outgoing message roots (class names are stable as of 2025)
  incoming: '.message-in',
  outgoing: '.message-out',

  // Message body text (tried in order)
  // NOTE: WhatsApp changed data-testid from "msg-text" to "selectable-text"
  msgText: [
    '[data-testid="selectable-text"]',
    '.selectable-text.copyable-text',
    '.copyable-text',
  ],

  // System notification bubbles (end-to-end notice, group events, etc.)
  systemMsg: '[data-testid="msg-notification"]',

  // Chat header – contact or group name (tried in order)
  chatTitle: [
    '[data-testid="conversation-info-header-chat-title"] span',
    '[data-testid="conversation-header"] span[title]',
    '#main header span[title]',
    '#main header span',
  ],
};

// Text patterns that identify noise / system messages
const NOISE_PATTERNS = [
  /messages and calls are end.to.end encrypted/i,
  /tap to learn more/i,
  /you deleted this message/i,
  /this message was deleted/i,
  /missed (voice|video) call/i,
  /security code (changed|with)/i,
  /(created group|left|added|removed|changed the subject|changed this group)/i,
  /^[\s\d+\-().]+$/, // pure phone numbers / timestamps
];

// =============================================================================
// State
// =============================================================================

// Record the moment the extension loaded – only speak messages from this point on
const LOAD_TIME = Date.now();

let cfg = {
  enabled: true,
  voiceName: '',
  rate: 1,
  pitch: 1,
  volume: 1,
  speakGroup: true,
  speakSender: true,
};

// Bounded dedup cache – prevents re-speaking on DOM re-renders / chat switches
const seen = new Set();
const CACHE_MAX = 500;

function cacheAdd(id) {
  if (seen.size >= CACHE_MAX) {
    // Evict the oldest entry (Sets preserve insertion order)
    seen.delete(seen.values().next().value);
  }
  seen.add(id);
}

// =============================================================================
// DOM helpers
// =============================================================================

/**
 * Query root with multiple fallback selectors; returns first match or null.
 */
function qs(root, sels) {
  for (const s of [].concat(sels)) {
    try {
      const el = root.querySelector(s);
      if (el) return el;
    } catch (_) { /* invalid selector – skip */ }
  }
  return null;
}

function getChatTitle() {
  for (const s of SEL.chatTitle) {
    try {
      const el = document.querySelector(s);
      if (el?.textContent?.trim()) return el.textContent.trim();
    } catch (_) {}
  }
  return '';
}

/**
 * Extract sender name from the data-pre-plain-text attribute.
 * WhatsApp sets it to something like "[12:30, 1/3/2026] John Doe: "
 * This is more reliable than hunting class names for the author span.
 */
function getSender(msgEl) {
  const copyable = msgEl.querySelector('[data-pre-plain-text]');
  if (copyable) {
    const raw = copyable.getAttribute('data-pre-plain-text') || '';
    const m = raw.match(/\]\s*~?(.+?):\s*$/);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Parse the message send-time from data-pre-plain-text.
 * Format: "[5:14 PM, 2/25/2026] Sender: "
 * Returns a timestamp (ms) or null if unparseable.
 */
function getMsgTime(msgEl) {
  const copyable = msgEl.querySelector('[data-pre-plain-text]');
  if (!copyable) return null;
  const raw = copyable.getAttribute('data-pre-plain-text') ?? '';
  // Capture time and date parts
  const m = raw.match(/\[(\d{1,2}:\d{2}(?:\s*[AP]M)?),\s*(\d{1,2}\/\d{1,2}\/\d{4})\]/i);
  if (!m) return null;
  return new Date(`${m[2]} ${m[1]}`).getTime();
}

// =============================================================================
// Speech
// =============================================================================

function speak(text) {
  if (!cfg.enabled || !text) return;
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate   = cfg.rate;
  utt.pitch  = cfg.pitch;
  utt.volume = cfg.volume;
  if (cfg.voiceName) {
    const voice = speechSynthesis.getVoices().find(v => v.name === cfg.voiceName);
    if (voice) utt.voice = voice;
  }
  speechSynthesis.speak(utt);
}

// =============================================================================
// Message processing
// =============================================================================

function isNoise(text) {
  if (!text || text.length < 2) return true;
  return NOISE_PATTERNS.some(re => re.test(text));
}

function processMsg(el) {
  // Safety: className may be an SVGAnimatedString on SVG nodes
  const cls = typeof el.className === 'string' ? el.className : (el.className?.baseVal ?? '');

  // Must be an incoming message bubble
  if (!cls.includes('message-in')) return;

  // Skip system notification rows
  if (el.querySelector(SEL.systemMsg)) return;

  // Only speak messages sent at or after the extension loaded.
  // data-pre-plain-text contains the exact send time – use it to gate old messages.
  const msgTime = getMsgTime(el);
  if (msgTime !== null && msgTime < LOAD_TIME) return;

  // Extract message text
  const textEl = qs(el, SEL.msgText);
  const text = textEl?.textContent?.trim() ?? '';
  if (isNoise(text)) return;

  // Extract sender (populated in group chats only)
  const sender = getSender(el);
  const chat   = getChatTitle();

  // Unique ID: chat + sender + text  (tab-separated to avoid collisions)
  const id = `${chat}\x00${sender}\x00${text}`;
  if (seen.has(id)) return;
  cacheAdd(id);

  // Build the announcement string
  const isGroup = !!sender;
  let out = '';
  if (isGroup && cfg.speakGroup && chat)  out += chat + '. ';
  if (cfg.speakSender)                    out += (sender || chat) + ': ';
  out += text;

  speak(out);
}

function handleAdded(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const cls = typeof node.className === 'string' ? node.className : (node.className?.baseVal ?? '');

  if (cls.includes('message-in')) {
    // The added node itself is a message bubble
    processMsg(node);
  } else {
    // The added node is a wrapper – check descendants
    node.querySelectorAll?.('.message-in').forEach(processMsg);
  }
}

// =============================================================================
// MutationObserver – attach to the message list
// =============================================================================

let observer     = null;
let observedRoot = null;
let attachTries  = 0;

/**
 * Silently record one message element into the dedup cache (no speech).
 */
function seedMsgEl(el) {
  const copyable = el.querySelector('[data-pre-plain-text]');
  const raw      = copyable?.getAttribute('data-pre-plain-text') ?? '';
  const m        = raw.match(/\]\s*~?(.+?):\s*$/);
  const sender   = m ? m[1].trim() : '';
  const textEl   = qs(el, SEL.msgText);
  const text     = textEl?.textContent?.trim() ?? '';
  if (text) cacheAdd(`${getChatTitle()}\x00${sender}\x00${text}`);
}

/**
 * Seed all currently-visible incoming messages so they are never spoken.
 */
function seedCache(root) {
  root.querySelectorAll('.message-in').forEach(seedMsgEl);
}

function attach(root) {
  if (observer) observer.disconnect();
  observedRoot = root;
  seedCache(root);
  observer = new MutationObserver(mutations => {
    if (!cfg.enabled) return;
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      m.addedNodes.forEach(handleAdded);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}

function tryAttach() {
  for (const s of SEL.msgList) {
    try {
      const el = document.querySelector(s);
      if (el) {
        if (el !== observedRoot) attach(el);
        return; // success
      }
    } catch (_) {}
  }

  // Not found yet – keep polling (give up after 60 tries ≈ 90 s)
  attachTries++;
  if (attachTries < 60) {
    setTimeout(tryAttach, 1500);
  }
}

// =============================================================================
// SPA navigation – re-try attaching when the user opens a different chat.
// WhatsApp Web doesn't reload on chat switch so we poll for href changes.
// =============================================================================

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref    = location.href;
    attachTries = 0;
    // Wait for new chat to render, then seed its existing messages before observing
    setTimeout(() => {
      if (observedRoot) seedCache(observedRoot);
      tryAttach();
    }, 1200);
  }
}, 1000);

// =============================================================================
// Chat list observer – reads new messages from chats that are NOT open.
//
// When a message arrives in a closed chat, WhatsApp moves that chat row to
// the top of #pane-side and updates its preview. We watch for those row
// additions, check for an unread badge, and speak the preview text.
//
// Selectors confirmed from live DOM (March 2026):
//   [role="row"]                     → each chat row in the list
//   span[aria-label*="unread"]       → unread message badge
//   span[dir="auto"][title]          → first = chat/group name
//   span[dir="auto"][aria-label]     → group sender ("Maybe Kevin" → "Kevin")
//   span[dir="ltr"]                  → message preview text
// =============================================================================

function extractChatRow(row) {
  // Chat name – first span with dir="auto" and a title attribute
  const nameEl = row.querySelector('span[dir="auto"][title]');
  const chat   = nameEl?.getAttribute('title')?.trim() ?? nameEl?.textContent?.trim() ?? '';

  // Sender – group chats show a "~ Kevin" span with aria-label="Maybe Kevin"
  const senderEl = row.querySelector('span[dir="auto"][aria-label]');
  let sender = '';
  if (senderEl) {
    const label = senderEl.getAttribute('aria-label') ?? '';
    sender = label.replace(/^Maybe\s+/i, '').trim();
  }

  // Message text – first span[dir="ltr"] holds the preview
  const textEl = row.querySelector('span[dir="ltr"]');
  const text   = textEl?.textContent?.trim() ?? '';

  return { chat, sender, text };
}

function processChatRow(row) {
  // Only act on rows that have an unread badge
  if (!row.querySelector('span[aria-label*="unread"]')) return;

  const { chat, sender, text } = extractChatRow(row);
  if (!text || isNoise(text)) return;

  const id = `${chat}\x00${sender}\x00${text}`;
  if (seen.has(id)) return;
  cacheAdd(id);

  const isGroup = !!sender;
  let out = '';
  if (isGroup && cfg.speakGroup && chat)  out += chat + '. ';
  if (cfg.speakSender)                    out += (sender || chat) + ': ';
  out += text;

  speak(out);
}

function seedChatList(panel) {
  // Mark every currently-visible preview as seen so nothing speaks on startup
  panel.querySelectorAll('[role="row"]').forEach(row => {
    const { chat, sender, text } = extractChatRow(row);
    if (text) cacheAdd(`${chat}\x00${sender}\x00${text}`);
  });
}

let chatListObserver = null;

function watchChatList() {
  const panel = document.querySelector('#pane-side');
  if (!panel) { setTimeout(watchChatList, 1500); return; }

  seedChatList(panel);

  // On ANY mutation in the chat list (new node, text change, attribute change),
  // scan all rows that currently show an unread badge and speak unseen ones.
  // This catches: new rows added, existing rows whose preview text updated,
  // and unread count increments — regardless of how WhatsApp mutates the DOM.
  chatListObserver = new MutationObserver(() => {
    if (!cfg.enabled) return;
    panel.querySelectorAll('[role="row"]').forEach(processChatRow);
  });

  chatListObserver.observe(panel, {
    childList: true,
    subtree: true,
    characterData: true,  // catches text content updates
    attributes: true,     // catches aria-label / class changes on badge
  });
}

// =============================================================================
// Settings – load once, then stay in sync with popup changes
// =============================================================================

const DEFAULTS = {
  enabled: true, voiceName: '', rate: 1, pitch: 1, volume: 1,
  speakGroup: true, speakSender: true,
};

chrome.storage.sync.get(DEFAULTS, items => {
  Object.assign(cfg, items);
  tryAttach();
  watchChatList();

  // ── Diagnostic log ──────────────────────────────────────────────────────────
  console.log('[WhatsApp Reader] ✅ Loaded at', new Date(LOAD_TIME).toLocaleTimeString(),
    '| Only messages from this time onward will be spoken.');

  setTimeout(() => {
    const msgs = document.querySelectorAll('.message-in');
    if (!msgs.length) {
      console.log('[WhatsApp Reader] ℹ️  No open chat found after 1 s (open a conversation to see messages).');
      return;
    }
    const last = msgs[msgs.length - 1];
    const copyable = last.querySelector('[data-pre-plain-text]');
    const raw      = copyable?.getAttribute('data-pre-plain-text') ?? '(no timestamp)';
    const textEl   = qs(last, SEL.msgText);
    const text     = textEl?.textContent?.trim() ?? '(no text)';
    const msgTime  = getMsgTime(last);
    const willSpeak = msgTime === null || msgTime >= LOAD_TIME;
    console.log('[WhatsApp Reader] 📩 Latest visible message:');
    console.log('  pre-plain-text :', raw);
    console.log('  text           :', text);
    console.log('  parsed time    :', msgTime ? new Date(msgTime).toLocaleTimeString() : 'n/a');
    console.log('  load time      :', new Date(LOAD_TIME).toLocaleTimeString());
    console.log('  would speak?   :', willSpeak ? '✅ YES (new)' : '🚫 NO (old — before load time)');
  }, 1000);
  // ────────────────────────────────────────────────────────────────────────────
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    cfg[key] = newValue;
  }
});
