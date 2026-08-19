import { ImoAuthLeaseRevokedError } from "./types.ts";
import type {
  ImoAuthLease,
  ImoAuthLeaseCacheMetadata,
  ImoAuthLeaseView,
  ImoAuthSecret,
} from "./types.ts";

export interface AuthLeaseRevocationCell {
  revoked: boolean;
}

export interface AuthCacheEntry {
  readonly key: string;
  readonly profile: string | null;
  readonly env: string | null;
  readonly secret: ImoAuthSecret;
  readonly view: ImoAuthLeaseView;
  readonly createdAt: string;
  readonly cell: AuthLeaseRevocationCell;
}

export class AuthLease implements ImoAuthLease {
  readonly view: ImoAuthLeaseView;
  readonly cache: ImoAuthLeaseCacheMetadata;
  #secret: ImoAuthSecret;
  #cell: AuthLeaseRevocationCell;

  constructor(entry: AuthCacheEntry, reused: boolean) {
    this.view = Object.freeze({ ...entry.view });
    this.cache = Object.freeze({ storage: "memory", createdAt: entry.createdAt, reused });
    this.#secret = entry.secret;
    this.#cell = entry.cell;
  }

  async use<T>(callback: (secret: ImoAuthSecret) => Promise<T> | T): Promise<T> {
    if (this.#cell.revoked) throw new ImoAuthLeaseRevokedError();
    return callback(this.#secret);
  }
}
