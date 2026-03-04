/**
 * Deprecated legacy module.
 * Identity storage integration is no longer supported in Bitshares-NESS custodial wallet.
 */

export class EmercoinNVS {
  constructor() {
    this.isConnected = false;
  }

  async connect() {
    throw new Error('Legacy identity integration has been removed');
  }

  async storeIdentity(_accountId, _identityData) {
    throw new Error('Legacy identity integration has been removed');
  }

  async retrieveIdentity(_accountId) {
    throw new Error('Legacy identity integration has been removed');
  }
}
