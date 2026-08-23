import { randomInt, timingSafeEqual } from 'node:crypto';
import { TrustedClientsError, TrustedClientsStore } from './trusted-clients.js';

const DEFAULT_OTP_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const OTP_LENGTH = 6;

type PairingOptions = {
  enabled: boolean;
  otpTtlMs?: number;
  maxAttempts?: number;
  trustStore: TrustedClientsStore;
  now?: () => number;
  printOtp?: (otp: string) => void;
};

export class PairingError extends Error {
  readonly code: 'pairing_required' | 'pairing_invalid' | 'pairing_unavailable' | 'pairing_not_allowed';

  constructor(code: PairingError['code']) {
    super('gateway pairing rejected the request');
    this.name = 'PairingError';
    this.code = code;
  }
}

export class GatewayPairing {
  readonly #enabled: boolean;
  readonly #ttlMs: number;
  readonly #maxAttempts: number;
  readonly #trustStore: TrustedClientsStore;
  readonly #now: () => number;
  readonly #printOtp: (otp: string) => void;
  #otp?: { value: string; expiresAt: number; attemptsRemaining: number };
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: PairingOptions) {
    this.#enabled = options.enabled;
    this.#ttlMs = positive(options.otpTtlMs ?? DEFAULT_OTP_TTL_MS, 'otpTtlMs');
    this.#maxAttempts = positive(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
    this.#trustStore = options.trustStore;
    this.#now = options.now ?? Date.now;
    this.#printOtp = options.printOtp ?? ((otp) => console.log(`PAIRING OTP: ${otp}`));
    if (this.#enabled && this.#trustStore.size === 0) this.#issueOtp();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  async register(publicKeyPem: string, otp: string): Promise<{ paired: true; kid: string; fingerprint: string }> {
    return this.#serialize(async () => {
      if (!this.#enabled) throw new PairingError('pairing_unavailable');
      if (this.#trustStore.size > 0) throw new PairingError('pairing_not_allowed');
      const current = this.#otp;
      if (!current || current.expiresAt <= this.#now()) {
        this.#otp = undefined;
        throw new PairingError('pairing_required');
      }
      if (!constantTimeOtpEqual(current.value, otp)) {
        current.attemptsRemaining -= 1;
        if (current.attemptsRemaining <= 0) {
          this.#otp = undefined;
          this.#issueOtp();
        }
        throw new PairingError('pairing_invalid');
      }
      let trusted;
      try {
        trusted = TrustedClientsStore.normalizePublicKey(publicKeyPem);
      } catch {
        throw new PairingError('pairing_invalid');
      }
      this.#otp = undefined;
      try {
        const saved = this.#trustStore.add(trusted.publicKeyPem);
        return { paired: true, kid: saved.kid, fingerprint: saved.fingerprint };
      } catch (error) {
        if (error instanceof TrustedClientsError) throw new PairingError('pairing_unavailable');
        throw error;
      }
    });
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #issueOtp(): void {
    const otp = randomInt(0, 1_000_000).toString().padStart(OTP_LENGTH, '0');
    this.#otp = { value: otp, expiresAt: this.#now() + this.#ttlMs, attemptsRemaining: this.#maxAttempts };
    this.#printOtp(otp);
  }
}

function constantTimeOtpEqual(expected: string, supplied: string): boolean {
  if (typeof supplied !== 'string' || !/^\d{6}$/.test(supplied)) {
    const safe = Buffer.alloc(OTP_LENGTH, 0);
    timingSafeEqual(Buffer.from(expected, 'utf8'), safe);
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(supplied, 'utf8'));
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
