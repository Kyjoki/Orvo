-- Existing Better Auth installations may have issued recovery codes.
-- This migration runs before Better Auth creates its tables on a fresh installation.
DO $$
BEGIN
  IF to_regclass('"twoFactor"') IS NOT NULL THEN
    EXECUTE $sql$UPDATE "twoFactor" SET "backupCodes" = '' WHERE "backupCodes" <> ''$sql$;
  END IF;
END $$;
