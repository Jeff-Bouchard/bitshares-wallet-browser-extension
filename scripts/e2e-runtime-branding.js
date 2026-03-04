#!/usr/bin/env node

/**
 * Runtime E2E branding validation (Chromium + unpacked MV3 extension).
 *
 * What it does:
 * - Builds the Chrome extension to dist/
 * - Launches Chromium with the unpacked extension loaded
 * - Opens the extension popup page
 * - Asserts Bitshares-NESS custodial wallet branding is present at runtime
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function die(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runBuildChrome() {
  const result = spawnSync('node', ['scripts/build.js', 'chrome'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0) {
    throw new Error(`Build failed with exit code ${result.status}`);
  }
}

function extractExtensionIdFromUrl(url) {
  const parsed = new URL(url);
  assert(parsed.protocol === 'chrome-extension:', `Unexpected extension URL protocol: ${url}`);
  assert(parsed.host, `Could not extract extension ID from URL: ${url}`);
  return parsed.host;
}

async function getExtensionIdFromServiceWorker(context, timeoutMs = 8000) {
  const existing = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith('chrome-extension://'));

  if (existing) {
    return extractExtensionIdFromUrl(existing.url());
  }

  let sw = null;
  try {
    sw = await context.waitForEvent('serviceworker', {
      timeout: timeoutMs,
      predicate: (worker) => worker.url().startsWith('chrome-extension://')
    });
  } catch (_) {
    return null;
  }

  if (!sw) return null;

  return extractExtensionIdFromUrl(sw.url());
}

async function getExtensionIdFromExtensionsPage(context, expectedExtensionName) {
  const page = await context.newPage();

  try {
    await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const extensionId = await page.evaluate((expectedName) => {
        const manager = document.querySelector('extensions-manager');
        const managerRoot = manager && manager.shadowRoot;
        if (!managerRoot) return null;

        const itemList = managerRoot.querySelector('extensions-item-list');
        const itemListRoot = itemList && itemList.shadowRoot;
        if (!itemListRoot) return null;

        const items = Array.from(itemListRoot.querySelectorAll('extensions-item'));
        if (!items.length) return null;

        for (const item of items) {
          const itemRoot = item.shadowRoot;
          const nameEl = itemRoot && itemRoot.querySelector('#name');
          const name = nameEl ? String(nameEl.textContent || '').trim() : '';
          if (name === expectedName) {
            return item.getAttribute('id') || item.id || null;
          }
        }

        const anyExtension = items.find((item) => {
          const id = item.getAttribute('id') || item.id || '';
          return /^[a-p]{32}$/.test(id);
        });

        return anyExtension ? anyExtension.getAttribute('id') || anyExtension.id : null;
      }, expectedExtensionName);

      if (extensionId) {
        return extensionId;
      }

      await page.waitForTimeout(250);
    }

    return null;
  } finally {
    await page.close();
  }
}

async function getExtensionId(context, expectedExtensionName) {
  const fromServiceWorker = await getExtensionIdFromServiceWorker(context);
  if (fromServiceWorker) {
    return fromServiceWorker;
  }

  const fromExtensionsPage = await getExtensionIdFromExtensionsPage(context, expectedExtensionName);
  if (fromExtensionsPage) {
    return fromExtensionsPage;
  }

  throw new Error(
    `Could not discover extension ID (service worker did not initialize in time and chrome://extensions fallback failed for extension "${expectedExtensionName}").`
  );
}

function requirePlaywright() {
  try {
    // eslint-disable-next-line global-require
    return require('playwright');
  } catch (e) {
    die(
      'Playwright is not installed. Install it with:\n\n' +
        '  npm i -D playwright\n\n' +
        'Then re-run:\n\n' +
        '  npm run test:e2e:runtime\n'
    );
  }
}

async function main() {
  console.log('Running runtime e2e branding validation (Chromium extension)...');

  runBuildChrome();

  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ not found after build.');
  }

  const popupPath = path.join(distDir, 'src', 'popup', 'popup.html');
  if (!fs.existsSync(popupPath)) {
    throw new Error('dist/src/popup/popup.html not found after build.');
  }

  const manifestPath = path.join(distDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('dist/manifest.json not found after build.');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const extensionName = String(manifest.name || '').trim() || 'Bitshares-NESS custodial wallet';

  const { chromium } = requirePlaywright();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-wallet-ext-e2e-'));
  const errors = [];
  const requestFailures = [];
  const keepOpenOnFail = String(process.env.E2E_KEEP_OPEN_ON_FAIL || '').toLowerCase() === '1';
  const debugOnFailMs = Number(process.env.E2E_DEBUG_ON_FAIL_MS || 5000);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 420, height: 720 },
    args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`]
  });

  try {
    const extensionId = await getExtensionId(context, extensionName);

    const page = await context.newPage();

    page.on('pageerror', (err) => {
      const message = err && err.message ? err.message : String(err);
      const stack = err && err.stack ? `\n${err.stack}` : '';
      errors.push(`pageerror: ${message}${stack}`);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location && msg.location();
        const locText = loc && loc.url ? ` (${loc.url}:${loc.lineNumber || 0}:${loc.columnNumber || 0})` : '';
        errors.push(`console.error: ${msg.text()}${locText}`);
      }
    });

    page.on('requestfailed', (request) => {
      const failure = request.failure();
      const reason = failure && failure.errorText ? failure.errorText : 'unknown';
      requestFailures.push(`requestfailed: ${request.method()} ${request.url()} (${reason})`);
    });

    const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
    await page.goto(popupUrl, { waitUntil: 'domcontentloaded' });

    const html = await page.content();

    const requiredSnippets = [
      'Bitshares-NESS custodial wallet',
      'Initializing Bitshares-NESS custodial wallet...',
      'Custodial BitShares wallet for BTS and XBTSX gateway assets',
      'BitShares Mainnet',
      'BitShares Testnet',
      'This site wants to connect to your Bitshares-NESS custodial wallet'
    ];

    for (const snippet of requiredSnippets) {
      assert(html.includes(snippet), `Popup runtime HTML missing branding snippet: "${snippet}"`);
    }

    // Allow any async startup logs/errors to surface before we decide pass/fail.
    await page.waitForTimeout(750);

    if (errors.length > 0 || requestFailures.length > 0) {
      const lines = [];
      if (errors.length > 0) {
        lines.push('Runtime console/page errors detected:');
        for (const e of errors) lines.push(`- ${e}`);
      }
      if (requestFailures.length > 0) {
        lines.push('Network request failures detected:');
        for (const f of requestFailures) lines.push(`- ${f}`);
      }

      if (keepOpenOnFail) {
        console.error(`\nE2E_KEEP_OPEN_ON_FAIL=1 set; leaving browser open for ${debugOnFailMs}ms for debugging...`);
        await page.waitForTimeout(debugOnFailMs);
      }

      throw new Error(lines.join('\n'));
    }

    console.log('\nRuntime e2e branding validation PASSED (Chromium).');
  } finally {
    await context.close();

    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_) {
      // ignore cleanup errors
    }
  }
}

main().catch((e) => {
  console.error(`\nRuntime e2e branding validation FAILED: ${e.message}`);
  process.exit(1);
});
