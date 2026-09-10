import { defineConfig } from 'drizzle-kit';

// Migrations land in ./migrations, which wrangler applies to the passenger-auth D1 database.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
});
