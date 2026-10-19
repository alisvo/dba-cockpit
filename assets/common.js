/* DBA Cockpit – ortak yardımcılar ve Vue bileşenleri.
 * Tüm hesaplama tarayıcıda yapılır; hiçbir veri sunucuya gönderilmez. */
(function () {
  'use strict';
  const { createApp, ref, reactive, computed, watch } = Vue;

  // ------------------------------------------------------------------
  // Güvenli localStorage erişimi (gizli pencerede / engelli depolamada patlamasın)
  // ------------------------------------------------------------------
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* yok say */ } },
    del(key) { try { localStorage.removeItem(key); } catch (e) { /* yok say */ } }
  };

  // ------------------------------------------------------------------
  // Tema
  // ------------------------------------------------------------------
  const THEME_KEY = 'dbac.theme';
  const theme = ref(store.get(THEME_KEY) ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  const applyTheme = () => { document.documentElement.dataset.theme = theme.value; };
  applyTheme();
  watch(theme, () => { applyTheme(); store.set(THEME_KEY, theme.value); });

  // ------------------------------------------------------------------
  // Bildirim, kopyalama, indirme
  // ------------------------------------------------------------------
  const toasts = reactive([]);
  function toast(message, type = 'ok') {
    const id = Date.now() + Math.random();
    toasts.push({ id, message, type });
    setTimeout(() => {
      const i = toasts.findIndex(t => t.id === id);
      if (i >= 0) toasts.splice(i, 1);
    }, 2600);
  }

  async function copy(text, message = 'Panoya kopyalandı') {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast(message);
    } catch (e) {
      toast('Kopyalama başarısız oldu', 'error');
    }
  }

  function download(text, filename) {
    const blob = new Blob([text.endsWith('\n') ? text : text + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(filename + ' indirildi');
  }

  // ------------------------------------------------------------------
  // Kriptografik güvenli şifre üretici (modulo bias olmadan)
  // Varsayılan semboller SQL*Plus (&), shell ($ ! `), URI (@ / :) ve
  // tırnak kaçışı sorunu yaratmayacak şekilde seçildi.
  // ------------------------------------------------------------------
  function randInt(max) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max;
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }
  function genPassword(len = 20, opts = {}) {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digit = '23456789';
    const sym = opts.symbols != null ? opts.symbols : '#_-+=*.^~';
    const groups = [upper, lower, digit];
    if (sym) groups.push(sym);
    const all = groups.join('');
    const out = groups.map(g => g[randInt(g.length)]);
    while (out.length < len) out.push(all[randInt(all.length)]);
    for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    // Oracle şifreleri harfle başlamalı (tırnaksız kullanım için de güvenli olsun)
    if (opts.letterFirst && !/[A-Za-z]/.test(out[0])) {
      const k = out.findIndex(c => /[A-Za-z]/.test(c));
      [out[0], out[k]] = [out[k], out[0]];
    }
    return out.join('');
  }

  // ------------------------------------------------------------------
  // Metin / tanımlayıcı yardımcıları
  // ------------------------------------------------------------------
  const list = (s) => String(s || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);

  const PG_RESERVED = new Set('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric system_user table then to trailing true union unique user using variadic when where window with'.split(' '));
  const pgIdent = (n) => {
    n = String(n == null ? '' : n).trim();
    if (/^[a-z_][a-z0-9_$]*$/.test(n) && !PG_RESERVED.has(n)) return n;
    return '"' + n.replace(/"/g, '""') + '"';
  };
  // "schema.tablo" → her parçayı ayrı tırnakla
  const pgQName = (n) => String(n || '').split('.').map(p => pgIdent(p.replace(/^"|"$/g, ''))).join('.');
  const pgLit = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

  const msIdent = (n) => '[' + String(n == null ? '' : n).trim().replace(/^\[|\]$/g, '').replace(/\]/g, ']]') + ']';
  const msQName = (n) => String(n || '').split('.').map(msIdent).join('.');
  const msLit = (s) => "N'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

  const oraIdent = (n) => {
    n = String(n == null ? '' : n).trim();
    if (/^[A-Za-z][A-Za-z0-9_$#]*$/.test(n)) return n.toUpperCase();
    return '"' + n.replace(/"/g, '') + '"';
  };
  const oraLit = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

  // POSIX shell için güvenli tırnaklama
  const sh = (s) => {
    s = String(s == null ? '' : s);
    if (s === '') return "''";
    if (/^[\w@%+=:,./-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  };

  // MB → okunur boyut (tam GB değilse MB bırakılır, yuvarlama hatası yapılmaz)
  const sizeMB = (mb) => {
    mb = Math.max(0, Math.round(mb));
    if (mb >= 1024 && mb % 1024 === 0) return (mb / 1024) + 'GB';
    return mb + 'MB';
  };

  const stamp = () => {
    const d = new Date(), p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  };

  // ------------------------------------------------------------------
  // Hafif sözdizimi renklendirici
  // ------------------------------------------------------------------
  const SQL_KW = new Set(('select from where and or not in is null as on join left right inner outer full cross apply ' +
    'group by order having limit offset fetch first next rows row only union all distinct case when then else end ' +
    'insert into values update set delete merge using create alter drop truncate table view index unique primary key ' +
    'foreign references constraint default check sequence trigger procedure function package body return returns ' +
    'begin declare exec execute immediate if exists loop for while do raise exception commit rollback savepoint ' +
    'grant revoke to with without role user login password schema database tablespace datafile tempfile size ' +
    'autoextend maxsize next unlimited quota profile identified account unlock lock nolock nowait asc desc ' +
    'over partition window recursive lateral cast coalesce nvl nullif between like ilike escape any some ' +
    'system session kill disconnect post_transaction go use backup restore log disk url recovery norecovery standby ' +
    'replace move stats checksum compression copy_only init noinit format differential vacuum analyze verbose freeze ' +
    'cluster reindex concurrently comment owner encoding template connection limit superuser nosuperuser createdb ' +
    'nocreatedb createrole nocreaterole nologin replication bypassrls inherit noinherit privileges usage connect ' +
    'temporary temp sequences tables schemas functions types reset reassign owned cascade restrict including contents ' +
    'datafiles constraints bigfile smallfile extent management local autoallocate segment space auto resize ' +
    'scope spfile memory both show parameter shrinkfile truncateonly emptyfile filegroup file filename filegrowth ' +
    'add remove modify single_user multi_user restricted_user rollback_snapshot read write committed uncommitted ' +
    'isolation level snapshot serializable repeatable top percent output inserted deleted nocount print raiserror ' +
    'try catch throw run allocate channel device type incremental archivelog plus input obsolete expired crosscheck ' +
    'validate controlfile current spfile until time sequence thread scn noprompt sql_id inst_id true false yes no ' +
    'online offline maxdop sort_in_tempdb fillfactor rebuild reorganize statistics reconfigure override sp_configure ' +
    'dbcc checkdb filelistonly headeronly verifyonly stopat encryption algorithm server certificate filestream ' +
    'local_temp prior nulls last explain buffers settings analyze_ costs timing summary returning conflict nothing ' +
    'listen_addresses').split(/\s+/));
  const SH_KW = new Set('sudo export kill if then fi for in do done echo cd mkdir chown chmod docker exec run nohup time su set unset'.split(' '));
  const CODE_KW = new Set('import from as def return with print const let var function async await new try catch finally class public static void package func main defer err nil if else for require module exports using namespace string int'.split(' '));

  const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function tokenRegex(lang) {
    const p = [];
    if (lang === 'sql') p.push(String.raw`--[^\n]*`, String.raw`\/\*[\s\S]*?\*\/`, String.raw`^\s*REM\b[^\n]*`);
    if (lang === 'sh' || lang === 'py' || lang === 'conf' || lang === 'ps') p.push(String.raw`(?:^|(?<=\s))#[^\n]*`);
    if (lang === 'ini') p.push(String.raw`^\s*[;#][^\n]*`);
    if (lang === 'js' || lang === 'go' || lang === 'cs' || lang === 'java') p.push(String.raw`\/\/[^\n]*`, String.raw`\/\*[\s\S]*?\*\/`);
    const comment = p.length ? '(' + p.join('|') + ')' : '(?!)';
    const str = String.raw`(N?'(?:[^'\n]|'')*'|"(?:[^"\\\n]|\\.)*"|\x60[^\x60]*\x60)`;
    const variable = lang === 'sh' || lang === 'ps'
      ? String.raw`(\$\{[^}\n]+\}|\$\(|\$[A-Za-z_]\w*|(?<=\s)--?[A-Za-z][\w-]*)`
      : String.raw`(@@?[A-Za-z_]\w*|\$\$|\$[A-Za-z_]\w*\$|&&?[A-Za-z_]\w*)`;
    const num = String.raw`(\b\d+(?:\.\d+)?(?:[KMGTP]B?|ms|s|min|h)?\b)`;
    const word = String.raw`([A-Za-z_][\w$#]*)(?=(\s*\()?)`;
    return new RegExp([comment, str, variable, num, word].join('|'), 'gm');
  }
  const RX_CACHE = {};

  function highlight(code, lang = 'sql') {
    code = String(code == null ? '' : code);
    if (lang === 'text') return esc(code);
    const rx = RX_CACHE[lang] || (RX_CACHE[lang] = tokenRegex(lang));
    const kws = lang === 'sql' ? SQL_KW : lang === 'sh' ? SH_KW : CODE_KW;
    let out = '', last = 0, m;
    rx.lastIndex = 0;
    while ((m = rx.exec(code))) {
      if (m[0] === '') { rx.lastIndex++; continue; }
      out += esc(code.slice(last, m.index));
      const t = esc(m[0]);
      if (m[1]) out += `<span class="tk-com">${t}</span>`;
      else if (m[2]) out += `<span class="tk-str">${t}</span>`;
      else if (m[3]) out += `<span class="tk-var">${t}</span>`;
      else if (m[4]) out += `<span class="tk-num">${t}</span>`;
      else if (m[5]) {
        const w = m[5].toLowerCase();
        if (kws.has(w)) out += `<span class="tk-kw">${t}</span>`;
        else if (m[6]) out += `<span class="tk-fn">${t}</span>`;
        else out += t;
      } else out += t;
      last = m.index + m[0].length;
    }
    return out + esc(code.slice(last));
  }

  // Not metinlerinde `kod` → <code>kod</code> (önce HTML kaçışı yapılır)
  const md = (s) => esc(String(s || '')).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

  // ------------------------------------------------------------------
  // Kalıcı form durumu (şifre gibi alanlar hariç tutulur)
  // ------------------------------------------------------------------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function persisted(key, defaults, omit = []) {
    const k = 'dbac.' + key;
    const state = reactive(clone(defaults));
    const saved = store.get(k);
    if (saved && typeof saved === 'object') {
      for (const f of Object.keys(defaults)) {
        if (omit.includes(f) || !(f in saved)) continue;
        if (typeof saved[f] === typeof defaults[f] || (Array.isArray(defaults[f]) && Array.isArray(saved[f]))) state[f] = saved[f];
      }
    }
    let t;
    watch(state, () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const o = clone(state);
        omit.forEach(f => delete o[f]);
        store.set(k, o);
      }, 250);
    }, { deep: true });
    const reset = () => { Object.assign(state, clone(defaults)); store.del(k); };
    return [state, reset];
  }

  // ------------------------------------------------------------------
  // URL hash ile modül yönlendirme (#modul) – derin bağlantı ve geri tuşu çalışır
  // ------------------------------------------------------------------
  function hashRoute(ids, def) {
    const read = () => { const h = decodeURIComponent(location.hash.slice(1)); return ids.includes(h) ? h : def; };
    const cur = ref(read());
    window.addEventListener('hashchange', () => { cur.value = read(); window.scrollTo({ top: 0 }); });
    return cur;
  }

  // ------------------------------------------------------------------
  // Bileşenler
  // ------------------------------------------------------------------
  const ENGINES = [
    { id: 'oracle', label: 'Oracle', href: 'oracle/' },
    { id: 'postgres', label: 'PostgreSQL', href: 'postgres/' },
    { id: 'sqlserver', label: 'SQL Server', href: 'sqlserver/' }
  ];

  const AppTop = {
    props: { engine: String, root: { type: String, default: '../' } },
    setup() { return { theme, ENGINES }; },
    template: `
      <header class="topbar"><div class="topbar-in">
        <a class="brand" :href="root || './'">
          <span class="brand-logo">⌘</span>
          <span class="t">DBA Cockpit<small>Oracle · PostgreSQL · SQL Server</small></span>
        </a>
        <nav class="engine-tabs" aria-label="Veritabanı motoru">
          <a v-for="e in ENGINES" :key="e.id" :href="root + e.href" :class="{ on: e.id === engine }">{{ e.label }}</a>
        </nav>
        <div class="top-actions">
          <span class="privacy" title="Hiçbir girdi sunucuya gönderilmez">Veriler tarayıcıda kalır</span>
          <button class="btn icon-btn" :title="theme === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç'"
            @click="theme = theme === 'dark' ? 'light' : 'dark'">{{ theme === 'dark' ? '☀' : '☾' }}</button>
        </div>
      </div></header>`
  };

  const AppFoot = {
    setup() { return { toasts }; },
    template: `
      <footer class="foot">
        <span>DBA Cockpit · %100 istemci taraflı · Hiçbir girdi kaydedilmez veya gönderilmez (form tercihleri yalnızca bu tarayıcıda saklanır, şifreler hariç)</span>
        <span>Üretilen komutları önce test ortamında doğrulayın.</span>
      </footer>
      <div class="toasts" role="status" aria-live="polite">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div>
      </div>`
  };

  const SideNav = {
    props: { modules: Array, current: String, title: String },
    template: `
      <aside class="side">
        <div class="side-title">{{ title }}</div>
        <a v-for="m in modules" :key="m.id" :href="'#' + m.id" :class="{ on: m.id === current }">
          <span class="ico">{{ m.icon }}</span><span>{{ m.name }}</span>
        </a>
        <div class="side-note"><slot></slot></div>
      </aside>`
  };

  const CodeBox = {
    props: { title: String, code: String, lang: { type: String, default: 'sql' }, file: String, wrap: Boolean },
    setup(props) {
      const copied = ref(false);
      const html = computed(() => highlight(props.code, props.lang));
      const doCopy = async () => { await copy(props.code, (props.title || 'Kod') + ' kopyalandı'); copied.value = true; setTimeout(() => copied.value = false, 1600); };
      const doDownload = () => download(props.code, props.file || 'script.sql');
      return { copied, html, doCopy, doDownload };
    },
    template: `
      <div class="code" :class="{ wrap }">
        <div class="code-head">
          <span class="code-title"><span class="lang">{{ lang }}</span>{{ title }}</span>
          <span class="code-actions">
            <button v-if="file" class="btn sm ghost" @click="doDownload" title="Dosya olarak indir">⭳ İndir</button>
            <button class="btn sm" :class="copied ? 'ok' : 'primary'" @click="doCopy">{{ copied ? '✓ Kopyalandı' : 'Kopyala' }}</button>
          </span>
        </div>
        <pre v-html="html"></pre>
      </div>`
  };

  const Notes = {
    props: { items: Array },
    setup() { return { md }; },
    template: `
      <div class="notes" v-if="items && items.length">
        <div v-for="(n, i) in items" :key="i" class="note" :class="n[0]"><span v-html="md(n[1])"></span></div>
      </div>`
  };

  const Seg = {
    props: { modelValue: [String, Number, Boolean], options: Array, full: Boolean },
    emits: ['update:modelValue'],
    template: `
      <div class="seg" :class="{ full }" role="radiogroup">
        <button v-for="o in options" :key="String(o[0])" type="button" role="radio" :aria-checked="modelValue === o[0]"
          :class="{ on: modelValue === o[0] }" @click="$emit('update:modelValue', o[0])">{{ o[1] }}</button>
      </div>`
  };

  const Chk = {
    props: { modelValue: Boolean, risky: Boolean },
    emits: ['update:modelValue'],
    template: `
      <label class="chk" :class="{ on: modelValue, risky }">
        <input type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked)">
        <span><slot></slot></span>
      </label>`
  };

  const QueryLib = {
    props: { queries: Array, cats: Array, lang: { type: String, default: 'sql' }, engine: String },
    setup(props) {
      const q = ref('');
      const cat = ref('all');
      const norm = (s) => String(s || '').toLocaleLowerCase('tr');
      const counts = computed(() => {
        const c = { all: props.queries.length };
        props.queries.forEach(x => { c[x.cat] = (c[x.cat] || 0) + 1; });
        return c;
      });
      const shown = computed(() => {
        const s = norm(q.value).trim();
        return props.queries.filter(x => (cat.value === 'all' || x.cat === cat.value) &&
          (!s || norm(x.title + ' ' + x.desc + ' ' + x.sql + ' ' + (x.tip || '')).includes(s)));
      });
      const catLabel = (id) => (props.cats.find(c => c[0] === id) || [id, id])[1];
      return { q, cat, counts, shown, catLabel, md };
    },
    template: `
      <div class="stack">
        <div class="card">
          <div class="qlib-bar">
            <input v-model="q" type="text" placeholder="Ara: lock, temp, index, backup, wait…" aria-label="Sorgu ara">
            <span class="sub">{{ shown.length }} / {{ queries.length }} sorgu</span>
          </div>
          <div class="pills" style="margin-top:12px">
            <button class="pill" :class="{ on: cat === 'all' }" @click="cat = 'all'">Tümü<span class="n">{{ counts.all }}</span></button>
            <button v-for="c in cats" :key="c[0]" class="pill" :class="{ on: cat === c[0] }" @click="cat = c[0]">{{ c[1] }}<span class="n">{{ counts[c[0]] || 0 }}</span></button>
          </div>
        </div>
        <div class="qcards" v-if="shown.length">
          <div v-for="x in shown" :key="x.id" class="qcard" :class="{ 'has-tip': x.tip }">
            <div class="qhead">
              <div class="qmeta"><span class="tag">{{ catLabel(x.cat) }}</span><span v-if="x.ver" class="tag grey">{{ x.ver }}</span></div>
              <h4>{{ x.title }}</h4>
              <p>{{ x.desc }}</p>
            </div>
            <code-box :title="x.id" :code="x.sql" :lang="lang" :file="x.id + '.sql'"></code-box>
            <div v-if="x.tip" class="qtip" v-html="'<b>Yorum:</b> ' + md(x.tip)"></div>
          </div>
        </div>
        <div v-else class="empty">Aramanızla eşleşen sorgu yok.</div>
      </div>`
  };

  function mount(options) {
    const app = createApp(options);
    app.component('app-top', AppTop);
    app.component('app-foot', AppFoot);
    app.component('side-nav', SideNav);
    app.component('code-box', CodeBox);
    app.component('notes', Notes);
    app.component('seg', Seg);
    app.component('chk', Chk);
    app.component('query-lib', QueryLib);
    Object.assign(app.config.globalProperties, { copy, download, toast });
    return app.mount('#app');
  }

  window.DBA = {
    mount, persisted, hashRoute, toast, copy, download, genPassword, highlight, md,
    list, pgIdent, pgQName, pgLit, msIdent, msQName, msLit, oraIdent, oraLit, sh, sizeMB, stamp
  };
})();
