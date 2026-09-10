import { handleRequest, type Providers } from './app.ts';
import { resolveYouTube } from './providers/youtube.ts';
import { searchYouTube } from './providers/youtube-search.ts';
import { searchYouTubeShorts } from './providers/youtube-shorts.ts';
import { resolveTwitch, statusTwitch } from './providers/twitch.ts';
import type { Env } from './env.ts';

const providers: Providers = {
  youtube: { resolve: (input, options) => resolveYouTube(input, options), search: searchYouTube, shorts: searchYouTubeShorts },
  twitch: { resolve: input => resolveTwitch(input), status: statusTwitch },
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, { providers, waitUntil: task => ctx.waitUntil(task) });
  },
} satisfies ExportedHandler<Env>;
