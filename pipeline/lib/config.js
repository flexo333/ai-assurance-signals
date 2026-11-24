// Shared pipeline constants.

/** The archive starts here: the collector's default window and the first backfilled edition. */
export const ARCHIVE_START = "2026-07-01";

/** Weekly edition cutoff: Fridays 04:17 UTC (15:17 AEDT / 14:17 AEST), matching publish.yml's cron. */
export const CUTOFF_UTC = { weekday: 5, hour: 4, minute: 17 };
