# KeePass Launcher

A Firefox extension that, with one toolbar click and your master password, opens a
private window with a set of sites from your KeePass database and signs you in.

- The tab list and passwords live **only in your `.kdbx` file**. The extension stores
  nothing but the file path and group name.
- Decryption happens in memory inside Firefox ([kdbxweb](https://github.com/keeweb/kdbxweb)
  + Argon2 from [hash-wasm](https://github.com/Daninet/hash-wasm)). Closing the private
  window ends the session and drops the decrypted data.
- Works with databases from KeePass 2 and KeePassXC (KDBX 3.1/4, AES-KDF or Argon2).

## How it works

```
toolbar popup ──master password──▶ background page
                                     │  asks native helper for the file bytes
                                     ▼
                     native-host/host.ps1  (reads the still-encrypted .kdbx)
                                     │
background: decrypt ─▶ entries in group "Launch" ─▶ private window, one tab per entry
                                     │
            content/fill.js in each tab ◀── username/password (only if host matches)
```

Extensions cannot read files from disk, so a tiny PowerShell helper registered through
Firefox native messaging reads the database file. It never sees the master password.

## Setup

1. **Register the native helper** (once per Windows user, no admin needed):
   ```powershell
   .\native-host\install.ps1
   ```
   Re-run it if you move this folder. `uninstall.ps1` removes it.

2. **Load the extension**
   - For development: open `about:debugging#/runtime/this-firefox` → *Load Temporary
     Add-on…* → pick `extension/manifest.json`. It is removed when Firefox restarts.
   - For permanent use: sign it as an unlisted add-on (see below) and install the `.xpi`.

3. **Allow private windows**: `about:addons` → KeePass Launcher → *Run in Private
   Windows* → Allow.

4. **Settings** (same page): enter the full path to your `.kdbx` file, then *Test file
   access*. Optionally change the group name (default `Launch`).

5. **In KeePass**, create a group named `Launch` and put (or copy) the entries you want
   opened there. Every entry with an `http(s)` URL becomes a tab, in database order,
   including entries in subgroups.

## Per-entry options

Add these as custom string fields (KeePass 2: *Advanced* tab → *String fields*;
KeePassXC: *Advanced* → *Additional attributes*). All optional.

| Field            | Example                     | Purpose                                                         |
| ---------------- | --------------------------- | --------------------------------------------------------------- |
| `kpl.username`   | `#email`                    | CSS selector of the username field                              |
| `kpl.password`   | `input[name=pass]`          | CSS selector of the password field                              |
| `kpl.submit`     | `button.login`              | CSS selector of the button to click                             |
| `kpl.autosubmit` | `false`                     | Fill only, don't submit                                          |
| `kpl.hosts`      | `auth.example.net, sso.com` | Extra hosts allowed to receive the credentials (login redirects) |

Credentials are only filled on the same **site** as the entry URL: any host under its
registrable domain, so an entry for `app.example.com` also fills on `login.example.com`
and `example.com` (the public suffix list decides, so `example.co.uk` works and
`alice.github.io` ≠ `bob.github.io`). A login on a different domain, such as a single
sign-on provider, needs that host in `kpl.hosts`. An `https` entry never fills on an
`http` page. If a page doesn't match, *Fill login on current tab* tells you which host
to add.

**Two-step logins** (username page, then password page) are detected automatically when
the username field has `autocomplete="username"`; otherwise set `kpl.username`.

After the password has been submitted once, a tab is not filled again (so a wrong
password can't cause a login loop). Use *Fill login on current tab* in the popup to
fill manually; it fills without submitting, and also works on tabs you opened yourself
in the session window.

## Manual fallback for difficult sites

While a session is open, the popup lists every entry, with entries matching the current
tab first. Click the username to copy it, or *Copy password* to copy the password. A
copied password is cleared from the clipboard after 30 seconds, or when the session
closes. The clear is unconditional, so anything else you copy in those 30 seconds is
cleared too.

Windows clipboard history (Win+V) and clipboard sync keep copies of everything copied,
passwords included. Turn them off in *Settings → System → Clipboard* if you use this.

## Signing for permanent install

Release Firefox only installs signed add-ons. Unlisted signing is free and the add-on
is not published:

1. Create API credentials at https://addons.mozilla.org/developers/addon/api/key/
2. ```powershell
   npx web-ext sign --source-dir extension --channel unlisted --api-key <JWT issuer> --api-secret <JWT secret>
   ```
3. Install the `.xpi` from `web-ext-artifacts/` by dragging it into Firefox.

Bump `version` in `manifest.json` before each new signing.

## Security notes

- Security equals your KeePass database: use a strong master password; a stolen PC
  only yields the encrypted `.kdbx`.
- While a session is open, decrypted entries are in Firefox's memory. Close the
  private window (or *Close session*) when done.
- Key files and Windows user account keys are not supported yet.
- Consider BitLocker for the disk; Windows can page memory to disk.

## Not implemented yet

- TOTP (2FA) filling
- Key file support
- Logins inside iframes
- Auto-lock after inactivity
