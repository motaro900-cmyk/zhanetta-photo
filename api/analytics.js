const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const TMP_FILE = '/tmp/zhanetta_cloud_analytics_v2.json';
const KV_APP_KEY = '170j51a0';
const KV_PREFIX = 'zv3_analytics_v2';
const KV_CHUNK_SIZE = 160;

// Owner Master PIN for private stats access (Owner only, NOT for photographer Zhanetta)
const OWNER_PIN = process.env.OWNER_PIN || '8890';
const PHOTOGRAPHER_PIN = '2026';

// In-memory sliding rate limiter to protect against abuse/DDoS
const ipRateLimits = new Map();
function isRateLimited(ip, maxPerMinute = 60) {
  const now = Date.now();
  const entry = ipRateLimits.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + 60000;
  } else {
    entry.count++;
  }
  ipRateLimits.set(ip, entry);
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
    .update(`${ip}_${userAgent || ''}_${today}_zv_salt_v2`)
    .digest('hex')
    .slice(0, 16);
}

function getRussianTimestamps(date = new Date()) {
  const krskFull = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Krasnoyarsk',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);

  const krskTime = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Krasnoyarsk',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);

  const mskTime = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);

  return {
    krskFull,
    krskTime,
    mskTime,
    epoch: date.getTime()
  };
}

function detectTrafficSource(rawSource = '', referrer = '', userAgent = '') {
  const s = rawSource.toLowerCase().trim();
  const ref = referrer.toLowerCase().trim();
  const ua = userAgent.toLowerCase();

  // 1. Explicit query parameters
  if (s.includes('stori') || s === 'ig_stories' || s === 'stories') {
    return { key: 'stories', title: 'Instagram Stories' };
  }
  if (s.includes('bio') || s === 'ig_bio') {
    return { key: 'bio', title: 'Шапка профиля (Bio)' };
  }
  if (s.includes('tg') || s.includes('telegr') || s === 'telegram') {
    return { key: 'tg_channel', title: 'Telegram канал' };
  }
  if (s.includes('taplink')) {
    return { key: 'taplink', title: 'Taplink' };
  }
  if (s.includes('vk')) {
    return { key: 'vk', title: 'ВКонтакте' };
  }
  if (s.includes('wa') || s.includes('whatsapp')) {
    return { key: 'whatsapp', title: 'WhatsApp' };
  }

  // 2. Automatic Referrer Detection (When links are clicked without UTM tags!)
  if (ref.includes('instagram.com')) {
    return { key: 'stories', title: 'Instagram (по ссылке)' };
  }
  if (ref.includes('t.me') || ref.includes('telegram.org')) {
    return { key: 'tg_channel', title: 'Telegram (по ссылке)' };
  }
  if (ref.includes('vk.com')) {
    return { key: 'vk', title: 'ВКонтакте' };
  }
  if (ref.includes('yandex') || ref.includes('ya.ru')) {
    return { key: 'yandex', title: 'Поиск Яндекс' };
  }
  if (ref.includes('google')) {
    return { key: 'google', title: 'Поиск Google' };
  }

  // 3. UserAgent In-App Browser Signature
  if (ua.includes('instagram')) {
    return { key: 'stories', title: 'Instagram App (Stories)' };
  }
  if (ua.includes('telegram')) {
    return { key: 'tg_channel', title: 'Telegram App' };
  }

  // 4. Default: Direct
  return { key: 'direct', title: 'Прямой заход / закладка' };
}

function detectDevice(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'Apple iPhone (iOS)';
  if (ua.includes('ipad')) return 'Apple iPad (iPadOS)';
  if (ua.includes('android')) return 'Android телефон';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'MacBook / Mac';
  if (ua.includes('windows')) return 'Windows ПК';
  return 'Мобильное устройство';
}

