export class PublicationLeaseLostError extends Error {
  constructor(publicationId, ownerId, cause = null) {
    super(`Publication lease lost for publication ${publicationId}`);
    this.name = 'PublicationLeaseLostError';
    this.code = 'PUBLICATION_LEASE_LOST';
    this.publicationId = publicationId;
    this.ownerId = ownerId;
    this.cause = cause || undefined;
  }
}

export class PublicationLeaseGuard {
  constructor({ repository, publicationId, ownerId, leaseMs, signal = null, logger = null }) {
    this.repository = repository;
    this.publicationId = publicationId;
    this.ownerId = ownerId;
    this.leaseMs = Math.max(1, Number(leaseMs) || 900_000);
    this.logger = logger;
    this.controller = new AbortController();
    this.timer = null;
    this.inFlight = null;
    this.lostError = null;
    this.externalSignal = signal;
    this.externalAbort = () => this.controller.abort(signal.reason);
    if (signal) {
      signal.addEventListener('abort', this.externalAbort, { once: true });
      if (signal.aborted) this.externalAbort();
    }
  }

  get signal() {
    return this.controller.signal;
  }

  start() {
    if (typeof this.repository.renewPublicationLease !== 'function' || this.timer) return this;
    const intervalMs = Math.max(1000, Math.floor(this.leaseMs / 3));
    this.timer = setInterval(() => this.heartbeat(), intervalMs);
    this.timer.unref?.();
    return this;
  }

  async heartbeat() {
    if (this.inFlight || this.lostError || this.controller.signal.aborted) return this.inFlight;
    this.inFlight = Promise.resolve()
      .then(() => this.repository.renewPublicationLease(this.publicationId, this.ownerId, this.leaseMs))
      .catch((error) => {
        this.markLost(error);
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  markLost(cause) {
    if (this.lostError) return;
    this.lostError = cause?.code === 'PUBLICATION_LEASE_LOST'
      ? cause
      : new PublicationLeaseLostError(this.publicationId, this.ownerId, cause);
    this.logger?.error?.('Publication lease lost; stopping worker side effects', {
      publicationId: this.publicationId,
      ownerId: this.ownerId,
      error: cause?.message || String(cause)
    });
    this.controller.abort(this.lostError);
  }

  assertActive() {
    if (this.lostError) throw this.lostError;
    if (this.externalSignal?.aborted) throw this.externalSignal.reason || new Error('Application shutting down');
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
    this.externalSignal?.removeEventListener('abort', this.externalAbort);
  }
}
