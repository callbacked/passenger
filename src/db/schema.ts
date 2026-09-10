// Drizzle schema for Better Auth (core tables plus the device-authorization plugin).
// After changing it, run `npm run db:generate` and then `npm run db:migrate`.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const created = () => timestamp('created_at').default(sql`(unixepoch() * 1000)`).notNull();
const updated = () => timestamp('updated_at').default(sql`(unixepoch() * 1000)`).$onUpdate(() => new Date()).notNull();

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  createdAt: created(),
  updatedAt: updated(),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: created(),
  updatedAt: updated(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, table => [index('session_user_id_idx').on(table.userId)]);

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: created(),
  updatedAt: updated(),
}, table => [index('account_user_id_idx').on(table.userId)]);

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, table => [index('verification_identifier_idx').on(table.identifier)]);

export const deviceCode = sqliteTable('device_code', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull().unique(),
  userCode: text('user_code').notNull().unique(),
  userId: text('user_id'),
  expiresAt: timestamp('expires_at').notNull(),
  status: text('status').notNull(),
  lastPolledAt: timestamp('last_polled_at'),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
});
