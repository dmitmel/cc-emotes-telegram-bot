import * as pathlib from 'path';
import leveldown, {
  Bytes,
  LevelDownGetOptions,
  LevelDownPutOptions,
  LevelDownDelOptions,
} from 'leveldown';
import levelup from 'levelup';
const LevelupNotFoundError = (levelup.errors.NotFoundError as unknown) as typeof Error;

export class Database {
  private inner = levelup(leveldown(pathlib.resolve(__dirname, '..', 'data')));

  public async get(key: Bytes, options?: LevelDownGetOptions): Promise<Bytes> {
    return await this.inner.get(key, options);
  }

  public async getOptional(key: Bytes, options?: LevelDownGetOptions): Promise<Bytes | null> {
    try {
      return await this.inner.get(key, options);
    } catch (err) {
      if (err instanceof LevelupNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  public async has(key: Bytes, options?: LevelDownGetOptions): Promise<boolean> {
    try {
      await this.inner.get(key, options);
      return true;
    } catch (err) {
      if (err instanceof LevelupNotFoundError) {
        return false;
      }
      throw err;
    }
  }

  public async set(key: Bytes, value: Bytes, options?: LevelDownPutOptions): Promise<void> {
    return await this.inner.put(key, value, options);
  }

  public async delete(key: Bytes, options?: LevelDownDelOptions): Promise<void> {
    return await this.inner.del(key, options);
  }
}

export function ensureBuffer(bytes: Bytes): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

export function ensureString(bytes: Bytes): string {
  return Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
}
