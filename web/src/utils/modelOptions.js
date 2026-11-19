// Video option lists for the upload pages, in display order, limited to the
// options the picked catalog entry from /api/config still prices. The server
// drops an option once fal stops accepting it (server/fal_schemas.py), so it
// disappears here without a deploy. New fal options are not added: they need
// a price on the server first.

function offered(order, table) {
  const kept = table ? order.filter((option) => option in table) : order;
  return kept.length ? kept : order;
}

export function videoOptions(outpaintEntry, upscaleEntry) {
  return {
    ltxRes: offered(['720p', '1080p', '480p'], outpaintEntry?.resolutions),
    btdRes: offered(['8k', '6k', '4k', '2k', '1080p'], upscaleEntry?.base_rates_usd),
    btdFps: offered(['30fps', '60fps'], upscaleEntry?.fps_multiplier),
    btdTier: offered(['fast', 'standard', 'pro'], upscaleEntry?.tier_multiplier),
    seedvrTarget: offered(['1080p', '2160p', '1440p', '720p'], upscaleEntry?.resolutions),
  };
}

// The picked option, or the first one offered once it is withdrawn.
export function offeredValue(value, options) {
  return options.includes(value) ? value : options[0];
}

// The highest resolution tier a catalog model prices (its rates run low to high).
export function topTier(catalog, model, fallback) {
  const tiers = Object.keys(catalog.find((entry) => entry.model === model)?.resolution_rates || {});
  return tiers.length ? tiers[tiers.length - 1] : fallback;
}
