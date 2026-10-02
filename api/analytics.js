const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const TMP_FILE = '/tmp/zhanetta_cloud_analytics_v1.json';
const KV_APP_KEY = '170j51a0';
const KV_PREFIX = 'zv3_analytics';
const KV_CHUNK_SIZE = 160;

// Owner Master PIN for private stats access (Owner only, NOT for photographer Zhanetta)
const OWNER_PIN = process.env.OWNER_PIN || '8890';
const PHOTOGRAPHER_PIN = '2026';

// In-memory sliding rate limiter to protect against abuse/DDoS
const ipRateLimits = new Map();
function isRateLimited(ip, maxPerMinute = 40) {
  const now = Date.now();
  const entry = ipRateLimits.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + 60000;
  } else {
    entry.count++;
  }
  ipRateLimits.set(ip, entry);
  // Auto-prune old entries every 100 requests
  if (ipRateLimits.size > 200) {
    for (const [k, v] of ipRateLimits.entries()) {
      if (now > v.resetAt) ipRateLimits.delete(k);
    }
  }
  return entry.count > maxPerMinute;
}

// 152-ФЗ compliant: anonymous IP hash that rotates daily (no raw IP stored)
function getAnonymousVisitorId(ip, userAgent) {
  const today = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${ip}_${userAgent || ''}_${today}_zv_salt`)
    .digest('hex')
    .slice(0, 16);
}

const DEFAULT_ANALYTICS = {
  version: 1,
  updatedAt: new Date().toISOString(),
  totals: {
    visits: 0,
    uniqueVisitors: 0,
    portfolioViews: 0,
    bookingStarts: 0,
    calendarViews: 0,
    leadsGenerated: 0
  },
  sources: {
    stories: 0,
    bio: 0,
    tg_channel: 0,
    taplink: 0,
    direct: 0,
    other: 0
  },
  campaigns: {
    sale20: { visits: 0, leads: 0, name: 'Скидка 20% (Stories)' },
    sale10: { visits: 0, leads: 0, name: 'Скидка 10% (Stories)' },
    autumn: { visits: 0, leads: 0, name: 'Осенняя съёмка' },
    lumos: { visits: 0, leads: 0, name: 'Студия Люмос' },
    default: { visits: 0, leads: 0, name: 'Без акции (органика)' }
  },
  devices: {
    ios: 0,
    android: 0,
    desktop: 0
  },
  recentEvents: [],
  visitorsSeen: [] // stored as rolling ring of 100 anonymous hashes
};

function readLocalAnalytics() {
  if (global.__zhanettaAnalyticsState) {
    return global.__zhanettaAnalyticsState;
  }
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      if (parsed && parsed.totals) {
        global.__zhanettaAnalyticsState = parsed;
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

function writeLocalAnalytics(state) {
  global.__zhanettaAnalyticsState = state;
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {}
}

async function fetchKvAnalytics() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
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
    const chunkTimer = setTimeout(() => chunkController.abort(), 7000);
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
    const parsed = JSON.parse(jsonStr);
    return parsed && parsed.totals ? parsed : null;
  } catch (e) {
    return null;
  }
}

async function pushKvAnalytics(state) {
  try {
    // Keep recent events and visitor list bounded to prevent infinite storage growth
    const boundedState = {
      ...state,
      recentEvents: (state.recentEvents || []).slice(-30),
      visitorsSeen: (state.visitorsSeen || []).slice(-200)
    };
    const compressed = zlib
      .deflateRawSync(Buffer.from(JSON.stringify(boundedState), 'utf8'))
      .toString('base64url');
    const chunks = [];
    for (let i = 0; i < compressed.length; i += KV_CHUNK_SIZE) {
      chunks.push(compressed.slice(i, i + KV_CHUNK_SIZE));
    }
    if (chunks.length === 0 || chunks.length > 40) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7500);
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

async function getOrInitAnalytics() {
  let state = readLocalAnalytics();
  if (!state) {
    state = await fetchKvAnalytics();
    if (state) writeLocalAnalytics(state);
  }
  if (!state) {
    state = JSON.parse(JSON.stringify(DEFAULT_ANALYTICS));
    writeLocalAnalytics(state);
  }
  return state;
}

function classifyDevice(ua = '') {
  const s = ua.toLowerCase();
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ipod')) return 'ios';
  if (s.includes('android')) return 'android';
  return 'desktop';
}

function normalizeSource(raw = '') {
  const s = raw.toLowerCase().trim();
  if (s.includes('stori') || s === 'ig_stories' || s === 'stories') return 'stories';
  if (s.includes('bio') || s === 'ig_bio' || s === 'instagram') return 'bio';
  if (s.includes('tg') || s.includes('telegr') || s === 'telegram') return 'tg_channel';
  if (s.includes('taplink')) return 'taplink';
  if (!s || s === 'direct' || s === 'none') return 'direct';
  return 'other';
}

function normalizeCampaign(raw = '') {
  const s = raw.toLowerCase().trim();
  if (!s || s === 'none' || s === 'undefined') return 'default';
  if (s.includes('20') || s === 'sale20') return 'sale20';
  if (s.includes('10') || s === 'sale10') return 'sale10';
  if (s.includes('autumn') || s.includes('осень')) return 'autumn';
  if (s.includes('lumos') || s.includes('люмос')) return 'lumos';
  return s.slice(0, 32);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1';

  // ------------------------------------------------------------------------
  // INGESTION: POST /api/analytics (Public silent tracking from client)
  // ------------------------------------------------------------------------
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }

    // Special Action: Reset stats (STRICT OWNER ONLY)
    if (body && body.action === 'reset') {
      const pinGiven = String(body.pin || req.query.pin || '').trim();
      if (pinGiven === PHOTOGRAPHER_PIN) {
        return res.status(403).json({
          ok: false,
          error: 'У фотографа нет доступа к сбросу аналитики (требуется Owner PIN)'
        });
      }
      if (pinGiven !== OWNER_PIN) {
        return res.status(403).json({ ok: false, error: 'Неверный Owner PIN' });
      }
      const resetState = JSON.parse(JSON.stringify(DEFAULT_ANALYTICS));
      resetState.updatedAt = new Date().toISOString();
      writeLocalAnalytics(resetState);
      await pushKvAnalytics(resetState);
      return res.status(200).json({ ok: true, message: 'Статистика успешно сброшена' });
    }

    // Rate limit public event tracking to protect KV & compute
    if (isRateLimited(clientIp, 45)) {
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    }

    const event = String(body.event || 'pageview').toLowerCase();
    const rawSource = String(body.source || body.from || body.utm_source || 'direct');
    const rawCampaign = String(body.campaign || body.utm_campaign || body.c || 'default');
    const ua = String(req.headers['user-agent'] || '');
    const device = classifyDevice(ua);
    const sourceKey = normalizeSource(rawSource);
    const campaignKey = normalizeCampaign(rawCampaign);
    const anonId = getAnonymousVisitorId(clientIp, ua);

    const state = await getOrInitAnalytics();
    state.updatedAt = new Date().toISOString();

    if (!state.visitorsSeen) state.visitorsSeen = [];
    const isNewVisitor = !state.visitorsSeen.includes(anonId);
    if (isNewVisitor) {
      state.visitorsSeen.push(anonId);
      if (state.visitorsSeen.length > 200) state.visitorsSeen.shift();
      state.totals.uniqueVisitors = (state.totals.uniqueVisitors || 0) + 1;
    }

    // Event funnel increments
    if (event === 'pageview') {
      state.totals.visits = (state.totals.visits || 0) + 1;
      state.sources[sourceKey] = (state.sources[sourceKey] || 0) + 1;
      state.devices[device] = (state.devices[device] || 0) + 1;

      if (!state.campaigns[campaignKey]) {
        state.campaigns[campaignKey] = { visits: 0, leads: 0, name: campaignKey };
      }
      state.campaigns[campaignKey].visits = (state.campaigns[campaignKey].visits || 0) + 1;
    } else if (event === 'portfolio') {
      state.totals.portfolioViews = (state.totals.portfolioViews || 0) + 1;
    } else if (event === 'wizard') {
      state.totals.bookingStarts = (state.totals.bookingStarts || 0) + 1;
    } else if (event === 'calendar') {
      state.totals.calendarViews = (state.totals.calendarViews || 0) + 1;
    } else if (event === 'lead' || event === 'submit_booking') {
      state.totals.leadsGenerated = (state.totals.leadsGenerated || 0) + 1;
      if (!state.campaigns[campaignKey]) {
        state.campaigns[campaignKey] = { visits: 0, leads: 0, name: campaignKey };
      }
      state.campaigns[campaignKey].leads = (state.campaigns[campaignKey].leads || 0) + 1;
    }

    // Keep last 30 anonymous events log
    if (!Array.isArray(state.recentEvents)) state.recentEvents = [];
    state.recentEvents.unshift({
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      event,
      source: sourceKey,
      campaign: campaignKey,
      device
    });
    if (state.recentEvents.length > 30) state.recentEvents.pop();

    writeLocalAnalytics(state);
    // Asynchronously push to persistent KV without blocking the client response
    pushKvAnalytics(state).catch(() => {});

    return res.status(200).json({ ok: true });
  }

  // ------------------------------------------------------------------------
  // REPORTING: GET /api/analytics (STRICT OWNER ONLY)
  // ------------------------------------------------------------------------
  const authPin = String(req.query.pin || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  // Explicit security block: If photographer tries to enter their calendar PIN '2026'
  if (authPin === PHOTOGRAPHER_PIN) {
    return res.status(403).json({
      ok: false,
      error: 'Доступ к трекингу и UTM-аналитике разрешён исключительно владельцу (Owner PIN). Доступ для фотографа закрыт.'
    });
  }

  if (authPin !== OWNER_PIN) {
    return res.status(401).json({
      ok: false,
      error: 'Требуется секретный Owner PIN для просмотра аналитики'
    });
  }

  const state = await getOrInitAnalytics();

  // Calculate funnel conversions
  const visits = state.totals.visits || 0;
  const portfolio = state.totals.portfolioViews || 0;
  const wizard = state.totals.bookingStarts || 0;
  const calendar = state.totals.calendarViews || 0;
  const leads = state.totals.leadsGenerated || 0;

  const funnel = {
    visits: { count: visits, percent: 100 },
    portfolio: { count: portfolio, percent: visits > 0 ? Math.round((portfolio / visits) * 100) : 0 },
    wizard: { count: wizard, percent: visits > 0 ? Math.round((wizard / visits) * 100) : 0 },
    calendar: { count: calendar, percent: visits > 0 ? Math.round((calendar / visits) * 100) : 0 },
    leads: { count: leads, percent: visits > 0 ? Math.round((leads / visits) * 100) : 0 }
  };

  return res.status(200).json({
    ok: true,
    ownerAuthorized: true,
    updatedAt: state.updatedAt,
    totals: state.totals,
    funnel,
    sources: state.sources,
    campaigns: state.campaigns,
    devices: state.devices,
    recentEvents: state.recentEvents || []
  });
};
