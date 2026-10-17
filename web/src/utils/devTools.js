/* Build-time switch for production: set VITE_SX_HIDE_DEV_TOOLS=true to hide
   the engine-probe and telemetry panels. Off by default, so dev and tests
   see the panels unchanged. Read per call so tests can stub the env. */
export function hideDevTools() {
  return import.meta.env.VITE_SX_HIDE_DEV_TOOLS === 'true';
}
