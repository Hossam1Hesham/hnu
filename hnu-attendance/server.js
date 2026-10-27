// نظام حضور جامعة حلوان الأهلية (HNU) — Node.js 18+ بدون أي مكتبات خارجية
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

// ---- قراءة ملف .env محلياً إن وُجد تلقائياً بدون أي مكتبة خارجية
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const k = trimmed.slice(0, eq).trim();
          let v = trimmed.slice(eq + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (process.env[k] === undefined) process.env[k] = v;
        }
      });
    } catch {}
  }
})();

// ---- قاعدة البيانات البسيطة (data.json)
const DBF = path.join(process.env.DATA_DIR || __dirname, 'data.json');
let db = { users: [], next: 1, settings: {} };
try {
  const parsed = JSON.parse(fs.readFileSync(DBF, 'utf8'));
  db = {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    next: parsed.next || 1,
    settings: parsed.settings || {}
  };
} catch {}
const save = () => {
  try {
    fs.writeFileSync(DBF, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save data.json:', err.message);
  }
};

// ---- الإعدادات العامة (تعطي الأولوية لما يُحفظ في لوحة الأدمن، ثم متغيرات البيئة)
const cfg = {
  get adminUser() { return process.env.ADMIN_USER || 'admin'; },
  get adminPass() { return process.env.ADMIN_PASS || 'admin123'; },
  get port() { return +process.env.PORT || 3000; },
  get secret() { return db.settings.secret || process.env.SECRET || 'hnu-attendance-secret-key-2026'; },
  get formUrl() { return (db.settings.formUrl || process.env.FORM_URL || '').trim(); },
  get tokenEntry() { return (db.settings.tokenEntry || process.env.TOKEN_ENTRY || '').trim(); },
  get sheetCsv() { return (db.settings.sheetCsv || process.env.SHEET_CSV || '').trim(); },
  get window() { return (+db.settings.windowSec || +process.env.WINDOW_SEC || 240) * 1000; },
  get tz() { return db.settings.tz || process.env.SHEET_TZ || 'Africa/Cairo'; },
  get dmy() {
    if (db.settings.dateOrder) return db.settings.dateOrder === 'DMY';
    return (process.env.DATE_ORDER || 'DMY') === 'DMY';
  }
};

const hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const sign = s => crypto.createHmac('sha256', cfg.secret).update(s).digest('hex');
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const mkSession = id => { const b = id + '.' + (Date.now() + 12 * 36e5); return b + '.' + sign(b); };

function getUser(req) {
  const m = (req.headers.cookie || '').match(/hnu=([^;]+)/);
  if (!m) return null;
  const p = m[1].split('.');
  if (p.length !== 3 || !eq(sign(p[0] + '.' + p[1]), p[2]) || +p[1] < Date.now()) return null;
  const id = +p[0];
  if (id === 0) return { id: 0, role: 'admin', name: 'الأدمن' };
  const u = db.users.find(x => x.id === id);
  return u ? { ...u, role: 'doctor' } : null;
}

// ---- توليد توكن الـ QR الذكي: بيتغير كل 5 ثواني
const slot6 = n => n.toString(36).padStart(6, '0');
const tokenFor = (d, l) => {
  const s = Math.floor(Date.now() / 5000);
  return `d${d}l${l}t${slot6(s)}${sign(`${d}.${l}.${s}`).slice(0, 5)}`;
};

// ---- قراءة ومعالجة ملف Google Sheet المنشور كـ CSV
function csv(t) {
  const r = []; let row = [], c = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') {
        if (t[i + 1] === '"') { c += '"'; i++; } else q = false;
      } else c += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === ',') {
      row.push(c); c = '';
    } else if (ch === '\n') {
      row.push(c); r.push(row); row = []; c = '';
    } else if (ch !== '\r') {
      c += ch;
    }
  }
  if (c || row.length) { row.push(c); r.push(row); }
  return r;
}

const tzOff = (t, tz = cfg.tz) => {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    }).formatToParts(new Date(t)).reduce((o, p) => (o[p.type] = +p.value, o), {});
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - t;
  } catch {
    return 0;
  }
};

