// ── Helpers ──────────────────────────────────────────────────────────────────

const OREF_HEADERS = {
  'Referer':          'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':           'application/json, text/plain, */*',
  'Accept-Language':  'he-IL,he;q=0.9,en;q=0.8',
};

const CORS_HEADERS = {
  'Content-Type':                 'application/json',
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const HISTORY_KEY    = 'events';
const HISTORY_MAX_MS = 12 * 60 * 60 * 1000; // 12 hours

// Long history (~10h): called by cron only
async function fetchLongHistory() {
  try {
    const res = await fetch(
      'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1',
      { headers: OREF_HEADERS, cf: { cacheEverything: false, cacheTtl: 0, country: 'IL' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Short history (~1h): called on endpoint requests to fill the gap since last cron
async function fetchShortHistory() {
  try {
    const res = await fetch(
      'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json',
      { headers: OREF_HEADERS, cf: { cacheEverything: false, cacheTtl: 0, country: 'IL' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Dedup key: always use alertDate|data so events from both APIs (with and without rid) match
function dedupKey(ev) {
  return `${(ev.alertDate || '').replace('T', ' ')}|${ev.data}`;
}

// Merge stored + fresh events: deduplicate, prune >12h, sort newest first
function mergeEvents(stored, fresh) {
  const cutoff = Date.now() - HISTORY_MAX_MS;
  const seen   = new Map();

  for (const ev of [...stored, ...fresh]) {
    const ts = new Date((ev.alertDate || '').replace('T', ' ')).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    const key = dedupKey(ev);
    if (!seen.has(key)) seen.set(key, { ...ev, alertDate: ev.alertDate.replace('T', ' ') });
  }

  return [...seen.values()].sort((a, b) => b.alertDate.localeCompare(a.alertDate));
}

// Read KV history — returns { lastWrite: ms|null, events: [] }
// Handles both old format (plain array) and new format ({ lastWrite, events })
async function readKV(env) {
  try {
    const raw = await env.HISTORY_STORE.get(HISTORY_KEY);
    if (!raw) return { lastWrite: null, events: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { lastWrite: null, events: parsed }; // old format
    return { lastWrite: parsed.lastWrite || null, events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch (e) {
    return { lastWrite: null, events: [] };
  }
}

// Write KV history with a lastWrite timestamp
async function writeKV(env, events) {
  await env.HISTORY_STORE.put(HISTORY_KEY, JSON.stringify({ lastWrite: Date.now(), events }));
}

// ── Cron: runs every 15 min ───────────────────────────────────────────────────
// Calls the heavy endpoint, merges into KV, extends the rolling 12h window.

async function refreshHistory(env) {
  const [{ events: stored }, fresh] = await Promise.all([readKV(env), fetchLongHistory()]);
  // Always log what the cron saw, even if we skip the write
  await env.HISTORY_STORE.put('cron_log', JSON.stringify({
    ts: Date.now(),
    freshCount: fresh.length,
    storedCount: stored.length,
    skipped: fresh.length === 0,
  }));
  if (fresh.length === 0) return; // OREF API failed — keep existing cache intact
  const merged = mergeEvents(stored, fresh);
  await writeKV(env, merged);
}

// ── /alarms-history endpoint ──────────────────────────────────────────────────
// Returns KV cache (deep history) + short history (fills gap since last cron run).
// If KV is empty (first deploy) uses long history to bootstrap the cache.

async function handleAlarmsHistory(env) {
  const { lastWrite, events: stored } = await readKV(env);

  if (stored.length === 0) {
    // First deploy: bootstrap KV from long history
    const fresh  = await fetchLongHistory();
    const merged = mergeEvents([], fresh);
    await writeKV(env, merged);
    return new Response(JSON.stringify({ lastWrite: Date.now(), events: merged }), { headers: CORS_HEADERS });
  }

  // Normal path: KV (deep history) + short history (last ~1h, fills cron gap)
  const recent = await fetchShortHistory();
  const merged = mergeEvents(stored, recent);
  // Persist back to KV if short history added new events
  if (merged.length > stored.length) {
    await writeKV(env, merged);
    return new Response(JSON.stringify({ lastWrite: Date.now(), events: merged }), { headers: CORS_HEADERS });
  }
  return new Response(JSON.stringify({ lastWrite, events: merged }), { headers: CORS_HEADERS });
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/alarms-history') {
      return handleAlarmsHistory(env);
    }

    // ── Debug endpoints ────────────────────────────────────────────────────────

    // /debug/short — raw result from fetchShortHistory()
    if (url.pathname === '/debug/short') {
      const data = await fetchShortHistory();
      return new Response(JSON.stringify({ count: data.length, events: data }), { headers: CORS_HEADERS });
    }

    // /debug/long — raw result from fetchLongHistory()
    if (url.pathname === '/debug/long') {
      const data = await fetchLongHistory();
      return new Response(JSON.stringify({ count: data.length, events: data }), { headers: CORS_HEADERS });
    }

    // /debug/cron-log — what the last scheduled cron run actually saw
    if (url.pathname === '/debug/cron-log') {
      const raw = await env.HISTORY_STORE.get('cron_log');
      if (!raw) return new Response(JSON.stringify({ error: 'no cron log yet — deploy and wait for next cron run' }), { headers: CORS_HEADERS });
      const log = JSON.parse(raw);
      return new Response(JSON.stringify({ ...log, tsHuman: new Date(log.ts).toISOString() }), { headers: CORS_HEADERS });
    }

    // /debug/kv — what is currently stored in KV
    if (url.pathname === '/debug/kv') {
      const { lastWrite, events } = await readKV(env);
      const newest = events[0] ? events[0].alertDate : null;
      const oldest = events[events.length - 1] ? events[events.length - 1].alertDate : null;
      return new Response(JSON.stringify({ lastWrite, lastWriteHuman: lastWrite ? new Date(lastWrite).toISOString() : null, count: events.length, newest, oldest }), { headers: CORS_HEADERS });
    }

    // /debug/cron — manually trigger refreshHistory and report what happened
    if (url.pathname === '/debug/cron') {
      const { events: stored } = await readKV(env);
      const fresh = await fetchLongHistory();
      if (fresh.length === 0) {
        return new Response(JSON.stringify({ result: 'skipped', reason: 'fetchLongHistory returned 0 events', storedCount: stored.length }), { headers: CORS_HEADERS });
      }
      const merged = mergeEvents(stored, fresh);
      await writeKV(env, merged);
      return new Response(JSON.stringify({ result: 'written', freshCount: fresh.length, storedCount: stored.length, mergedCount: merged.length, newest: merged[0] ? merged[0].alertDate : null }), { headers: CORS_HEADERS });
    }

    // Simple proxy routes
    let targetUrl, referer;
    if (url.pathname === '/history') {
      targetUrl = 'https://api.tzevaadom.co.il/alerts-history';
      referer   = 'https://www.tzevaadom.co.il/';
    } else if (url.pathname === '/oref') {
      targetUrl = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
      referer   = 'https://www.oref.org.il/';
    } else {
      return new Response('Not found', { status: 404 });
    }

    const res  = await fetch(targetUrl, {
      headers: { ...OREF_HEADERS, Referer: referer },
      cf: { cacheEverything: false, cacheTtl: 0, country: 'IL', resolveOverride: 'www.oref.org.il' },
    });
    return new Response(await res.text(), { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    // OREF blocks Cloudflare scheduler IPs — self-trigger via HTTP to use a regular edge IP
    if (env.WORKER_URL) {
      await fetch(`${env.WORKER_URL}/debug/cron`);
    } else {
      await refreshHistory(env);
    }
  },
};
