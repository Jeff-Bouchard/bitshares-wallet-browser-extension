/**
 * Deprecated legacy module.
 * Alternative network routing integration is no longer supported in Bitshares-NESS custodial wallet.
 */

export class SkywireNetwork {
  constructor() {
    this.isInitialized = false;
  }

  async initialize() {
    throw new Error('Legacy routing integration has been removed');
  }

  async routeTrafficThroughSkywire(_nodeUrl) {
    throw new Error('Legacy routing integration has been removed');
  }
}