function tsParse(s) {
  if (!s) return NaN;
  let str = String(s).trim();
  let isPM = false, hasAmPm = false;
  if (/م|pm|p\.m\./i.test(str)) { isPM = true; hasAmPm = true; }
  else if (/ص|am|a\.m\./i.test(str)) { isPM = false; hasAmPm = true; }

  const clean = str.replace(/[^\d\/: -]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = clean.match(/(\d+)[-\/](\d+)[-\/](\d+)\s+(\d+)[:.](\d+)(?:[:.](\d+))?/);
  if (!m) {
    const p = Date.parse(s);
    return isNaN(p) ? NaN : p;
  }

  let y, mo, d, H, M, S;
  if (m[1].length === 4) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else {
    let yr = +m[3];
    if (yr < 100) yr += 2000;
    y = yr;
    if (cfg.dmy) { d = +m[1]; mo = +m[2]; } else { mo = +m[1]; d = +m[2]; }
  }

  H = +m[4]; M = +m[5]; S = +(m[6] || 0);
  if (hasAmPm) {
    if (isPM && H < 12) H += 12;
    if (!isPM && H === 12) H = 0;
  }

  const g = Date.UTC(y, mo - 1, d, H, M, S);
  return g - tzOff(g);
}

let cache = { t: 0, rows: [], headers: [] };
async function sheet() {
  const url = cfg.sheetCsv;
  if (!url) return { rows: [], headers: [] };
  if (Date.now() - cache.t < 6000 && cache.rows.length) return cache;

  const r = await fetch(url, { headers: { 'User-Agent': 'HNU-Attendance/1.0' } });
  if (!r.ok) throw new Error(`تعذر فتح شيت جوجل (كود الرد: ${r.status}). تأكد من نشر الشيت إلى الويب كـ CSV.`);
  const text = await r.text();
  const parsed = csv(text);
  if (!parsed.length) return { rows: [], headers: [] };

  const headers = parsed[0].map(h => (h || '').trim());
  const rows = parsed.slice(1);
  cache = { t: Date.now(), rows, headers };
  return cache;
}

// دالة التحقق من الحضور وتطابق التوكن
async function att(doc, lec) {
  const { rows, headers } = await sheet();
  const seen = new Map();

  let colName = 1, colCode = 2, colSec = 3, colGrp = 4, colToken = 5;
  headers.forEach((h, idx) => {
    const l = h.toLowerCase();
    if (l.includes('توكن') || l.includes('token')) colToken = idx;
    else if (l.includes('اسم') || l.includes('name')) colName = idx;
    else if (l.includes('كود') || l.includes('code') || l.includes('رقم') || l.includes('id')) colCode = idx;
    else if (l.includes('سيكشن') || l.includes('سكشن') || l.includes('sec')) colSec = idx;
    else if (l.includes('جروب') || l.includes('group') || l.includes('مجموع')) colGrp = idx;
  });

  for (const r of rows) {
    let rawToken = (r[colToken] || '').trim();
    let m = rawToken.match(/^d(\d+)l(\d+)t([0-9a-z]{6})([0-9a-f]{5})$/i);
    if (!m) {
      for (let ci = 0; ci < r.length; ci++) {
        if (ci === colToken) continue;
        const candidate = (r[ci] || '').trim();
        const cm = candidate.match(/^d(\d+)l(\d+)t([0-9a-z]{6})([0-9a-f]{5})$/i);
        if (cm) { m = cm; colToken = ci; break; }
      }
    }
    if (!m || +m[1] !== doc || +m[2] !== lec) continue;

    const s = parseInt(m[3], 36);
    if (!eq(sign(`${doc}.${lec}.${s}`).slice(0, 5), m[4].toLowerCase())) continue;

    const ts = tsParse(r[0]);
    if (!ts || isNaN(ts)) continue;
    const dt = ts - s * 5000;
    if (!(dt >= -60000 && dt <= cfg.window)) continue;

    const code = (r[colCode] || '').trim();
    const name = (r[colName] || '').trim();
    const sec = (r[colSec] || '').trim();
    const grp = (r[colGrp] || '').trim();

    if (code && !seen.has(code)) {
      seen.set(code, { name, code, sec, grp, t: ts });
    }
  }

  return [...seen.values()].sort((a, b) => a.t - b.t);
}

// ---- خادم HTTP
const json = (res, c, o) => {
  res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(o));
};

const body = req => new Promise(r => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 5e5) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } });
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