function normalizeCampaign(raw = '', srcKey = 'direct') {
  const s = raw.toLowerCase().trim();
  if (s && s !== 'none' && s !== 'undefined' && s !== 'default') {
    if (s.includes('20') || s === 'sale20') return { key: 'sale20', title: 'Скидка 20% (Stories)' };
    if (s.includes('10') || s === 'sale10') return { key: 'sale10', title: 'Скидка 10% (Stories)' };
    if (s.includes('autumn') || s.includes('осень')) return { key: 'autumn', title: 'Осенняя съёмка' };
    if (s.includes('lumos') || s.includes('люмос')) return { key: 'lumos', title: 'Студия Люмос' };
    return { key: s.slice(0, 32), title: s.slice(0, 32) };
  }
  if (srcKey === 'stories') return { key: 'stories_general', title: 'Stories (без спец. акции)' };
  if (srcKey === 'bio') return { key: 'bio_profile', title: 'Шапка профиля Instagram' };
  return { key: 'default', title: 'Без акции (органика)' };
}

const DEFAULT_ANALYTICS = {
  version: 2,
  updatedAt: new Date().toISOString(),
  totals: {
    visits: 0,
    uniqueVisitors: 0,
    repeatVisits: 0,
    storiesVisits: 0,
    bioVisits: 0,
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
    vk: 0,
    direct: 0,
    other: 0
  },
  campaigns: {
    sale20: { visits: 0, leads: 0, name: 'Скидка 20% (Stories)' },
    sale10: { visits: 0, leads: 0, name: 'Скидка 10% (Stories)' },
    autumn: { visits: 0, leads: 0, name: 'Осенняя съёмка' },
    lumos: { visits: 0, leads: 0, name: 'Студия Люмос' },
    bio_profile: { visits: 0, leads: 0, name: 'Шапка профиля Instagram' },
    stories_general: { visits: 0, leads: 0, name: 'Stories (без промокода)' },
    default: { visits: 0, leads: 0, name: 'Без акции (органика)' }
  },
  devices: {
    ios: 0,
    android: 0,
    desktop: 0
  },
  visitorsMap: {}, // anonHash -> { count: N, first: ts, last: ts }
  recentEvents: [] // rolling ring of 40 detailed events
};

