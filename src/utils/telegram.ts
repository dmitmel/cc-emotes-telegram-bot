import { TelegramError } from 'telegraf';
import * as utils from '../utils';

export async function retryAfterRatelimit<T>(
  callback: () => T | Promise<T>,
  defaultTimeout = 5,
): Promise<T> {
  while (true) {
    try {
      return await callback();
    } catch (err) {
      debugger;
      if (err instanceof TelegramError && err.code === 429) {
        await utils.wait((err.parameters?.retry_after ?? defaultTimeout) * 1000);
        continue;
      }
    }
  }
}
