/**
 * Bitshares-NESS custodial wallet manager
 * Handles wallet creation, encryption, storage, and key management
 */

import { CryptoUtils, bytesToBase64, base64ToBytes } from './crypto-utils.js';
import { BitSharesAPI } from './bitshares-api.js';

export class WalletManager {
  constructor() {
    this.isUnlockedState = false;
    this.currentWallet = null;
    this.decryptedKeys = null;
    this.api = null;

    // Auto-lock duration (timer managed via chrome.alarms)
    this.autoLockDuration = 15 * 60 * 1000; // Default: 15 minutes

    // Mutex to prevent concurrent lock/unlock race conditions
    this._lockMutex = Promise.resolve();

    // Unlock attempt rate-limiting
    this._failedUnlockAttempts = 0;
    this._unlockLockoutUntil = 0;
  }

  /**
   * Check if a wallet exists in storage
   */
  async hasWallet() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['wallet'], (result) => {
        resolve(!!result.wallet);
      });
    });
  }

  /**
   * Check if the wallet is currently unlocked
   * Checks both memory state and session storage for persisted unlock state
   */
  async isUnlocked() {
    // If already unlocked in memory, return true
    if (this.isUnlockedState && this.decryptedKeys !== null) {
      return true;
    }

    // Check if there's a valid session in storage and try to restore it
    return new Promise((resolve) => {
      const storage = chrome.storage.session || chrome.storage.local;
      storage.get(['encryptedSessionData', 'unlockTimestamp', 'autoLockDuration', 'persistedSessionKey'], async (result) => {
        if (!result.encryptedSessionData || !result.unlockTimestamp) {
          resolve(false);
          return;
        }

        // Check if unlock is still valid (within auto-lock period)
        const autoLockMs = result.autoLockDuration !== undefined ? result.autoLockDuration : this.autoLockDuration;
        if (autoLockMs > 0) {
          const elapsed = Date.now() - result.unlockTimestamp;
          if (elapsed >= autoLockMs) {
            // Session expired, clear it
            await this.clearSessionPassword();
            resolve(false);
            return;
          }
        }

        // Try to restore session encryption key if needed
        if (!this._sessionEncryptionKey && result.persistedSessionKey) {
          try {
            this._sessionEncryptionKey = new Uint8Array(
              base64ToBytes(result.persistedSessionKey)
            );
          } catch (e) {
            resolve(false);
            return;
          }
        }

        // If we have the session key, try to restore the session
        if (this._sessionEncryptionKey) {
          const restored = await this.restoreFromSession();
          resolve(restored);
        } else {
          // No session key available
          resolve(false);
        }
      });
    });
  }

  /**
   * Ensure the wallet is unlocked, restoring from session if needed
   * Call this before operations that require decrypted keys
   */
  async ensureUnlocked() {
    // Serialize lock/unlock to prevent race conditions
    const prev = this._lockMutex;
    let release;
    this._lockMutex = new Promise(r => { release = r; });
    await prev;
    try {
      // If already unlocked in memory with keys, we're good
      if (this.isUnlockedState && this.decryptedKeys !== null) {
        return true;
      }

      // Try to restore from session
      const restored = await this.restoreFromSession();
      if (!restored) {
        throw new Error('Wallet is locked');
      }
      return true;
    } finally {
      release();
    }
  }

  /**
   * Share the popup's already-connected API instance with the wallet manager.
   * Called from popup.js after initializeAPI() so that account operations use
   * the same network (mainnet/testnet) the user selected.
   */
  setApi(api) {
    this.api = api;
    // Remember the nodes so reconnection uses the same network
    this._apiNodes = api && api.nodes ? [...api.nodes] : null;
  }

  /**
   * Ensure the BitSharesAPI instance exists and its WebSocket is connected.
   * Re-creates and reconnects whenever the instance is missing or the socket
   * has dropped (e.g. after service-worker idle, network hiccup, etc.).
   * Uses the nodes saved via setApi() so reconnection stays on the correct network.
   * Falls back to reading selectedNetwork from storage when _apiNodes is null
   * (handles the MV3 service-worker restart race where setApi hasn't been called yet).
   */
  async ensureApiConnected() {
    if (!this.api || !this.api.isConnected) {
      let nodes = this._apiNodes;
      if (!nodes) {
        // Service worker restarted before setApi() was called — read the user's
        // network preference from storage so we connect to the right chain.
        const stored = await chrome.storage.local.get(['selectedNetwork']);
        const net = stored.selectedNetwork || 'mainnet';
        nodes = net === 'testnet'
          ? ['wss://testnet.xbts.io/ws', 'wss://testnet.dex.trading/']
          : ['wss://node.xbts.io/ws', 'wss://cloud.xbts.io/ws', 'wss://public.xbts.io/ws',
             'wss://btsws.roelandp.nl/ws', 'wss://dex.iobanker.com/ws', 'wss://api.bitshares.dev/ws'];
        this._apiNodes = nodes; // cache so subsequent reconnects stay on the same network
      }
      this.api = new BitSharesAPI(nodes);
      await this.api.connect();
    }
  }

  /**
   * Restore unlock state from session storage
   * Used when service worker restarts but session is still valid
   *
   * SECURITY NOTE: The session encryption key is stored only in memory by default.
   * When auto-lock is disabled, the key is persisted to allow session restoration.
   */
  async restoreFromSession() {
    return new Promise((resolve) => {
      const storage = chrome.storage.session || chrome.storage.local;
      storage.get(['encryptedSessionData', 'unlockTimestamp', 'autoLockDuration', 'persistedSessionKey'], async (result) => {
        // Check if session data exists
        if (!result.unlockTimestamp || !result.encryptedSessionData) {
          resolve(false);
          return;
        }

        const autoLockMs = result.autoLockDuration !== undefined ? result.autoLockDuration : this.autoLockDuration;
        if (autoLockMs > 0) {
          const elapsed = Date.now() - result.unlockTimestamp;
          if (elapsed >= autoLockMs) {
            // Session expired - clear data
            await this.clearSessionPassword();
            resolve(false);
            return;
          }
        }

        // Try to restore session encryption key from storage (when auto-lock disabled)
        if (!this._sessionEncryptionKey && result.persistedSessionKey) {
          try {
            this._sessionEncryptionKey = new Uint8Array(
              base64ToBytes(result.persistedSessionKey)
            );
          } catch (e) {
            // Failed to restore key
            resolve(false);
            return;
          }
        }

        // If we still don't have the session encryption key, we can't restore
        if (!this._sessionEncryptionKey) {
          resolve(false);
          return;
        }

        try {
          // Decrypt the password from session storage
          const password = await this._decryptFromSession(result.encryptedSessionData);
          // Try to unlock with decrypted password
          const success = await this.unlock(password);
          resolve(success);
        } catch (error) {
          // Failed to decrypt or unlock - session is invalid
          await this.clearSessionPassword();
          resolve(false);
        }
      });
    });
  }

  // === Auto-lock Timer Methods ===

  /**
   * Set auto-lock duration in milliseconds
   * Set to 0 to disable auto-lock
   */
  async setAutoLockDuration(durationMs) {
    this.autoLockDuration = durationMs;
    // Persist setting to local storage
    return new Promise((resolve) => {
      chrome.storage.local.set({ autoLockDuration: durationMs }, () => {
        // Reset timer with new duration if unlocked
        if (this.isUnlockedState) {
          this.resetAutoLockTimer();
        }

        // Update session storage with new duration and reset timestamp
        const storage = chrome.storage.session || chrome.storage.local;
        storage.set({
          autoLockDuration: durationMs,
          unlockTimestamp: Date.now() // Reset timer when changing duration
        }, () => resolve());
      });
    });
  }

  /**
   * Get current auto-lock duration in milliseconds
   */
  async getAutoLockDuration() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['autoLockDuration'], (result) => {
        if (result.autoLockDuration !== undefined) {
          this.autoLockDuration = result.autoLockDuration;
        }
        resolve(this.autoLockDuration);
      });
    });
  }

  /**
   * Reset the auto-lock timer
   * Call this after any wallet activity to extend the unlock period
   */
  resetAutoLockTimer() {
    // Don't start timer if auto-lock is disabled or wallet is locked
    if (this.autoLockDuration <= 0 || !this.isUnlockedState) {
      return;
    }

    // Update unlock timestamp in session storage
    const storage = chrome.storage.session || chrome.storage.local;
    storage.set({ unlockTimestamp: Date.now() });

    // Delegate to chrome.alarms (survives service worker restarts).
    // The alarm listener is registered in service-worker.js setupAutoLock().
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      chrome.alarms.clear('auto-lock');
      chrome.alarms.create('auto-lock', {
        delayInMinutes: this.autoLockDuration / 60000
      });
    }
  }

  /**
   * Touch the wallet to reset auto-lock timer
   * Call this on any user activity
   */
  touch() {
    if (this.isUnlockedState) {
      this.resetAutoLockTimer();
    }
  }

  /**
   * Get remaining time until auto-lock in milliseconds
   * Returns 0 if auto-lock is disabled or wallet is locked
   */
  getTimeUntilLock() {
    if (!this.isUnlockedState || this.autoLockDuration <= 0 || !this.autoLockTimer) {
      return 0;
    }
    // Note: This is an approximation since we don't track exact start time
    return this.autoLockDuration;
  }

  /**
   * Create a new wallet with the given parameters.
   * When bitsharesAccountName and bitsharesPassword are provided (password-based
   * cloud wallet, matching wallet.bitshares.org / ex.xbts.io), keys are derived
   * from those credentials via generateKeysFromPassword.  The brainkey is stored
   * as an alternative recovery path.  When only a brainkey is supplied the legacy
   * SLIP-48 derivation is used instead.
   */
  async createWallet(name, password, brainkey = null, bitsharesAccountName = null, bitsharesPassword = null, network = 'mainnet') {
    try {
      // Generate brainkey if not provided
      if (!brainkey) {
        brainkey = CryptoUtils.generateBrainkey();
      }

      // Normalize brainkey
      brainkey = CryptoUtils.normalizeBrainkey(brainkey);

      // Validate brainkey has sufficient entropy (expect 12+ words)
      const wordCount = brainkey.split(' ').length;
      if (wordCount < 12) {
        throw new Error(`Brainkey too short (${wordCount} words). Must be at least 12 words for sufficient entropy.`);
      }

      // Determine primary keys:
      // • password-based (cloud wallet) when BitShares credentials are provided
      // • brainkey-based (SLIP-48 HD) as fallback
      let keys;
      if (bitsharesAccountName && bitsharesPassword) {
        const keyPrefix = network === 'testnet' ? 'TEST' : 'BTS';
        keys = await CryptoUtils.generateKeysFromPassword(bitsharesAccountName, bitsharesPassword, keyPrefix);
      } else {
        keys = await CryptoUtils.generateKeysFromBrainkey(brainkey);
      }

      // Generate unique salt for this wallet
      const salt = CryptoUtils.generateSalt();

      // Encrypt the wallet data with unique salt
      const encryptionKey = await CryptoUtils.deriveKey(password, salt);
      const encryptedData = await CryptoUtils.encrypt({
        brainkey: brainkey,
        bitsharesAccountName: bitsharesAccountName || null,
        // Stored inside wallet-encrypted payload so users can retrieve it later.
        bitsharesPassword: bitsharesPassword || null,
        keys: keys,
        accounts: []
      }, encryptionKey);

      // Create wallet structure with salt (version 2 = with salt)
      const wallet = {
        name: name,
        encrypted: encryptedData,
        salt: salt,
        publicKeys: {
          active: keys.active.publicKey,
          owner: keys.owner.publicKey,
          memo: keys.memo.publicKey
        },
        createdAt: Date.now(),
        version: 2
      };

      // Store wallet
      await this.saveWallet(wallet);

      // Set as unlocked
      this.currentWallet = wallet;
      this.decryptedKeys = keys;
      this.isUnlockedState = true;

      // Store password for session
      await this.storeSessionPassword(password);

      // Try to find associated account on chain
      if (bitsharesAccountName) {
        await this.findAndAddAccountByName(bitsharesAccountName, network);
      } else {
        try {
          await this.findAndAddAccountForKeys(keys, network);
        } catch (e) {
          if (!String(e?.message || e).includes('No accounts found for key')) {
            throw e;
          }
        }
      }

      return true;
    } catch (error) {
      throw new Error('Failed to create wallet: ' + error.message);
    }
  }

  /**
   * Import an existing wallet
   */
  async importWallet(importData, password, network = 'mainnet') {
    try {
      let keys;
      let brainkey = null;

      let bitsharesAccountName = null;
      let bitsharesPassword = null;

      const keyPrefix = network === 'testnet' ? 'TEST' : 'BTS';

      switch (importData.type) {
        case 'account':
          // Generate keys from account name and password, using the correct prefix for the network
          keys = await CryptoUtils.generateKeysFromPassword(
            importData.accountName,
            importData.password,
            keyPrefix
          );
          bitsharesAccountName = importData.accountName;
          bitsharesPassword = importData.password;
          break;

        case 'brainkey':
          brainkey = CryptoUtils.normalizeBrainkey(importData.brainkey);
          keys = await CryptoUtils.generateKeysFromBrainkey(brainkey);
          break;

        default:
          throw new Error('Invalid import type');
      }

      // Generate unique salt for this wallet
      const salt = CryptoUtils.generateSalt();

      // Encrypt wallet data with unique salt
      const encryptionKey = await CryptoUtils.deriveKey(password, salt);
      const encryptedData = await CryptoUtils.encrypt({
        brainkey: brainkey,
        bitsharesAccountName: bitsharesAccountName,
        // Stored inside wallet-encrypted payload so users can retrieve it later.
        bitsharesPassword: bitsharesPassword,
        keys: keys,
        accounts: []
      }, encryptionKey);

      // Create wallet structure with salt (version 2)
      const wallet = {
        name: 'Imported Wallet',
        encrypted: encryptedData,
        salt: salt,
        publicKeys: {
          active: keys.active.publicKey,
          owner: keys.owner?.publicKey,
          memo: keys.memo?.publicKey
        },
        importType: importData.type,
        createdAt: Date.now(),
        version: 2
      };

      // Store wallet
      await this.saveWallet(wallet);

      // Set as unlocked
      this.currentWallet = wallet;
      this.decryptedKeys = keys;
      this.isUnlockedState = true;

      // Store password for session
      await this.storeSessionPassword(password);

      // Find and add account
      if (importData.type === 'account' && importData.accountName) {
        // For account import, look up the account directly by name
        await this.findAndAddAccountByName(importData.accountName, network);
      } else {
        // For other types, try to find by public key
        try {
          await this.findAndAddAccountForKeys(keys, network);
        } catch (e) {
          if (!String(e?.message || e).includes('No accounts found for key')) {
            throw e;
          }
        }
      }

      return true;
    } catch (error) {
      console.error('Import wallet error:', error);
      throw new Error('Failed to import wallet: ' + error.message);
    }
  }

  async saveWallet(wallet) {
    this.currentWallet = wallet;
    return new Promise((resolve) => {
      chrome.storage.local.set({ wallet }, () => resolve());
    });
  }

  async loadWallet() {
    if (this.currentWallet) return this.currentWallet;
    const result = await new Promise((resolve) => {
      chrome.storage.local.get(['wallet'], (r) => resolve(r));
    });
    this.currentWallet = result.wallet || null;
    return this.currentWallet;
  }

  async _getSessionStorage() {
    return chrome.storage.session || chrome.storage.local;
  }

  async _importSessionKey() {
    if (!this._sessionEncryptionKey) {
      this._sessionEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
    }
    return await crypto.subtle.importKey(
      'raw',
      this._sessionEncryptionKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async _encryptForSession(plaintext) {
    const key = await this._importSessionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(String(plaintext));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    return bytesToBase64(combined);
  }

  async _decryptFromSession(encryptedBase64) {
    const combined = base64ToBytes(encryptedBase64);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const key = await this._importSessionKey();
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(decrypted);
  }

  async storeSessionPassword(password) {
    const storage = await this._getSessionStorage();
    const encryptedSessionData = await this._encryptForSession(password);

    const payload = {
      encryptedSessionData,
      unlockTimestamp: Date.now(),
      autoLockDuration: this.autoLockDuration
    };

    if (this.autoLockDuration <= 0) {
      payload.persistedSessionKey = bytesToBase64(this._sessionEncryptionKey);
    }

    return new Promise((resolve) => {
      storage.set(payload, () => resolve());
    });
  }

  async clearSessionPassword() {
    const storage = await this._getSessionStorage();
    return new Promise((resolve) => {
      storage.remove(['encryptedSessionData', 'unlockTimestamp', 'persistedSessionKey', 'autoLockDuration'], () => resolve());
    });
  }

  async _getWalletPasswordFromSession() {
    const storage = await this._getSessionStorage();
    const result = await new Promise((resolve) => {
      storage.get(['encryptedSessionData'], (r) => resolve(r));
    });
    if (!result.encryptedSessionData) {
      throw new Error('Wallet is locked');
    }
    return await this._decryptFromSession(result.encryptedSessionData);
  }

  async _readDecryptedWalletData(password) {
    const wallet = await this.loadWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }
    const encryptionKey = await CryptoUtils.deriveKey(password, wallet.salt);
    return await CryptoUtils.decrypt(wallet.encrypted, encryptionKey);
  }

  async _persistWalletData(updatedData) {
    const wallet = await this.loadWallet();
    if (!wallet) throw new Error('No wallet found');
    const password = await this._getWalletPasswordFromSession();
    const encryptionKey = await CryptoUtils.deriveKey(password, wallet.salt);
    const encrypted = await CryptoUtils.encrypt(updatedData, encryptionKey);
    const nextWallet = { ...wallet, encrypted };
    await this.saveWallet(nextWallet);
    this._walletData = updatedData;
  }

  async unlock(password) {
    const wallet = await this.loadWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    // Lockout check
    if (this._unlockLockoutUntil && Date.now() < this._unlockLockoutUntil) {
      return false;
    }

    try {
      const data = await this._readDecryptedWalletData(password);
      this._walletData = data;
      this.decryptedKeys = data.keys || null;
      this.isUnlockedState = !!this.decryptedKeys;

      await this.storeSessionPassword(password);
      this.resetAutoLockTimer();

      this._failedUnlockAttempts = 0;
      this._unlockLockoutUntil = 0;
      return true;
    } catch (e) {
      this._failedUnlockAttempts++;
      if (this._failedUnlockAttempts >= 10) {
        this._unlockLockoutUntil = Date.now() + 60_000;
      }
      return false;
    }
  }

  async lock() {
    this.isUnlockedState = false;
    this.decryptedKeys = null;
    this._walletData = null;
    this._sessionEncryptionKey = null;
    await this.clearSessionPassword();
    try {
      chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' });
    } catch (_) {
      // ignore
    }
  }

  async getBrainkey() {
    await this.ensureUnlocked();
    return this._walletData?.brainkey || null;
  }

  async _resolveAccountFromWalletData(walletData, accountId = null) {
    const accounts = Array.isArray(walletData?.accounts) ? walletData.accounts : [];
    if (!accounts.length) return null;

    if (accountId) {
      const byId = accounts.find((a) => a.id === accountId);
      if (byId) return byId;
    }

    const { activeAccountId } = await new Promise((resolve) => {
      chrome.storage.local.get(['activeAccountId'], (r) => resolve(r));
    });

    if (activeAccountId) {
      const active = accounts.find((a) => a.id === activeAccountId);
      if (active) return active;
    }

    return accounts[0] || null;
  }

  async getPrivateKey(walletPassword, keyType = 'active', accountId = null) {
    if (!walletPassword) return null;

    const allowedTypes = new Set(['active', 'owner', 'memo']);
    if (!allowedTypes.has(keyType)) {
      throw new Error(`Invalid key type: ${keyType}`);
    }

    let walletData;
    try {
      walletData = await this._readDecryptedWalletData(walletPassword);
    } catch (_) {
      return null;
    }

    const account = await this._resolveAccountFromWalletData(walletData, accountId);
    if (account?.watchOnly) {
      return null;
    }

    const keys = account?.keys || walletData?.keys || null;
    const keyPair = keys?.[keyType] || null;
    if (!keyPair?.privateKey) {
      return null;
    }

    return {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey || ''
    };
  }

  async getBitsharesPassword(walletPassword, accountId = null) {
    if (!walletPassword) return null;

    let walletData;
    try {
      walletData = await this._readDecryptedWalletData(walletPassword);
    } catch (_) {
      throw new Error('Invalid wallet password');
    }

    const account = await this._resolveAccountFromWalletData(walletData, accountId);
    if (account?.watchOnly) {
      return null;
    }

    const accountName = account?.name || walletData?.bitsharesAccountName || null;
    const password = account?.bitsharesPassword || walletData?.bitsharesPassword || null;

    if (!accountName || !password) {
      return null;
    }

    return { accountName, password };
  }

  async resetWallet() {
    await this.lock();
    this.currentWallet = null;
    return new Promise((resolve) => {
      chrome.storage.local.remove(['wallet', 'activeAccountId', 'connectedSites'], () => resolve());
    });
  }

  async _ensureWalletDataLoaded() {
    if (this._walletData) return;
    const password = await this._getWalletPasswordFromSession();
    this._walletData = await this._readDecryptedWalletData(password);
  }

  async getAllAccounts(network = null) {
    await this.ensureUnlocked();
    await this._ensureWalletDataLoaded();
    const accounts = Array.isArray(this._walletData.accounts) ? this._walletData.accounts : [];
    if (!network) return accounts;
    return accounts.filter(a => a.network === network);
  }

  async getCurrentAccount() {
    await this.ensureUnlocked();
    const { activeAccountId } = await new Promise((resolve) => {
      chrome.storage.local.get(['activeAccountId'], (r) => resolve(r));
    });
    const accounts = await this.getAllAccounts();
    if (!accounts.length) return null;
    if (activeAccountId) {
      const found = accounts.find(a => a.id === activeAccountId);
      if (found) return found;
    }
    return accounts[0];
  }

  async setActiveAccount(accountId) {
    await this.ensureUnlocked();
    return new Promise((resolve) => {
      chrome.storage.local.set({ activeAccountId: accountId }, () => {
        try {
          chrome.runtime.sendMessage({ type: 'ACCOUNT_CHANGED', data: { accountId } });
        } catch (_) {
          // ignore
        }
        resolve();
      });
    });
  }

  async isWatchOnlyAccount(accountId) {
    const accounts = await this.getAllAccounts();
    const acc = accounts.find(a => a.id === accountId);
    return !!acc?.watchOnly;
  }

  async addWatchOnlyAccount(accountName, network = 'mainnet') {
    await this.ensureUnlocked();
    await this.ensureApiConnected();
    await this._ensureWalletDataLoaded();

    const chainAccount = await this.api.getAccount(accountName);
    if (!chainAccount) {
      throw new Error('Account not found on BitShares');
    }

    const existing = (this._walletData.accounts || []).find(a => a.id === chainAccount.id);
    if (existing) {
      return true;
    }

    const nextAccounts = [...(this._walletData.accounts || []), {
      id: chainAccount.id,
      name: chainAccount.name,
      network,
      watchOnly: true
    }];
    await this._persistWalletData({ ...this._walletData, accounts: nextAccounts });

    const { activeAccountId } = await new Promise((resolve) => {
      chrome.storage.local.get(['activeAccountId'], (r) => resolve(r));
    });
    if (!activeAccountId) {
      await this.setActiveAccount(chainAccount.id);
    }
    return true;
  }

  async addAccountByCredentials(accountName, bitsharesPassword, walletPassword, skipVerify = false, keyPrefix = 'BTS', network = 'mainnet') {
    await this.ensureUnlocked();
    await this.ensureApiConnected();
    await this._ensureWalletDataLoaded();

    // Verify walletPassword matches the encrypted wallet (user re-auth)
    try {
      await this._readDecryptedWalletData(walletPassword);
    } catch (e) {
      throw new Error('Invalid wallet password');
    }

    const keys = await CryptoUtils.generateKeysFromPassword(accountName, bitsharesPassword, keyPrefix);
    const chainAccount = await this.api.getAccount(accountName);
    if (!chainAccount) {
      throw new Error('Account not found on BitShares');
    }

    if (!skipVerify) {
      const generatedPubKeys = [keys.active.publicKey, keys.owner.publicKey, keys.memo.publicKey];
      const onchainKeys = [
        ...(chainAccount.active?.key_auths?.map(k => k[0]) || []),
        ...(chainAccount.owner?.key_auths?.map(k => k[0]) || []),
        chainAccount.options?.memo_key
      ].filter(Boolean);
      const hasMatch = generatedPubKeys.some(k => onchainKeys.includes(k));
      if (!hasMatch) {
        throw new Error('Password does not match on-chain keys');
      }
    }

    const nextAccounts = [...(this._walletData.accounts || []).filter(a => a.id !== chainAccount.id), {
      id: chainAccount.id,
      name: chainAccount.name,
      network,
      watchOnly: false,
      keys,
      bitsharesPassword
    }];
    await this._persistWalletData({ ...this._walletData, accounts: nextAccounts });
    await this.setActiveAccount(chainAccount.id);
    return true;
  }

  async removeAccount(accountId) {
    await this.ensureUnlocked();
    await this._ensureWalletDataLoaded();
    const nextAccounts = (this._walletData.accounts || []).filter(a => a.id !== accountId);
    await this._persistWalletData({ ...this._walletData, accounts: nextAccounts });
    const { activeAccountId } = await new Promise((resolve) => {
      chrome.storage.local.get(['activeAccountId'], (r) => resolve(r));
    });
    if (activeAccountId === accountId) {
      const next = nextAccounts[0]?.id || null;
      await new Promise((resolve) => {
        chrome.storage.local.set({ activeAccountId: next }, () => resolve());
      });
    }
    return true;
  }

  async updateAccountNetwork(accountId, newNetwork) {
    await this.ensureUnlocked();
    await this._ensureWalletDataLoaded();
    const nextAccounts = (this._walletData.accounts || []).map(a => a.id === accountId ? { ...a, network: newNetwork } : a);
    await this._persistWalletData({ ...this._walletData, accounts: nextAccounts });
    return true;
  }

  async findAndAddAccountByName(accountName, network = 'mainnet') {
    await this.ensureUnlocked();
    await this.ensureApiConnected();
    await this._ensureWalletDataLoaded();

    const chainAccount = await this.api.getAccount(accountName);
    if (!chainAccount) {
      throw new Error('Account not found on BitShares');
    }

    const keys = this.decryptedKeys;
    if (!keys) {
      throw new Error('Wallet is locked');
    }

    const nextAccounts = [...(this._walletData.accounts || []).filter(a => a.id !== chainAccount.id), {
      id: chainAccount.id,
      name: chainAccount.name,
      network,
      watchOnly: false,
      keys
    }];
    await this._persistWalletData({ ...this._walletData, accounts: nextAccounts });
    await this.setActiveAccount(chainAccount.id);
    return true;
  }

  async findAndAddAccount(publicKey, network = 'mainnet') {
    await this.ensureUnlocked();
    await this.ensureApiConnected();
    const accounts = await this.api.getAccountsByKey(publicKey);
    if (!accounts || accounts.length === 0) {
      return false;
    }
    const first = accounts[0];
    // get_key_references typically returns account IDs
    if (typeof first === 'string' && first.startsWith('1.2.')) {
      const acct = await this.api.getAccount(first);
      if (!acct) throw new Error('Account not found on BitShares');
      return await this.findAndAddAccountByName(acct.name, network);
    }
    return false;
  }

  async findAndAddAccountForKeys(keys, network = 'mainnet') {
    await this.ensureUnlocked();
    await this.ensureApiConnected();

    const candidates = [
      keys?.active?.publicKey,
      keys?.owner?.publicKey,
      keys?.memo?.publicKey
    ].filter(Boolean);

    for (const pubKey of candidates) {
      const accounts = await this.api.getAccountsByKey(pubKey);
      if (accounts && accounts.length > 0) {
        const first = accounts[0];
        if (typeof first === 'string' && first.startsWith('1.2.')) {
          const acct = await this.api.getAccount(first);
          if (!acct) throw new Error('Account not found on BitShares');
          return await this.findAndAddAccountByName(acct.name, network);
        }
        // If the node returns unexpected schema, keep trying.
      }
    }

    return false;
  }

  async registerAccountViaFaucet(accountName, keys, faucetUrl) {
    const payload = {
      account: {
        name: accountName,
        owner_key: keys.owner.publicKey,
        active_key: keys.active.publicKey,
        memo_key: keys.memo.publicKey
      }
    };

    const res = await fetch(faucetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Faucet error (${res.status}): ${text}`);
    }

    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (json && (json.error || json.errors)) {
      throw new Error(`Faucet error: ${JSON.stringify(json.error || json.errors)}`);
    }

    return json;
  }

  async createAccountOnChain(accountName, keys, feeAccountNameOrId) {
    await this.ensureUnlocked();
    await this.ensureApiConnected();
    await this._ensureWalletDataLoaded();

    const feeAccount = await this.api.getAccount(feeAccountNameOrId);
    if (!feeAccount) {
      throw new Error('Fee account not found on BitShares');
    }

    const accounts = await this.getAllAccounts();
    const signer = accounts.find(a => a.id === feeAccount.id) || null;
    const signerKey = signer?.keys?.active?.privateKey || this.decryptedKeys?.active?.privateKey;
    if (!signerKey) {
      throw new Error('Fee account private key not available in wallet');
    }

    const opData = {
      fee: { amount: 0, asset_id: '1.3.0' },
      registrar: feeAccount.id,
      referrer: feeAccount.id,
      referrer_percent: 0,
      name: accountName,
      owner: {
        weight_threshold: 1,
        account_auths: [],
        key_auths: [[keys.owner.publicKey, 1]],
        address_auths: []
      },
      active: {
        weight_threshold: 1,
        account_auths: [],
        key_auths: [[keys.active.publicKey, 1]],
        address_auths: []
      },
      options: {
        memo_key: keys.memo.publicKey,
        voting_account: '1.2.5',
        num_witness: 0,
        num_committee: 0,
        votes: [],
        extensions: []
      },
      extensions: []
    };

    return await this.api.broadcastTransaction('account_create', opData, signerKey);
  }

  async _getSigningKeysForAccount(accountId) {
    await this.ensureUnlocked();
    const accounts = await this.getAllAccounts();
    const acc = accounts.find(a => a.id === accountId) || null;
    if (acc?.watchOnly) throw new Error('Watch-only account cannot sign');
    return acc?.keys || this.decryptedKeys;
  }

  async broadcastOperation(operationType, operationData) {
    await this.ensureUnlocked();
    await this.ensureApiConnected();
    const account = await this.getCurrentAccount();
    if (!account) throw new Error('No active account');
    const keys = await this._getSigningKeysForAccount(account.id);
    if (!keys?.active?.privateKey) throw new Error('Active private key not available');
    return await this.api.broadcastTransaction(operationType, operationData, keys.active.privateKey);
  }

  async sendTransfer(to, amount, assetId = '1.3.0', memo = null) {
    await this.ensureUnlocked();
    await this.ensureApiConnected();

    const fromAccount = await this.getCurrentAccount();
    if (!fromAccount) throw new Error('No active account');

    const toAccount = await this.api.getAccount(to);
    if (!toAccount) throw new Error('Recipient not found');

    const asset = await this.api.getAsset(assetId);
    if (!asset) throw new Error('Asset not found');

    const precision = Math.pow(10, asset.precision);
    const amt = Math.floor(Number(amount) * precision);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount');

    const keys = await this._getSigningKeysForAccount(fromAccount.id);
    if (!keys?.active?.privateKey) throw new Error('Active private key not available');

    let memoObject = undefined;
    if (memo && String(memo).trim().length > 0) {
      const toMemoKey = toAccount.options?.memo_key;
      if (toMemoKey && keys.memo?.privateKey) {
        memoObject = await CryptoUtils.encryptMemo(String(memo), keys.memo.privateKey, toMemoKey);
      }
    }

    const opData = {
      fee: { amount: 0, asset_id: '1.3.0' },
      from: fromAccount.id,
      to: toAccount.id,
      amount: { amount: amt, asset_id: asset.id || assetId },
      memo: memoObject,
      extensions: []
    };

    return await this.api.broadcastTransaction('transfer', opData, keys.active.privateKey);
  }

  async signTransaction(transaction) {
    await this.ensureUnlocked();
    await this.ensureApiConnected();
    const account = await this.getCurrentAccount();
    if (!account) throw new Error('No active account');
    const keys = await this._getSigningKeysForAccount(account.id);
    if (!keys?.active?.privateKey) throw new Error('Active private key not available');
    return await this.api.signTransaction(transaction, keys.active.privateKey);
  }

  async getConnectedSites(accountId = null, network = null) {
    const { connectedSites } = await new Promise((resolve) => {
      chrome.storage.local.get(['connectedSites'], (r) => resolve(r));
    });
    const sites = Array.isArray(connectedSites) ? connectedSites : [];
    return sites.filter(s => {
      if (network && s.network !== network) return false;
      if (accountId && s.accountId !== accountId) return false;
      return true;
    });
  }

  async addConnectedSite(origin, accountId, accountName, network = 'mainnet') {
    const sites = await this.getConnectedSites(null, null);
    const next = [
      ...sites.filter(s => !(s.origin === origin && s.accountId === accountId && s.network === network)),
      { origin, accountId, accountName, network, connectedAt: Date.now() }
    ];
    return new Promise((resolve) => {
      chrome.storage.local.set({ connectedSites: next }, () => resolve(true));
    });
  }

  async removeConnectedSite(origin, accountId = null, network = null) {
    const sites = await this.getConnectedSites(null, null);
    const next = sites.filter(s => {
      if (s.origin !== origin) return true;
      if (network && s.network !== network) return true;
      if (accountId && s.accountId !== accountId) return true;
      if (!accountId) return false;
      return false;
    });
    return new Promise((resolve) => {
      chrome.storage.local.set({ connectedSites: next }, () => resolve(true));
    });
  }

  async isSiteConnected(origin, accountId = null, network = 'mainnet') {
    const sites = await this.getConnectedSites(null, null);
    return sites.some(s => {
      if (s.origin !== origin) return false;
      if (network && s.network !== network) return false;
      if (accountId && s.accountId !== accountId) return false;
      return true;
    });
  }

}
