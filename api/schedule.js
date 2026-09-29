const fs = require('fs');
const zlib = require('zlib');

const TMP_FILE = '/tmp/zhanetta_cloud_schedule_v3.json';
const NTFY_TOPIC = 'zhanetta_krasnoyarsk_schedule_v3_clean_9509722463';
const KV_APP_KEY = '170j51a0';
const KV_PREFIX = 'zv3_sched';
const KV_CHUNK_SIZE = 160;
const ADMIN_PIN = '2026';

// All future dates start 100% FREE by default so Zhanetta herself marks only the days/hours she wants to close
const DEFAULT_STATE = {
  updatedAt: '2026-09-27T08:00:00.000Z',
  schedules: {
    '2026-09': {},
    '2026-10': {},
    '2026-11': {},
    '2026-12': {},
    '2027-01': {},
    '2027-02': {}
  },
  bookings: []
};

function ensureAllMonths(schedulesObj) {
  const base = {
    '2026-09': {},
    '2026-10': {},
    '2026-11': {},
    '2026-12': {},
    '2027-01': {},
    '2027-02': {}
  };
  if (schedulesObj && typeof schedulesObj === 'object') {
    for (const k of Object.keys(schedulesObj)) {
      if (schedulesObj[k] && typeof schedulesObj[k] === 'object') {
        base[k] = schedulesObj[k];
      }
    }
  }
  return base;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const schedules = raw.schedules || (raw.schedule && raw.schedule.months);
  if (!schedules || typeof schedules !== 'object') return null;
  const bookings = Array.isArray(raw.bookings)
    ? raw.bookings
    : (raw.schedule && Array.isArray(raw.schedule.bookings) ? raw.schedule.bookings : []);
  return {
    updatedAt: raw.updatedAt || (raw.schedule && raw.schedule.updatedAt) || DEFAULT_STATE.updatedAt,
    schedules: ensureAllMonths(schedules),
    bookings
  };
}

function readLocalCache() {
  if (global.__zhanettaCloudStateV3) {
    return global.__zhanettaCloudStateV3;
  }
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = normalizeState(JSON.parse(fs.readFileSync(TMP_FILE, 'utf8')));
      if (parsed) {
        global.__zhanettaCloudStateV3 = parsed;
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

function writeLocalCache(state) {
  global.__zhanettaCloudStateV3 = state;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {}
}

// Layer 1: Permanent KV Store (keyvalue.immanuel.co — never expires after 12h)
async function fetchKvState() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const metaRes = await fetch(
      `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KV_APP_KEY}/${KV_PREFIX}_meta`,
      { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, signal: controller.signal }
    );
    clearTimeout(timer);
    if (!metaRes.ok) return null;
    const metaStr = (await metaRes.text()).replace(/^"|"$/g, '').trim();
    if (!metaStr || metaStr === 'null') return null;
    const [cntStr, expectedLenStr] = metaStr.split('_');
    const cnt = parseInt(cntStr, 10);
    const expectedLen = parseInt(expectedLenStr, 10);
    if (!cnt || cnt < 1 || cnt > 40) return null;

    const chunkController = new AbortController();
    const chunkTimer = setTimeout(() => chunkController.abort(), 8000);
    const chunks = await Promise.all(
      Array.from({ length: cnt }, (_, idx) =>
        fetch(
          `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KV_APP_KEY}/${KV_PREFIX}_c${idx}`,
          { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, signal: chunkController.signal }
        )
          .then(r => (r.ok ? r.text() : ''))
          .then(t => t.replace(/^"|"$/g, '').trim())
      )
    );
    clearTimeout(chunkTimer);

    const joined = chunks.join('');
    if (expectedLen && joined.length !== expectedLen) return null;
    const jsonStr = zlib.inflateRawSync(Buffer.from(joined, 'base64url')).toString('utf8');
    return normalizeState(JSON.parse(jsonStr));
  } catch (e) {
    return null;
  }
}

async function pushKvState(state) {
  try {
    const compressed = zlib
      .deflateRawSync(Buffer.from(JSON.stringify(state), 'utf8'))
      .toString('base64url');
    const chunks = [];
    for (let i = 0; i < compressed.length; i += KV_CHUNK_SIZE) {
      chunks.push(compressed.slice(i, i + KV_CHUNK_SIZE));
    }
    if (chunks.length === 0 || chunks.length > 40) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8500);
    const chunkResps = await Promise.all(
      chunks.map((chunk, idx) =>
        fetch(
          `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KV_APP_KEY}/${KV_PREFIX}_c${idx}/${chunk}`,
          { method: 'POST', signal: controller.signal }
        )
      )
    );
    if (!chunkResps.every(r => r && r.ok)) {
      clearTimeout(timer);
      return false;
    }
    const metaVal = `${chunks.length}_${compressed.length}`;
    const metaResp = await fetch(
      `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KV_APP_KEY}/${KV_PREFIX}_meta/${metaVal}`,
      { method: 'POST', signal: controller.signal }
    );
    clearTimeout(timer);
    return Boolean(metaResp && metaResp.ok);
  } catch (e) {
    return false;
  }
}

