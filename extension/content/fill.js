'use strict';

// Injected into session tabs by the background page. Finds the login form, asks
// the background for credentials and fills them in. The background only answers
// for tabs in the current session whose host matches the KeePass entry.
(() => {
  if (window.__kplRunning) return;
  window.__kplRunning = true;

  const WAIT_MS = 15000;
  const POLL_MS = 250;
  const QUIET_MS = 500;
  const QUIET_MAX_MS = 4000;
  const REFILL_DELAY_MS = 300;
  const SUBMIT_DELAY_MS = 150;
  const SUBMIT_TEXT = /log ?in|sign ?in|continue|next|submit|logg inn|logga in|anmelden|fortsett|neste|weiter/i;
  const TEXT_TYPES = new Set(['text', 'email', 'tel']);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function query(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null; // invalid selector in the KeePass entry
    }
  }

  function looksLikeUsername(el) {
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    return autocomplete.includes('username') || autocomplete.includes('email') || el.type === 'email' ||
      /user|e-?mail|login|account|brukernavn|anv[äa]ndarnamn|benutzer/i.test(
        [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ')
      );
  }

  function findPasswordField(selectors) {
    if (selectors.password) {
      const el = query(selectors.password);
      return isVisible(el) ? el : null;
    }
    return [...document.querySelectorAll('input[type="password"]')].find(isVisible) || null;
  }

  // With a password field: the text input right before it (same form if any).
  function findUsernameBefore(selectors, passwordField) {
    if (selectors.username) {
      const el = query(selectors.username);
      return isVisible(el) ? el : null;
    }
    const scope = passwordField.form || document;
    const before = [...scope.querySelectorAll('input')].filter((el) =>
      TEXT_TYPES.has(el.type) && isVisible(el) &&
      el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    return before.filter(looksLikeUsername).pop() || before.pop() || null;
  }

  // Username-only page (two-step login). Only trusted when the entry has a
  // kpl.username selector or the field declares autocomplete="username", so a
  // newsletter e-mail box on a landing page is never filled and submitted.
  function findStandaloneUsername(selectors) {
    if (selectors.username) {
      const el = query(selectors.username);
      return isVisible(el) ? el : null;
    }
    return [...document.querySelectorAll('input[autocomplete~="username" i]')]
      .find((el) => TEXT_TYPES.has(el.type) && isVisible(el)) || null;
  }

  function detect(config) {
    const password = findPasswordField(config.selectors);
    if (password) {
      const username = config.hasUsername ? findUsernameBefore(config.selectors, password) : null;
      return { step: username ? 'full' : 'password', username, password };
    }
    if (config.hasUsername && config.allowUsernameStep) {
      const username = findStandaloneUsername(config.selectors);
      if (username) return { step: 'username', username, password: null };
    }
    return null;
  }

  function waitFor(fn, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const result = fn();
        if (result || Date.now() - started > timeoutMs) resolve(result || null);
        else setTimeout(tick, POLL_MS);
      };
      tick();
    });
  }

  // Resolves once the DOM has not changed for quietMs (or after maxMs). Single
  // page apps often hydrate or re-render the login form right after it first
  // appears, which throws away anything filled in before that.
  function waitForQuiet(quietMs, maxMs) {
    return new Promise((resolve) => {
      let quietTimer;
      const done = () => {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quietMs);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      quietTimer = setTimeout(done, quietMs);
      const maxTimer = setTimeout(done, maxMs);
    });
  }

  // Use the native value setter and fire events so frameworks (React, Vue, …)
  // notice the change. Clearing first guarantees React's value tracker sees a
  // change even if the DOM already held this value (e.g. after hydration).
  function setValue(el, value) {
    const setNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setNative.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setNative.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function fill(found, credentials) {
    if (found.username && credentials.username != null) setValue(found.username, credentials.username);
    if (found.password && credentials.password != null) setValue(found.password, credentials.password);
  }

  function submit(field, submitSelector) {
    const custom = query(submitSelector);
    if (custom) {
      custom.click();
      return;
    }
    const form = field.form;
    if (form) {
      const button = [...form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')]
        .find(isVisible);
      if (button) {
        button.click();
        return;
      }
      form.requestSubmit();
      return;
    }
    const button = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter(isVisible)
      .find((el) => SUBMIT_TEXT.test(el.textContent || el.value || el.getAttribute('aria-label') || ''));
    if (button) {
      button.click();
      return;
    }
    for (const type of ['keydown', 'keypress', 'keyup']) {
      field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  async function run() {
    const config = await browser.runtime.sendMessage({ type: 'kpl:config' });
    if (!config?.active) return;

    // Up to two rounds on the same page: a username step, then the password
    // field that appears without a page load.
    for (let round = 0; round < 2; round++) {
      if (!(await waitFor(() => detect(config), WAIT_MS))) return;
      await waitForQuiet(QUIET_MS, QUIET_MAX_MS);

      let found = await waitFor(() => detect(config), WAIT_MS);
      if (!found) return;

      const credentials = await browser.runtime.sendMessage({ type: 'kpl:credentials', step: found.step });
      if (!credentials) return;
      fill(found, credentials);

      let submitted = false;
      if (config.autoSubmit) {
        // Fill again on freshly found fields right before submitting, in case the
        // page replaced the inputs or reset its state in the meantime.
        await sleep(REFILL_DELAY_MS);
        found = detect(config);
        if (!found) return;
        fill(found, credentials);
        await sleep(SUBMIT_DELAY_MS);
        submit(found.password || found.username, config.selectors.submit);
        submitted = true;
      }
      await browser.runtime.sendMessage({ type: 'kpl:filled', step: found.step, submitted });

      if (found.step !== 'username' || !submitted) return;
      config.allowUsernameStep = false;
    }
  }

  run()
    .catch(() => {})
    .finally(() => {
      window.__kplRunning = false;
    });
})();
