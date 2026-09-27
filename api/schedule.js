const fs = require('fs');

const TMP_FILE = '/tmp/zhanetta_cloud_schedule_v3.json';
const NTFY_TOPIC = 'zhanetta_krasnoyarsk_schedule_v3_clean_9509722463';
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

function readLocalCache() {
  if (global.__zhanettaCloudStateV3) {
    return global.__zhanettaCloudStateV3;
  }
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      if (parsed && parsed.schedules) {
        parsed.schedules = ensureAllMonths(parsed.schedules);
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

async function fetchRemoteState() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
    const resp = await fetch(`https://ntfy.sh/${NTFY_TOPIC}/json?poll=1&since=30d`, {
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
          const payload = JSON.parse(msg.message);
          if (payload && payload.schedules) {
            payload.schedules = ensureAllMonths(payload.schedules);
            return payload;
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

async function pushRemoteState(state) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3800);
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

    const current = readLocalCache() || (await fetchRemoteState()) || DEFAULT_STATE;
    const incomingMonths =
      (body.schedule && body.schedule.months && typeof body.schedule.months === 'object')
        ? body.schedule.months
        : (body.schedules && typeof body.schedules === 'object')
          ? body.schedules
          : current.schedules;
    const incomingBookings =
      (body.schedule && Array.isArray(body.schedule.bookings))
        ? body.schedule.bookings
        : Array.isArray(body.bookings)
          ? body.bookings
          : (current.bookings || []);

    const nextState = {
      updatedAt: new Date().toISOString(),
      schedules: ensureAllMonths(incomingMonths),
      bookings: incomingBookings
    };

    writeLocalCache(nextState);
    const syncedCloud = await pushRemoteState(nextState);

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
  let state = await fetchRemoteState();
  const cached = readLocalCache();
  if (state && cached) {
    if (new Date(cached.updatedAt || 0) > new Date(state.updatedAt || 0)) {
      state = cached;
      // Refresh remote cache in background so ntfy never expires active state
      pushRemoteState(cached).catch(() => {});
    } else {
      writeLocalCache(state);
    }
  } else if (state) {
    writeLocalCache(state);
  } else if (cached) {
    state = cached;
    if (cached.updatedAt !== DEFAULT_STATE.updatedAt) {
      pushRemoteState(cached).catch(() => {});
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