function readLocalAnalytics() {
  if (global.__zhanettaAnalyticsStateV2) {
    return global.__zhanettaAnalyticsStateV2;
  }
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
      if (parsed && parsed.totals) {
        global.__zhanettaAnalyticsStateV2 = parsed;
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

function writeLocalAnalytics(state) {
  global.__zhanettaAnalyticsStateV2 = state;
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
    // Keep data tightly bounded so it compresses into 1-2 small KV chunks
    const boundedVisitors = {};
    if (state.visitorsMap && typeof state.visitorsMap === 'object') {
      const entries = Object.entries(state.visitorsMap).slice(-150);
      for (const [k, v] of entries) boundedVisitors[k] = v;
    }

    const boundedState = {
      ...state,
      visitorsMap: boundedVisitors,
      recentEvents: (state.recentEvents || []).slice(0, 40)
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
    if (isRateLimited(clientIp, 60)) {
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    }

    const event = String(body.event || 'pageview').toLowerCase();
    const rawSource = String(body.source || body.from || body.utm_source || '');
    const rawCampaign = String(body.campaign || body.utm_campaign || body.c || '');
    const rawRef = String(body.ref || req.headers['referer'] || '');
    const ua = String(req.headers['user-agent'] || '');

    const { key: srcKey, title: srcTitle } = detectTrafficSource(rawSource, rawRef, ua);
    const { key: cmpKey, title: cmpTitle } = normalizeCampaign(rawCampaign, srcKey);
    const deviceTitle = detectDevice(ua);
    const devShort = deviceTitle.includes('iPhone') || deviceTitle.includes('iPad') ? 'ios' : (deviceTitle.includes('Android') ? 'android' : 'desktop');

    const anonId = getAnonymousVisitorId(clientIp, ua);
    const now = new Date();
    const ts = getRussianTimestamps(now);

    const state = await getOrInitAnalytics();
    state.updatedAt = now.toISOString();

    if (!state.visitorsMap || typeof state.visitorsMap !== 'object') state.visitorsMap = {};
    const visitorRecord = state.visitorsMap[anonId] || { count: 0, first: ts.epoch, last: ts.epoch };

    let isReturning = false;
    let eventTitle = 'Визит на сайт';

    if (event === 'pageview') {
      visitorRecord.count++;
      visitorRecord.last = ts.epoch;
      state.visitorsMap[anonId] = visitorRecord;

      isReturning = visitorRecord.count > 1;

      state.totals.visits = (state.totals.visits || 0) + 1;
      if (isReturning) {
        state.totals.repeatVisits = (state.totals.repeatVisits || 0) + 1;
        eventTitle = `Повторный визит #${visitorRecord.count}`;
      } else {
        state.totals.uniqueVisitors = (state.totals.uniqueVisitors || 0) + 1;
        eventTitle = 'Новый посетитель';
      }

      if (srcKey === 'stories') state.totals.storiesVisits = (state.totals.storiesVisits || 0) + 1;
      if (srcKey === 'bio') state.totals.bioVisits = (state.totals.bioVisits || 0) + 1;

      if (!state.sources[srcKey]) state.sources[srcKey] = 0;
      state.sources[srcKey]++;

      if (!state.devices[devShort]) state.devices[devShort] = 0;
      state.devices[devShort]++;

      if (!state.campaigns[cmpKey]) {
        state.campaigns[cmpKey] = { visits: 0, leads: 0, name: cmpTitle };
      }
      state.campaigns[cmpKey].visits = (state.campaigns[cmpKey].visits || 0) + 1;
    } else if (event === 'portfolio') {
      state.totals.portfolioViews = (state.totals.portfolioViews || 0) + 1;
      eventTitle = 'Просмотр портфолио';
    } else if (event === 'wizard') {
      state.totals.bookingStarts = (state.totals.bookingStarts || 0) + 1;
      eventTitle = 'Выбор тарифа (Шаг 1)';
    } else if (event === 'calendar') {
      state.totals.calendarViews = (state.totals.calendarViews || 0) + 1;
      eventTitle = 'Открыл календарь (Шаг 4)';
    } else if (event === 'lead' || event === 'submit_booking') {
      state.totals.leadsGenerated = (state.totals.leadsGenerated || 0) + 1;
      eventTitle = '✅ СФОРМИРОВАЛ ЧЕК В TG/WA';
      if (!state.campaigns[cmpKey]) {
        state.campaigns[cmpKey] = { visits: 0, leads: 0, name: cmpTitle };
      }
      state.campaigns[cmpKey].leads = (state.campaigns[cmpKey].leads || 0) + 1;
    }

    // Insert rich event into recent events log
    if (!Array.isArray(state.recentEvents)) state.recentEvents = [];
    state.recentEvents.unshift({
      id: 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timeKrsk: ts.krskTime,
      dateKrsk: ts.krskFull.split(',')[0].trim(),
      timeMsk: ts.mskTime,
      epoch: ts.epoch,
      event,
      eventTitle,
      source: srcKey,
      sourceTitle: srcTitle,
      campaign: cmpKey,
      campaignTitle: cmpTitle,
      device: deviceTitle,
      isReturning,
      visitCount: visitorRecord.count
    });

    if (state.recentEvents.length > 40) {
      state.recentEvents = state.recentEvents.slice(0, 40);
    }

    writeLocalAnalytics(state);
    pushKvAnalytics(state).catch(() => {});

    return res.status(200).json({ ok: true });
  }

  // ------------------------------------------------------------------------
  // REPORTING: GET /api/analytics (STRICT OWNER ONLY)
  // ------------------------------------------------------------------------
  const authPin = String(req.query.pin || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

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

  const tsNow = getRussianTimestamps();

  return res.status(200).json({
    ok: true,
    ownerAuthorized: true,
    serverTimeKrsk: tsNow.krskTime,
    serverTimeMsk: tsNow.mskTime,
    serverDateKrsk: tsNow.krskFull.split(',')[0].trim(),
    updatedAt: state.updatedAt,
    totals: state.totals,
    funnel,
    sources: state.sources,
    campaigns: state.campaigns,
    devices: state.devices,
    recentEvents: state.recentEvents || []
  });
};
