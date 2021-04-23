import { Telegraf, Context as TelegrafContext } from 'telegraf';
import type * as tt from 'telegraf/src/core/types/typegram';

const config = require('../config.json');
const registry = require('../emote-registry.json');

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

// <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping>
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

bot.on(
  'inline_query',
  async (ctx: TelegrafContext, next: () => Promise<void>): Promise<void> => {
    let inlineQuery = ctx.inlineQuery!;
    let page = parseInt(inlineQuery.offset, INLINE_QUERY_PAGE_NUMBER_BASE);
    if (Number.isNaN(page)) page = 0;
    let offset = page * INLINE_QUERY_PAGE_SIZE;
    let limit = INLINE_QUERY_PAGE_SIZE;

    let matchedEmotes: Array<EmoteRegistryEntry> = [];
    let queryRegex = new RegExp(escapeRegExp(inlineQuery.query), 'i');
    let matchCounter = 0;
    for (let emote of registryV1.list) {
      if (matchedEmotes.length >= limit) break;
      if (!emote.safe) continue;
      if (!(queryRegex.test(emote.name) || queryRegex.test(emote.guild_name))) continue;
      if (matchCounter >= offset) {
        matchedEmotes.push(emote);
      }
      matchCounter++;
    }

    let queryDebugStr = JSON.stringify(inlineQuery.query);
    console.log(
      `search:${queryDebugStr} offset:${offset} limit:${limit} results:${matchedEmotes.length}`,
    );

    let results: tt.InlineQueryResult[] = matchedEmotes.map((emote) => {
      let id = `emote:${emote.id}`;
      let caption = emote.name;
      if (emote.animated) {
        let result: tt.InlineQueryResultGif = {
          type: 'gif',
          id,
          title: caption,
          caption,
          gif_url: `https://cdn.discordapp.com/emojis/${emote.id}.gif?size=256`,
          gif_width: 256,
          gif_height: 256,
          thumb_url: `https://cdn.discordapp.com/emojis/${emote.id}.gif?size=256`,
          // thumb_width: 256,
          // thumb_height: 256,
        };
        return result;
      } else {
        let result: tt.InlineQueryResultPhoto = {
          type: 'photo',
          id,
          title: caption,
          caption,
          photo_url: `https://cdn.discordapp.com/emojis/${emote.id}.jpeg?size=256`,
          photo_width: 256,
          photo_height: 256,
          thumb_url: `https://cdn.discordapp.com/emojis/${emote.id}.jpeg?size=256`,
          // thumb_width: 256,
          // thumb_height: 256,
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

bot.launch();
