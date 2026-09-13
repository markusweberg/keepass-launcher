'use strict';

// Decrypts the .kdbx file with kdbxweb and extracts the entries to launch.
// Passwords stay wrapped in kdbxweb.ProtectedValue (XOR-masked in memory) until
// a content script actually needs one.

// kdbxweb ships without Argon2 (the default KDF in KeePassXC and newer KeePass
// databases); hash-wasm provides it. kdbxweb passes memory in KiB already.
kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
  if (version !== 0x13) throw new Error(`Unsupported Argon2 version 0x${version.toString(16)}.`);
  const argon2 = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? hashwasm.argon2id : hashwasm.argon2d;
  const hash = await argon2({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    iterations,
    parallelism,
    memorySize: memory,
    hashLength: length,
    outputType: 'binary',
  });
  return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
});

async function openDatabase(fileBytes, masterPassword) {
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(masterPassword));
  const data = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);
  try {
    return await kdbxweb.Kdbx.load(data, credentials);
  } catch (error) {
    if (error?.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
      throw new Error('Wrong master password. (Databases that need a key file are not supported yet.)');
    }
    throw new Error(`Could not open the database: ${error?.message || error}`);
  }
}

// "Launch" finds the first group with that name anywhere (breadth-first);
// "Internet/Launch" walks down from the root group.
function findGroup(db, groupPath) {
  const root = db.getDefaultGroup();
  const byName = (groups, name) => groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  const parts = groupPath.split('/').map((p) => p.trim()).filter(Boolean);

  if (parts.length > 1) {
    let group = root;
    for (const part of parts) {
      group = byName(group.groups, part);
      if (!group) return null;
    }
    return group;
  }

  const queue = [root];
  while (queue.length) {
    const group = queue.shift();
    if (group.name.toLowerCase() === parts[0]?.toLowerCase()) return group;
    queue.push(...group.groups);
  }
  return null;
}

function fieldText(entry, name) {
  const value = entry.fields.get(name);
  if (value == null) return '';
  return value instanceof kdbxweb.ProtectedValue ? value.getText() : String(value);
}

function parseEntryUrl(raw) {
  const text = raw.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function toLaunchEntry(entry) {
  const url = parseEntryUrl(fieldText(entry, 'URL'));
  if (!url) return null;

  const password = entry.fields.get('Password');
  const extraHosts = fieldText(entry, 'kpl.hosts').split(/[\s,]+/).filter(Boolean);

  return {
    title: fieldText(entry, 'Title'),
    url: url.href,
    protocol: url.protocol,
    hosts: [url.hostname, ...extraHosts].map((h) => h.toLowerCase().replace(/^www\./, '')),
    username: fieldText(entry, 'UserName'),
    password: password instanceof kdbxweb.ProtectedValue
      ? password
      : kdbxweb.ProtectedValue.fromString(String(password ?? '')),
    selectors: {
      username: fieldText(entry, 'kpl.username') || null,
      password: fieldText(entry, 'kpl.password') || null,
      submit: fieldText(entry, 'kpl.submit') || null,
    },
    autoSubmit: fieldText(entry, 'kpl.autosubmit').trim().toLowerCase() !== 'false',
  };
}

async function loadLaunchEntries(fileBytes, masterPassword, groupPath) {
  const db = await openDatabase(fileBytes, masterPassword);
  const group = findGroup(db, groupPath);
  if (!group) throw new Error(`Group "${groupPath}" was not found in the database.`);

  const recycleBin = db.meta.recycleBinEnabled ? db.meta.recycleBinUuid : null;
  const entries = [];
  const collect = (g) => {
    if (recycleBin && g.uuid.equals(recycleBin)) return;
    for (const entry of g.entries) {
      const launchEntry = toLaunchEntry(entry);
      if (launchEntry) entries.push(launchEntry);
    }
    g.groups.forEach(collect);
  };
  collect(group);
  return entries;
}
