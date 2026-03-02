#!/usr/bin/env node

/**
 * Runtime E2E branding validation (Chromium + unpacked MV3 extension).
 *
 * What it does:
 * - Builds the Chrome extension to dist/
 * - Launches Chromium with the unpacked extension loaded
 * - Opens the extension popup page
 * - Asserts Privateness.network + BitShares branding is present at runtime
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

async function getExtensionIdFromServiceWorker(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker');
  }

  const swUrl = sw.url();
  const u = new URL(swUrl);
  assert(u.protocol === 'chrome-extension:', `Unexpected service worker protocol: ${swUrl}`);
  assert(u.host, `Could not extract extension ID from service worker URL: ${swUrl}`);

  return u.host;
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
    const extensionId = await getExtensionIdFromServiceWorker(context);

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
      'Privateness.network BitShares Wallet',
      'Initializing Privateness.network BitShares Wallet...',
      'BitShares Mainnet',
      'BitShares Testnet',
      'Privateness.network BitShares wallet'
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