const tries = {}, PUB = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname, m = req.method;

    // خدمة الملفات الثابتة (Static Files)
    if (!p.startsWith('/api/')) {
      const f = path.join(PUB, p === '/' ? 'index.html' : p);
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('الصفحة غير موجودة (404)');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      return fs.createReadStream(f).pipe(res);
    }

    // تسجيل الدخول
    if (p === '/api/login' && m === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const t = tries[ip] = (tries[ip] || []).filter(x => Date.now() - x < 9e5);
      if (t.length >= 10) return json(res, 429, { error: 'محاولات دخول كثيرة، يرجى المحاولة بعد 15 دقيقة' });

      const b = await body(req), pw = String(b.p || '');
      let id = null;
      if (b.u === cfg.adminUser && eq(pw, cfg.adminPass)) {
        id = 0;
      } else {
        const x = db.users.find(u => u.username === b.u);
        if (x && eq(hp(pw, x.salt), x.hash)) id = x.id;
      }

      if (id === null) {
        t.push(Date.now());
        return json(res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      res.setHeader('Set-Cookie', `hnu=${mkSession(id)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
      return json(res, 200, { ok: 1 });
    }

    // تسجيل الخروج
    if (p === '/api/logout') {
      res.setHeader('Set-Cookie', 'hnu=; Path=/; Max-Age=0');
      return json(res, 200, { ok: 1 });
    }

    const u = getUser(req);
    if (!u) return json(res, 401, { error: 'يرجى تسجيل الدخول أولاً' });
    const adm = u.role === 'admin';

    // بيانات المستخدم الحالي
    if (p === '/api/me') {
      return json(res, 200, {
        role: u.role,
        name: u.name,
        lectures: u.lectures || 0,
        isConfigured: !!(cfg.formUrl && cfg.tokenEntry && cfg.sheetCsv)
      });
    }

    // استعراض الحضور
    if (p === '/api/attendance') {
      const d = adm ? +url.searchParams.get('doctor') : u.id;
      try {
        const rows = await att(d, +url.searchParams.get('lec'));
        return json(res, 200, { rows });
      } catch (e) {
        return json(res, 502, { error: e.message || 'تعذر قراءة شيت الردود من جوجل' });
      }
    }

    // لوحة الدكتور
    if (!adm) {
      if (p === '/api/lectures' && m === 'POST') {
        const x = db.users.find(y => y.id === u.id);
        x.lectures = (x.lectures || 0) + 1;
        save();
        return json(res, 200, { lectures: x.lectures });
      }

      if (p === '/api/qr') {
        if (!cfg.formUrl || !cfg.tokenEntry) {
          return json(res, 500, { error: 'رابط Google Form أو حقل التوكن غير مضبوط في الإعدادات، يرجى مراجعة الأدمن.' });
        }
        const lec = +url.searchParams.get('lec');
        const token = tokenFor(u.id, lec);
        return json(res, 200, {
          url: `${cfg.formUrl}?usp=pp_url&${cfg.tokenEntry}=${token}`,
          token
        });
      }

      return json(res, 403, { error: 'غير مسموح بهذا الإجراء' });
    }

    // ==================== صلاحيات الأدمن فقط ====================

    // عرض إعدادات الربط
    if (p === '/api/settings' && m === 'GET') {
      return json(res, 200, {
        formUrl: cfg.formUrl,
        tokenEntry: cfg.tokenEntry,
        sheetCsv: cfg.sheetCsv,
        windowSec: Math.round(cfg.window / 1000),
        dateOrder: cfg.dmy ? 'DMY' : 'MDY',
        isConfigured: !!(cfg.formUrl && cfg.tokenEntry && cfg.sheetCsv)
      });
    }

    // حفظ إعدادات الربط
    if (p === '/api/settings' && m === 'POST') {
      const b = await body(req);
      db.settings = db.settings || {};
      if (b.formUrl !== undefined) db.settings.formUrl = String(b.formUrl).trim();
      if (b.tokenEntry !== undefined) db.settings.tokenEntry = String(b.tokenEntry).trim();
      if (b.sheetCsv !== undefined) db.settings.sheetCsv = String(b.sheetCsv).trim();
      if (b.windowSec !== undefined && +b.windowSec > 0) db.settings.windowSec = +b.windowSec;
      if (b.dateOrder !== undefined) db.settings.dateOrder = b.dateOrder === 'MDY' ? 'MDY' : 'DMY';
      if (b.secret && String(b.secret).trim().length >= 8) db.settings.secret = String(b.secret).trim();

      save();
      cache = { t: 0, rows: [], headers: [] }; // تصفير الكاش لتحديث البيانات فوراً
      return json(res, 200, { ok: 1, message: 'تم حفظ الإعدادات بنجاح ✔' });
    }

    // فحص واختبار الاتصال بـ Google Sheet
    if (p === '/api/test-sheet') {
      try {
        cache = { t: 0, rows: [], headers: [] };
        const data = await sheet();
        return json(res, 200, {
          ok: 1,
          totalRows: data.rows.length,
          headers: data.headers,
          sampleRow: data.rows[0] || null
        });
      } catch (err) {
        return json(res, 400, {
          ok: 0,
          error: err.message
        });
      }
    }

    // تحميل نسخة احتياطية من قاعدة البيانات
    if (p === '/api/backup' && m === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="hnu-attendance-backup.json"'
      });
      return res.end(JSON.stringify(db, null, 2));
    }

    // استعادة نسخة احتياطية
    if (p === '/api/restore' && m === 'POST') {
      const b = await body(req);
      if (b && Array.isArray(b.users)) {
        db = {
          users: b.users,
          next: b.next || b.users.length + 1,
          settings: b.settings || db.settings || {}
        };
        save();
        return json(res, 200, { ok: 1, message: 'تم استعادة النسخة الاحتياطية بنجاح ✔' });
      }
      return json(res, 400, { error: 'ملف النسخة الاحتياطية غير صالح' });
    }

    // إدارة الدكاترة
    if (p === '/api/doctors' && m === 'GET') {
      return json(res, 200, {
        doctors: db.users.map(({ id, username, name, lectures }) => ({ id, username, name, lectures: lectures || 0 }))
      });
    }

    if (p === '/api/doctors' && m === 'POST') {
      const b = await body(req);
      const un = String(b.username || '').trim().toLowerCase();
      const nm = String(b.name || '').trim();
      const pw = String(b.password || '');

      if (!/^[a-z0-9._-]{3,30}$/.test(un) || !nm || pw.length < 6) {
        return json(res, 400, { error: 'اسم مستخدم (إنجليزي 3+)، اسم الدكتور، وكلمة مرور 6 خانات على الأقل' });
      }
      if (un === cfg.adminUser.toLowerCase() || db.users.some(x => x.username === un)) {
        return json(res, 400, { error: 'اسم المستخدم مسجل مسبقاً' });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      db.users.push({
        id: db.next++,
        username: un,
        name: nm,
        salt,
        hash: hp(pw, salt),
        lectures: 10
      });
      save();
      return json(res, 200, { ok: 1 });
    }

    const dm = p.match(/^\/api\/doctors\/(\d+)(\/password)?$/);
    if (dm) {
      const x = db.users.find(y => y.id === +dm[1]);
      if (!x) return json(res, 404, { error: 'الحساب غير موجود' });

      if (dm[2] && m === 'POST') {
        const pw = String((await body(req)).password || '');
        if (pw.length < 6) return json(res, 400, { error: 'كلمة المرور 6 أحرف على الأقل' });
        x.salt = crypto.randomBytes(16).toString('hex');
        x.hash = hp(pw, x.salt);
        save();
        return json(res, 200, { ok: 1 });
      }

      if (!dm[2] && m === 'DELETE') {
        db.users = db.users.filter(y => y !== x);
        save();
        return json(res, 200, { ok: 1 });
      }
    }

    return json(res, 404, { error: 'المسار غير موجود (404)' });
  } catch (e) {
    console.error('Server error:', e);
    return json(res, 500, { error: 'حدث خطأ في الخادم' });
  }
});

server.listen(cfg.port, () => {
  console.log('='.repeat(50));
  console.log(`🚀 نظام حضور جامعة حلوان الأهلية (HNU) يعمل الآن!`);
  console.log(`📡 الرابط: http://localhost:${cfg.port}`);
  console.log(`👤 حساب الأدمن: ${cfg.adminUser}`);
  console.log('='.repeat(50));
});
