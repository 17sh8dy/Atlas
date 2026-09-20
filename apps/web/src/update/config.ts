/**
 * Where Atlas looks for updates — the one place these live.
 *
 * The manifest is a small JSON file published with each GitHub release (see
 * `scripts/make-update-manifest.mjs`). `releases/latest/download/<file>` always
 * resolves to the newest release, so nothing here changes per version. To move
 * the manifest elsewhere, change this line and add the host to `ALLOWED_HOSTS`
 * in `updater.rs` — the native side refuses any host it was not built to trust.
 */
export const UPDATE_MANIFEST_URL =
  'https://github.com/17sh8dy/Atlas/releases/latest/download/latest.json';

/** The product id inside the manifest. */
export const UPDATE_PRODUCT = 'atlas';

/** The product name inside the installer's version resource. */
export const UPDATE_PRODUCT_NAME = 'Atlas';

/**
 * Refuse an installer that is not code-signed. Off until Atlas builds are
 * signed (roadmap, Phase 10); a signed-but-invalid installer is refused either
 * way. Flip this when signing is in place and unsigned builds stop updating.
 */
export const UPDATE_REQUIRE_SIGNATURE = false;

/** First automatic check after launch: long enough not to compete with startup. */
export const FIRST_CHECK_DELAY_MS = 20_000;

/** Then, while Atlas stays open. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Storage keys — lowercase, like every other key in the app. */
export const KEY_DISMISSED = 'atlas.update.dismissed';
export const KEY_AUTO_CHECK = 'atlas.update.autocheck';
