'use strict';

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = kind;
  el.hidden = !text;
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function load() {
  const { dbPath = '', groupName = '' } = await browser.storage.local.get(['dbPath', 'groupName']);
  $('db-path').value = dbPath;
  $('group-name').value = groupName;
  $('private-warning').hidden = await browser.extension.isAllowedIncognitoAccess();
}

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  await browser.storage.local.set({
    dbPath: $('db-path').value.trim(),
    groupName: $('group-name').value.trim(),
  });
  setStatus('Saved.', 'ok');
});

$('test').addEventListener('click', async () => {
  setStatus('Testing…', 'hint');
  const result = await browser.runtime.sendMessage({ type: 'options:test', path: $('db-path').value.trim() });
  if (result.error) setStatus(result.error, 'error');
  else setStatus(`Found ${result.stat.path} (${formatSize(result.stat.size)}).`, 'ok');
});

load();
