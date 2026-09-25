-- Report kinds are defined by the code-side report registry, so the column becomes plain TEXT.
-- Data-preserving: existing enum values cast to their text form (no DROP COLUMN).
ALTER TABLE "report_exports" ALTER COLUMN "kind" TYPE TEXT USING "kind"::text;

DROP TYPE "ReportKind";
