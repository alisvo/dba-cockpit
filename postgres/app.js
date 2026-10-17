/* PostgreSQL DBA Cockpit – 13 / 14 / 15 / 16 / 17 */
(function () {
  const { computed, ref } = Vue;
  const { persisted, hashRoute, genPassword, list, pgIdent, pgQName, pgLit, sh, sizeMB } = DBA;

  const modules = [
    { id: 'backup', name: 'Yedekleme', icon: '📦' },
    { id: 'roles', name: 'Rol & Kullanıcı', icon: '👤' },
    { id: 'storage', name: 'DB & Tablespace & Vacuum', icon: '💾' },
    { id: 'sessions', name: 'Oturum & Kill', icon: '⚡' },
    { id: 'queries', name: 'Teşhis Sorguları', icon: '🔍' },
    { id: 'connection', name: 'Bağlantı & Config', icon: '🌐' },
    { id: 'pgtune', name: 'PGTune / Bellek', icon: '🧮' }
  ];

  // ------------------------------------------------------------------
  // Yardımcılar
  // ------------------------------------------------------------------
  const txt = (v, d = '') => { const s = String(v == null ? '' : v).trim(); return s || d; };
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const tidy = (n) => String(Number(Number(n).toFixed(3)));
  // Kabuk yolu: $(...) içeriyorsa komut yerine geçirme bozulmasın diye tırnaklanmaz
  const pathQ = (p) => (/\$\(|`/.test(p) ? p : sh(p));
  // libpq anahtar=değer değeri
  const kvq = (v) => (/^[^\s'\\]+$/.test(v) ? v : "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
  const PASS_NOTE = ['tip', 'Parola komuta yazılmaz. Kimlik için `~/.pgpass` (Windows: `%APPDATA%\\postgresql\\pgpass.conf`; Linux\'ta `chmod 600`) veya `PGPASSWORD` ortam değişkeni kullanın; böylece parola `ps` çıktısında ve shell geçmişinde görünmez.'];

  // ==================================================================
  // 1. YEDEKLEME (pg_dump / pg_restore / pg_dumpall / pg_basebackup)
  // ==================================================================
  const dumpFormats = [
    { key: 'c', flag: '-Fc', label: 'Custom (önerilen) · sıkıştırılmış, seçici restore' },
    { key: 'd', flag: '-Fd', label: 'Directory · paralel (-j) için' },
    { key: 't', flag: '-Ft', label: 'Tar arşivi' },
    { key: 'p', flag: '-Fp', label: 'Düz SQL · pg_restore okumaz, psql ile yüklenir' }
  ];

  const [bk, resetBk] = persisted('pg.backup', {
    tool: 'pg_dump', host: '127.0.0.1', port: 5432, username: 'postgres', database: 'production_db',
    path: '/backup/production_db.dump', format: 'c', content: 'all',
    inSchema: '', exSchema: '', inTable: '', exTable: '', exTableData: '',
    jobs: 4, compression: 'default', clean: true, ifExists: true, create: false,
    noOwner: true, noPrivs: true, verbose: true, blobs: true, singleTx: false, globalsOnly: false,
    docker: false, container: 'postgres_container',
    bcDir: '/var/lib/postgresql/17/main', bcFormat: 'p', bcWal: 'stream', bcRecovery: true,
    bcSlot: 'standby1', bcCreateSlot: true, bcCheckpoint: 'fast', bcProgress: true,
    bcRate: '', bcCompress: 'none'
  });

  const bkCanJobs = computed(() => (bk.tool === 'pg_dump' && bk.format === 'd') ||
    (bk.tool === 'pg_restore' && !bk.singleTx && (bk.format === 'c' || bk.format === 'd')));

  // pg_basebackup komut üretici
  const baseOut = computed(() => {
    const b = bk, notes = [], T = [], legend = new Map();
    const add = (tok, name, desc) => { T.push(tok); if (!legend.has(name)) legend.set(name, desc); };
    const port = int(b.port, 5432);
    const slot = txt(b.bcSlot);
    if (txt(b.host)) add('-h ' + sh(txt(b.host)), '-h', 'Sunucu adresi (primary)');
    if (port !== 5432) add('-p ' + port, '-p', 'Port');
    if (txt(b.username)) add('-U ' + sh(txt(b.username)), '-U', 'Replikasyon yetkisi olan kullanıcı');
    add('-D ' + pathQ(txt(b.bcDir, '/var/lib/postgresql/17/main')), '-D', 'Yedek hedef dizini (boş olmalı)');
    add('-F' + b.bcFormat, '-F' + b.bcFormat, b.bcFormat === 't' ? 'Tar formatı (base.tar + pg_wal.tar)' : 'Düz format: veri dizini kopyası');
    add('-X' + (b.bcWal === 'stream' ? 's' : 'f'), '-X', b.bcWal === 'stream' ? 'WAL, yedekleme sırasında akışla (stream) toplanır' : 'WAL, yedek bitince getirilir (fetch)');
    if (b.bcProgress) add('-P', '-P', 'İlerleme göstergesi');
    if (b.bcRecovery) add('-R', '-R', 'Standby ayarını yazar (primary_conninfo + standby.signal)');
    if (b.bcCheckpoint === 'fast') add('--checkpoint=fast', '--checkpoint', 'Başlangıçta hızlı checkpoint (I/O yükü artar)');
    if (slot) add('--slot=' + sh(slot), '--slot', 'Replication slot adı (gereken WAL korunur)');
    if (b.bcCreateSlot) {
      if (slot) add('-C', '-C', 'Slot yoksa oluşturur (--slot ile)');
      else notes.push(['danger', '`-C` (slot oluştur) için **--slot** gerekir; slot adı boş olduğu için `-C` kaldırıldı.']);
    }
    if (txt(b.bcRate)) add('--max-rate=' + sh(txt(b.bcRate)), '--max-rate', 'Aktarım hızı sınırı (ör. 50M)');
    if (b.bcCompress === 'gzip') add('-z', '-z', 'gzip sıkıştırma');
    else if (b.bcCompress !== 'none') add('--compress=' + b.bcCompress, '--compress', 'Sıkıştırma yöntemi (PG15+)');

    if (b.bcCompress !== 'none' && b.bcFormat === 'p') notes.push(['info', 'Sıkıştırma genelde tar formatıyla (`-Ft`) kullanılır; düz formatta (`-Fp`) sürüme göre kısıt olabilir.']);
    notes.push(['info', 'Replikasyon kullanıcısı **REPLICATION** yetkisine sahip olmalı (`ALTER ROLE replicator WITH REPLICATION LOGIN;`) ve primary `pg_hba.conf` içinde `replication` satırı bulunmalı: `host replication replicator 10.0.0.0/16 scram-sha-256`.']);
    if (b.bcRecovery) notes.push(['tip', '`-R` (PG12+): `standby.signal` ve `primary_conninfo` yazar. Standby\'ı başlatmadan önce `postgresql.auto.conf` içeriğini kontrol edin.']);
    if (slot && b.bcCreateSlot) notes.push(['info', 'Slot primary üzerinde oluşturulur; `max_replication_slots` yeterli olmalı. İş bittikten sonra kullanılmayan slot bırakmayın; WAL birikir.']);
    notes.push(PASS_NOTE);
    return {
      cmd: ['pg_basebackup', ...T].join(' \\\n  '),
      notes,
      legend: [...legend.entries()],
      file: 'pg_basebackup_task.sh'
    };
  });

  const backupOut = computed(() => {
    if (bk.tool === 'pg_basebackup') return baseOut.value;
    const b = bk, notes = [], T = [], legend = new Map();
    const add = (tok, name, desc) => { T.push(tok); if (!legend.has(name)) legend.set(name, desc); };
    const isDump = b.tool === 'pg_dump', isRestore = b.tool === 'pg_restore', isAll = b.tool === 'pg_dumpall';
    const fmt = b.format, docker = !!b.docker, cont = txt(b.container, 'postgres_container');
    const prog = isDump ? 'pg_dump' : isRestore ? 'pg_restore' : 'pg_dumpall';
    const rawPath = txt(b.path);
    const port = int(b.port, 5432);
    const tmpDir = '/tmp/pgcockpit_dir';

    if (/\$\(/.test(rawPath)) notes.push(['info', 'Yol `$(...)` içerdiği için kabuk komut yerine geçirmesi çalışır; bu nedenle tırnaklanmadı.']);

    // Bağlantı bayrakları (ortak)
    const connArgs = [];
    if (txt(b.host)) connArgs.push(['-h ' + sh(txt(b.host)), '-h', 'Sunucu adresi']);
    if (port !== 5432) connArgs.push(['-p ' + port, '-p', 'Port']);
    if (txt(b.username)) connArgs.push(['-U ' + sh(txt(b.username)), '-U', 'Kullanıcı']);

    // ---------- Özel durum: pg_restore + düz SQL (-Fp) → psql ----------
    if (isRestore && fmt === 'p') {
      const dbArg = b.create ? 'postgres' : (txt(b.database) || 'postgres');
      const inPath = rawPath || 'backup.sql';
      notes.push(['info', 'pg_restore düz SQL (`-Fp`) dosyasını okuyamaz; bu seçimde `psql` ile geri yükleme komutu üretildi.']);
      if (!rawPath) notes.push(['info', 'Girdi dosyası boş; örnek olarak `backup.sql` kullanıldı.']);
      if (b.create) notes.push(['info', 'Düz SQL dosyası `-C` ile üretildiyse içinde `CREATE DATABASE` ve `\\connect` bulunur; `psql` bakım veritabanına (`postgres`) bağlanır.']);
      if (b.clean) notes.push(['info', 'Düz SQL dosyasında `-c` (temizle) psql tarafından uygulanmaz; temizlik gerekiyorsa dökümü `-c` ile yeniden alın.']);
      connArgs.forEach(([t, n, d]) => add(t, n, d));
      add('-d ' + sh(dbArg), '-d', 'Hedef veritabanı');
      add('-v ON_ERROR_STOP=1', '-v', 'İlk hatada dur');
      if (b.singleTx) add('-1', '-1', 'Tek transaction (hata olursa tümü geri alınır)');
      let code;
      if (docker) {
        code = ['docker exec -i ' + cont + ' psql \\\n  ' + T.join(' \\\n  ') + ' \\\n  < ' + pathQ(inPath)];
        notes.push(['info', 'Docker: dosya `stdin` üzerinden verilir (`docker exec -i`, `-t` kullanılmaz).']);
      } else {
        add('-f ' + pathQ(inPath), '-f', 'Girdi SQL dosyası');
        code = ['psql \\\n  ' + T.join(' \\\n  ')];
      }
      notes.push(PASS_NOTE);
      return { cmd: code.join('\n'), notes, legend: [...legend.entries()], file: 'psql_restore_task.sh' };
    }

    // ---------- pg_dump / pg_restore / pg_dumpall ----------
    const hasFilter = isDump || isRestore;
    let useJobs = int(b.jobs, 1) > 1;
    const jobs = Math.max(1, int(b.jobs, 1));
    if (isRestore && b.singleTx && useJobs) { notes.push(['danger', '`--single-transaction` ile `-j` birlikte kullanılamaz; pg_restore hata verir. `-j` kaldırıldı.']); useJobs = false; }
    if (isRestore && fmt === 't' && useJobs) { notes.push(['info', 'Tar formatında (`-Ft`) paralel restore (`-j`) desteklenmez; `-j` kaldırıldı.']); useJobs = false; }
    if (isRestore && docker && fmt !== 'd' && useJobs) { notes.push(['info', 'Docker\'da dosya `stdin` üzerinden okunduğu için paralel restore (`-j`) mümkün değil; `-j` kaldırıldı. Dizin formatı (`-Fd`) `docker cp` ile konteynere kopyalanarak paralel çalıştırılabilir.']); useJobs = false; }
    if (isDump && fmt !== 'd' && useJobs) { notes.push(['info', '`-j` yalnızca `-Fd` (directory) formatında pg_dump ile kullanılabilir; bu seçimde atlandı.']); useJobs = false; }
    if (isAll && useJobs) { notes.push(['info', '`pg_dumpall` paralel (`-j`) desteklemez; atlandı.']); useJobs = false; }

    let clean = !!b.clean;
    if (clean && b.content === 'data') {
      notes.push(['danger', '`-c` (temizle) ile `-a` (yalnızca veri) birlikte geçersizdir; yalnızca veri yüklenirken nesne DROP edilemez. `-c` kaldırıldı; hedef tabloları önceden `TRUNCATE` edin.']);
      clean = false;
    }

    connArgs.forEach(([t, n, d]) => add(t, n, d));
    if (isDump) {
      const fd = dumpFormats.find(f => f.key === fmt);
      add(fd.flag, fd.flag, fd.label);
    }
    if (useJobs) add('-j ' + jobs, '-j', jobs + ' paralel iş parçacığı');
    if (b.content === 'schema') add('-s', '-s', 'Yalnızca şema (DDL)');
    if (b.content === 'data') add('-a', '-a', 'Yalnızca veri (COPY)');

    if (hasFilter) {
      list(b.inSchema).forEach(x => add('-n ' + sh(x), '-n', 'Dahil edilecek şema (desen)'));
      list(b.exSchema).forEach(x => add('-N ' + sh(x), '-N', 'Hariç tutulacak şema (desen)'));
      list(b.inTable).forEach(x => add('-t ' + sh(x), '-t', 'Dahil edilecek tablo (desen)'));
      if (isDump) list(b.exTable).forEach(x => add('-T ' + sh(x), '-T', 'Hariç tutulacak tablo (desen)'));
      else if (list(b.exTable).length) notes.push(['warn', 'pg_restore\'da `-T` tablo hariç tutmaz, **trigger** seçer. Tablo hariç tutmak için `pg_restore -l dump > list.txt` ile listeyi alıp satırları silin, sonra `-L list.txt` ile geri yükleyin. Bu yüzden `-T` eklenmedi.']);
    }
    if (isDump) list(b.exTableData).forEach(x => add('--exclude-table-data=' + sh(x), '--exclude-table-data', 'Bu tabloların verisi atlanır (şema kalır)'));

    if (isDump && b.blobs) {
      if (list(b.inSchema).length || list(b.inTable).length) add('-b', '-b', 'Büyük nesneleri (large objects) filtreye rağmen dahil et');
      else notes.push(['info', '`-b` yalnızca `-n`/`-t` filtresi kullanılırken gerekir; filtre yoksa büyük nesneler zaten dahil edilir, bayrak eklenmedi.']);
    }

    if (clean) {
      add('-c', '-c', 'Nesneleri yüklemeden önce DROP eder');
      if (b.ifExists) add('--if-exists', '--if-exists', 'DROP öncesi IF EXISTS (hata üretmez)');
    }
    if (b.create && isDump) add('-C', '-C', 'Dökümün başına CREATE DATABASE ekler');
    if (b.create && isRestore) {
      add('-C', '-C', 'Veritabanını dosyadan oluşturur');
      notes.push(['info', '`-C` ile `-d` hedef veritabanı değil bakım veritabanı (`postgres`) olmalı; `-d postgres` kullanıldı.']);
    }
    if (b.noOwner) add('-O', '-O', 'Sahiplik (OWNER TO) ifadelerini atlar');
    if (b.noPrivs) add('-x', '-x', 'GRANT/REVOKE yetki ifadelerini atlar');
    if (b.verbose) add('-v', '-v', 'Ayrıntılı çıktı');
    if (isRestore && b.singleTx) add('--single-transaction', '--single-transaction', 'Hata olursa tüm restore geri alınır');
    if (isAll && b.globalsOnly) {
      add('-g', '-g', 'Yalnızca roller ve tablespace\'ler (veri yok)');
      notes.push(['info', '`-g` yalnızca roller ve tablespace\'leri yazar; veritabanı verisi içermez.']);
    }
    if (isDump && b.compression !== 'default') {
      add('-Z ' + b.compression, '-Z', 'Sıkıştırma: ' + b.compression);
      if (b.compression === 'lz4' || b.compression === 'zstd') notes.push(['info', '`lz4` / `zstd` sıkıştırma pg_dump için **PG16+** gerektirir.']);
      if (fmt === 'p' || fmt === 't') notes.push(['info', 'Düz (`-Fp`) ve tar (`-Ft`) formatlarında `-Z` davranışı sürüme göre değişir; sıkıştırma için genelde `-Fc` veya `-Fd` tercih edilir.']);
    }

    const db = isRestore && b.create ? 'postgres' : txt(b.database);
    if (isDump || isRestore) {
      if (db) add('-d ' + sh(db), '-d', 'Hedef veritabanı');
      else if (isRestore) notes.push(['warn', 'Hedef veritabanı boş: `pg_restore -d` olmadan SQL ekrana yazılır. `-d` için veritabanı girin.']);
    }

    // ---------- Çıktı / girdi ve docker sarmalayıcı ----------
    const lines = [];
    const inPath = rawPath || 'backup.dump';
    if (isRestore && !rawPath) notes.push(['info', 'Girdi dosyası boş; örnek olarak `backup.dump` kullanıldı.']);
    const join = (first, arr) => [first, ...arr].join(' \\\n  ');

    if (docker) notes.push(['info', 'Docker: `docker exec -i` kullanılır (`-t` **kullanılmaz**; TTY ikili çıktıyı bozar). Konteyner içindeki bağlantı ayarları (`-h`, `-p`) konteynerin kendi görüşüne göre çözülür.']);

    if (isRestore) {
      if (docker && fmt === 'd') {
        lines.push(`docker cp ${pathQ(inPath)} ${cont}:${tmpDir}`);
        lines.push(join(`docker exec -i ${cont} ${prog}`, [...T, tmpDir]));
        lines.push(`docker exec ${cont} rm -rf ${tmpDir}`);
      } else if (docker) {
        lines.push(join(`docker exec -i ${cont} ${prog}`, T) + ' \\\n  < ' + pathQ(inPath));
      } else {
        lines.push(join(prog, [...T, pathQ(inPath)]));
      }
    } else if (docker) {
      if (fmt === 'd' && isDump) {
        lines.push(join(`docker exec -i ${cont} ${prog}`, [...T, '-f ' + tmpDir]));
        lines.push(`docker cp ${cont}:${tmpDir} ${pathQ(rawPath || './backup_dir')}`);
        lines.push(`docker exec ${cont} rm -rf ${tmpDir}`);
        notes.push(['info', 'Dizin formatı stdout\'a yazılamaz: konteyner içinde `/tmp` altına yazılır, `docker cp` ile kopyalanır.']);
      } else {
        const redir = rawPath ? ' \\\n  > ' + pathQ(rawPath) : '';
        lines.push(join(`docker exec -i ${cont} ${prog}`, T) + redir);
      }
    } else {
      if (rawPath) add('-f ' + pathQ(rawPath), '-f', 'Çıktı dosyası veya dizini');
      lines.push(join(prog, T));
    }

    if (isAll) notes.push(['info', '`pg_dumpall` tüm veritabanlarını ve rolleri tek düz SQL dosyasına yazar; büyük kurulumlarda `pg_dump -Fd` tercih edin.']);
    notes.push(PASS_NOTE);

    return { cmd: lines.join('\n'), notes, legend: [...legend.entries()], file: 'backup_task.sh' };
  });

  // ==================================================================
  // 2. ROL & KULLANICI
  // ==================================================================
  const [rl, resetRl] = persisted('pg.role', {
    preset: 'readonly', name: 'reporting_user', password: '', pwLen: 24,
    database: 'production_db', schema: 'public', owner: 'app_owner', connLimit: -1, validUntil: '',
    login: true, superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false,
    useReadAll: true, schemaCreate: true, members: ''
  }, ['password']);

  const regenPwd = (silent) => {
    const len = Math.min(48, Math.max(12, int(rl.pwLen, 24)));
    rl.password = genPassword(len);
    if (!silent) DBA.toast('Yeni şifre üretildi');
  };
  if (!rl.password) regenPwd(true);

  const ROLE_BASE = { login: true, superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false };
  const applyRolePreset = (p) => {
    rl.preset = p;
    if (p === 'readonly') Object.assign(rl, ROLE_BASE, { name: 'reporting_user', useReadAll: true });
    else if (p === 'app_rw') Object.assign(rl, ROLE_BASE, { name: 'app_backend', schemaCreate: true });
    else Object.assign(rl, ROLE_BASE, { name: 'app_readers_group', login: false });
    regenPwd(true);
  };
  const resetRoleAll = () => { resetRl(); regenPwd(true); DBA.toast('Rol formu varsayılana döndü'); };

  const roleOut = computed(() => {
    const r = rl, notes = [];
    const isGroup = r.preset === 'group_nologin';
    const login = !isGroup && !!r.login;
    const name = txt(r.name, 'app_user');
    const N = pgIdent(name), NL = pgLit(name);
    const db = txt(r.database, 'postgres');
    const schema = txt(r.schema, 'public'), S = pgIdent(schema);
    const owner = txt(r.owner);
    const defFor = owner ? ' FOR ROLE ' + pgIdent(owner) : '';
    const needDefault = !(r.preset === 'readonly' && r.useReadAll);

    const attrs = [login ? 'LOGIN' : 'NOLOGIN'];
    if (login && r.password) attrs.push('PASSWORD ' + pgLit(r.password));
    attrs.push(r.superuser ? 'SUPERUSER' : 'NOSUPERUSER', r.createdb ? 'CREATEDB' : 'NOCREATEDB',
      r.createrole ? 'CREATEROLE' : 'NOCREATEROLE', r.replication ? 'REPLICATION' : 'NOREPLICATION',
      r.bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS', 'CONNECTION LIMIT ' + int(r.connLimit, -1));
    if (txt(r.validUntil)) attrs.push('VALID UNTIL ' + pgLit(txt(r.validUntil)));

    const L = [
      '-- ================================================================',
      `-- PostgreSQL rol & yetki scripti: ${name}`,
      '-- Tekrar çalıştırılabilir (idempotent)',
      '-- ================================================================',
      '',
      '-- 1. Rolü oluştur veya güncelle ($do$ kullanılır: parolada $$ olsa bile bozulmaz)',
      'DO $do$',
      'BEGIN',
      `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${NL}) THEN`,
      `    CREATE ROLE ${N} WITH ${attrs.join(' ')};`,
      '  ELSE',
      `    ALTER ROLE ${N} WITH ${attrs.join(' ')};`,
      '  END IF;',
      'END',
      '$do$;',
      ''
    ];
    if (login && r.password) L.push('-- Alternatif: parolayı psql içinde girin (betik parolasız kalır, log\'a düşmez):', '-- psql: \\password ' + name, '');
    L.push('-- 2. Veritabanına bağlanma izni');
    L.push(`GRANT CONNECT ON DATABASE ${pgIdent(db)} TO ${N};`, '');
    L.push(`-- psql: \\c ${db} (diğer araçlarda hedef veritabanına bağlanın)`, '');

    if (r.preset === 'readonly') {
      if (r.useReadAll) {
        L.push('-- 3. PG14+: pg_read_all_data (KÜME GENELİ okuma yetkisi)', `GRANT pg_read_all_data TO ${N};`, '');
        notes.push(['info', '`pg_read_all_data` **tüm veritabanlarındaki** tablo, şema ve sequence\'ları okuyabilir (küme genelinde). Tek veritabanıyla sınırlamak için kutucuğu kaldırıp şema bazlı GRANT kullanın.']);
      } else {
        L.push('-- 3. Şema ve mevcut nesnelere okuma', `GRANT USAGE ON SCHEMA ${S} TO ${N};`,
          `GRANT SELECT ON ALL TABLES IN SCHEMA ${S} TO ${N};`, `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${S} TO ${N};`, '');
        L.push('-- 4. Sonradan oluşturulacak nesneler için', `ALTER DEFAULT PRIVILEGES${defFor} IN SCHEMA ${S} GRANT SELECT ON TABLES TO ${N};`,
          `ALTER DEFAULT PRIVILEGES${defFor} IN SCHEMA ${S} GRANT SELECT ON SEQUENCES TO ${N};`, '');
      }
    } else if (r.preset === 'app_rw') {
      L.push('-- 3. Uygulama: CRUD ve sequence yetkileri',
        r.schemaCreate ? `GRANT USAGE, CREATE ON SCHEMA ${S} TO ${N};` : `GRANT USAGE ON SCHEMA ${S} TO ${N};`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${S} TO ${N};`,
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${S} TO ${N};`, '');
      L.push('-- 4. Sonradan oluşturulacak nesneler için',
        `ALTER DEFAULT PRIVILEGES${defFor} IN SCHEMA ${S} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${N};`,
        `ALTER DEFAULT PRIVILEGES${defFor} IN SCHEMA ${S} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${N};`, '');
      if (schema === 'public' && r.schemaCreate) notes.push(['tip', 'PG15+ ile `public` şemasında PUBLIC rolünün `CREATE` yetkisi kaldırıldı. Uygulama rolünün tablo yaratabilmesi için bu scriptteki `GRANT USAGE, CREATE` satırı gereklidir.']);
    } else {
      L.push('-- 3. Grup rolüne şema ve nesne yetkileri', `GRANT USAGE ON SCHEMA ${S} TO ${N};`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${S} TO ${N};`, '');
      L.push('-- 4. Sonradan oluşturulacak tablolar için', `ALTER DEFAULT PRIVILEGES${defFor} IN SCHEMA ${S} GRANT SELECT ON TABLES TO ${N};`, '');
      const mem = list(r.members);
      if (mem.length) L.push('-- 5. Üyeler', `GRANT ${N} TO ${mem.map(m => pgIdent(m)).join(', ')};`);
      else L.push('-- 5. Üye eklemek için (gerçek kullanıcılar):', `-- GRANT ${N} TO kullanici_ahmet;`);
    }
    L.push('', '-- Kontrol',
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil FROM pg_roles WHERE rolname = ${NL};`,
      `SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = ${NL} ORDER BY 1, 2 LIMIT 50;`);

    if (r.superuser) notes.push(['danger', '**SUPERUSER** tüm veritabanı kontrolü ve OS erişimi (ör. `COPY ... PROGRAM`) anlamına gelir. Uygulama rolü için önerilmez.']);
    if (r.createrole) notes.push(['warn', '**CREATEROLE** rolü başka roller oluşturup yetki dağıtabilir; yetki yükseltmeye yol açabilir.']);
    if (r.bypassrls) notes.push(['warn', '**BYPASSRLS** Row Level Security politikalarını atlar.']);
    if (r.replication) notes.push(['info', '**REPLICATION** yalnızca replikasyon içindir; `pg_hba.conf` içinde `replication` satırı gerekir.']);
    if (login && r.password) notes.push(['info', 'Düz `PASSWORD` ifadesi sunucu loguna ve `pg_stat_statements`e düşebilir. Alternatif: psql içinde `\\password ROL`.']);
    if (!owner && needDefault) notes.push(['info', '**Nesne sahibi** boş: `ALTER DEFAULT PRIVILEGES` `FOR ROLE` olmadan yazıldı; bu yalnızca **şu an scripti çalıştıran** rolün yarattığı nesneleri kapsar. Tabloları başka bir rol yaratıyorsa sahibini girin.']);
    if (isGroup) notes.push(['tip', 'NOLOGIN grup rolü doğrudan giriş yapamaz; kullanıcıları `GRANT grup TO kullanici` ile gruba ekleyin. Yetkiler gruba verilir.']);
    notes.push(['info', 'Veritabanı bazlı yetkiler (`GRANT ... ON DATABASE`, şema/nesne) her veritabanında ayrı verilir; yukarıdaki satırlar `\\c` ile hedef veritabanında çalıştırılmalıdır.']);

    return { sql: L.join('\n'), notes, file: 'create_role.sql' };
  });

  const roleDrop = computed(() => {
    const name = txt(rl.name, 'target_role');
    const N = pgIdent(name), NL = pgLit(name);
    return [
      `-- '${name}' rolünü güvenle silme`,
      '-- 1. Rolün açık oturumlarını sonlandır',
      'SELECT pg_terminate_backend(pid)',
      'FROM pg_stat_activity',
      `WHERE usename = ${NL}`,
      '  AND pid <> pg_backend_pid();',
      '',
      '-- 2. Her veritabanında (nesne sahibi olunan) tekrarlayın:',
      '--    REASSIGN OWNED ve DROP OWNED VERİTABANI BAZLIDIR.',
      '--    Veritabanlarını listele: SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1;',
      '--    psql: \\c <veritabani>   (diğer araçlarda hedef veritabanına bağlanın)',
      `REASSIGN OWNED BY ${N} TO postgres;`,
      `DROP OWNED BY ${N};`,
      '',
      '-- 3. Tüm veritabanlarındaki temizlik bittikten sonra rolü sil',
      `DROP ROLE IF EXISTS ${N};`
    ].join('\n');
  });

  // ==================================================================
  // 3. DB, TABLESPACE, AUTOVACUUM, BAKIM
  // ==================================================================
  const storageSubs = [
    ['create_db', 'CREATE DATABASE'],
    ['tablespace', 'Tablespace'],
    ['autovacuum', 'Autovacuum'],
    ['maintenance', 'Bakım & VACUUM']
  ];
  const sub = ref('autovacuum');
  const LOCALES = [['C.UTF-8', 'C.UTF-8 (önerilen)'], ['en_US.UTF-8', 'en_US.UTF-8'], ['tr_TR.UTF-8', 'tr_TR.UTF-8'], ['custom', 'Özel…']];

  // --- CREATE DATABASE ---
  const [dbc, resetDbc] = persisted('pg.createdb', {
    name: 'crm_production', owner: 'app_owner', template: 'template0', encoding: 'UTF8',
    provider: 'libc', collate: 'tr_TR.UTF-8', collateCustom: '', ctype: 'C.UTF-8', ctypeCustom: '',
    icuLocale: 'tr-TR', tablespace: 'pg_default', connLimit: -1, revokePublic: false
  });

  const dbOut = computed(() => {
    const d = dbc, notes = [];
    const name = txt(d.name, 'my_database');
    const collate = d.collate === 'custom' ? txt(d.collateCustom, 'C.UTF-8') : d.collate;
    const ctype = d.ctype === 'custom' ? txt(d.ctypeCustom, 'C.UTF-8') : d.ctype;
    const icu = d.provider === 'icu';
    const opts = [
      `OWNER = ${pgIdent(txt(d.owner, 'postgres'))}`,
      `TEMPLATE = ${d.template === 'template1' ? 'template1' : 'template0'}`,
      `ENCODING = ${pgLit(d.encoding)}`
    ];
    if (icu) opts.push('LOCALE_PROVIDER = icu', `ICU_LOCALE = ${pgLit(txt(d.icuLocale, 'tr-TR'))}`);
    else opts.push(`LC_COLLATE = ${pgLit(collate)}`, `LC_CTYPE = ${pgLit(ctype)}`);
    opts.push(`TABLESPACE = ${pgIdent(txt(d.tablespace, 'pg_default'))}`, `CONNECTION LIMIT = ${int(d.connLimit, -1)}`);

    const body = ['CREATE DATABASE ' + pgIdent(name), '  WITH', ...opts.map(o => '  ' + o)];
    body[body.length - 1] += ';';
    const L = [...body, '', `COMMENT ON DATABASE ${pgIdent(name)} IS ${pgLit('Created via PostgreSQL DBA Cockpit')};`];
    if (d.revokePublic) {
      L.push('', '-- PUBLIC bağlantı iznini kaldır (yalnızca açıkça yetkilendirilen roller bağlanır)',
        `REVOKE CONNECT ON DATABASE ${pgIdent(name)} FROM PUBLIC;`,
        `-- Uygulama rolüne izin verin: GRANT CONNECT ON DATABASE ${pgIdent(name)} TO app_backend;`);
      notes.push(['warn', 'PUBLIC\'in CONNECT yetkisi kaldırıldığında yalnızca açıkça yetkilendirilen roller bağlanır; uygulama rolüne `GRANT CONNECT` vermeyi unutmayın.']);
    }
    if (d.template === 'template1') notes.push(['info', '`template1` kopyalanır: ENCODING ve LC_* değerleri template1 ile uyumlu olmalı, aksi halde "new encoding is incompatible" hatası alırsınız. Varsayılan `template0` önerilir.']);
    if (d.encoding === 'SQL_ASCII') notes.push(['warn', '`SQL_ASCII` karakter doğrulaması yapmaz; yeni sistemlerde `UTF8` kullanın.']);
    if (!icu && /^tr_TR/i.test(ctype)) notes.push(['warn', '**LC_CTYPE = tr_TR** ile büyük/küçük harf dönüşümünde `i`↔`İ` ve `I`↔`ı` ayrışır. `UPPER()/LOWER()`, `citext`, indeks ve uygulama karşılaştırmaları beklenmedik sonuç verebilir. LC_CTYPE için `C.UTF-8` veya `en_US.UTF-8` önerilir; Türkçe sıralama için yalnızca `LC_COLLATE = tr_TR.UTF-8` kullanın.']);
    if (!icu && /^tr_TR/i.test(collate)) notes.push(['tip', 'Türkçe `LC_COLLATE` ile oluşturulan indekslerde glibc sürümü değişirse sıralama değişir (collation version uyumsuzluğu); `REINDEX` gerekebilir.']);
    if (icu) notes.push(['tip', '`LOCALE_PROVIDER = icu` **PG15+** gerektirir; Türkçe için `ICU_LOCALE = tr-TR`.']);
    if (!icu) notes.push(['info', 'libc locale\'leri işletim sisteminde kurulu olmalıdır (`locale -a` ile kontrol edin).']);
    notes.push(['info', 'CREATE DATABASE bir transaction bloğu içinde çalışmaz; `BEGIN … COMMIT` ile sarmadan tek başına çalıştırın.']);
    notes.push(['tip', '`template0` temiz şablondur; `template1`e eklenen nesneler her yeni veritabanına kopyalanır.']);
    return { sql: L.join('\n'), notes, file: 'create_database.sql' };
  });

  // --- TABLESPACE ---
  const [ts, resetTs] = persisted('pg.tablespace', {
    name: 'fast_nvme_ts', owner: 'postgres', location: '/mnt/nvme_pool/pg_tablespace', table: 'public.orders'
  });

  const tsOut = computed(() => {
    const t = ts, notes = [];
    const name = pgIdent(txt(t.name, 'fast_ts'));
    const owner = pgIdent(txt(t.owner, 'postgres'));
    const loc = pgLit(txt(t.location, '/mnt/fast/pg_tablespace'));
    const tbl = pgQName(txt(t.table, 'public.orders'));
    const L = [
      '-- 1. Tablespace oluştur (dizin boş olmalı ve OS\'te postgres kullanıcısına ait olmalı)',
      `CREATE TABLESPACE ${name} OWNER ${owner} LOCATION ${loc};`,
      '',
      '-- 2. Yeni tablolar için kullanım örneği',
      `-- CREATE TABLE sensor_stream (...) TABLESPACE ${name};`,
      '',
      '-- 3. Mevcut tabloyu taşı (ACCESS EXCLUSIVE kilit; tablo yeniden yazılır)',
      `-- ALTER TABLE ${tbl} SET TABLESPACE ${name};`,
      '-- İlişkili indeksleri ayrıca taşıyın:',
      `-- ALTER INDEX <indeks_adi> SET TABLESPACE ${name};`,
      '',
      '-- 4. Oturum bazlı varsayılan tablespace',
      `-- SET default_tablespace = ${name};`
    ];
    notes.push(['warn', '`ALTER TABLE ... SET TABLESPACE` tabloyu **ACCESS EXCLUSIVE** kilidiyle kilitler ve tabloyu baştan yazar. Yoğun saatlerden kaçının; büyük tablolarda `pg_repack` veya parça parça taşıma düşünün.']);
    notes.push(['info', 'PostgreSQL tablespace\'leri farklı diskleri göstermek içindir; Oracle\'daki gibi mantıksal bölümleme aracı değildir. Bölümleme için `PARTITION BY` kullanın.']);
    notes.push(['info', '`CREATE TABLESPACE` süper kullanıcı gerektirir ve dizin, sunucu tarafından erişilebilir olmalıdır.']);
    return { sql: L.join('\n'), notes, file: 'tablespace.sql' };
  });

  // --- AUTOVACUUM ---
  const AV_PROFILES = {
    high_churn: { label: 'Yüksek UPDATE/DELETE', scale: 0.02, threshold: 500, costLimit: 1500, insertScale: 0.02, insertThreshold: 1000 },
    large_oltp: { label: 'Büyük OLTP', scale: 0.05, threshold: 1000, costLimit: 1000, insertScale: 0.02, insertThreshold: 1000 },
    append_only: { label: 'Yalnızca INSERT (append-only)', scale: 0.1, threshold: 2000, costLimit: 800, insertScale: 0.02, insertThreshold: 5000 }
  };
  const [av, resetAv] = persisted('pg.autovacuum', {
    schema: 'public', table: 'orders', profile: 'high_churn',
    scale: 0.02, threshold: 500, costLimit: 1500, insertScale: 0.02, insertThreshold: 5000
  });
  const applyAv = (p) => {
    const v = AV_PROFILES[p];
    Object.assign(av, { profile: p, scale: v.scale, threshold: v.threshold, costLimit: v.costLimit, insertScale: v.insertScale, insertThreshold: v.insertThreshold });
  };

  const avOut = computed(() => {
    const a = av, notes = [];
    const full = `${txt(a.schema, 'public')}.${txt(a.table, 'orders')}`;
    const tbl = pgQName(full);
    const ap = a.profile === 'append_only';
    const set = [
      `autovacuum_vacuum_scale_factor = ${tidy(a.scale)}`,
      `autovacuum_vacuum_threshold = ${int(a.threshold, 500)}`,
      `autovacuum_analyze_scale_factor = ${tidy(a.scale / 2)}`,
      `autovacuum_analyze_threshold = ${Math.round(int(a.threshold, 500) / 2)}`,
      `autovacuum_vacuum_cost_limit = ${int(a.costLimit, 1000)}`,
      'autovacuum_vacuum_cost_delay = 2'
    ];
    if (ap) set.push(`autovacuum_vacuum_insert_scale_factor = ${tidy(a.insertScale)}`, `autovacuum_vacuum_insert_threshold = ${int(a.insertThreshold, 1000)}`);
    const names = set.map(s => s.split(' = ')[0]);
    const L = [
      `-- ${full} tablosu için tablo bazlı autovacuum`,
      `ALTER TABLE ${tbl} SET (`,
      ...set.map((s, i) => '  ' + s + (i < set.length - 1 ? ',' : '')),
      ');',
      '',
      '-- Doğrulama',
      `SELECT relname, reloptions FROM pg_class WHERE oid = ${pgLit(tbl)}::regclass;`,
      `SELECT relname, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, n_dead_tup, autovacuum_count FROM pg_stat_user_tables WHERE relid = ${pgLit(tbl)}::regclass;`,
      '',
      '-- Varsayılana dönüş (cluster ayarları geri gelir)',
      `-- ALTER TABLE ${tbl} RESET (`,
      ...names.map((n, i) => `--   ${n}${i < names.length - 1 ? ',' : ''}`),
      '-- );'
    ];
    notes.push(['tip', 'Tablo bazlı ayar yalnızca bu tabloya uygulanır; cluster geneli `postgresql.conf` değerleri değişmez. Sonucu `pg_stat_user_tables` üzerinden izleyin.']);
    if (ap) notes.push(['tip', 'Yalnızca INSERT alan tablolarda `autovacuum_vacuum_insert_*` (PG13+) freeze ve visibility map güncellemesini zamanında yapar; insert eşiği çok yüksekse wraparound riski doğabilir.']);
    if (a.profile === 'high_churn') notes.push(['info', 'Yüksek UPDATE/DELETE tablolarında düşük scale ve yüksek cost limit, dead tuple birikimini hızla temizler; I/O artışını izleyin.']);
    notes.push(['info', '`autovacuum_vacuum_cost_limit` yüksek olduğunda autovacuum daha agresif çalışır; `cost_delay` (ms) bekleme süresini belirler.']);
    return { sql: L.join('\n'), notes, file: 'autovacuum_' + txt(a.table, 'orders') + '.sql' };
  });

  // --- MANUEL VACUUM / BAKIM ---
  const [vc, resetVc] = persisted('pg.vacuum', {
    target: 'public.orders', analyze: true, verbose: true, full: false, freeze: false, skipLocked: true,
    indexCleanup: 'default', parallel: 2, vacJobs: 4, vacDb: 'production_db'
  });

  const vacOut = computed(() => {
    const v = vc, notes = [];
    const opts = [];
    let parallel = int(v.parallel, 0);
    const target = txt(v.target);
    if (v.full) opts.push('FULL');
    if (v.freeze) opts.push('FREEZE');
    if (v.verbose) opts.push('VERBOSE');
    if (v.analyze) opts.push('ANALYZE');
    if (v.skipLocked) opts.push('SKIP_LOCKED');
    if (v.indexCleanup !== 'default') opts.push('INDEX_CLEANUP ' + (v.indexCleanup === 'on' ? 'ON' : 'OFF'));
    if (parallel > 0) {
      if (v.full) { notes.push(['danger', '`VACUUM FULL` ile `PARALLEL` birlikte kullanılamaz; `PARALLEL` kaldırıldı.']); parallel = 0; }
      else opts.push('PARALLEL ' + parallel);
    }
    if (v.full) notes.push(['danger', '`VACUUM FULL` tabloyu **ACCESS EXCLUSIVE** kilidiyle kilitler (okuma ve yazma bloke olur) ve tablo + indeksler için yaklaşık **2 kat** boş alan ister. Canlıda `pg_repack` (kilitsiz) tercih edin.']);
    if (v.freeze) notes.push(['info', '`FREEZE` agresif donduruma zorlar; yoğun I/O üretebilir. Wraparound riskinde kullanın.']);
    if (v.skipLocked) notes.push(['tip', '`SKIP_LOCKED` (PG12+) kilitli tabloları/sayfaları atlar; kilit beklemeden çalışır.']);
    const vac = ['VACUUM', opts.length ? '(' + opts.join(', ') + ')' : '', target ? pgQName(target) : ''].filter(Boolean).join(' ') + ';';
    const reindex = target
      ? `REINDEX (VERBOSE) TABLE CONCURRENTLY ${pgQName(target)};`
      : '-- REINDEX için hedef tablo girin (ör. public.orders)';
    const vdb = `vacuumdb -d ${sh(txt(v.vacDb, 'production_db'))} -j ${Math.max(1, int(v.vacJobs, 4))} --analyze-in-stages`;
    notes.push(['info', '`REINDEX ... CONCURRENTLY` (PG12+) kilit almadan indeks yeniden yazar; transaction bloğunda çalışmaz ve geçici alan ister.']);
    notes.push(['tip', '`vacuumdb --analyze-in-stages` `pg_upgrade` sonrası önerilir: önce hızlı istatistik üretir, sonra tam istatistik toplar. `-j` yalnızca birden çok tabloda işe yarar.']);
    return { vac, reindex, vdb, notes };
  });

  const resetStorage = () => {
    if (sub.value === 'create_db') resetDbc();
    else if (sub.value === 'tablespace') resetTs();
    else if (sub.value === 'autovacuum') resetAv();
    else resetVc();
    DBA.toast('Form varsayılana döndü');
  };

  // ==================================================================
  // 4. OTURUM & KILL
  // ==================================================================
  const [ss, resetSs] = persisted('pg.session', {
    pids: '24150', db: 'production_db', idleMin: 10, appRole: 'app_backend'
  });

  const ssOut = computed(() => {
    const s = ss, notes = [];
    let pids = list(s.pids).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
    if (!pids.length) {
      notes.push(['warn', 'Geçerli bir PID girilmedi; örnek olarak `12345` kullanılıyor.']);
      pids = [12345];
    }
    const one = pids.length === 1;
    const idList = pids.join(', ');
    const arr = `ARRAY[${idList}]`;
    const lookup = `SELECT pid, usename, datname, application_name, client_addr, state, wait_event_type, wait_event,\n       now() - query_start AS duration, left(query, 150) AS query\nFROM pg_stat_activity\nWHERE pid IN (${idList});`;
    const cancel = one
      ? `SELECT pg_cancel_backend(${pids[0]});`
      : `SELECT pg_cancel_backend(pid) FROM unnest(${arr}) AS pid;`;
    const term = one
      ? `SELECT pg_terminate_backend(${pids[0]});`
      : `SELECT pg_terminate_backend(pid) FROM unnest(${arr}) AS pid;`;
    const os = [
      '# 1. Önce doğrula: PID hâlâ bir PostgreSQL backend\'i mi?',
      `ps -fp ${pids.join(' ')}`,
      '',
      '# 2. Nazik sonlandırma (SIGTERM): backend temizlenip kapanır',
      `kill -15 ${pids.join(' ')}`,
      '',
      '# 3. Son çare: YALNIZCA SIGTERM işe yaramazsa',
      `# kill -9 ${pids.join(' ')}`,
      '',
      '# Windows: PostgreSQL servisinin pg_ctl ile sinyal gönderimi',
      `pg_ctl kill TERM ${pids[0]}`
    ].join('\n');

    const db = txt(s.db, 'target_db');
    const DB = pgIdent(db), DL = pgLit(db);
    const mins = Math.max(1, int(s.idleMin, 10));
    const role = pgIdent(txt(s.appRole, 'app_backend'));
    const mass = [
      '-- 1) (Önerilir) Yeni bağlantıları kapat. Gerekirse açın:',
      `-- ALTER DATABASE ${DB} ALLOW_CONNECTIONS false;`,
      '',
      '-- 2) Kendi oturumunuz hariç tüm istemci bağlantılarını sonlandır',
      'SELECT pg_terminate_backend(pid)',
      'FROM pg_stat_activity',
      `WHERE datname = ${DL}`,
      "  AND backend_type = 'client backend'",
      '  AND pid <> pg_backend_pid();',
      '',
      '-- 3) Bağlantıları yeniden aç:',
      `-- ALTER DATABASE ${DB} ALLOW_CONNECTIONS true;`,
      '',
      '-- 4) PG13+: veritabanını tamamen düşür (GERİ DÖNÜŞ YOK!)',
      `-- DROP DATABASE ${DB} WITH (FORCE);`
    ].join('\n');

    const idle = [
      `-- 'idle in transaction' durumunda ${mins} dakikadan uzun süredir kilit tutan oturumları sonlandır`,
      'SELECT pg_terminate_backend(pid),',
      '       pid, usename, client_addr,',
      '       now() - state_change AS idle_duration,',
      '       left(query, 150) AS last_query',
      'FROM pg_stat_activity',
      "WHERE state = 'idle in transaction'",
      `  AND now() - state_change > interval '${mins} minutes'`,
      '  AND pid <> pg_backend_pid();'
    ].join('\n');

    const prevent = [
      '-- Rol bazlı zaman aşımları (yalnızca YENİ bağlantılarda geçerli)',
      `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${mins}min';`,
      `-- PG14+: boşta bağlı kalan oturumlar için`,
      `ALTER ROLE ${role} SET idle_session_timeout = '30min';`
    ].join('\n');

    notes.push(['info', '`pg_terminate_backend` / `pg_cancel_backend` başka kullanıcının oturumu için süper kullanıcı veya `pg_signal_backend` rolü ister.']);
    notes.push(['danger', 'Hiçbir PostgreSQL backend\'ine `kill -9` göndermeyin: postmaster paylaşılan belleğin bozulmuş olabileceğini varsayar, **tüm bağlantıları keser ve cluster\'ı crash recovery\'ye sokar**. `kill -15` = `pg_terminate_backend` ile aynı etkiyi güvenle verir. Postmaster prosesini asla öldürmeyin.']);
    notes.push(['tip', '`pg_cancel_backend` yalnızca çalışan sorguyu iptal eder, oturum açık kalır. Sorun sürerse `pg_terminate_backend` kullanın.']);
    notes.push(['info', 'Mass kill öncesi `pg_stat_activity` ile hedef oturumları doğrulayın; `ALLOW_CONNECTIONS false` yeni bağlantıları engeller.']);
    notes.push(['info', '`idle_in_transaction_session_timeout` ayarı mevcut oturumlara uygulanmaz; uygulama bağlantı havuzunu yeniden başlatın.']);

    return { lookup, cancel, term, os, mass, idle, prevent, notes, pidList: pids.join(', ') };
  });

  // ==================================================================
  // 5. TEŞHİS SORGULARI
  // ==================================================================
  const qcats = [
    ['locks', '🔒 Kilit'],
    ['activity', '⏱️ Aktivite'],
    ['size', '🎈 Boyut & Bloat'],
    ['index', '⚡ İndeks'],
    ['perf', '🧠 Cache & İstatistik'],
    ['repl', '🔄 Replikasyon & WAL'],
    ['maint', '🧰 Vacuum & Bakım']
  ];

  const queriesA = [
    { id: 'lock_tree', cat: 'locks', ver: 'PG10+', title: 'Kilitlenme ağacı (kök blocker → bekleyenler)',
      desc: 'Kim kimi bekletiyor? Kök kilitleyiciden başlayıp bekleyen oturumları girintili ağaç olarak gösterir.',
      tip: 'Ağacın en üstündeki pid genellikle `idle in transaction` olan ve commit etmeyen bir uygulamadır. Sonlandırmadan önce uygulama sahibine ulaşın.',
      sql: `WITH RECURSIVE l AS (
  SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
), tree AS (
  SELECT pid, 0 AS depth, pid::text AS path FROM l
  WHERE cardinality(blockers) = 0 AND pid IN (SELECT unnest(blockers) FROM l)
  UNION ALL
  SELECT l.pid, t.depth + 1, t.path || ' > ' || l.pid
  FROM l JOIN tree t ON t.pid = ANY (l.blockers)
)
SELECT repeat('   ', t.depth) || t.pid AS lock_tree, a.usename, a.state, a.wait_event,
       now() - a.xact_start AS xact_age, left(a.query, 150) AS query
FROM tree t JOIN pg_stat_activity a USING (pid)
ORDER BY t.path;` },
    { id: 'lock_waits', cat: 'locks', ver: 'PG9.6+', title: 'Bekleyen kilit istekleri (granted = false)',
      desc: 'Kilit alamayan (bekleyen) oturumlar, hedef ilişki ve bekleme süresi.',
      sql: `SELECT l.pid, a.usename, l.locktype, l.mode, l.granted, l.relation::regclass AS relation,
       now() - a.query_start AS waiting_for, left(a.query, 120) AS query
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE NOT l.granted
ORDER BY waiting_for DESC;` },
    { id: 'long_running', cat: 'activity', ver: 'PG9.6+', title: 'En uzun süredir çalışan aktif sorgular',
      desc: 'Idle olmayan ve en uzun süredir yürütülen sorguları süresiyle listeler; bekleme olayını da gösterir.',
      tip: 'Yavaş sorguyu `EXPLAIN (ANALYZE, BUFFERS)` ile test edin; takılmışsa `pg_cancel_backend` ile iptal edin.',
      sql: `SELECT pid, usename, client_addr, application_name,
       now() - query_start AS duration, state,
       wait_event_type, wait_event, left(query, 150) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid()
ORDER BY duration DESC
LIMIT 20;` },
    { id: 'long_transactions', cat: 'activity', ver: 'PG9.6+', title: 'Uzun süren transaction\'lar',
      desc: 'Açık kalmış transaction\'lar; yaşı ve xmin değeriyle birlikte.',
      tip: 'Uzun transaction\'lar xmin\'i geri tutar; vacuum temizleyemez ve tablolar şişer (bloat).',
      sql: `SELECT pid, usename, datname, state, now() - xact_start AS xact_age, now() - state_change AS state_age,
       backend_xmin, left(query, 150) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start
LIMIT 20;` },
    { id: 'xmin_horizon', cat: 'maint', ver: 'PG9.6+', title: 'xmin ufkunu geri tutan kaynaklar',
      desc: 'Oturumlar, replikasyon slotları ve hazırlanmış (prepared) transaction\'lar; vacuum\'un temizleyemediği satırların sebebi.',
      tip: 'En yaşlı kaynağı kapatmak veya bitirmek vacuum\'un ilerlemesini sağlar. Prepared transaction\'lar unutulmuşsa `ROLLBACK PREPARED` ile temizleyin.',
      sql: `SELECT 'session' AS source, pid::text AS id, age(backend_xmin) AS xmin_age FROM pg_stat_activity WHERE backend_xmin IS NOT NULL
UNION ALL
SELECT 'replication_slot', slot_name::text, age(xmin) FROM pg_replication_slots WHERE xmin IS NOT NULL
UNION ALL
SELECT 'replication_slot_catalog', slot_name::text, age(catalog_xmin) FROM pg_replication_slots WHERE catalog_xmin IS NOT NULL
UNION ALL
SELECT 'prepared_xact', gid, age(transaction) FROM pg_prepared_xacts
ORDER BY xmin_age DESC;` },
    { id: 'connections', cat: 'activity', ver: 'PG10+', title: 'Bağlantı dağılımı ve max_connections kullanımı',
      desc: 'Veritabanı, kullanıcı ve duruma göre istemci bağlantı sayıları; ardından toplam kullanım yüzdesi.',
      tip: 'Yüzde %80\'in üzerindeyse `max_connections` artırmak yerine PgBouncer ile havuzlayın.',
      sql: `SELECT datname, usename, state, count(*) AS cnt, max(now() - state_change) AS max_state_age
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY datname, usename, state
ORDER BY cnt DESC;

SELECT count(*) AS used,
       current_setting('max_connections')::int AS max_connections,
       round(100.0 * count(*) / current_setting('max_connections')::int, 1) AS pct
FROM pg_stat_activity
WHERE backend_type = 'client backend';` },
    { id: 'pg_stat_statements_top', cat: 'perf', ver: 'PG13+', title: 'En çok toplam süre harcayan 20 sorgu (pg_stat_statements)',
      desc: 'Toplam çalışma süresine göre en pahalı sorgular; ortalama süre ve tüm süre içindeki yüzdeleri.',
      tip: 'Yüksek `mean_ms` ve düşük `calls` → tek pahalı sorgu; yüksek `calls` → çok sık çalışan küçük sorgu (N+1 olabilir).',
      sql: `-- CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- shared_preload_libraries gerekir
SELECT queryid, calls,
       round(total_exec_time::numeric / 1000, 1) AS total_s,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct,
       rows, shared_blks_hit, shared_blks_read,
       left(query, 150) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;` },
    { id: 'db_stats', cat: 'perf', ver: 'PG9.6+', title: 'Veritabanı bazlı cache isabeti, commit/rollback, temp ve deadlock',
      desc: 'Her veritabanının buffer cache isabet oranı, transaction sayaçları, geçici dosya ve deadlock sayıları.',
      tip: 'OLTP sistemde isabet oranı %99\'un altındaysa `shared_buffers` ve RAM kapasitesini gözden geçirin.',
      sql: `SELECT datname,
       round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       xact_commit, xact_rollback,
       temp_files,
       pg_size_pretty(temp_bytes) AS temp_size,
       deadlocks
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY blks_read DESC;` },
    { id: 'table_sizes', cat: 'size', ver: 'PG10+', title: 'En büyük 25 tablo (tablo, indeks, toplam)',
      desc: 'Tablo verisi, indeks ve toplam disk tüketimi; pg_class üzerinden hesaplanır (karışık büyük/küçük harf adlarında güvenli).',
      tip: 'İndeks boyutu tablo boyutunun çok üzerindeyse `REINDEX ... CONCURRENTLY` veya gereksiz indeks temizliği adayıdır.',
      sql: `SELECT n.nspname || '.' || c.relname AS table_name,
       pg_size_pretty(pg_table_size(c.oid)) AS table_size,
       pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       c.reltuples::bigint AS est_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 25;` },
    { id: 'db_sizes', cat: 'size', ver: 'PG9.6+', title: 'Veritabanı boyutları',
      desc: 'Bağlantıya izin verilen her veritabanının diskte kapladığı alan.',
      sql: `SELECT datname,
       pg_size_pretty(pg_database_size(datname)) AS size,
       pg_database_size(datname) AS size_bytes
FROM pg_database
WHERE datallowconn
ORDER BY pg_database_size(datname) DESC;` },
    { id: 'dead_tuples', cat: 'size', ver: 'PG9.6+', title: 'Ölü satırlar (dead tuples) ve autovacuum geçmişi',
      desc: 'Autovacuum bekleyen veya aşırı UPDATE/DELETE sonucu biriken ölü satır sayısı ve son vacuum/analyze zamanları.',
      tip: 'Dead tuple yüzdesi %20\'nin üzerindeyse ilgili tablo için `VACUUM (ANALYZE)` çalıştırın ve tablo bazlı autovacuum ayarını gözden geçirin.',
      sql: `SELECT schemaname, relname AS table_name, n_live_tup, n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_tuple_pct,
       last_vacuum, last_autovacuum, last_autoanalyze, autovacuum_count
FROM pg_stat_user_tables
WHERE (n_live_tup + n_dead_tup) > 1000
ORDER BY n_dead_tup DESC
LIMIT 20;` },
    { id: 'pgstattuple_bloat', cat: 'size', ver: 'PG9.6+ · pgstattuple', title: 'Gerçek bloat ölçümü (pgstattuple)',
      desc: 'İstatistiklerden daha doğru bloat oranı; tablo ve indeks için ayrı ölçüm.',
      tip: '`dead_tuple_percent` ve `free_percent` yüksekse `VACUUM` (tablo) veya `REINDEX CONCURRENTLY` (indeks) değerlendirin. `pgstattuple_approx` büyük tablolarda daha hızlıdır.',
      sql: `-- CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT * FROM pgstattuple_approx('public.orders'::regclass);

SELECT * FROM pgstatindex('public.orders_pkey');` },
    { id: 'unused_indexes', cat: 'index', ver: 'PG9.6+', title: 'Hiç kullanılmamış indeksler (idx_scan = 0)',
      desc: 'Yazmayı yavaşlatan ama hiç okunmayan indeksler. PRIMARY KEY, UNIQUE ve kısıt indeksleri hariç tutulur.',
      tip: 'Silmeden önce `SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();` ile istatistiklerin ne kadar süredir biriktiğine, ayrıca standby sunucularda kullanımına bakın. Silmek için `DROP INDEX CONCURRENTLY`.',
      sql: `SELECT schemaname || '.' || relname AS table_name,
       indexrelname AS index_name,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
       idx_scan
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
WHERE idx_scan = 0
  AND indisprimary = false
  AND indisunique = false
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = indexrelid)
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 25;` },
    { id: 'duplicate_indexes', cat: 'index', ver: 'PG9.6+', title: 'Aynı tanımlı (duplicate) indeksler',
      desc: 'Tablo, operator class, sütunlar, ifade ve kısmi koşul aynı olan indeksleri gruplar.',
      tip: 'Gruptaki fazla indeksleri `DROP INDEX CONCURRENTLY` ile kaldırın; birini tutun (genelde ilk sıradaki).',
      sql: `SELECT pg_size_pretty(sum(pg_relation_size(idx))::bigint) AS size,
       (array_agg(idx))[1] AS idx1, (array_agg(idx))[2] AS idx2,
       (array_agg(idx))[3] AS idx3, (array_agg(idx))[4] AS idx4
FROM (SELECT indexrelid::regclass AS idx,
             (indrelid::text || E'\\n' || indclass::text || E'\\n' || indkey::text || E'\\n' ||
              coalesce(indexprs::text, '') || E'\\n' || coalesce(indpred::text, '')) AS key
      FROM pg_index) sub
GROUP BY key HAVING count(*) > 1
ORDER BY sum(pg_relation_size(idx)) DESC;` },
    { id: 'seq_scan_heavy', cat: 'index', ver: 'PG9.6+', title: 'Sıralı tarama (seq scan) yoğun tablolar',
      desc: 'Çok sayıda satırın sıralı tarama ile okunduğu tablolar; eksik indeks adayları.',
      tip: 'Büyük bir tablo için yüksek `avg_rows_per_seq_scan` ve düşük `idx_scan`, uygun bir indeks eksikliğine işaret eder. Sorguların `EXPLAIN` planına bakın.',
      sql: `SELECT schemaname, relname AS table_name, seq_scan, seq_tup_read, idx_scan,
       ROUND(seq_tup_read::numeric / NULLIF(seq_scan, 0)) AS avg_rows_per_seq_scan,
       pg_size_pretty(pg_relation_size(relid)) AS table_size
FROM pg_stat_user_tables
ORDER BY seq_tup_read DESC
LIMIT 20;` },
    { id: 'index_build_progress', cat: 'index', ver: 'PG12+', title: 'Devam eden indeks oluşturma ilerlemesi',
      desc: 'CREATE INDEX / REINDEX (CONCURRENTLY dahil) işlemlerinin faz ve blok bazlı yüzdesi.',
      sql: `SELECT p.pid, p.datname, p.relid::regclass AS table_name, p.index_relid::regclass AS index_name,
       p.phase, p.blocks_done, p.blocks_total,
       ROUND(100.0 * p.blocks_done / NULLIF(p.blocks_total, 0), 1) AS pct
FROM pg_stat_progress_create_index p;` }
  ];

  const queriesB = [
    { id: 'replication_lag', cat: 'repl', ver: 'PG10+', title: 'Streaming replikasyon gecikmesi (primary ve standby)',
      desc: 'Primary\'deki bağlı standby\'ların gönderme/yazma/flush/replay gecikmeleri; standby\'da replay gecikme süresi.',
      tip: 'Byte gecikmesi gigabayt seviyesine çıkıyorsa standby\'ın I/O veya ağ darboğazını inceleyin.',
      sql: `SELECT application_name, client_addr, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag_size,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- Standby'da:
SELECT pg_is_in_recovery(), now() - pg_last_xact_replay_timestamp() AS replay_delay,
       pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();` },
    { id: 'replication_slots', cat: 'repl', ver: 'PG13+', title: 'Replikasyon slotları ve tutulan WAL',
      desc: 'Her slotun neden olduğu WAL birikimi ve slotun aktif olup olmadığı.',
      tip: 'Aktif olmayan slot WAL\'ı sonsuza kadar tutar ve disk dolar. Gereksizse `SELECT pg_drop_replication_slot(\'slot\');` ile kaldırın; `max_slot_wal_keep_size` ile sınır koyun.',
      sql: `SELECT slot_name, slot_type, database, active, active_pid,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
       wal_status, safe_wal_size
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;` },
    { id: 'wal_archiver', cat: 'repl', ver: 'PG9.6+', title: 'WAL arşivleme durumu ve pg_wal boyutu',
      desc: 'pg_stat_archiver\'daki son başarılı/başarısız arşivleme ve pg_wal klasörünün toplam boyutu.',
      tip: 'Son arşivleme zamanı eskiyse veya `failed_count` artıyorsa `archive_command` hatalıdır. `pg_ls_waldir()` süper kullanıcı veya `pg_monitor` ister.',
      sql: `SELECT archived_count, last_archived_wal, last_archived_time,
       now() - last_archived_time AS since_last_archive,
       failed_count, last_failed_wal, last_failed_time
FROM pg_stat_archiver;

SELECT count(*) AS wal_files, pg_size_pretty(sum(size)) AS wal_size FROM pg_ls_waldir();` },
    { id: 'wraparound', cat: 'maint', ver: 'PG9.6+', title: 'Transaction ID wraparound takibi',
      desc: 'Veritabanları ve tablolar için xid yaşı; 2^31\'e ne kadar yaklaşıldığı.',
      tip: 'Yüzde %50\'nin üzerindeki veritabanlarında `autovacuum_freeze_max_age` ve uzun transaction\'ları kontrol edin. Yüzde %75\'te acil `VACUUM (FREEZE)` gerekir.',
      sql: `SELECT datname, age(datfrozenxid) AS xid_age,
       round(100.0 * age(datfrozenxid) / 2147483647, 1) AS pct_to_wraparound,
       current_setting('autovacuum_freeze_max_age')::int AS freeze_max_age
FROM pg_database ORDER BY age(datfrozenxid) DESC;

SELECT c.oid::regclass AS table_name, age(c.relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
WHERE c.relkind IN ('r', 'm', 't')
ORDER BY age(c.relfrozenxid) DESC LIMIT 20;` },
    { id: 'vacuum_progress', cat: 'maint', ver: 'PG12+', title: 'Canlı VACUUM ve autovacuum işçileri',
      desc: 'Çalışan VACUUM işlemlerinin fazı ve taranan blok yüzdesi; ayrıca aktif autovacuum işçileri.',
      tip: 'İlerleme yavaşsa `autovacuum_vacuum_cost_limit` değerini ve tablo bazlı ayarları kontrol edin.',
      sql: `SELECT p.pid, c.relname AS table_name, p.phase,
       p.heap_blks_total, p.heap_blks_scanned,
       ROUND(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 2) AS scanned_pct,
       p.heap_blks_vacuumed
FROM pg_stat_progress_vacuum p
JOIN pg_class c ON p.relid = c.oid;

SELECT pid, datname, state, wait_event_type, wait_event, now() - xact_start AS running_for, query
FROM pg_stat_activity
WHERE backend_type = 'autovacuum worker';` },
    { id: 'changed_settings', cat: 'maint', ver: 'PG9.6+', title: 'Varsayılan dışı ve restart bekleyen ayarlar',
      desc: 'Config dosyası, ALTER SYSTEM veya komut satırından değiştirilmiş parametreler ve restart bekleyenler.',
      tip: 'Kaynağı `sourcefile` gösterir; birden çok dosyada aynı parametre varsa son okunan geçerlidir.',
      sql: `SELECT name, setting, unit, source, sourcefile, pending_restart
FROM pg_settings
WHERE source NOT IN ('default', 'override') OR pending_restart
ORDER BY pending_restart DESC, name;` },
    { id: 'reload_conf', cat: 'maint', ver: 'PG9.4+', title: 'Yapılandırmayı canlıya al (pg_reload_conf) ve restart kontrolü',
      desc: 'Restart gerektirmeyen değişiklikleri hemen uygular; restart bekleyen parametreleri listeler.',
      tip: '`shared_buffers`, `max_connections`, `max_worker_processes` gibi parametreler `pending_restart = true` olarak kalır; servis restart gerekir.',
      sql: `SELECT pg_reload_conf();

SELECT name, setting, pending_restart FROM pg_settings WHERE pending_restart = true;` },
    { id: 'checkpoints', cat: 'perf', ver: 'PG16- / PG17+', title: 'Checkpoint istatistikleri',
      desc: 'Zamanlanmış ve istek üzerine (requested) checkpoint sayıları, yazma süreleri ve yazılan buffer sayısı.',
      tip: 'requested >> timed ise checkpoint\'ler `max_wal_size` dolduğu için tetikleniyor demektir; `max_wal_size` değerini artırın.',
      sql: `-- PG17+
SELECT num_timed, num_requested, write_time, sync_time, buffers_written FROM pg_stat_checkpointer;

-- PG16 ve altı
SELECT checkpoints_timed, checkpoints_req, buffers_checkpoint, buffers_backend FROM pg_stat_bgwriter;` }
  ];

  const queries = [...queriesA, ...queriesB];

  // ==================================================================
  // 6. BAĞLANTI & CONFIG
  // ==================================================================
  const CONN_FORMATS = [
    ['uri', 'Postgres URI'], ['psql', 'psql'], ['pgpass', '.pgpass'], ['hba', 'pg_hba.conf'],
    ['pgbouncer', 'PgBouncer'], ['jdbc', 'JDBC'], ['python', 'Python'], ['nodejs', 'Node.js'],
    ['golang', 'Go'], ['docker', 'Docker']
  ];
  const CONN_LANG = { uri: 'sh', psql: 'sh', pgpass: 'text', hba: 'conf', pgbouncer: 'ini', jdbc: 'text', python: 'py', nodejs: 'js', golang: 'go', docker: 'sh' };
  const CONN_FILE = { uri: 'connection_uri.txt', psql: 'connect_psql.sh', pgpass: 'pgpass_line.txt', hba: 'pg_hba_snippet.conf', pgbouncer: 'pgbouncer.ini', jdbc: 'jdbc_url.txt', python: 'connect.py', nodejs: 'db.js', golang: 'main.go', docker: 'docker_psql.sh' };

  const [cn, resetCn] = persisted('pg.conn', {
    host: 'db.internal.example.com', port: 5432, database: 'production', username: 'app_user', password: '',
    sslmode: 'require', appName: 'dba_cockpit', hbaCidr: '10.0.0.0/16', hbaMethod: 'scram-sha-256',
    format: 'uri', pbListen: '0.0.0.0', pbPort: 6432, poolMode: 'transaction', maxClient: 1000,
    poolSize: 20, reservePool: 5, adminUsers: 'pgbouncer_admin'
  }, ['password']);

  const connOut = computed(() => {
    const c = cn, notes = [];
    const host = txt(c.host, 'localhost');
    const port = int(c.port, 5432);
    const db = txt(c.database, 'postgres');
    const user = txt(c.username, 'postgres');
    const app = txt(c.appName);
    const ssl = c.sslmode;
    const isTls = ssl === 'verify-ca' || ssl === 'verify-full';
    const enc = encodeURIComponent;
    const pwEnc = c.password ? enc(c.password) : '<SIFRE>';
    const pwPlain = c.password ? c.password : 'SIFRE';
    const hbaType = ssl === 'disable' ? 'host' : 'hostssl';
    const cidr = txt(c.hbaCidr, '10.0.0.0/16');
    const method = txt(c.hbaMethod, 'scram-sha-256');
    const uri = `postgresql://${enc(user)}:${pwEnc}@${host}:${port}/${enc(db)}?sslmode=${ssl}` + (app ? `&application_name=${enc(app)}` : '');
    const kv = [['host', host], ['port', port], ['dbname', db], ['user', user], ['sslmode', ssl]];
    if (app) kv.push(['application_name', app]);
    const libpq = kv.map(([k, v]) => k + '=' + kvq(String(v))).join(' ');
    const row = (a, b, c2, d, e) => [a.padEnd(10), b.padEnd(15), c2.padEnd(15), d.padEnd(19), e].join(' ');
    const pgEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    const lang = CONN_LANG[c.format] || 'sh';
    let code = '';

    if (c.format === 'uri') {
      code = uri;
    } else if (c.format === 'psql') {
      code = [
        '# Parola: ~/.pgpass önerilir (.pgpass seçeneğine bakın). Bağlantı:',
        'psql "' + libpq.replace(/(["\\$`])/g, '\\$1') + '"',
        '',
        '# Alternatif: URI ile',
        'psql ' + sh(uri)
      ].join('\n');
    } else if (c.format === 'pgpass') {
      code = [
        '# ~/.pgpass  (Windows: %APPDATA%\\postgresql\\pgpass.conf)',
        '# Satır biçimi: host:port:database:user:password   (\\ ve : karakterleri \\ ile kaçılır)',
        `${pgEsc(host)}:${port}:${pgEsc(db)}:${pgEsc(user)}:${pgEsc(pwPlain)}`,
        '',
        '# İzinler (Linux/macOS): libpq 0600 değilse dosyayı yok sayar',
        'chmod 600 ~/.pgpass'
      ].join('\n');
    } else if (c.format === 'hba') {
      const rows = [
        '# pg_hba.conf  (sıra önemlidir: ilk eşleşen satır kazanır)',
        '# TYPE      DATABASE       USER           ADDRESS            METHOD',
        row(hbaType, db, user, cidr, method)
      ];
      if (ssl !== 'disable') rows.push('# Düz TCP bağlantılarını reddet (genel host kurallarından ÖNCE olmalı):', '# ' + row('hostnossl', 'all', 'all', '0.0.0.0/0', 'reject'));
      rows.push('# Yerel socket (postgres sistem kullanıcısı):', '# ' + row('local', 'all', 'postgres', '', 'peer'), '', '# Uygulamak için (superuser):', '# SELECT pg_reload_conf();');
      code = rows.join('\n');
      if (method === 'trust') notes.push(['danger', '`trust` yöntemi parolasız erişim verir; üretimde kullanmayın. Yerelde bile `peer` veya `scram-sha-256` tercih edin.']);
      if (method === 'peer' && cidr && !/^local$/.test(cidr)) notes.push(['warn', '`peer` yalnızca `local` (Unix socket) satırlarında geçerlidir; ağ adresi için `scram-sha-256` kullanın.']);
      if (method === 'md5') notes.push(['info', '`md5` eski bir yöntemdir; `password_encryption = scram-sha-256` ile `scram-sha-256` kullanın.']);
      if (ssl === 'disable') notes.push(['warn', '`sslmode=disable` ile `host` satırı kullanılır: bağlantı şifrelenmez.']);
      notes.push(['tip', 'Düz TCP bağlantılarını reddetmek için `hostnossl all all 0.0.0.0/0 reject` kuralını, genel `host` kurallarından **önce** ekleyin, ardından `SELECT pg_reload_conf();` çalıştırın.']);
    } else if (c.format === 'pgbouncer') {
      const sslMode = ssl;
      code = [
        '; /etc/pgbouncer/pgbouncer.ini',
        '[databases]',
        `${db} = host=${host} port=${port} dbname=${db}`,
        '',
        '[pgbouncer]',
        `listen_addr = ${txt(c.pbListen, '0.0.0.0')}`,
        `listen_port = ${int(c.pbPort, 6432)}`,
        'auth_type = scram-sha-256',
        'auth_file = /etc/pgbouncer/userlist.txt',
        `pool_mode = ${txt(c.poolMode, 'transaction')}`,
        `max_client_conn = ${int(c.maxClient, 1000)}`,
        `default_pool_size = ${int(c.poolSize, 20)}`,
        `reserve_pool_size = ${int(c.reservePool, 5)}`,
        `server_tls_sslmode = ${sslMode}`,
        `admin_users = ${txt(c.adminUsers, 'pgbouncer_admin')}`,
        '',
        '; /etc/pgbouncer/userlist.txt  (satır: "kullanıcı" "SCRAM hash")',
        '; Hash\'i sunucudan alın (süper kullanıcı gerekir):',
        `; SELECT rolname, rolpassword FROM pg_authid WHERE rolname = '${user}';`,
        `"${user}" "<rolpassword değeri: SCRAM-SHA-256$...>"`
      ].join('\n');
      if (txt(c.poolMode, 'transaction') === 'transaction') notes.push(['warn', 'Transaction pooling: `SET`, `LISTEN/NOTIFY`, advisory lock, temp table ve session bazlı prepared statement\'lar transaction\'lar arasında kaybolur. Eski sürücülerde prepared statement kapatılmalı; PgBouncer 1.21+ `max_prepared_statements` ile destekler.']);
      notes.push(['info', 'Uygulamalar PgBouncer üzerinden `listen_port` (6432) ile bağlanır; `[databases]` satırı gerçek PostgreSQL sunucusunu gösterir. `admin_users` için de userlist\'te kayıt olmalı.']);
    } else if (c.format === 'jdbc') {
      code = [
        `jdbc:postgresql://${host}:${port}/${db}?sslmode=${ssl}` + (app ? `&ApplicationName=${enc(app)}` : ''),
        '',
        '# Kullanıcı ve parolayı URL\'ye koymayın; Properties ile verin:',
        `# user=${user}`,
        '# password=<ortam değişkeni / secret store>'
      ].join('\n');
      notes.push(['tip', 'JDBC\'de kimlik bilgileri URL\'de değil `Properties` (user/password) içinde verilmelidir; böylece loglarda görünmez.']);
    } else if (c.format === 'python') {
      code = [
        '# pip install "psycopg[binary]"',
        'import os',
        'import psycopg',
        '',
        'with psycopg.connect(',
        `    host=${JSON.stringify(host)}, port=${port}, dbname=${JSON.stringify(db)}, user=${JSON.stringify(user)},`,
        '    password=os.environ["PGPASSWORD"],',
        `    sslmode=${JSON.stringify(ssl)}` + (app ? `, application_name=${JSON.stringify(app)}` : '') + ',',
        ') as conn:',
        '    with conn.cursor() as cur:',
        '        cur.execute("SELECT version();")',
        '        print(cur.fetchone()[0])'
      ].join('\n');
      notes.push(['tip', 'Parola `PGPASSWORD` ortam değişkeninden okunur; kodda tutulmaz.']);
    } else if (c.format === 'nodejs') {
      const sslCode = ssl === 'disable' ? 'false'
        : (isTls ? "{ rejectUnauthorized: true, ca: fs.readFileSync('root.crt').toString() }" : '{ rejectUnauthorized: false }');
      code = [
        '// npm install pg',
        ...(isTls ? ["const fs = require('fs');"] : []),
        "const { Pool } = require('pg');",
        '',
        'const pool = new Pool({',
        `  host: ${JSON.stringify(host)},`,
        `  port: ${port},`,
        `  user: ${JSON.stringify(user)},`,
        '  password: process.env.PGPASSWORD,',
        `  database: ${JSON.stringify(db)},`,
        ...(app ? [`  application_name: ${JSON.stringify(app)},`] : []),
        `  ssl: ${sslCode},`,
        '  max: 20,',
        '  idleTimeoutMillis: 30000,',
        '});',
        '',
        'async function testConnection() {',
        '  const client = await pool.connect();',
        "  const res = await client.query('SELECT NOW()');",
        "  console.log('Connected at:', res.rows[0].now);",
        '  client.release();',
        '}',
        'testConnection().finally(() => pool.end());'
      ].join('\n');
      if (ssl === 'require') notes.push(['info', 'Node\'da `require` sertifikayı doğrulamaz (`rejectUnauthorized: false`). Üretimde `verify-full` ve `root.crt` önerilir.']);
    } else if (c.format === 'golang') {
      const dsn = libpq;
      code = [
        '// go get github.com/jackc/pgx/v5/pgxpool',
        'package main',
        '',
        'import (',
        '\t"context"',
        '\t"fmt"',
        '\t"os"',
        '',
        '\t"github.com/jackc/pgx/v5/pgxpool"',
        ')',
        '',
        'func main() {',
        `\tcfg, err := pgxpool.ParseConfig(${JSON.stringify(dsn)})`,
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tcfg.ConnConfig.Password = os.Getenv("PGPASSWORD")',
        '',
        '\tpool, err := pgxpool.NewWithConfig(context.Background(), cfg)',
        '\tif err != nil {',
        '\t\tfmt.Fprintf(os.Stderr, "Bağlantı hatası: %v\\n", err)',
        '\t\tos.Exit(1)',
        '\t}',
        '\tdefer pool.Close()',
        '',
        '\tvar now string',
        '\tif err := pool.QueryRow(context.Background(), "SELECT NOW()::text").Scan(&now); err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tfmt.Println("Postgres saat:", now)',
        '}'
      ].join('\n');
    } else if (c.format === 'docker') {
      code = `docker run --rm -it postgres:17 psql ${sh(uri)}`;
      if (host === '127.0.0.1' || host === 'localhost') notes.push(['info', 'Konteyner içinde `localhost`, konteynerin kendisidir. Ana makineye erişmek için `host.docker.internal` (Docker Desktop) veya Linux\'ta `--network host` kullanın.']);
    }

    // Ortak uyarılar
    if (ssl === 'disable') notes.push(['warn', '`sslmode=disable`: bağlantı şifrelenmez; parola ve veri ağda açık gider. Yalnızca localhost veya izole ağda kullanın.']);
    if (ssl === 'require') notes.push(['tip', '`require` bağlantıyı şifreler ama sunucu sertifikasını doğrulamaz. Üretimde `verify-full` önerilir (`root.crt` gerekir).']);
    if (isTls) notes.push(['info', '`verify-ca` / `verify-full` için istemcide kök sertifika (`root.crt`) bulunmalı. Node örneğinde `fs.readFileSync` ile okunur.']);
    if (c.format === 'uri' || c.format === 'docker') notes.push(['tip', 'URI içinde parola açık görünür (URL-kodlanmış olsa da). Üretimde `.pgpass` veya gizli değişken yönetimi tercih edin.']);
    if (c.format === 'psql') notes.push(['tip', 'Paylaşımlı sunucuda `PGPASSWORD` ortam değişkeni `ps` ve `/proc` ile sızabilir; `~/.pgpass` kullanın.']);
    if (c.format === 'pgpass') notes.push(['tip', '`.pgpass` dosyası `chmod 600` olmalı, aksi halde libpq yok sayar. Host/port/db/user alanlarında `*` joker karakteri kullanılabilir. Windows: `%APPDATA%\\postgresql\\pgpass.conf`.']);
    if (c.format === 'uri') notes.push(['info', 'Kullanıcı, parola, veritabanı ve application_name değerleri `encodeURIComponent` ile kodlanır (ör. `@`, `:`, `/`, `%`).']);
    if (!c.password) notes.push(['info', 'Parola alanı boş: çıktıda `<SIFRE>` yer tutucusu kullanılır. Parola tarayıcıya kaydedilmez.']);

    return { code, lang, file: CONN_FILE[c.format] || 'connection.txt', notes };
  });

  // ==================================================================
  // 7. PGTUNE / BELLEK
  // ==================================================================
  const [pt, resetPt] = persisted('pg.tune', {
    ramGb: 16, cpu: 8, maxConn: 100, workload: 'web', disk: 'ssd', version: '17', mode: 'conf'
  });

  const PT_RESTART = ['shared_buffers', 'max_connections', 'huge_pages', 'max_worker_processes', 'wal_buffers'];

  const ptOut = computed(() => {
    const p = pt, notes = [];
    const ram = Math.min(512, Math.max(1, int(p.ramGb, 16)));
    const cores = Math.min(128, Math.max(1, int(p.cpu, 4)));
    const maxConn = Math.min(2000, Math.max(20, int(p.maxConn, 100)));
    const wl = p.workload, disk = p.disk, ver = p.version;
    const ramMB = ram * 1024;

    const shared = Math.round(ramMB / 4);
    const cache = Math.round(ramMB * 3 / 4);
    const maint = Math.min(2048, Math.round(ramMB / (wl === 'dw' ? 8 : 16)));
    const gather = wl === 'dw' ? Math.ceil(cores / 2) : Math.min(4, Math.ceil(cores / 2));
    const parMaint = Math.min(4, Math.ceil(cores / 2));
    let work = (ramMB - shared) / (maxConn * 3) / Math.max(1, gather);
    if (wl === 'dw' || wl === 'mixed') work /= 2;
    work = Math.max(4, Math.floor(work));
    const wal = { web: [1024, 4096], oltp: [2048, 8192], dw: [4096, 16384], mixed: [1024, 4096] }[wl] || [1024, 4096];
    const stats = wl === 'dw' ? 500 : 100;
    const rpc = disk === 'hdd' ? '4' : '1.1';
    const eic = { ssd: 200, san: 300, hdd: 2 }[disk] || 200;

    const P = [
      ['max_connections', String(maxConn)],
      ['shared_buffers', sizeMB(shared)],
      ['effective_cache_size', sizeMB(cache)],
      ['maintenance_work_mem', sizeMB(maint)],
      ['work_mem', sizeMB(work)],
      ['huge_pages', 'try'],
      ['wal_buffers', '16MB'],
      ['checkpoint_completion_target', '0.9'],
      ['default_statistics_target', String(stats)],
      ['min_wal_size', sizeMB(wal[0])],
      ['max_wal_size', sizeMB(wal[1])],
      ['random_page_cost', rpc],
      ['effective_io_concurrency', String(eic)],
      ['max_worker_processes', String(cores)],
      ['max_parallel_workers_per_gather', String(gather)],
      ['max_parallel_workers', String(cores)],
      ['max_parallel_maintenance_workers', String(parMaint)]
    ];

    let code;
    if (p.mode === 'alter') {
      code = [
        `-- PG ${ver}: ALTER SYSTEM değerleri postgresql.auto.conf dosyasına yazar`,
        ...P.map(([k, v]) => `ALTER SYSTEM SET ${k} = '${v}';` + (PT_RESTART.includes(k) ? '  -- RESTART gerekir' : '')),
        '',
        'SELECT pg_reload_conf();  -- restart gerektirmeyenler hemen devreye girer',
        '-- RESTART gerekenler için: sudo systemctl restart postgresql  (ya da pg_ctl restart)',
        '-- Bekleyen parametreler: SELECT name FROM pg_settings WHERE pending_restart;'
      ].join('\n');
    } else {
      const w = Math.max(...P.map(([k]) => k.length)) + 2;
      code = [
        '# =================================================================',
        `# PostgreSQL DBA Cockpit ile üretildi (PG ${ver})`,
        `# Donanım: ${ram} GB RAM | ${cores} CPU | Disk: ${disk.toUpperCase()} | İş yükü: ${wl}`,
        '# =================================================================',
        '',
        ...P.map(([k, v]) => `${k.padEnd(w)}= ${v}` + (PT_RESTART.includes(k) ? '   # RESTART gerekir' : ''))
      ].join('\n');
    }

    if (maxConn > 300) notes.push(['warn', `\`max_connections\` (${maxConn}) 300\'ün üzerinde: her bağlantı bellek ve planlayıcı yükü getirir. Bağlantıları **PgBouncer** ile havuzlayın ve sunucudaki değeri düşük tutun.`]);
    const totalWork = work * maxConn;
    if (totalWork > ramMB) notes.push(['warn', `\`work_mem\` × \`max_connections\` (${sizeMB(totalWork)}) RAM\'i (${sizeMB(ramMB)}) aşıyor. Sorgu başına birden çok sort/hash bellek kullanabilir; work_mem değerini düşürün veya bağlantıyı havuzlayın.`]);
    notes.push(['info', 'Restart gerektirenler: `shared_buffers`, `max_connections`, `huge_pages`, `max_worker_processes`, `wal_buffers`. Diğer parametreler `SELECT pg_reload_conf();` ile hemen devreye girer.']);
    notes.push(['tip', '`huge_pages = try` değeri, Linux HugePages yoksa normal sayfa kullanır; `on` yaparsanız HugePages yoksa sunucu açılmaz.']);
    notes.push(['info', 'Bu değerler başlangıç noktasıdır. Gerçek iş yükünde `pg_stat_statements` ve `EXPLAIN (ANALYZE, BUFFERS)` ile doğrulayın.']);
    if (wl === 'dw' || wl === 'mixed') notes.push(['tip', 'Karma / DW iş yüklerinde `work_mem` yarıya indirildi: büyük sorgular birden çok bellek bloğu kullanabilir.']);

    const sharedPct = (shared / ramMB) * 100;
    const cachePct = Math.max(0, (cache - shared) / ramMB * 100);
    const restPct = Math.max(0, 100 - sharedPct - cachePct);

    return {
      code, notes, mode: p.mode,
      tiles: { shared: sizeMB(shared), cache: sizeMB(cache), work: sizeMB(work), maint: sizeMB(maint) },
      sharedPct, cachePct, restPct,
      sharedTxt: sizeMB(shared), cacheTxt: sizeMB(cache - shared), restTxt: sizeMB(ramMB - cache)
    };
  });

  // ==================================================================
  // Uygulama kökü
  // ==================================================================
  DBA.mount({
    setup() {
      const tab = hashRoute(modules.map(m => m.id), 'backup');
      return {
        modules, tab,
        bk, resetBk, bkCanJobs, dumpFormats, backupOut,
        rl, regenPwd, applyRolePreset, resetRoleAll, roleOut, roleDrop,
        sub, storageSubs, LOCALES, resetStorage,
        dbc, dbOut,
        ts, tsOut,
        av, AV_PROFILES, applyAv, avOut,
        vc, vacOut,
        ss, resetSs, ssOut,
        queries, qcats,
        CONN_FORMATS, cn, resetCn, connOut,
        pt, resetPt, ptOut
      };
    }
  });
})();
