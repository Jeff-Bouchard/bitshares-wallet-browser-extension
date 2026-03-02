/**
 * Privateness.network Wallet - Inpage Script
 * Provides the wallet API to web pages with Emercoin identity touch
 * This script runs in the page context
 */

(function() {
  'use strict';

  // Prevent multiple definitions
  if (window.bitsharesWallet) {
    return;
  }

  let requestId = 0;
  const pendingRequests = new Map();
  const eventListeners = new Map();

  /**
   * Send a request to the extension
   */
  function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      
      pendingRequests.set(id, { resolve, reject });

      // Set timeout
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 120000); // 2 minute timeout for user interactions

      window.postMessage({
        type: 'BITSHARES_WALLET_REQUEST',
        method,
        params,
        id
      }, window.location.origin);
    });
  }

  // Listen for responses from content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const { type, id, data, error, event: eventType } = event.data;

    if (type === 'BITSHARES_WALLET_RESPONSE') {
      if (id && pendingRequests.has(id)) {
        const { resolve, reject } = pendingRequests.get(id);
        pendingRequests.delete(id);

        if (error) {
          reject(new Error(error));
        } else {
          resolve(data);
        }
      }
    } else if (type === 'BITSHARES_WALLET_EVENT') {
      // Update internal state for account changes
      if (eventType === 'accountChanged' && event.data.data) {
        updateProviderAccount(event.data.data);
      }
      // Update cached chainId when the network changes or the wallet unlocks
      if ((eventType === 'networkChanged' || eventType === 'unlocked') && event.data.data && providerInstance) {
        providerInstance.chainId = event.data.data.chainId || null;
      }
      // Emit event to listeners
      emitEvent(eventType, event.data.data);
    }
  });

  /**
   * Emit event to all listeners
   */
  function emitEvent(eventType, data) {
    const listeners = eventListeners.get(eventType) || [];
    listeners.forEach(callback => {
      try {
        callback(data);
      } catch (err) {
        console.error('BitShares Wallet event listener error:', err);
      }
    });
  }

  /**
   * Update provider account from account change event
   */
  let providerInstance = null;
  function updateProviderAccount(accountData) {
    if (providerInstance && accountData) {
      providerInstance.account = {
        name: accountData.name,
        id: accountData.id
      };
    }
  }

  // Define Privateness.network enhanced provider
  class BitSharesProvider {
    constructor() {
      this.isConnected = false;
      this.account = null;
      this.chainId = null;
      // Privateness.network features with Emercoin touch
      this.privateness = {
        emercoinIdentity: {
          store: this.storeEmercoinIdentity.bind(this),
          retrieve: this.retrieveEmercoinIdentity.bind(this)
        }
      };
    }

    async connect(options = {}) {
      const result = await sendRequest('connect', options);
      this.isConnected = true;
      this.account = result.account;
      this.chainId = result.chainId;
      return result;
    }

    async checkConnection() {
      const result = await sendRequest('checkConnection');
      this.isConnected = result.connected;
      if (result.connected && result.account) {
        this.account = result.account;
        this.chainId = result.chainId;
      }
      return result;
    }

    async disconnect() {
      const result = await sendRequest('disconnect');
      this.isConnected = false;
      this.account = null;
      return result;
    }

    async getAccount() {
      return await sendRequest('getAccount');
    }

    async getChainId() {
      return await sendRequest('getChainId');
    }

    async signTransaction(transaction) {
      return await sendRequest('signTransaction', { transaction });
    }

    async transfer(params) {
      return await sendRequest('transfer', params);
    }

    // Privateness.network Emercoin Identity Methods
    async storeEmercoinIdentity(identityData) {
      return await sendRequest('storeEmercoinIdentity', { identityData });
    }

    async retrieveEmercoinIdentity(accountId) {
      return await sendRequest('retrieveEmercoinIdentity', { accountId });
    }

    on(eventType, callback) {
      if (!eventListeners.has(eventType)) {
        eventListeners.set(eventType, []);
      }
      eventListeners.get(eventType).push(callback);
    }

    off(eventType, callback) {
      if (eventListeners.has(eventType)) {
        const listeners = eventListeners.get(eventType);
        const index = listeners.indexOf(callback);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
        if (listeners.length === 0) {
          eventListeners.delete(eventType);
        }
      }
    }

    removeAllListeners(eventType) {
      if (eventListeners.has(eventType)) {
        eventListeners.delete(eventType);
      }
    }
  }

  // Create provider instance
  providerInstance = new BitSharesProvider();
  window.bitsharesWallet = providerInstance;

  // Also define window.beet and window.scatter for compatibility
  if (!window.beet) {
    window.beet = {
      requestIdentity: async () => {
        const result = await providerInstance.connect();
        return {
          accounts: [{ name: result.account.name, authority: 'active' }]
        };
      },
      requestSignature: async (payload) => {
        return await providerInstance.signTransaction(payload.transaction);
      },
      forgetIdentity: async () => {
        return await providerInstance.disconnect();
      }
    };
  }

  if (!window.scatter) {
    window.scatter = {
      connect: async () => {
        return await providerInstance.connect();
      },
      disconnect: async () => {
        return await providerInstance.disconnect();
      },
      getIdentity: async () => {
        const result = await providerInstance.connect();
        return {
          accounts: [{ name: result.account.name, authority: 'active' }]
        };
      },
      forgetIdentity: async () => {
        return await providerInstance.disconnect();
      },
      requestSignature: async (payload) => {
        return await providerInstance.signTransaction(payload.transaction);
      }
    };
  }

  // Dispatch event to notify page that wallet is available
  window.dispatchEvent(new CustomEvent('bitsharesWalletReady', {
    detail: { provider: window.bitsharesWallet }
  }));
})();
