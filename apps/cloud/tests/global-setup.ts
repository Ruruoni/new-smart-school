import { execFileSync } from "node:child_process";
export default function setup() {
  const url = process.env.CLOUD_TEST_DATABASE_URL ?? "postgresql://smartschool:smartschool@localhost:5433/smartschool_cloud_test";
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { env: { ...process.env, CLOUD_DATABASE_URL: url }, stdio: "pipe" });
}
