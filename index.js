import express from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 7000;
const TMDB = process.env.TMDB_KEY || '';

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const j = async (url, ms = 6500) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

const dec = (s) => {
  try { return JSON.parse(Buffer.from(s, 'base64url').toString()); } catch { return {}; }
};

const LANGS = {
  el: ['ell', 'gre'], en: ['eng'], sv: ['swe'], de: ['ger', 'deu'], fr: ['fre', 'fra'],
  it: ['ita'], es: ['spa'], pt: ['por', 'pob'], ru: ['rus'], nl: ['dut', 'nld'],
  tr: ['tur'], pl: ['pol'], da: ['dan'], no: ['nor'], fi: ['fin'],
};

const DUB = {
  it: /\b(ita|italian)\b/i, de: /\b(ger|german|deutsch)\b/i, fr: /\b(french|vff|truefrench)\b/i,
  es: /\b(spa|spanish|latino|castellano)\b/i, ru: /\b(rus|russian)\b/i,
  pt: /\b(por|portuguese|dublado)\b/i, pl: /\b(polish|lektor)\b/i, tr: /\b(turkish)\b/i,
  hi: /\b(hindi)\b/i, ja: /\b(jpn dub|japanese dub)\b/i,
};

const langCache = new Map();
async function originalLang(imdbId) {
  if (!TMDB) return null;
  if (langCache.has(imdbId)) return langCache.get(imdbId);
  const r = await j(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${TMDB}`);
  const x = r && ((r.tv_results && r.tv_results[0]) || (r.movie_results && r.movie_results[0]));
  const l = x ? x.original_language : null;
  langCache.set(imdbId, l);
  return l;
}

function parse(s) {
  const bh = s.behaviorHints || {};
  const txt = `${s.name || ''}\n${s.title || ''}\n${s.description || ''}\n${bh.filename || ''}`;
  const res = /2160p|4k|uhd/i.test(txt) ? 2160 : /1080p/i.test(txt) ? 1080 : /720p/i.test(txt) ? 720 : /480p/i.test(txt) ? 480 : 0;
  let gb = bh.videoSize ? bh.videoSize / 1e9 : 0;
  if (!gb) {
    const m = txt.match(/(\d+(?:\.\d+)?)\s?(GB|MB)/i);
    if (m) gb = m[2].toUpperCase() === 'GB' ? +m[1] : +m[1] / 1000;
  }
  const head = `${s.name || ''} ${s.description || s.title || ''}`;
  const cached = !!s.url && /\+\]|⚡|\bcached\b/i.test(head) && !/download|uncached|⏳/i.test(head);
  return { s, txt, res, gb, cached, hash: !!bh.videoHash };
}

function score(p, ctx) {
  const t = p.txt.toLowerCase();
  if (!p.cached) return -1;
  if (/\b(cam|hdcam|hdts|telesync|ts|tc)\b/.test(t)) return -1;
  const multi = /\b(multi|dual)\b/.test(t);
  if (!multi) {
    for (const [lang, re] of Object.entries(DUB)) {
      if (lang !== ctx.orig && re.test(t)) return -1;
    }
    if (/\bdub(bed)?\b/.test(t) && ctx.orig !== 'en') return -1;
  }
  let sc = 0;
  if (p.res === 2160) sc += ctx.can4k ? 30 : -20;
  else if (p.res === 1080) sc += 40;
  else if (p.res === 720) sc += 20;
  if (/web-?dl|bluray|blu-ray/.test(t)) sc += 15;
  if (/x265|hevc/.test(t)) sc += 8;
  if (/eac3|ddp|dd\+|ac3|aac/.test(t)) sc += 10;
  if (/truehd|atmos|dts-hd/.test(t)) sc -= 15;
  if (/\bdv\b|dolby.?vision/.test(t) && !ctx.can4k) sc -= 25;
  if (/remux/.test(t)) sc -= 10;
  if (p.hash) sc += 12;
  if (p.gb > ctx.maxGB) sc -= 30;
  return sc;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/:cfg/manifest.json', (req, res) => {
  res.json({
    id: 'org.bestplay.addon',
    version: '1.0.0',
    name: 'BestPlay',
    description: 'Συγχωνεύει streams, διαλέγει το καλύτερο με original ήχο, υπότιτλοι στη γλώσσα σου.',
    resources: ['stream', 'subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true },
  });
});

app.get('/:cfg/stream/:type/:id.json', async (req, res) => {
  const { cfg: c, type, id } = req.params;
  const cfg = dec(c);
  const ups = [...new Set((cfg.up || []).map((u) => String(u).trim().replace(/\/manifest\.json$/, '').replace(/\/$/, '')).filter(Boolean))];
  const imdb = id.split(':')[0];

  const [orig, ...lists] = await Promise.all([
    originalLang(imdb),
    ...ups.map((u) => j(`${u}/stream/${type}/${id}.json`)),
  ]);

  const ctx = {
    orig: orig || 'en',
    can4k: !!cfg.can4k,
    maxGB: Number(cfg.maxGB) || (type === 'series' ? 3 : 10),
  };

  const seen = new Set();
  const ranked = [];
  for (const l of lists) {
    for (const s of (l && l.streams) || []) {
      const p = parse(s);
      const key = (s.behaviorHints && s.behaviorHints.filename) || `${p.res}-${p.gb.toFixed(2)}-${(s.title || '').split('\n')[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      p.score = score(p, ctx);
      if (p.score >= 0) ranked.push(p);
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.gb - b.gb);

  const n = Number(cfg.n) || 3;
  const streams = ranked.slice(0, n).map((p, i) => ({
    url: p.s.url,
    name: i === 0 ? '★ BestPlay' : 'Εναλλακτικό',
    description: `${p.res || '?'}p · ${p.gb ? p.gb.toFixed(1) + ' GB' : ''}\n${(p.s.behaviorHints && p.s.behaviorHints.filename) || ''}`,
    behaviorHints: { ...(p.s.behaviorHints || {}), bingeGroup: `bestplay-${p.res}` },
  }));
  res.json({ streams });
});

async function subs(req, res) {
  const cfg = dec(req.params.cfg);
  const rest = req.originalUrl.split('/subtitles/')[1];
  const r = await j(`https://opensubtitles-v3.strem.io/subtitles/${rest}`, 9000);
  const all = (r && r.subtitles) || [];
  const pref = LANGS[cfg.sub || 'en'] || ['eng'];
  const a = all.filter((x) => pref.includes(x.lang)).slice(0, 3);
  const e = cfg.sub === 'en' ? [] : all.filter((x) => x.lang === 'eng').slice(0, 1);
  res.json({ subtitles: [...a, ...e] });
}
app.get('/:cfg/subtitles/:type/:id/:extra.json', subs);
app.get('/:cfg/subtitles/:type/:id.json', subs);

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BestPlay</title>
  <style>
    body { font: 16px system-ui; max-width: 620px; margin: 2rem auto; padding: 0 1rem; color: #111827; }
    textarea, select, input { width: 100%; padding: .75rem .8rem; margin: .35rem 0 1rem; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 10px; font: inherit; }
    button { padding: .8rem 1rem; border: none; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer; }
    .primary { background: #111827; color: white; }
    .secondary { background: #e5e7eb; color: #111827; }
    .muted { color: #4b5563; font-size: .95rem; }
    #result { display: none; margin-top: 1rem; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1rem; background: #f9fafb; }
    #result.show { display: block; }
    .linkbox { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: .7rem .8rem; word-break: break-all; font-size: .95rem; margin: .5rem 0; }
    .actions { display: flex; gap: .75rem; flex-wrap: wrap; }
    .err { color: #b91c1c; background: #fee2e2; border: 1px solid #fecaca; border-radius: 10px; padding: .8rem .95rem; margin-bottom: 1rem; display: none; }
    .err.show { display: block; }
  </style>
</head>
<body>
  <h2>BestPlay</h2>
  <div id="err" class="err">Βάλε τουλάχιστον ένα addon URL για να δημιουργηθεί το install link.</div>
  <label>Τα addons σου (ένα URL ανά γραμμή, ρυθμισμένα με το debrid σου, χωρίς /manifest.json)</label>
  <textarea id="up" rows="5" placeholder="https://torrentio.strem.fun/realdebrid=KEY\nhttps://comet.elfhosted.com/CONFIG"></textarea>
  <label>Γλώσσα υποτίτλων</label>
  <select id="sub">
    <option value="el">Ελληνικά</option>
    <option value="en">English</option>
    <option value="sv">Svenska</option>
    <option value="de">Deutsch</option>
    <option value="fr">Français</option>
    <option value="it">Italiano</option>
    <option value="es">Español</option>
    <option value="pt">Português</option>
    <option value="nl">Nederlands</option>
    <option value="tr">Türkçe</option>
    <option value="pl">Polski</option>
  </select>
  <label><input type="checkbox" id="k4" style="width:auto"> Η συσκευή παίζει 4K/HDR</label>
  <button id="installBtn" class="primary">Εγκατάσταση στο Stremio</button>

  <div id="result">
    <div class="muted">Το τελικό Stremio install link:</div>
    <div class="linkbox" id="linkbox"></div>
    <div class="actions">
      <button id="copyBtn" class="secondary" type="button">Αντιγραφή</button>
      <button id="webBtn" class="secondary" type="button">Άνοιγμα στο Stremio Web</button>
    </div>
    <div class="muted" style="margin-top:.8rem;">Manifest URL:</div>
    <div class="linkbox" id="manifestbox"></div>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const sub = document.getElementById('sub');
      const k4 = document.getElementById('k4');
      const up = document.getElementById('up');
      const err = document.getElementById('err');
      const result = document.getElementById('result');
      const linkbox = document.getElementById('linkbox');
      const manifestbox = document.getElementById('manifestbox');
      const copyBtn = document.getElementById('copyBtn');
      const webBtn = document.getElementById('webBtn');
      const installBtn = document.getElementById('installBtn');

      const l = (navigator.language || 'en').split('-')[0];
      if ([...sub.options].some(o => o.value === l)) sub.value = l;

      function showError(msg) {
        err.textContent = msg;
        err.classList.add('show');
        result.classList.remove('show');
      }

      function hideError() {
        err.classList.remove('show');
      }

      function b64url(s) {
        return btoa(unescape(encodeURIComponent(s)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      }

      async function copyText(value) {
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
            return true;
          }
        } catch {}
        const t = document.createElement('textarea');
        t.value = value;
        document.body.appendChild(t);
        t.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(t);
        return true;
      }

      installBtn.addEventListener('click', () => {
        const raw = up.value.split('\n').map(s => s.trim()).filter(Boolean);
        if (!raw.length) {
          showError('Βάλε τουλάχιστον ένα URL addon για να δημιουργηθεί το install link.');
          return;
        }
        hideError();

        const cfg = { up: raw, sub: sub.value, can4k: k4.checked };
        const code = b64url(JSON.stringify(cfg));
        const host = location.hostname + (location.port ? ':' + location.port : '');
        const origin = location.origin || (location.protocol + '//' + host);
        const manifestUrl = `${origin}/${code}/manifest.json`;
        const stremioLink = `stremio://${host}/${code}/manifest.json`;
        const webLink = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;

        linkbox.textContent = stremioLink;
        manifestbox.textContent = manifestUrl;
        copyBtn.onclick = () => copyText(stremioLink);
        webBtn.onclick = () => window.open(webLink, '_blank');
        result.classList.add('show');

        try {
          const a = document.createElement('a');
          a.href = stremioLink;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => a.remove(), 1200);
        } catch (e) {}

        setTimeout(() => {
          try { window.location.href = stremioLink; } catch (e) {}
        }, 250);
      });
    });
  </script>
</body>
</html>`;

app.get(['/', '/configure', '/:cfg/configure'], (req, res) => res.type('html').send(PAGE));

app.listen(PORT, () => console.log(`BestPlay on :${PORT}`));
