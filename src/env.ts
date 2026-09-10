// Bindings come from wrangler.toml (see `wrangler types`); secrets and vars are set per deployment.
export interface Env {
  ASSETS: Fetcher;
  APP_DATA: KVNamespace;
  DB?: D1Database;
  MEDIA_SIGNING_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_DEV_PASSWORD?: string;
}
