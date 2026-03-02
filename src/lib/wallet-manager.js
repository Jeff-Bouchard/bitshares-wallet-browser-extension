/**
 * Privateness.network Wallet Manager
 * Handles wallet creation, encryption, storage, and key management
 */

import { CryptoUtils, bytesToBase64, base64ToBytes } from './crypto-utils.js';
import { BitSharesAPI } from './bitshares-api.js';
import { EmercoinNVS } from './emercoin-nvs.js';

export class WalletManager {
  constructor() {
    this.isUnlockedState = false;
    this.currentWallet = null;
    this.decryptedKeys = null;
    this.api = null;
    this.emercoinNVS = new EmercoinNVS();

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
        keys = await CryptoUtils.generateKeysFromPassword(bitsharesAccountName, bitsharesPassword);
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
        // Note: bitsharesPassword is intentionally NOT stored — only derived keys are kept.
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
        await this.findAndAddAccount(keys.active.publicKey, network);
      }

      // Store identity on Emercoin NVS for decentralized verification
      const identityData = { publicKey: keys.active.publicKey, walletName: name };
      await this.emercoinNVS.storeIdentity(name, identityData);

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
        // bitsharesPassword intentionally NOT stored — only derived keys are kept.
        // Storing the source password would expose it if the wallet password is compromised.
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
        await this.findAndAddAccount(keys.active.publicKey, network);
      }

      // Store identity on Emercoin NVS for decentralized verification
      const identityData = { publicKey: keys.active.publicKey, walletName: 'Imported Wallet' };
      await this.emercoinNVS.storeIdentity('Imported Wallet', identityData);

      return true;
    } catch (error) {
      console.error('Import wallet error:', error);
      throw new Error('Failed to import wallet: ' + error.message);
    } finally {
      // Added finally block to ensure proper closure of the importWallet method
    }
  }

  // ... rest of the code remains the same ...
