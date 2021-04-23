import { Telegraf, Context as TelegrafContext } from 'telegraf';
import type * as tt from 'telegraf/src/core/types/typegram';
import * as https from 'https';
import fetch from 'node-fetch';
import { PNG } from 'pngjs';
import * as utils from './utils';
import * as telegramUtils from './utils/telegram';
import * as databaseM from './database';

const config = require('../config.json');
const registry = require('../emote-registry.json');

let agent = new https.Agent({ keepAlive: true });
let db = new databaseM.Database();

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
      let fileId = await db.getOptional(`emote_uploaded_file_id:${emote.id}`, { asBuffer: false });
      if (fileId == null) continue;
      fileId = databaseM.ensureString(fileId);
      if (matchCounter >= offset) {
        matchedEmotes.push({ emote, fileId: fileId });
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

      let cachedData = await db.getOptional(`download:${emote.url}:data`, { asBuffer: true });
      let cachedFileType = await db.getOptional(`download:${emote.url}:file_type`, {
        asBuffer: false,
      });
      if (cachedData != null && cachedFileType != null) {
        cachedData = databaseM.ensureBuffer(cachedData);
        cachedFileType = databaseM.ensureString(cachedFileType);
      } else {
        let response = await fetch(emote.url, { agent });
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }
        cachedData = await response.buffer();
        cachedFileType = response.headers.get('content-type') ?? 'application/octet-stream';
        await db.set(`download:${emote.url}:data`, cachedData);
        await db.set(`download:${emote.url}:file_type`, cachedFileType);
      }

      console.log('transforming', emote.ref);
      let transformedImage = cachedData;
      switch (cachedFileType) {
        case 'image/png': {
          let pngImage = PNG.sync.read(transformedImage);
          let sw = pngImage.width;
          let sh = pngImage.height;
          let spixels = pngImage.data;

          // premultiply alpha
          for (let i = 0, len = sw * sh * 4; i < len; i += 4) {
            let a = spixels[i + 3];
            spixels[i + 0] = (spixels[i + 0] * a) / 0xff;
            spixels[i + 1] = (spixels[i + 1] * a) / 0xff;
            spixels[i + 2] = (spixels[i + 2] * a) / 0xff;
            spixels[i + 3] = 0xff;
          }

          let dstSize = 128;
          let dstBorder = 16;
          let srcSize = 0;
          let srcOffX = 0;
          let srcOffY = 0;
          if (sw >= sh) {
            srcSize = sw;
            srcOffY += Math.floor((sw - sh) / 2);
          } else {
            srcSize = sh;
            srcOffX += Math.floor((sh - sw) / 2);
          }

          // JS shaders basically
          let pngImage2 = new PNG({
            width: dstSize + dstBorder * 2,
            height: dstSize + dstBorder * 2,
          });
          let dw = pngImage2.width;
          let dh = pngImage2.height;
          let pixels2 = pngImage2.data;
          for (let dy = 0; dy < dh; dy++) {
            for (let dx = 0; dx < dw; dx++) {
              let di = (dx + dy * dw) * 4;
              let sx = Math.floor(((dx - dstBorder) * srcSize) / dstSize) - srcOffX;
              let sy = Math.floor(((dy - dstBorder) * srcSize) / dstSize) - srcOffY;
              if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) {
                let si = (sx + sy * sw) * 4;
                pixels2[di + 0] = spixels[si + 0];
                pixels2[di + 1] = spixels[si + 1];
                pixels2[di + 2] = spixels[si + 2];
                pixels2[di + 3] = spixels[si + 3];
              } else {
                pixels2[di + 0] = 0x00;
                pixels2[di + 1] = 0x00;
                pixels2[di + 2] = 0x00;
                pixels2[di + 3] = 0xff;
              }
            }
          }

          transformedImage = PNG.sync.write(pngImage2);
          break;
        }

        case 'image/gif': {
          // TODO
          // <https://github.com/pkrumins/node-gif>
          // <https://github.com/benwiley4000/gif-frames>
          break;
        }

        default: {
          throw new Error(`Unknown emote file type: ${cachedFileType}`);
        }
      }

      console.log('uploading', emote.ref);
      let sendChatId = config.cdnChatId;
      let sendInputFile: tt.InputFile = { source: transformedImage };
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

      console.log('saving', emote.ref);
      await db.set(`emote_uploaded_file_id:${emote.id}`, fileId);
    }
  }
  console.log('done uploading emotes');
}

main();
