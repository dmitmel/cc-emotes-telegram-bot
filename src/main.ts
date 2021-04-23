import { Telegraf, Context as TelegrafContext } from 'telegraf';
import type * as tt from 'telegraf/src/core/types/typegram';
import * as https from 'https';
import fetch from 'node-fetch';
import * as utils from './utils';
import * as telegramUtils from './utils/telegram';
import * as database from './database';

const config = require('../config.json');
const registry = require('../emote-registry.json');

let agent = new https.Agent({ keepAlive: true });
let db = new database.Database();

interface EmoteRegistry {
  version: 1;
  list: EmoteRegistryEntry[];
}

interface EmoteRegistryEntry {
  ref: string;
  id: string;
  name: string;
  requires_colons: boolean;
  animated: boolean;
  url: string;
  safe: boolean;
  guild_id: string;
  guild_name: string;
}

if (registry.version !== 1) {
  throw new Error('unsupported emote registry version!!!ъ');
}
let registryV1: EmoteRegistry = registry;

const bot = new Telegraf(config.token);

const INLINE_QUERY_PAGE_NUMBER_BASE = 36; // maximum available
const INLINE_QUERY_PAGE_SIZE = 50;

// bot.use(
//   (ctx: TelegrafContext, next: () => Promise<void>): Promise<void> => {
//     if (ctx.from?.id === config.ownerUserId) {
//       return next();
//     } else {
//       return Promise.resolve();
//     }
//   },
// );

bot.on(
  'inline_query',
  async (ctx: TelegrafContext, next: () => Promise<void>): Promise<void> => {
    let inlineQuery = ctx.inlineQuery!;
    let page = parseInt(inlineQuery.offset, INLINE_QUERY_PAGE_NUMBER_BASE);
    if (Number.isNaN(page)) page = 0;
    let offset = page * INLINE_QUERY_PAGE_SIZE;
    let limit = INLINE_QUERY_PAGE_SIZE;

    let matchedEmotes: Array<{ emote: EmoteRegistryEntry; fileId: string }> = [];
    let queryRegex = new RegExp(utils.escapeRegExp(inlineQuery.query), 'i');
    let matchCounter = 0;
    for (let emote of registryV1.list) {
      if (matchedEmotes.length >= limit) break;
      if (!emote.safe) continue;
      if (!(queryRegex.test(emote.name) || queryRegex.test(emote.guild_name))) continue;
      let fileId = await db.getOptional(`emote_uploaded_file_id:${emote.id}`);
      if (fileId == null) continue;
      if (matchCounter >= offset) {
        matchedEmotes.push({ emote, fileId: fileId.toString() });
      }
      matchCounter++;
    }

    let queryDebugStr = JSON.stringify(inlineQuery.query);
    console.log(
      `search:${queryDebugStr} offset:${offset} limit:${limit} results:${matchedEmotes.length}`,
    );

    let results: tt.InlineQueryResult[] = matchedEmotes.map(({ emote, fileId }) => {
      let id = `emote:${emote.id}`;
      let caption = emote.name;
      if (emote.animated) {
        let result: tt.InlineQueryResultCachedGif = {
          type: 'gif',
          id,
          title: caption,
          caption,
          gif_file_id: fileId,
        };
        return result;
      } else {
        let result: tt.InlineQueryResultCachedPhoto = {
          type: 'photo',
          id,
          title: caption,
          caption,
          photo_file_id: fileId,
        };
        return result;
      }
    });

    await ctx.answerInlineQuery(results, {
      cache_time: 0,
      is_personal: false,
      next_offset: (page + 1).toString(INLINE_QUERY_PAGE_NUMBER_BASE),
    });
    return next();
  },
);

async function main(): Promise<void> {
  await bot.launch();

  for (let emote of registryV1.list) {
    if (!emote.safe) continue;

    if (!(await db.has(`emote_uploaded_file_id:${emote.id}`))) {
      console.log('downloading', emote.ref);

      let response = await fetch(emote.url, { agent });
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }
      let downloadedImageData = await response.buffer();

      console.log('uploading', emote.ref);
      let sendChatId = config.cdnChatId;
      let sendInputFile: tt.InputFile = { source: downloadedImageData };
      let sendExtra = { caption: emote.id };
      let fileId: string;
      if (emote.animated) {
        let msg: tt.Message.AnimationMessage = await telegramUtils.retryAfterRatelimit(() => {
          return bot.telegram.sendAnimation(sendChatId, sendInputFile, sendExtra);
        });
        fileId = msg.animation.file_id;
      } else {
        let msg: tt.Message.PhotoMessage = await telegramUtils.retryAfterRatelimit(() => {
          return bot.telegram.sendPhoto(sendChatId, sendInputFile, sendExtra);
        });
        fileId = msg.photo[0].file_id;
      }

      console.log('saving');
      await db.set(`emote_uploaded_file_id:${emote.id}`, fileId);
    }
  }
  console.log('done uploading emotes');
}

main();
