# Latency probes, 2026-11-10

These probes ran after the move to the named tunnel on `echomultiverse.com` and to the edge-cached `media.echomultiverse.com` media domain. They are compared with the quick-tunnel baseline in `docs/performance-latency-profile-2026-10-29.md`, section 1.

## Files

- `probe.py`: the curl probe. Each target gets 12 cold requests, each on a new connection, then 15 warm requests on one connection, with the first warm request dropped. Usage: `python3 probe.py <label> [host]`.
- `raw/<label>.json`: full results. Only Tokyo, London and home-tw finished, so only they have a JSON file.
- `raw/<label>.log`: per-target lines printed while the probe ran. The logs also cover the runs that stopped early.
- `quest/quest_probe.mjs`, `quest/warm.json`: a warm `fetch` probe run inside the Quest browser over CDP.
- `quest/quest_cold.mjs`, `quest/cold.json`, `quest/cold.log`: a fresh-connection probe on the Quest. Before each request it clears the DNS cache and flushes the socket pools in `chrome://net-internals`, then navigates to the URL and reads Navigation Timing. The JSON holds medians of 7 runs.

## Method

The tables show **edge+origin**: warm TTFB p50 minus TCP connect p50. This removes the access-network leg, so runs from different networks can be compared. All values are milliseconds.

The two networks differ a lot:

- Baseline: home network in Vietnam, TCP to the HKG edge 28 ms.
- Now: a network in Taiwan. Its own delay is about 100 ms (TCP to the edge about 102 ms; ping to 1.1.1.1 ranged from 102 to 394 ms).

## Runs

| Label | When | Network | Colo | Result |
|---|---|---|---|---|
| tokyo, sydney, seattle, new-york, london, frankfurt | 00:33–02:09 | Surfshark VPN on the first network | Tokyo and London went through SJC and LHR | Only Tokyo and London finished. The 1 MB mp4 request timed out in Seattle, New York and Frankfurt (VPN throughput about 91 KB/s). The Sydney run stopped before the mp4 target. |
| home-tw | 11:01 | Taiwan network, no VPN. Surfshark failed to connect on this network. | SJC | Complete. All responses were 200 or 206. |
| Quest warm | 11:35 | Quest 3S, OculusBrowser 154, same Taiwan network | TPE, h3 | Complete. The trace RTT to the edge was 103 ms. |
| Quest cold | 12:07 | Same as Quest warm | TPE, h2 on fresh connections | No timing for the mp4: a media document records no Navigation Timing. |

## Edge+origin compared with the baseline

Each cell is baseline (2026-10-29) → now (2026-11-10).

| Location | healthz | feed | reels | player | poster |
|---|---|---|---|---|---|
| Home: Vietnam HKG → Taiwan SJC (Mac) | 178 → 179 | 302 → 263 | 404 → 349 | 453 → 359 | 106 → 7 |
| Home: Vietnam HKG → Taiwan TPE (Quest)¹ | 178 → 199 | 302 → 284 | 404 → 281 | 453 → 316 | n/a |
| Tokyo (now via SJC) | 224 → 307 | 319 → 300 | 402 → 516 | 453 → 471 | 150 → 135 |
| Sydney | 173 → 164 | 266 → 260 | 357 → 312 | 428 → 314 | 137 → 13 |
| Seattle | 50 → 76 | 159 → 169 | 255 → 452 | 301 → 259 | 176 → 41 |
| New York | 105 → 106 | 200 → 186 | 360 → 233 | 383 → 212 | 212 → 16 |
| London | 176 → 214 | 311 → 275 | 368 → 384 | 715 → 352 | 320 → 58 |
| Frankfurt | 212 → 198 | 314 → 302 | 402 → 348 | 743 → 333 | 562 → 80 |

¹ For the Quest, edge+origin is warm TTFB minus the warm `/cdn-cgi/trace` RTT (103 ms). Resource timing for the poster is hidden because `media.` sends no `Timing-Allow-Origin` header.

Other numbers from now:

- **SPA JS:** edge+origin was 11 ms on the Quest (TPE). That points to an edge cache hit. From the Mac (SJC) it was 168 ms, which looks like a miss.
- **1 MB mp4 from home-tw:** warm total 472 ms, cold total 2603 ms.
- **1 MB mp4 on the Quest:** warm total 456 ms, first request 1243 ms.

## Quest fresh connections (medians of 7)

| Target | DNS | Connect incl. TLS | Request → first byte | TTFB from start | Total |
|---|---|---|---|---|---|
| healthz | 161 | 403 | 326 | 1296 | 1297 |
| feed | 97 | 244 | 549 | 1083 | 1225 |
| player | 101 | 230 | 431 | 785 | 1586 |
| spa_index | 114 | 225 | 268 | 711 | 712 |
| poster | 91 | 268 | 148 | 511 | 817 |

There were outliers from the access network: two DNS lookups took 1114 ms and 2123 ms, and one TLS handshake took 11 s.

## Takeaways

1. **Edge-cached media is the big win.** Poster edge+origin fell from 106–562 ms to 7–80 ms. The exception is Tokyo, at 135 ms, because the VPN routed it through SJC. Europe gains the most.
2. **The named tunnel did not change API latency.** healthz from Asia is still about 180–200 ms, which is the trip to Oregon.
3. **The API is now the slowest part.** feed, reels and player cost 260–360 ms edge+origin, so they spend about 80–180 ms in the server on top of the trip. The player is faster than in the baseline because of the reels list fixes (baseline doc, section 7). The next levers are edge-caching the feed, an APAC origin, and fewer requests that wait on each other.
4. **On a fresh connection, setup costs as much as the server.** DNS plus connect plus TLS takes about 330–400 ms, and fresh connections start on h2. A `preconnect` to `media.echomultiverse.com` and connection reuse between reels would help.
5. **The VPN distorts results.** It caps throughput, which caused the mp4 timeouts, and it can route oddly. Compare only edge+origin across VPN runs.
6. **Open question:** healthz through SJC takes 179 ms, but Seattle took 50 ms in the baseline. A rerun from a US network would show whether the tunnel enters Cloudflare far from SJC, or whether the Taiwan network's own delay causes it.