// Layer 2: Fast Stream Store (ntfy.sh with since=all)
async function fetchNtfyState() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`https://ntfy.sh/${NTFY_TOPIC}/json?poll=1&since=all`, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const text = await resp.text();
    const lines = text.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]);
        if (msg && msg.event === 'message' && msg.message) {
          const parsed = normalizeState(JSON.parse(msg.message));
          if (parsed) return parsed;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

async function pushNtfyState(state) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache': 'yes'
      },
      body: JSON.stringify(state),
      signal: controller.signal
    });
    clearTimeout(timer);
    return Boolean(resp && resp.ok);
  } catch (e) {
    return false;
  }
}

async function fetchBestRemoteState() {
  const [kvState, ntfyState] = await Promise.all([fetchKvState(), fetchNtfyState()]);
  if (kvState && ntfyState) {
    const kvTime = new Date(kvState.updatedAt || 0).getTime();
    const ntfyTime = new Date(ntfyState.updatedAt || 0).getTime();
    if (kvTime > ntfyTime) {
      pushNtfyState(kvState).catch(() => {});
      return kvState;
    }
    if (ntfyTime > kvTime) {
      pushKvState(ntfyState).catch(() => {});
      return ntfyState;
    }
    return kvState;
  }
  if (kvState) {
    // ntfy expired after 12h — automatically re-hydrate ntfy from permanent KV
    pushNtfyState(kvState).catch(() => {});
    return kvState;
  }
  if (ntfyState) {
    pushKvState(ntfyState).catch(() => {});
    return ntfyState;
  }
  return null;
}

async function pushAllRemoteStores(state) {
  const [kvOk, ntfyOk] = await Promise.all([pushKvState(state), pushNtfyState(state)]);
  return Boolean(kvOk || ntfyOk);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    if (!body || String(body.pin) !== ADMIN_PIN) {
      return res.status(403).json({ ok: false, error: 'Неверный PIN-код фотографа' });
    }

    const explicitMonths =
      (body.schedule && body.schedule.months && typeof body.schedule.months === 'object')
        ? body.schedule.months
        : (body.schedules && typeof body.schedules === 'object')
          ? body.schedules
          : null;
    const explicitBookings =
      (body.schedule && Array.isArray(body.schedule.bookings))
        ? body.schedule.bookings
        : Array.isArray(body.bookings)
          ? body.bookings
          : null;

    const current = (explicitMonths && explicitBookings)
      ? DEFAULT_STATE
      : (readLocalCache() || (await fetchBestRemoteState()) || DEFAULT_STATE);

    const incomingMonths = explicitMonths || current.schedules;
    const incomingBookings = explicitBookings || current.bookings || [];

    const nextState = {
      updatedAt: new Date().toISOString(),
      schedules: ensureAllMonths(incomingMonths),
      bookings: incomingBookings
    };

    writeLocalCache(nextState);
    const syncedCloud = await pushAllRemoteStores(nextState);

    return res.status(200).json({
      ok: true,
      syncedCloud,
      updatedAt: nextState.updatedAt,
      schedules: nextState.schedules,
      bookings: nextState.bookings,
      schedule: {
        version: 3,
        updatedAt: nextState.updatedAt,
        months: nextState.schedules,
        bookings: nextState.bookings
      }
    });
  }

  // GET request
  let state = await fetchBestRemoteState();
  const cached = readLocalCache();
  if (state && cached) {
    if (new Date(cached.updatedAt || 0) > new Date(state.updatedAt || 0)) {
      state = cached;
      pushAllRemoteStores(cached).catch(() => {});
    } else {
      writeLocalCache(state);
    }
  } else if (state) {
    writeLocalCache(state);
  } else if (cached) {
    state = cached;
    if (cached.updatedAt !== DEFAULT_STATE.updatedAt) {
      pushAllRemoteStores(cached).catch(() => {});
    }
  } else {
    state = DEFAULT_STATE;
  }

  state.schedules = ensureAllMonths(state.schedules);

  return res.status(200).json({
    ok: true,
    updatedAt: state.updatedAt,
    schedules: state.schedules,
    bookings: state.bookings || [],
    schedule: {
      version: 3,
      updatedAt: state.updatedAt,
      months: state.schedules,
      bookings: state.bookings || []
    }
  });
};
