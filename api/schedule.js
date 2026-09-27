const fs = require('fs');
const path = require('path');

const TMP_FILE = '/tmp/zhanetta_cloud_schedule_v2.json';
const NTFY_TOPIC = 'zhanetta_krasnoyarsk_schedule_v2_sync_9509722463';
const ADMIN_PIN = '2026';

const ALL_SLOTS = [
  '07:00', '08:00', '09:00', '10:00–12:00', '11:00', '12:00',
  '12:30–14:30', '14:00', '15:00–17:00', '16:00', '17:00',
  '17:30–19:30', '19:00', '20:00', '21:00', '22:00', '23:00'
];

const DEFAULT_STATE = {
  updatedAt: '2026-09-26T18:00:00.000Z',
  schedules: {
    '2026-09': {
      27: { status: 'partial', busySlots: ['12:00', '12:30–14:30', '15:00–17:00'] },
      28: { status: 'off', busySlots: ALL_SLOTS }
    },
    '2026-10': {
      3:  { status: 'busy',    busySlots: ALL_SLOTS },
      4:  { status: 'off',     busySlots: ALL_SLOTS },
      7:  { status: 'partial', busySlots: ['10:00–12:00', '11:00', '15:00–17:00', '16:00'] },
      10: { status: 'partial', busySlots: ['12:00', '12:30–14:30', '15:00–17:00'] },
      11: { status: 'busy',    busySlots: ALL_SLOTS },
      12: { status: 'off',     busySlots: ALL_SLOTS },
      17: { status: 'busy',    busySlots: ALL_SLOTS },
      18: { status: 'partial', busySlots: ['10:00–12:00', '15:00–17:00'] },
      19: { status: 'off',     busySlots: ALL_SLOTS },
      24: { status: 'partial', busySlots: ['12:30–14:30', '17:30–19:30'] },
      25: { status: 'busy',    busySlots: ALL_SLOTS },
      26: { status: 'off',     busySlots: ALL_SLOTS }
    },
    '2026-11': {
      1:  { status: 'off',     busySlots: ALL_SLOTS },
      8:  { status: 'off',     busySlots: ALL_SLOTS },
      15: { status: 'off',     busySlots: ALL_SLOTS },
      22: { status: 'off',     busySlots: ALL_SLOTS },
      29: { status: 'off',     busySlots: ALL_SLOTS }
    },
    '2026-12': {
      6:  { status: 'off',     busySlots: ALL_SLOTS },
      13: { status: 'off',     busySlots: ALL_SLOTS },
      20: { status: 'off',     busySlots: ALL_SLOTS },
      31: { status: 'off',     busySlots: ALL_SLOTS }
    }
  },
  bookings: []
};

function readLocalCache() {
  if (global.__zhanettaCloudState) {
    return global.__zhanettaCloudState;
  }
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      if (parsed && parsed.schedules) {
        global.__zhanettaCloudState = parsed;
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

function writeLocalCache(state) {
  global.__zhanettaCloudState = state;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {}
}

async function fetchRemoteState() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2800);
    const resp = await fetch(`https://ntfy.sh/${NTFY_TOPIC}/json?poll=1&since=30d`, {
      method: 'GET',
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
    const timer = setTimeout(() => controller.abort(), 3500);
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify(state),
      signal: controller.signal
    });
    clearTimeout(timer);
    return true;
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
    const nextState = {
      updatedAt: new Date().toISOString(),
      schedules: (body.schedules && typeof body.schedules === 'object') ? body.schedules : current.schedules,
      bookings: Array.isArray(body.bookings) ? body.bookings : (current.bookings || [])
    };

    writeLocalCache(nextState);
    const syncedCloud = await pushRemoteState(nextState);

    return res.status(200).json({
      ok: true,
      syncedCloud,
      updatedAt: nextState.updatedAt,
      schedules: nextState.schedules,
      bookings: nextState.bookings
    });
  }

  // GET request
  let state = await fetchRemoteState();
  const cached = readLocalCache();
  if (state && cached) {
    if (new Date(cached.updatedAt || 0) > new Date(state.updatedAt || 0)) {
      state = cached;
    } else {
      writeLocalCache(state);
    }
  } else if (state) {
    writeLocalCache(state);
  } else if (cached) {
    state = cached;
  } else {
    state = DEFAULT_STATE;
  }

  const isAdmin = req.query && String(req.query.pin) === ADMIN_PIN;
  return res.status(200).json({
    ok: true,
    updatedAt: state.updatedAt,
    schedules: state.schedules,
    bookings: isAdmin ? (state.bookings || []) : undefined
  });
};
