/** Shared overview route prefix (single definition; no import cycles). */
export const OVERVIEW_PATH = "/api/icomposer-workbench/insuremo/overview" as const;
/** Read-only, cache-only Skills source catalog projection. */
export const SKILL_CATALOG_PATH = `${OVERVIEW_PATH}/skill-catalog` as const;
