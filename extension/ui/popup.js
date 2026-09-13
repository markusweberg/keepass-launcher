'use strict';

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-setup', 'view-private', 'view-unlock', 'view-session'];
const UNLOCK_LABEL = 'Unlock & open tabs';

function show(viewId) {
  for (const id of VIEWS) $(id).hidden = id !== viewId;
}

function setMessage(el, text, kind = 'error') {
  el.textContent = text || '';
  el.className = kind;
  el.hidden = !text;
}

async function copyField(index, field) {
  const result = await browser.runtime.sendMessage({ type: 'popup:copy', index, field });
  if (result?.error) setMessage($('session-message'), result.error);
  else if (field === 'password') setMessage($('session-message'), `Password copied. Clears in ${result.clearsAfterSeconds} s.`, 'ok');
  else setMessage($('session-message'), 'Username copied.', 'ok');
}

// Entries matching the active tab come first and are highlighted.
function renderEntries(entries) {
  const list = $('entries');
  list.replaceChildren();
  const sorted = [...entries].sort((a, b) => Number(b.matchesActiveTab) - Number(a.matchesActiveTab));
  for (const entry of sorted) {
    const item = document.createElement('li');
    item.className = entry.matchesActiveTab ? 'entry match' : 'entry';

    const text = document.createElement('div');
    text.className = 'entry-text';
    const title = document.createElement('span');
    title.className = 'entry-title';
    title.textContent = entry.title;
    title.title = entry.host;
    const username = document.createElement('button');
    username.type = 'button';
    username.className = 'entry-username';
    username.textContent = entry.username || '(no username)';
    username.title = 'Copy username';
    username.disabled = !entry.username;
    username.addEventListener('click', () => copyField(entry.index, 'username'));
    text.append(title, username);

    const password = document.createElement('button');
    password.type = 'button';
    password.className = 'entry-password';
    password.textContent = 'Copy password';
    password.addEventListener('click', () => copyField(entry.index, 'password'));

    item.append(text, password);
    list.append(item);
  }
}

async function render() {
  const status = await browser.runtime.sendMessage({ type: 'popup:status' });
  if (status.session) {
    $('tab-count').textContent = status.session.tabCount;
    const { entries } = await browser.runtime.sendMessage({ type: 'popup:entries' });
    renderEntries(entries);
    show('view-session');
  } else if (!status.configured) {
    show('view-setup');
  } else if (!status.incognitoAllowed) {
    show('view-private');
  } else {
    $('group-name').textContent = status.groupName;
    show('view-unlock');
    $('password').focus();
  }
}

$('view-unlock').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('password');
  const button = $('unlock');
  const password = input.value;
  input.value = '';

  input.disabled = button.disabled = true;
  button.textContent = 'Unlocking…';
  setMessage($('unlock-error'), '');

  const result = await browser.runtime.sendMessage({ type: 'popup:unlock', password });
  if (result?.error) {
    setMessage($('unlock-error'), result.error);
    input.disabled = button.disabled = false;
    button.textContent = UNLOCK_LABEL;
    input.focus();
    return;
  }
  window.close();
});

$('refill').addEventListener('click', async () => {
  const result = await browser.runtime.sendMessage({ type: 'popup:refill' });
  if (result?.error) setMessage($('session-message'), result.error);
  else window.close();
});

$('close-session').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'popup:close-session' });
  window.close();
});

for (const el of document.querySelectorAll('.open-settings')) {
  el.addEventListener('click', (event) => {
    event.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });
}

render();
