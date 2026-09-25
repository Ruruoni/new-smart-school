import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.CLOUD_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://smartschool:smartschool@localhost:5433/smartschool_cloud" },
});
