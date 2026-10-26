import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import { APP_SETTINGS_KEY, SETTINGS_MIGRATIONS_KEY } from "./keys";
import type { AppSettings, KeyValueStorage, PersistedAppSettings } from "./storage";

const AppliedMigrationsSchema = z.strictObject({ applied: z.array(z.string()) });

/** Existing mobile installs materialized the old 15px content default in storage. */
const MOBILE_CONTENT_16_MIGRATION = "mobile-content-16";

/**
 * Brings stored settings up to date, returning what the caller should use. Owns both writes so
 * the marker can only ever be written after the settings it describes: a failed marker write
 * leaves the migration to re-run harmlessly, while a failed settings write must leave the marker
 * unwritten or the migration is lost for good.
 */
export async function migrateAppSettings(
  settings: AppSettings,
  storage: KeyValueStorage,
  stored?: PersistedAppSettings,
  options: { native?: boolean } = {},
): Promise<AppSettings> {
  const migrationMarker = await readValidatedJson(
    storage,
    SETTINGS_MIGRATIONS_KEY,
    AppliedMigrationsSchema,
  );
  const applied = new Set(migrationMarker?.applied ?? []);
  let addedMigration = false;

  let migrated = settings;
  if (options.native && !applied.has(MOBILE_CONTENT_16_MIGRATION)) {
    migrated = migrated.contentFontSize === 15 ? { ...migrated, contentFontSize: 16 } : migrated;
    applied.add(MOBILE_CONTENT_16_MIGRATION);
    addedMigration = true;
  }

  if (!addedMigration) {
    return settings;
  }

  if (migrated !== settings) {
    const storedSidebarRowItems = stored?.sidebarRowItems ?? {};
    await storage.setItem(
      APP_SETTINGS_KEY,
      JSON.stringify({
        ...stored,
        ...migrated,
        sidebarRowItems: { ...storedSidebarRowItems, ...migrated.sidebarRowItems },
      }),
    );
  }

  await storage.setItem(SETTINGS_MIGRATIONS_KEY, JSON.stringify({ applied: [...applied] }));
  return migrated;
}
