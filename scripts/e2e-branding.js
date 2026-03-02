#!/usr/bin/env node

/**
 * End-to-end branding validation for built extension artifacts.
 *
 * Verifies Privateness.network + BitShares branding across:
 * - Chrome build output (dist)
 * - Firefox build output (dist-firefox)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function runBuildAll() {
  const result = spawnSync('node', ['scripts/build.js', 'all'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0) {
    throw new Error(`Build failed with exit code ${result.status}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(value, requiredTokens, label, errors) {
  const text = String(value || '');
  for (const token of requiredTokens) {
    if (!text.includes(token)) {
      errors.push(`${label} must include "${token}". Actual: ${text}`);
    }
  }
}

function validateManifest(manifestPath, toolbarTitleKey) {
  const manifest = readJson(manifestPath);
  const errors = [];

  assertIncludes(manifest.name, ['Privateness.network', 'BitShares'], `${manifestPath} -> name`, errors);
  assertIncludes(manifest.description, ['Privateness.network', 'BitShares'], `${manifestPath} -> description`, errors);
  assertIncludes(manifest.author, ['Privateness.network', 'BitShares'], `${manifestPath} -> author`, errors);

  const toolbarTitle = toolbarTitleKey
    .split('.')
    .reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), manifest);

  assertIncludes(toolbarTitle, ['Privateness.network', 'BitShares'], `${manifestPath} -> ${toolbarTitleKey}`, errors);

  return errors;
}

function validatePopupHtml(popupPath) {
  const html = readText(popupPath);
  const errors = [];

  const requiredSnippets = [
    'Privateness.network BitShares Wallet',
    'Initializing Privateness.network BitShares Wallet...',
    'BitShares Mainnet',
    'BitShares Testnet',
    'Privateness.network BitShares wallet'
  ];

  for (const snippet of requiredSnippets) {
    if (!html.includes(snippet)) {
      errors.push(`${popupPath} is missing required branding snippet: "${snippet}"`);
    }
  }

  return errors;
}

function main() {
  console.log('Running e2e branding validation...');

  runBuildAll();

  const checks = [
    ...validateManifest(path.join(ROOT, 'dist', 'manifest.json'), 'action.default_title'),
    ...validateManifest(path.join(ROOT, 'dist-firefox', 'manifest.json'), 'browser_action.default_title'),
    ...validatePopupHtml(path.join(ROOT, 'dist', 'src', 'popup', 'popup.html')),
    ...validatePopupHtml(path.join(ROOT, 'dist-firefox', 'src', 'popup', 'popup.html'))
  ];

  if (checks.length > 0) {
    console.error('\nBranding e2e validation FAILED:\n');
    for (const error of checks) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log('\nBranding e2e validation PASSED for Chrome + Firefox builds.');
}

try {
  main();
} catch (error) {
  console.error(`\nBranding e2e validation crashed: ${error.message}`);
  process.exit(1);
}
