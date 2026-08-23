import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type TrustedClient = {
  publicKeyPem: string;
  pairedAt: string;
  fingerprint: string;
};

export type TrustedClientsFile = {
  version: 1;
  clients: Record<string, TrustedClient>;
};

export type TrustedPublicKey = {
  kid: string;
  publicKeyPem: string;
  fingerprint: string;
};

export class TrustedClientsError extends Error {
  constructor(message = 'trusted client store is unavailable') {
    super(message);
    this.name = 'TrustedClientsError';
  }
}

export class TrustedClientsStore {
  readonly #filePath: string;
  #file: TrustedClientsFile;

  constructor(filePath: string) {
    if (!path.isAbsolute(filePath) || filePath.includes('\u0000')) throw new TrustedClientsError();
    this.#filePath = filePath;
    this.#file = this.#load();
  }

  get filePath(): string {
    return this.#filePath;
  }

  get size(): number {
    return Object.keys(this.#file.clients).length;
  }

  entries(): ReadonlyArray<TrustedPublicKey> {
    return Object.entries(this.#file.clients).map(([kid, client]) => ({
      kid,
      publicKeyPem: client.publicKeyPem,
      fingerprint: client.fingerprint,
    }));
  }

  add(publicKeyPem: string): TrustedPublicKey {
    const normalized = normalizePublicKey(publicKeyPem);
    const client: TrustedClient = {
      publicKeyPem: normalized.publicKeyPem,
      pairedAt: new Date().toISOString(),
      fingerprint: normalized.fingerprint,
    };
    const next: TrustedClientsFile = {
      version: 1,
      clients: { ...this.#file.clients, [normalized.fingerprint]: client },
    };
    this.#write(next);
    this.#file = next;
    return { kid: normalized.fingerprint, ...normalized };
  }

  static normalizePublicKey(publicKeyPem: string): TrustedPublicKey {
    const normalized = normalizePublicKey(publicKeyPem);
    return { kid: normalized.fingerprint, ...normalized };
  }

  #load(): TrustedClientsFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, clients: {} };
      throw new TrustedClientsError();
    }
    if (!isTrustedClientsFile(parsed)) throw new TrustedClientsError();
    return parsed;
  }

  #write(file: TrustedClientsFile): void {
    const directory = path.dirname(this.#filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      throw new TrustedClientsError();
    }
    const tempPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let renamed = false;
    try {
      fd = fs.openSync(tempPath, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify(file, null, 2), { encoding: 'utf8' });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, this.#filePath);
      renamed = true;
      fs.chmodSync(this.#filePath, 0o600);
      const directoryFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      throw new TrustedClientsError();
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve the original store failure.
        }
      }
      if (!renamed) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Best effort; no secret is exposed through the error surface.
        }
      }
    }
  }
}

function normalizePublicKey(publicKeyPem: string): Omit<TrustedPublicKey, 'kid'> {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0 || publicKeyPem.length > 16_384)
    throw new TrustedClientsError('public key is invalid');
  if (/PRIVATE KEY/i.test(publicKeyPem)) throw new TrustedClientsError('public key is invalid');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(publicKeyPem);
  } catch {
    throw new TrustedClientsError('public key is invalid');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new TrustedClientsError('public key is invalid');
  const der = key.export({ type: 'spki', format: 'der' });
  const normalized = key.export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicKeyPem: normalized,
    fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
  };
}

function isTrustedClientsFile(value: unknown): value is TrustedClientsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.clients || typeof candidate.clients !== 'object') return false;
  return Object.entries(candidate.clients as Record<string, unknown>).every(([kid, client]) => {
    if (!/^[a-f0-9]{64}$/.test(kid) || !client || typeof client !== 'object' || Array.isArray(client)) return false;
    const record = client as Record<string, unknown>;
    return (
      typeof record.publicKeyPem === 'string' &&
      record.publicKeyPem.length > 0 &&
      record.publicKeyPem.length <= 16_384 &&
      typeof record.pairedAt === 'string' &&
      typeof record.fingerprint === 'string' &&
      record.fingerprint === kid
    );
  });
}
