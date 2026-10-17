// Prisma CLI configuration (Prisma 7). Database URLs live here, not in schema.prisma.
// The filename is what `prisma init` generated for Prisma 7; the CLI locates it automatically.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
