'use strict';

// Session state lives only in this background page's memory. Nothing decrypted
// is ever written to storage; closing the private window (or Firefox) ends it.

const DEFAULT_GROUP = 'Launch';
const MAX_USERNAME_SUBMITS = 2;
const CLIPBOARD_CLEAR_MS = 30000;

// { windowId, entries, tabs: Map<tabId, { entry, usernameSubmits, done, manual }> }
let session = null;
let launching = false;
let clipboardTimer = null;

async function getSettings() {
  const { dbPath = '', groupName = '' } = await browser.storage.local.get(['dbPath', 'groupName']);
  return { dbPath, groupName: groupName.trim() || DEFAULT_GROUP };
}

function newTabState(entry) {
  return { entry, usernameSubmits: 0, done: false, manual: false };
}

// Registrable domain ("site"): login.example.co.uk -> example.co.uk. Private
// suffixes count too, so alice.github.io and bob.github.io are different sites.
// Hosts without one (localhost, IP addresses) only match themselves.
function siteOf(hostname) {
  return tldts.getDomain(hostname, { allowPrivateDomains: true }) || hostname;
}

// Credentials are only released to pages on the same site as the entry URL
// (any subdomain of its registrable domain) or on a host listed in the entry's
// kpl.hosts field, and never over plain http when the entry itself uses https.
function hostAllowed(entry, pageUrl) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (entry.protocol === 'https:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (siteOf(host) === siteOf(new URL(entry.url).hostname)) return true;
  return entry.hosts.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

function clearClipboardNow() {
  clearTimeout(clipboardTimer);
  clipboardTimer = null;
  navigator.clipboard.writeText('').catch((error) => console.warn('KeePass Launcher: clearing the clipboard failed', error));
}

function injectFiller(tabId) {
  return browser.tabs.executeScript(tabId, { file: '/content/fill.js', runAt: 'document_idle' });
}

async function unlockAndLaunch(masterPassword) {
  if (launching) throw new Error('Already unlocking…');
  if (session) {
    await browser.windows.update(session.windowId, { focused: true });
    return;
  }

  launching = true;
  try {
    if (!(await browser.extension.isAllowedIncognitoAccess())) {
      throw new Error('Allow this extension to "Run in Private Windows" first (Settings).');
    }
    const { dbPath, groupName } = await getSettings();
    if (!dbPath) throw new Error('Set the database path in Settings first.');

    const fileBytes = await readDatabaseFile(dbPath);
    const entries = await loadLaunchEntries(fileBytes, masterPassword, groupName);
    if (entries.length === 0) throw new Error(`No entries with a web URL in group "${groupName}".`);

    const win = await browser.windows.create({ incognito: true, url: entries.map((e) => e.url) });
    const tabs = (await browser.tabs.query({ windowId: win.id })).sort((a, b) => a.index - b.index);

    session = { windowId: win.id, entries, tabs: new Map() };
    tabs.forEach((tab, i) => {
      if (entries[i]) session.tabs.set(tab.id, newTabState(entries[i]));
    });

    // Pages that finished loading before the session existed missed onCompleted.
    for (const tab of tabs) {
      const state = session.tabs.get(tab.id);
      if (state && tab.status === 'complete' && hostAllowed(state.entry, tab.url)) {
        injectFiller(tab.id).catch(() => {});
      }
    }
  } finally {
    launching = false;
  }
}

async function closeSession() {
  if (clipboardTimer) clearClipboardNow();
  if (!session) return { ok: true };
  const { windowId } = session;
  session = null;
  await browser.windows.remove(windowId).catch(() => {});
  return { ok: true };
}

// Manual fill from the popup: fills without submitting. Also works for tabs the
// user opened in the session window, by matching the page to an entry.
async function refillActiveTab() {
  if (!session) return { error: 'No active session.' };
  const [tab] = await browser.tabs.query({ active: true, windowId: session.windowId });
  if (!tab) return { error: 'No active tab in the session window.' };

  let state = session.tabs.get(tab.id);
  if (!state || !hostAllowed(state.entry, tab.url)) {
    const entry = session.entries.find((e) => hostAllowed(e, tab.url));
    if (!entry) {
      let host = '';
      try {
        host = new URL(tab.url).hostname;
      } catch {}
      return {
        error: host
          ? `No entry matches ${host}. If this is the login page for one of your entries, add "${host}" to that entry's kpl.hosts field, or use the copy buttons above.`
          : 'No entry in the session matches this page.',
      };
    }
    state = newTabState(entry);
    session.tabs.set(tab.id, state);
  }

  state.done = false;
  state.manual = true;
  try {
    await injectFiller(tab.id);
  } catch (error) {
    return { error: `Could not access this page: ${error.message}` };
  }
  return { ok: true };
}

// Entry list for the popup's manual fallback. Never includes passwords.
async function sessionEntries() {
  if (!session) return { entries: [] };
  const [tab] = await browser.tabs.query({ active: true, windowId: session.windowId });
  return {
    entries: session.entries.map((entry, index) => {
      const host = new URL(entry.url).hostname;
      return {
        index,
        title: entry.title || host,
        host,
        username: entry.username,
        matchesActiveTab: Boolean(tab && hostAllowed(entry, tab.url)),
      };
    }),
  };
}

// Copied passwords are wiped from the clipboard after CLIPBOARD_CLEAR_MS, or
// when the session ends. Usernames are left alone.
async function copyEntryField(index, field) {
  const entry = session?.entries[index];
  if (!entry) return { error: 'No active session.' };
  if (field === 'password') {
    await navigator.clipboard.writeText(entry.password.getText());
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(clearClipboardNow, CLIPBOARD_CLEAR_MS);
    return { ok: true, clearsAfterSeconds: CLIPBOARD_CLEAR_MS / 1000 };
  }
  await navigator.clipboard.writeText(entry.username);
  return { ok: true };
}

function sessionStateFor(sender) {
  if (!session || !sender.tab || sender.frameId !== 0) return null;
  const state = session.tabs.get(sender.tab.id);
  if (!state || state.done || !hostAllowed(state.entry, sender.url)) return null;
  return state;
}

function contentConfig(sender) {
  const state = sessionStateFor(sender);
  if (!state) return { active: false };
  const { entry } = state;
  return {
    active: true,
    selectors: entry.selectors,
    autoSubmit: entry.autoSubmit && !state.manual,
    hasUsername: entry.username !== '',
    allowUsernameStep: state.manual || state.usernameSubmits < MAX_USERNAME_SUBMITS,
  };
}

function contentCredentials(sender, step) {
  const state = sessionStateFor(sender);
  if (!state) return null;
  const { entry } = state;
  switch (step) {
    case 'full':
      return { username: entry.username, password: entry.password.getText() };
    case 'password':
      return { password: entry.password.getText() };
    case 'username':
      return state.manual || state.usernameSubmits < MAX_USERNAME_SUBMITS ? { username: entry.username } : null;
    default:
      return null;
  }
}

function recordFill(sender, step, submitted) {
  const state = sessionStateFor(sender);
  if (!state) return;
  if (step === 'username') {
    if (submitted) state.usernameSubmits++;
    return;
  }
  // Once the password has been filled, stop. A wrong password must not cause a
  // submit loop; the popup's "Fill login on this tab" can retry manually.
  state.done = true;
  state.manual = false;
}

async function getStatus() {
  const { dbPath, groupName } = await getSettings();
  return {
    configured: dbPath !== '',
    groupName,
    incognitoAllowed: await browser.extension.isAllowedIncognitoAccess(),
    launching,
    session: session ? { tabCount: session.tabs.size } : null,
  };
}

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case 'popup:status':
      return getStatus();
    case 'popup:unlock':
      return unlockAndLaunch(message.password).then(
        () => ({ ok: true }),
        (error) => ({ error: error.message })
      );
    case 'popup:close-session':
      return closeSession();
    case 'popup:refill':
      return refillActiveTab();
    case 'popup:entries':
      return sessionEntries();
    case 'popup:copy':
      return copyEntryField(message.index, message.field).catch((error) => ({ error: error.message }));
    case 'options:test':
      return statDatabaseFile(message.path).then(
        (stat) => ({ ok: true, stat }),
        (error) => ({ error: error.message })
      );
    case 'kpl:config':
      return Promise.resolve(contentConfig(sender));
    case 'kpl:credentials':
      return Promise.resolve(contentCredentials(sender, message.step));
    case 'kpl:filled':
      recordFill(sender, message.step, message.submitted);
      return Promise.resolve();
  }
  return undefined;
});

browser.webNavigation.onCompleted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const state = session?.tabs.get(tabId);
  if (!state || state.done || !hostAllowed(state.entry, url)) return;
  injectFiller(tabId).catch(() => {});
});

browser.tabs.onRemoved.addListener((tabId) => {
  session?.tabs.delete(tabId);
});

browser.windows.onRemoved.addListener((windowId) => {
  if (session && session.windowId === windowId) {
    session = null;
    if (clipboardTimer) clearClipboardNow();
  }
});
