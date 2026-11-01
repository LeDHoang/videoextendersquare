/* Build-time switch for the engine-probe and telemetry panels. Production builds hide them unless
   VITE_SX_HIDE_DEV_TOOLS=false; dev and tests show them unless VITE_SX_HIDE_DEV_TOOLS=true.
   Read per call so tests can stub the env. */
export function hideDevTools() {
  const flag = import.meta.env.VITE_SX_HIDE_DEV_TOOLS;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return Boolean(import.meta.env.PROD);
}
