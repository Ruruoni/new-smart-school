import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Applies every migration to the throwaway test databases (school + cloud) once per run. */
export default function setup() {
  const school = process.env.TEST_DATABASE_URL ?? "postgresql://smartschool:smartschool@localhost:5433/smartschool_school_test";
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: school }, stdio: "pipe" });
  const cloud = process.env.CLOUD_TEST_DATABASE_URL ?? "postgresql://smartschool:smartschool@localhost:5433/smartschool_cloud_test";
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd: resolve("../cloud"), env: { ...process.env, CLOUD_DATABASE_URL: cloud }, stdio: "pipe" });
}
