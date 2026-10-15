const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const TMP_FILE = '/tmp/zhanetta_cloud_portfolio_v3.json';
const NTFY_TOPIC = 'zhanetta_krasnoyarsk_portfolio_v3_clean_9509722463';
const KV_APP_KEY = '170j51a0';
const KV_PREFIX = 'zv3_port_v1';
const KV_CHUNK_SIZE = 160;
const ADMIN_PIN = '2026';

// Rate-limiting & brute-force protection
const failedPinAttempts = new Map();
function isPinLocked(ip) {
  const now = Date.now();
  const entry = failedPinAttempts.get(ip);
  if (!entry) return false;
  if (now > entry.lockUntil) {
    failedPinAttempts.delete(ip);
    return false;
  }
  return entry.count >= 6;
}

function recordPinFailure(ip) {
  const now = Date.now();
  const entry = failedPinAttempts.get(ip) || { count: 0, lockUntil: now + 15 * 60 * 1000 };
  entry.count++;
  if (entry.count >= 6) {
    entry.lockUntil = now + 15 * 60 * 1000;
  }
  failedPinAttempts.set(ip, entry);
}

function clearPinFailures(ip) {
  failedPinAttempts.delete(ip);
}

function isPinValid(candidate) {
  if (typeof candidate !== 'string') candidate = String(candidate || '');
  const targetBuffer = Buffer.from(ADMIN_PIN, 'utf8');
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  if (targetBuffer.length !== candidateBuffer.length) return false;
  return crypto.timingSafeEqual(targetBuffer, candidateBuffer);
}

const DEFAULT_STATE = {
  updatedAt: '2026-10-15T09:30:00.000Z',
  order: [], // custom order of IDs: ['p1', 'p2', ...]
  hidden: [], // IDs hidden from visitors: ['p10']
  custom: [], // newly added photos by Zhanetta: [{ id, src, cat, catLabel, title, isBw, addedAt }]
  likes: {}   // aggregated like counts from clients: { "p1": 12, "p5": 8 }
};

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    updatedAt: raw.updatedAt || DEFAULT_STATE.updatedAt,
    order: Array.isArray(raw.order) ? raw.order : [],
    hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    custom: Array.isArray(raw.custom) ? raw.custom : [],
    likes: (raw.likes && typeof raw.likes === 'object') ? raw.likes : {}
  };
}

function readLocalCache() {
  if (global.__zhanettaCloudPortfolioV3) {
    return global.__zhanettaCloudPortfolioV3;
  }
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = normalizeState(JSON.parse(fs.readFileSync(TMP_FILE, 'utf8')));
      if (parsed) {
        global.__zhanettaCloudPortfolioV3 = parsed;
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

function writeLocalCache(state) {
  global.__zhanettaCloudPortfolioV3 = state;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {}
}

// Layer 1: Permanent KV Store (keyvalue.immanuel.co)
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
    if (!cnt || cnt < 1 || cnt > 60) return null;

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
    if (chunks.length === 0 || chunks.length > 60) return false;

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

// Layer 2: Fast Stream Store (ntfy.sh)
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
  const [kvOk, ntfyOk] = await Promise.all([
    pushKvState(state).catch(() => false),
    pushNtfyState(state).catch(() => false)
  ]);
  return kvOk || ntfyOk;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const clientIp =
    (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1')
      .split(',')[0]
      .trim();

  // POST request: update portfolio (order, hidden, custom photo addition, client like tally)
  if (req.method === 'POST') {
    const body = req.body || {};
    const action = body.action || 'update';

    // Public like action from visitors (no PIN required, debounced)
    if (action === 'like') {
      const photoId = String(body.id || '');
      if (photoId) {
        const current = readLocalCache() || (await fetchBestRemoteState()) || DEFAULT_STATE;
        const nextState = { ...current };
        if (!nextState.likes || typeof nextState.likes !== 'object') nextState.likes = {};
        nextState.likes[photoId] = (nextState.likes[photoId] || 0) + 1;
        writeLocalCache(nextState);
        pushAllRemoteStores(nextState).catch(() => {});
        return res.status(200).json({ ok: true, likes: nextState.likes });
      }
    }

    // Admin protected actions below (PIN required)
    if (isPinLocked(clientIp)) {
      return res.status(429).json({
        ok: false,
        error: 'Слишком много попыток ввода PIN. Попробуйте через 15 минут.'
      });
    }

    const pin = String(req.headers['x-admin-pin'] || body.pin || '');
    if (!isPinValid(pin)) {
      recordPinFailure(clientIp);
      return res.status(401).json({
        ok: false,
        error: 'Неверный PIN администратора.'
      });
    }
    clearPinFailures(clientIp);

    const current = readLocalCache() || (await fetchBestRemoteState()) || DEFAULT_STATE;
    let nextState = { ...current, updatedAt: new Date().toISOString() };

    if (action === 'reorder') {
      if (Array.isArray(body.order)) {
        nextState.order = body.order;
      }
    } else if (action === 'hide') {
      const id = String(body.id || '');
      if (id) {
        const set = new Set(nextState.hidden);
        if (body.hide === false) {
          set.delete(id);
        } else {
          set.add(id);
        }
        nextState.hidden = Array.from(set);
      }
    } else if (action === 'add') {
      const photo = body.photo;
      if (photo && photo.src) {
        const newPhoto = {
          id: photo.id || `c_${Date.now()}`,
          src: photo.src,
          cat: photo.cat || 'portrait',
          catLabel: photo.catLabel || 'Портрет',
          title: photo.title || '',
          isBw: Boolean(photo.isBw),
          addedAt: new Date().toISOString()
        };
        nextState.custom = [newPhoto, ...nextState.custom.filter(p => p.id !== newPhoto.id)];
        nextState.order = [newPhoto.id, ...nextState.order.filter(id => id !== newPhoto.id)];
      }
    } else if (action === 'delete_custom') {
      const id = String(body.id || '');
      if (id) {
        nextState.custom = nextState.custom.filter(p => p.id !== id);
        nextState.order = nextState.order.filter(i => i !== id);
        nextState.hidden = nextState.hidden.filter(i => i !== id);
      }
    } else if (action === 'reset') {
      nextState.order = [];
      nextState.hidden = [];
    }

    writeLocalCache(nextState);
    const syncedCloud = await pushAllRemoteStores(nextState);

    return res.status(200).json({
      ok: true,
      syncedCloud,
      updatedAt: nextState.updatedAt,
      order: nextState.order,
      hidden: nextState.hidden,
      custom: nextState.custom,
      likes: nextState.likes || {}
    });
  }

  // GET request: fetch portfolio state for all visitors
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
  } else {
    state = DEFAULT_STATE;
  }

  return res.status(200).json({
    ok: true,
    updatedAt: state.updatedAt,
    order: state.order,
    hidden: state.hidden,
    custom: state.custom,
    likes: state.likes || {}
  });
};
