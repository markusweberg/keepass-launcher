'use strict';

// Talks to the native helper (native-host/host.ps1), which reads the .kdbx file
// from disk. Extensions have no file system access of their own.

const NATIVE_HOST = 'keepass_launcher';

function nativeHostError(error) {
  return new Error(
    `Could not reach the native helper (${error?.message || 'unknown error'}). ` +
    'Run native-host\\install.ps1 and restart Firefox.'
  );
}

async function statDatabaseFile(path) {
  let response;
  try {
    response = await browser.runtime.sendNativeMessage(NATIVE_HOST, { type: 'stat', path });
  } catch (error) {
    throw nativeHostError(error);
  }
  if (response?.type === 'error') throw new Error(response.message);
  return response;
}

function decodeBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readDatabaseFile(path) {
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connectNative(NATIVE_HOST);
    let chunks = null;
    let received = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      if (error) reject(error);
      else resolve(value);
    };

    const assemble = () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    };

    port.onMessage.addListener((message) => {
      if (message.type === 'error') {
        finish(new Error(message.message));
      } else if (message.type === 'meta') {
        chunks = new Array(message.chunks);
        if (message.chunks === 0) finish(null, new Uint8Array(0));
      } else if (message.type === 'chunk' && chunks) {
        chunks[message.index] = decodeBase64(message.data);
        if (++received === chunks.length) finish(null, assemble());
      }
    });

    port.onDisconnect.addListener((p) => {
      if (!settled) {
        settled = true;
        reject(p.error ? nativeHostError(p.error) : new Error('The native helper closed unexpectedly.'));
      }
    });

    port.postMessage({ type: 'read', path });
  });
}
