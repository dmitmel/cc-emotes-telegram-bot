import { Telegraf, Context as TelegrafContext } from 'telegraf';
import type * as tt from 'telegraf/src/core/types/typegram';
import * as https from 'https';
import fetch from 'node-fetch';
import * as utils from './utils';
import * as telegramUtils from './utils/telegram';
import * as databaseM from './database';
import * as subprocess from 'child_process';

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

      const IMAGEMAGICK_FORMAT_MAPPING = new Map<string, string>([
        ['image/png', 'png'],
        ['image/gif', 'gif'],
      ]);

      console.log('processing', emote.ref);
      let imagemagickFormat = IMAGEMAGICK_FORMAT_MAPPING.get(cachedFileType);
      if (imagemagickFormat == null) {
        throw new Error(`Unknown emote file type: ${cachedFileType}`);
      }

      // Apparently calling out to an ImageMagick subprocess is a viable method
      // of image processing in JS.
      let program = 'convert';
      let args: string[] = [];
      // read from stdin
      args.push(`${imagemagickFormat}:-`);
      // replace the background with black color
      // <https://legacy.imagemagick.org/Usage/anim_mods/#remove_trans>
      args.push('-coalesce', '-background', 'black');
      // resize and fit into a 128x128 px square
      args.push('-gravity', 'Center', '-resize', '128x128', '-extent', '128x128');
      // add a 16px black border
      args.push('-bordercolor', 'black', '-border', '16');
      // <https://legacy.imagemagick.org/Usage/anim_basics/#types>
      // <https://legacy.imagemagick.org/Usage/anim_basics/#overlay>
      // <https://legacy.imagemagick.org/Usage/anim_opt/>
      args.push('-layers', 'Optimize');
      // write to stdout
      args.push(`${imagemagickFormat}:-`);

      // Again, the stupid insanely-hard-to-use stream APIs... I hope I did
      // everything correctly here. Also, spawnSync can't be used for
      // simplification because it is limited by a fixed buffer size, and if
      // the size of subprocess'es output exceeds this buffer size, the whole
      // operation fails with an exception. On the other hand, the async
      // variant of spawn allows for unbounded input and output.
      let processedImage: Buffer = await new Promise((resolve, reject) => {
        let proc = subprocess.spawn(program, args, {
          stdio: [/* stdin */ 'pipe', /* stdout */ 'pipe', /* stderr */ 'inherit'],
        });
        proc.on('error', (err: Error) => {
          reject(err);
        });
        let chunks: Buffer[] = [];
        proc.stdout.on('data', (data: Buffer) => {
          chunks.push(data);
        });
        proc.stdout.on('error', (err: Error) => {
          reject(err);
        });
        proc.on('close', (code: number | null) => {
          if (code !== 0) {
            reject(new Error(`Command failed with a non-zero exit code: ${code}`));
          } else {
            resolve(Buffer.concat(chunks));
          }
        });
        proc.stdin.end(cachedData);
      });

      console.log('uploading', emote.ref);
      let sendChatId = config.cdnChatId;
      let sendInputFile: tt.InputFile = { source: processedImage };
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
