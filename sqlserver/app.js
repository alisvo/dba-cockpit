/* SQL Server DBA Cockpit – T-SQL, bcp, bağlantı dizgesi ve kaynak hesaplayıcı */
(function () {
  const { computed, ref } = Vue;
  const { persisted, hashRoute, genPassword, msIdent, msQName, msLit, stamp } = DBA;

  const modules = [
    { id: 'backup', name: 'Backup / Restore / BCP', icon: '📦' },
    { id: 'security', name: 'Login & Yetki', icon: '👤' },
    { id: 'storage', name: 'Database & Storage', icon: '💾' },
    { id: 'sessions', name: 'Oturum & Kill', icon: '⚡' },
    { id: 'dmv', name: 'DMV Sorguları', icon: '🔍' },
    { id: 'connection', name: 'Bağlantı', icon: '🌐' },
    { id: 'tuning', name: 'Memory & MAXDOP', icon: '🧮' }
  ];

  DBA.mount({
    setup() {
      const tab = hashRoute(modules.map(m => m.id), 'backup');

      // ==============================================================
      // Ortak yardımcılar (yalnızca bu sayfa)
      // ==============================================================
      const DEFAULT_BK_DIR = 'D:\\SQLBackups\\';
      const DEFAULT_DATA_DIR = 'D:\\SQLData\\';
      const DEFAULT_LOG_DIR = 'L:\\SQLLog\\';

      // Sayı alanlarını güvenli aralığa sıkıştırır; boş/geçersiz girişte varsayılanı döndürür
      const posInt = (v, min, max, dflt) => {
        const n = parseInt(v, 10);
        return isNaN(n) ? dflt : Math.min(max, Math.max(min, n));
      };
      // "D:\\A\\b.bak" → "D:\\A\\"  (sondaki ayraç dahil)
      const dirOf = (p) => {
        const m = /^(.*[\\/])[^\\/]*$/.exec(String(p || ''));
        return m ? m[1] : '';
      };
      // Klasör + dosya adı birleştirir (Windows ayracı)
      const joinWin = (dir, name) => {
        const d = String(dir || '').trim().replace(/[\\/]+$/, '');
        return (d ? d + '\\' : '') + name;
      };
      // "x/y.bak" → ["x/y", ".bak"]; uzantı yoksa ["x/y", ""]
      const splitExt = (p) => {
        const s = String(p || '');
        const i = s.search(/\.[^\\/.]*$/);
        return i > 0 ? [s.slice(0, i), s.slice(i)] : [s, ''];
      };
      // Yedek/restore için DISK listesi
      const diskList = (paths) => paths.map(p => 'DISK = ' + msLit(p)).join(', ');
      // cmd satırında çift tırnaklı değer (tırnak karakteri kaldırılır)
      const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '\\"') + '"';
      const onOff = (b) => (b ? 'ON' : 'OFF');
      const indent = (text) => text.split('\n').map(l => (l ? '    ' + l : l)).join('\n');
      // Üretilen betiğe standart başlık bloğu
      const hdr = (title, lines = []) => [
        '-- =================================================================',
        '-- ' + title,
        ...lines.map(l => '-- ' + l),
        '-- ================================================================='
      ].join('\n');

      // Yedek geçmişi: hem BACKUP modülünde hem DMV listesinde kullanılır
      const SQL_LAST_BACKUPS = `-- Veritabanı başına son FULL / DIFF / LOG yedek zamanları (msdb)
SELECT d.name AS database_name, d.recovery_model_desc,
       MAX(CASE WHEN b.type = 'D' THEN b.backup_finish_date END) AS last_full,
       MAX(CASE WHEN b.type = 'I' THEN b.backup_finish_date END) AS last_diff,
       MAX(CASE WHEN b.type = 'L' THEN b.backup_finish_date END) AS last_log
FROM sys.databases d
LEFT JOIN msdb.dbo.backupset b ON b.database_name = d.name AND b.is_copy_only = 0
WHERE d.name <> 'tempdb'
GROUP BY d.name, d.recovery_model_desc
ORDER BY last_full;
GO`;

      // ==============================================================
      // 1. BACKUP / RESTORE / BCP
      // ==============================================================
      const bkSub = ref('backup');
      const BK_TITLE = { FULL: 'FULL BACKUP', DIFF: 'DIFFERENTIAL BACKUP', LOG: 'TRANSACTION LOG BACKUP' };

      const [bk, resetBk] = persisted('ms.bk', {
        database: 'AdventureWorks2022', type: 'FULL', path: 'D:\\SQLBackups\\AdventureWorks2022_Full.bak',
        stripes: 1, compression: true, checksum: true, copyOnly: false, init: true, format: false,
        stats: 5, tuneIo: false, encrypt: false, encAlgo: 'AES_256', encCert: 'BackupCert', backupName: ''
      });

      const autoBkPath = () => {
        const ext = bk.type === 'LOG' ? '.trn' : '.bak';
        const dir = dirOf(bk.path) || DEFAULT_BK_DIR;
        const name = (bk.database.trim() || 'DB').replace(/[\\/:*?"<>|\s]/g, '_');
        bk.path = dir + name + '_' + bk.type + '_' + stamp() + ext;
        DBA.toast('Yedek dosya yoluna tarih damgası eklendi');
      };

      const bkOut = computed(() => {
        const b = bk, notes = [];
        const db = b.database.trim() || 'VeritabaniAdi';
        const isLog = b.type === 'LOG', isDiff = b.type === 'DIFF';
        const path = b.path.trim();
        const n = posInt(b.stripes, 1, 8, 1);
        const [base, ext] = splitExt(path);
        const paths = n > 1 ? Array.from({ length: n }, (_, i) => base + '_' + (i + 1) + ext) : [path];
        const opts = [];

        if (isDiff) opts.push('DIFFERENTIAL');
        if (b.copyOnly) {
          if (isDiff) notes.push(['info', 'COPY_ONLY, DIFFERENTIAL yedekle etkisizdir; seçenek üretilmedi.']);
          else opts.push('COPY_ONLY');
        }
        if (b.compression) opts.push('COMPRESSION');
        if (b.checksum) opts.push('CHECKSUM');
        opts.push(b.init ? 'INIT' : 'NOINIT');
        if (b.format) {
          opts.push('FORMAT');
          notes.push(['warn', "`FORMAT` medya başlığını yeniden yazar; aynı dosyadaki önceki yedek setleri artık kullanılamaz. Yeni bir dosya adı kullanın."]);
        }
        if (b.encrypt) {
          opts.push('ENCRYPTION (ALGORITHM = ' + b.encAlgo + ', SERVER CERTIFICATE = ' + msIdent(b.encCert.trim() || 'BackupCert') + ')');
          notes.push(['warn', "Şifreli yedek: sertifikayı **ve özel anahtarını** (`BACKUP CERTIFICATE … WITH PRIVATE KEY`) ayrıca yedekleyin. Yoksa yedek başka bir sunucuda veya sertifika kaybında **geri yüklenemez**."]);
        }
        if (b.backupName.trim()) opts.push('NAME = ' + msLit(b.backupName.trim()));
        const st = posInt(b.stats, 0, 100, 0);
        if (st > 0) opts.push('STATS = ' + st);
        if (b.tuneIo) {
          opts.push('BUFFERCOUNT = 64', 'MAXTRANSFERSIZE = 4194304');
          notes.push(['tip', 'BUFFERCOUNT × MAXTRANSFERSIZE yedek başına bellek kullanımıdır (64 × 4 MB = 256 MB / stripe). Sunucu belleği kısıtlıysa değerleri düşürün.']);
        }

        if (!path) notes.push(['danger', 'Yedek dosya yolu boş.']);
        if (n > 1) notes.push(['info', 'Stripe yedekte tüm dosyaları RESTORE sırasında aynı sırayla verin; biri eksikse restore başarısız olur.']);
        if (isLog) notes.push(['warn', "LOG yedeği yalnızca **FULL** veya **BULK_LOGGED** kurtarma modelinde alınabilir (SIMPLE modelde hata verir). Kontrol: `SELECT name, recovery_model_desc FROM sys.databases;`"]);
        if (isDiff) notes.push(['info', 'Diferansiyel yedek, son COPY_ONLY olmayan FULL yedeğe göre alınır. Yeni bir FULL alındığında fark zincirini yeniden başlatın.']);

        const sql = [
          hdr(BK_TITLE[b.type] || BK_TITLE.FULL, ['Veritabanı: ' + db]),
          'BACKUP ' + (isLog ? 'LOG ' : 'DATABASE ') + msIdent(db),
          'TO ' + diskList(paths),
          'WITH',
          '  ' + opts.join(',\n  ') + ';',
          'GO'
        ].join('\n');

        const verify = hdr('Yedek doğrulama (veritabanını geri yüklemeden)') +
          '\nRESTORE VERIFYONLY FROM ' + diskList(paths) + '\nWITH CHECKSUM;\nGO';

        return { sql, verify, notes, file: 'backup_' + db + '_' + b.type + '.sql' };
      });

      const [rs, resetRs] = persisted('ms.rs', {
        targetDb: 'AdventureWorks_Restored', backupPath: 'D:\\SQLBackups\\AdventureWorks2022_Full.bak',
        recovery: 'RECOVERY', standbyUndo: 'D:\\SQLBackups\\AdventureWorks_undo.ldf',
        replace: true, checksum: true, stats: 5,
        moveFiles: [
          { logicalName: 'AdventureWorks2022_Data', physicalPath: 'D:\\SQLData\\AdventureWorks_Restored.mdf' },
          { logicalName: 'AdventureWorks2022_Log', physicalPath: 'L:\\SQLLog\\AdventureWorks_Restored.ldf' }
        ],
        logFiles: '', stopAt: ''
      });

      const addMove = () => rs.moveFiles.push({ logicalName: '', physicalPath: '' });
      const removeMove = (i) => rs.moveFiles.splice(i, 1);

      // Kurtarma modu → WITH seçeneği
      const recOpt = (mode, undo) => mode === 'RECOVERY'
        ? 'RECOVERY'
        : mode === 'STANDBY' ? 'STANDBY = ' + msLit(undo) : 'NORECOVERY';

      const rsOut = computed(() => {
        const r = rs, notes = [];
        const name = r.targetDb.trim() || 'RestoredDb';
        const db = msIdent(name);
        const src = r.backupPath.trim();
        const logs = r.logFiles.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const hasLogs = logs.length > 0;
        let stop = r.stopAt.trim().replace('T', ' ');
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stop)) stop += ':00';
        const stopOk = !!stop;
        const undo = r.standbyUndo.trim();
        const stats = posInt(r.stats, 0, 100, 0);
        const moves = r.moveFiles
          .filter(m => m.logicalName.trim() && m.physicalPath.trim())
          .map(m => 'MOVE ' + msLit(m.logicalName.trim()) + ' TO ' + msLit(m.physicalPath.trim()));
        const finalRec = r.recovery;
        const fullRec = hasLogs ? 'NORECOVERY' : finalRec;

        if (r.replace) notes.push(['warn', "REPLACE mevcut veritabanının üzerine yazar ve **tail-log yedeği kontrolünü atlar**. Kaynak yedeğin doğru olduğundan emin olun."]);
        else notes.push(['info', 'REPLACE kapalı: hedef adda veritabanı varsa restore hata verir.']);
        if (finalRec === 'STANDBY' && !undo) notes.push(['danger', 'STANDBY için undo dosyası yolu gerekli.']);
        if (stopOk && !hasLogs) notes.push(['warn', "STOPAT yalnızca log yedeği restore'unda kullanılır; log listesi boş olduğu için yok sayıldı."]);
        if (hasLogs) notes.push(['info', 'Zincir: tam yedek NORECOVERY ile yüklenir, ara log yedekleri NORECOVERY, son log seçilen kurtarma moduyla (varsa STOPAT ile) tamamlanır.']);
        if (!moves.length) notes.push(['info', 'MOVE tanımlı değil: dosyalar yedekteki özgün yollara yazılır; bu klasörler yoksa restore başarısız olur. Mantıksal adlar için aşağıdaki FILELISTONLY çıktısına bakın.']);
        if (finalRec === 'NORECOVERY' && !hasLogs) notes.push(['tip', 'NORECOVERY: veritabanı RESTORING durumunda kalır ve ek log yedekleri uygulanabilir. Tamamlamak için son adımda RECOVERY veya STANDBY kullanın.']);
        if (finalRec === 'STANDBY') notes.push(['info', 'STANDBY: veritabanı salt okunur kalır ve log uygulanmaya devam eder. Bu modda MULTI_USER komutu üretilmez.']);

        const L = [];
        L.push(hdr('RESTORE DATABASE', ['Hedef: ' + name, 'Son kurtarma: ' + (hasLogs ? 'log zinciri, ' : '') + finalRec]));
        L.push('USE [master];', 'GO', '');
        if (r.replace) {
          L.push('-- Hedef veritabanı varsa tek kullanıcıya al (yoksa bu satır etkisizdir)');
          L.push('IF DB_ID(' + msLit(name) + ') IS NOT NULL ALTER DATABASE ' + db + ' SET SINGLE_USER WITH ROLLBACK IMMEDIATE;');
          L.push('GO', '');
        }

        const fullOpts = [];
        if (r.replace) fullOpts.push('REPLACE');
        fullOpts.push(recOpt(fullRec, undo));
        fullOpts.push(...moves);
        if (r.checksum) fullOpts.push('CHECKSUM');
        if (stats > 0) fullOpts.push('STATS = ' + stats);
        L.push('-- Tam yedek');
        L.push('RESTORE DATABASE ' + db, 'FROM DISK = ' + msLit(src), 'WITH', '  ' + fullOpts.join(',\n  ') + ';', 'GO', '');

        logs.forEach((p, i) => {
          const last = i === logs.length - 1;
          const o = [];
          if (last && stopOk) o.push('STOPAT = ' + msLit(stop));
          o.push(last ? recOpt(finalRec, undo) : 'NORECOVERY');
          if (r.checksum) o.push('CHECKSUM');
          if (stats > 0) o.push('STATS = ' + stats);
          L.push('-- Log yedeği ' + (i + 1) + ' / ' + logs.length + (last ? ' (son)' : ''));
          L.push('RESTORE LOG ' + db, 'FROM DISK = ' + msLit(p), 'WITH ' + o.join(', ') + ';', 'GO', '');
        });

        if (finalRec === 'RECOVERY') L.push('ALTER DATABASE ' + db + ' SET MULTI_USER;', 'GO');

        return { sql: L.join('\n'), notes, file: 'restore_' + name + '.sql' };
      });

      const rsHeader = computed(() => {
        const p = rs.backupPath.trim() || 'D:\\SQLBackups\\yedek.bak';
        return hdr('Mantıksal dosya adları ve yedek başlığı (MOVE için)') +
          '\nRESTORE FILELISTONLY FROM DISK = ' + msLit(p) + ';\nGO\n\n' +
          'RESTORE HEADERONLY FROM DISK = ' + msLit(p) + ';\nGO';
      });

      // ---------- BCP ----------
      const [bc, resetBc] = persisted('ms.bcp', {
        direction: 'out', fmt: 'char', delim: ',', lf: true, auth: 'T', server: 'SRV-SQL01',
        database: 'AdventureWorks2022', table: 'Sales.Customer', query: 'SELECT TOP 1000 * FROM Sales.Customer',
        filePath: 'D:\\Export\\CustomerData.csv', user: 'sa', password: '',
        skipHeader: false, keepNulls: false, keepIdentity: false, utf8: true, batchSize: 10000, tablock: false
      }, ['password']);

      const bcOut = computed(() => {
        const c = bc, notes = [];
        const dir = c.direction;
        const isIn = dir === 'in';
        const srv = c.server.trim() || 'localhost';
        const db = c.database.trim() || 'master';
        const file = c.filePath.trim() || 'veri.dat';

        let target;
        if (dir === 'queryout') {
          const query = c.query.trim().replace(/\s*\r?\n\s*/g, ' ');
          if (!query) notes.push(['danger', 'queryout için sorgu boş.']);
          if (query.includes('"')) notes.push(['warn', 'Sorgudaki çift tırnaklar `\\"` ile kaçışlandı. Tanımlayıcıları `[ ]` ile yazmak daha güvenlidir.']);
          target = q(query);
        } else {
          target = msQName(c.table.trim() || 'dbo.Tablo');
        }

        const parts = ['bcp', target, dir, q(file), '-S', q(srv), '-d', q(db)];

        if (c.auth === 'T') {
          parts.push('-T');
        } else {
          parts.push('-U', q(c.user.trim() || 'sa'), '-P', q(c.password || '<şifre>'));
          notes.push(['warn', "SQL kimlik doğrulamada `-P` parolası komut satırında ve PowerShell geçmişinde görünür. Mümkünse `-T` (Windows kimlik doğrulama) kullanın."]);
        }

        if (c.fmt === 'char') parts.push('-c', '-t', q(c.delim));
        else if (c.fmt === 'wide') parts.push('-w');
        else parts.push('-n');
        if (c.lf && c.fmt !== 'native') parts.push('-r', '"\\n"');

        if (c.fmt === 'char' && c.utf8) parts.push('-C', '65001');
        else if (c.utf8) notes.push(['info', '`-C 65001` yalnızca `-c` (karakter) biçiminde geçerlidir; `-n` ve `-w` için üretilmedi.']);

        const inOpts = [];
        if (c.skipHeader) inOpts.push('-F 2');
        if (c.keepNulls) inOpts.push('-k');
        if (c.keepIdentity) inOpts.push('-E');
        const batch = posInt(c.batchSize, 1, 100000000, 0);
        if (batch > 0) inOpts.push('-b ' + batch);
        if (c.tablock) inOpts.push('-h "TABLOCK"');
        if (isIn) parts.push(...inOpts);
        else {
          const selected = [];
          if (c.skipHeader) selected.push('-F 2');
          if (c.keepNulls) selected.push('-k');
          if (c.keepIdentity) selected.push('-E');
          if (c.tablock) selected.push('-h "TABLOCK"');
          if (selected.length) notes.push(['info', selected.join(' ') + ' yalnızca **in** (import) yönünde geçerlidir; ' + dir + ' komutuna eklenmedi.']);
        }

        parts.push('-e', q((dirOf(file) || '.\\') + 'bcp_err.log'));

        if (dir === 'queryout') notes.push(['info', 'queryout yalnızca sorgu sonucunu yazar; `-d` sorgunun çalışacağı veritabanıdır.']);
        if (isIn) notes.push(['tip', 'Hedef tablo önceden var olmalı. Kolon sırası dosyayla eşleşmiyorsa bir format dosyası kullanın.']);
        if (!c.lf && c.fmt !== 'native') notes.push(['tip', 'Satır sonu LF değil; bcp varsayılanı (CRLF) kullanılacak.']);

        return { cmd: parts.join(' '), notes, file: 'bcp_' + dir + '.cmd' };
      });

      // ==============================================================
      // 2. LOGIN & YETKİ
      // ==============================================================
      const PRESET_LABEL = { readonly: 'Salt okunur', readwrite: 'Okuma / yazma', ddladmin: 'DDL yöneticisi', granular: 'Ayrıntılı' };

      const [sec, resetSec] = persisted('ms.sec', {
        loginType: 'SQL', username: 'app_service_user', password: '', database: 'Production_DB',
        checkPolicy: true, checkExpiration: true, mustChange: false,
        preset: 'readonly', granularPerm: 'EXECUTE', granularTarget: 'OBJECT', granularName: 'dbo.usp_CalculateReport',
        roles: { processadmin: false, securityadmin: false, dbcreator: false, sysadmin: false }
      }, ['password']);
      if (!sec.password) sec.password = genPassword(20);
      const regenPwd = () => { sec.password = genPassword(20); DBA.toast('Yeni şifre üretildi'); };

      const secOut = computed(() => {
        const s = sec, notes = [];
        const name = s.username.trim() || 'app_user';
        const N = msIdent(name);
        const DB = msIdent(s.database.trim() || 'master');
        const L = [];
        L.push(hdr('LOGIN VE KULLANICI YETKİLENDİRME', ['Login: ' + name, 'Veritabanı: ' + (s.database.trim() || 'master')]));
        L.push('USE [master];', 'GO', '');

        let create;
        if (s.loginType === 'WINDOWS') {
          create = 'CREATE LOGIN ' + N + ' FROM WINDOWS WITH DEFAULT_DATABASE = ' + DB + ';';
          notes.push(['info', "Windows login adı `DOMAIN\\kullanici` biçiminde olmalı ve Active Directory'de bulunmalı. Şifre alanı kullanılmaz."]);
        } else if (s.loginType === 'ENTRA') {
          create = 'CREATE LOGIN ' + N + ' FROM EXTERNAL PROVIDER WITH DEFAULT_DATABASE = ' + DB + ';';
          notes.push(['info', "Entra ID login'i için SQL Server 2022+ (Entra entegrasyonu) veya Azure SQL Managed Instance gerekir. Ad UPN biçiminde olmalı (`ad@sirket.com`)."]);
        } else {
          let check = s.checkPolicy, exp = s.checkExpiration;
          if (s.mustChange && (!check || !exp)) {
            notes.push(['info', "MUST_CHANGE, CHECK_POLICY ve CHECK_EXPIRATION'ın ikisinin de ON olmasını gerektirir; ikisi de açıldı."]);
            check = true; exp = true;
          }
          if (exp && !check) {
            notes.push(['warn', 'CHECK_EXPIRATION = ON, CHECK_POLICY = ON gerektirir; şifre süresi kapatıldı.']);
            exp = false;
          }
          if (!s.password) notes.push(['danger', 'Şifre boş. "Yeni üret" ile bir şifre oluşturun.']);
          create = 'CREATE LOGIN ' + N +
            '\n    WITH PASSWORD = ' + msLit(s.password) + (s.mustChange ? ' MUST_CHANGE' : '') + ',' +
            '\n         DEFAULT_DATABASE = ' + DB + ',' +
            '\n         CHECK_POLICY = ' + onOff(check) + ',' +
            '\n         CHECK_EXPIRATION = ' + onOff(exp) + ';';
        }
        L.push('-- Server login (yoksa oluştur)');
        L.push('IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = ' + msLit(name) + ')', 'BEGIN', indent(create), 'END', 'GO', '');

        const roles = ['processadmin', 'securityadmin', 'dbcreator', 'sysadmin'].filter(r => s.roles[r]);
        if (roles.length) {
          L.push('-- Sunucu rolleri (isteğe bağlı)');
          roles.forEach(r => L.push('ALTER SERVER ROLE ' + msIdent(r) + ' ADD MEMBER ' + N + ';'));
          L.push('GO', '');
        }
        if (s.roles.sysadmin) notes.push(['danger', '`sysadmin` sunucudaki her şeye tam yetki verir. Uygulama ve servis hesaplarına **verilmemeli**.']);

        L.push('-- Veritabanı kullanıcısı (login ile eşleşen)');
        L.push('USE ' + DB + ';', 'GO', '');
        L.push('IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ' + msLit(name) + ')');
        L.push('    CREATE USER ' + N + ' FOR LOGIN ' + N + ' WITH DEFAULT_SCHEMA = [dbo];', 'GO', '');

        L.push('-- Veritabanı yetkileri (' + PRESET_LABEL[s.preset] + ')');
        if (s.preset === 'readonly') {
          L.push('ALTER ROLE [db_datareader] ADD MEMBER ' + N + ';', 'GRANT VIEW DEFINITION TO ' + N + ';');
        } else if (s.preset === 'readwrite') {
          L.push('ALTER ROLE [db_datareader] ADD MEMBER ' + N + ';', 'ALTER ROLE [db_datawriter] ADD MEMBER ' + N + ';', 'GRANT EXECUTE TO ' + N + ';');
          notes.push(['info', "db_datawriter tüm kullanıcı tablolarına yazma verir; `GRANT EXECUTE` veritabanındaki tüm prosedür ve fonksiyonları çalıştırabilir."]);
        } else if (s.preset === 'ddladmin') {
          L.push('ALTER ROLE [db_datareader] ADD MEMBER ' + N + ';', 'ALTER ROLE [db_datawriter] ADD MEMBER ' + N + ';', 'ALTER ROLE [db_ddladmin] ADD MEMBER ' + N + ';');
          notes.push(['warn', '`db_ddladmin` şema değiştirme (CREATE / ALTER / DROP) yetkisi verir; uygulama hesabına önerilmez.']);
        } else {
          const obj = s.granularName.trim() || 'dbo.Nesne';
          if (s.granularTarget === 'SCHEMA') L.push('GRANT ' + s.granularPerm + ' ON SCHEMA::' + msIdent(obj) + ' TO ' + N + ';');
          else L.push('GRANT ' + s.granularPerm + ' ON OBJECT::' + msQName(obj) + ' TO ' + N + ';');
        }
        L.push('GO');
        return { sql: L.join('\n'), notes, file: 'login_' + name + '.sql' };
      });

      const secMaint = computed(() => {
        const name = sec.username.trim() || 'app_user';
        const N = msIdent(name);
        const DB = msIdent(sec.database.trim() || 'master');
        const orphan = `-- Orphan kullanıcılar: veritabanında var, sunucuda login'i yok
SELECT dp.name
FROM sys.database_principals dp
LEFT JOIN sys.server_principals sp ON dp.sid = sp.sid
WHERE sp.sid IS NULL
  AND dp.type IN ('S','U','G')
  AND dp.authentication_type_desc = 'INSTANCE';
GO

-- Eşleştirme (login adı aynıysa)
ALTER USER ${N} WITH LOGIN = ${N};
GO`;
        const drop = `-- 1. Kullanıcının sahip olduğu şemalar (DROP USER bunları engeller)
USE ${DB};
GO
SELECT name FROM sys.schemas WHERE principal_id = USER_ID(${msLit(name)});
-- Sahipliği devretmek için: ALTER AUTHORIZATION ON SCHEMA::[sema] TO dbo;
GO

-- 2. Login'in sahip olduğu veritabanları (DROP LOGIN bunları engeller)
SELECT name FROM sys.databases WHERE SUSER_SNAME(owner_sid) = ${msLit(name)};
-- Sahipliği devretmek için: ALTER AUTHORIZATION ON DATABASE::[db] TO [sa];
GO

-- 3. Açık oturumlar (önce KILL, bkz. Oturum modülü)
SELECT session_id, login_name, host_name, program_name, status
FROM sys.dm_exec_sessions
WHERE login_name = ${msLit(name)};
GO

-- 4. Veritabanı kullanıcısını sil (bu veritabanında)
-- DROP USER ${N};
-- GO

-- 5. Sunucu login'ini sil (master'da, tüm veritabanlarındaki eşlemelerden sonra)
-- USE [master];
-- DROP LOGIN ${N};
-- GO`;
        return { orphan, drop };
      });

      // ==============================================================
      // 3. DATABASE, FILE & STORAGE
      // ==============================================================
      const stSub = ref('create_db');

      const [cdb, resetCdb] = persisted('ms.st.create', {
        name: 'Yeni_DB', dataPath: 'E:\\SQLData', logPath: 'L:\\SQLLog',
        dataSize: '1024MB', dataGrowth: '256MB', logSize: '256MB', logGrowth: '128MB',
        recovery: 'FULL', owner: 'sa', rcsi: false
      });

      const cdbOut = computed(() => {
        const c = cdb, notes = [];
        const name = c.name.trim() || 'Yeni_DB';
        const N = msIdent(name);
        // Sabit MB değerleri; yüzde büyüme ve geçersiz girişler uyarılarak düzeltilir
        const mbVal = (raw, dflt, label) => {
          const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
          if (s.includes('%')) {
            notes.push(['warn', label + ': yüzde (%) büyüme kullanılmaz; büyük dosyada yüzde büyüme her seferinde daha fazla alan ister. Sabit MB verin. ' + dflt + ' kullanıldı.']);
            return dflt;
          }
          const m = /^(\d+)(MB|GB|M|G)?$/.exec(s);
          if (!m) {
            notes.push(['warn', label + ': "' + raw + '" geçersiz; ' + dflt + ' kullanıldı.']);
            return dflt;
          }
          return parseInt(m[1], 10) + ((m[2] || 'MB')[0] === 'G' ? 'GB' : 'MB');
        };
        const dSize = mbVal(c.dataSize, '1024MB', 'Veri boyutu');
        const dGrow = mbVal(c.dataGrowth, '256MB', 'Veri büyümesi');
        const lSize = mbVal(c.logSize, '256MB', 'Log boyutu');
        const lGrow = mbVal(c.logGrowth, '128MB', 'Log büyümesi');
        const dataFile = joinWin(c.dataPath || DEFAULT_DATA_DIR, name + '.mdf');
        const logFile = joinWin(c.logPath || DEFAULT_LOG_DIR, name + '_log.ldf');

        const L = [];
        L.push(hdr('CREATE DATABASE', ['Veritabanı: ' + name, 'Kurtarma modeli: ' + c.recovery]));
        L.push('USE [master];', 'GO', '');
        L.push('CREATE DATABASE ' + N,
          'ON PRIMARY',
          '(',
          '    NAME = ' + msLit(name) + ',',
          '    FILENAME = ' + msLit(dataFile) + ',',
          '    SIZE = ' + dSize + ',',
          '    FILEGROWTH = ' + dGrow,
          ')',
          'LOG ON',
          '(',
          '    NAME = ' + msLit(name + '_log') + ',',
          '    FILENAME = ' + msLit(logFile) + ',',
          '    SIZE = ' + lSize + ',',
          '    FILEGROWTH = ' + lGrow,
          ');',
          'GO', '');
        if (c.owner.trim()) L.push('ALTER AUTHORIZATION ON DATABASE::' + N + ' TO ' + msIdent(c.owner.trim()) + ';', 'GO', '');
        L.push('ALTER DATABASE ' + N + ' SET RECOVERY ' + c.recovery + ';', 'GO', '');
        if (c.rcsi) L.push('ALTER DATABASE ' + N + ' SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;', 'GO', '');

        if (c.recovery === 'FULL') notes.push(['warn', "FULL kurtarma modelinde log zinciri **ilk FULL yedekten** sonra başlar. Veritabanı oluşturulunca hemen FULL yedek ve düzenli log yedeği planlayın; yoksa log sürekli büyür."]);
        if (c.recovery === 'SIMPLE') notes.push(['info', 'SIMPLE modelde log yedeği alınamaz ve point-in-time restore yapılamaz.']);
        if (c.rcsi) notes.push(['info', 'RCSI satır sürümlerini tempdb içinde tutar; tempdb büyüklüğünü izleyin. Açılırken veritabanına tek kullanıcı erişimi gerekebilir.']);
        if (!c.dataPath.trim() || !c.logPath.trim()) notes.push(['info', 'Veri veya log klasörü boş: varsayılan klasörler kullanıldı; klasörlerin var olduğundan emin olun.']);

        return { sql: L.join('\n'), notes, file: 'create_' + name + '.sql' };
      });

      const [afl, resetAfl] = persisted('ms.st.addfile', {
        database: 'Production_DB', fileType: 'DATA', filegroup: 'PRIMARY', logicalName: 'Prod_Data_02',
        physicalPath: 'E:\\SQLData\\Prod_Data_02.ndf', size: '10240MB', filegrowth: '1024MB', maxsize: 'UNLIMITED'
      });

      const aflOut = computed(() => {
        const f = afl, notes = [];
        const isLog = f.fileType === 'LOG';
        const body = '(\n    NAME = ' + msLit(f.logicalName.trim() || 'Yeni_Dosya') +
          ',\n    FILENAME = ' + msLit(f.physicalPath.trim() || DEFAULT_DATA_DIR + 'Yeni_Dosya.ndf') +
          ',\n    SIZE = ' + (f.size.trim() || '1024MB') +
          ',\n    FILEGROWTH = ' + (f.filegrowth.trim() || '256MB') +
          ',\n    MAXSIZE = ' + (f.maxsize.trim() || 'UNLIMITED') + '\n)';
        if (/%/.test(f.filegrowth)) notes.push(['warn', 'FILEGROWTH için yüzde kullanmayın; sabit MB verin.']);
        const db = msIdent(f.database.trim() || 'VeritabaniAdi');
        let sql;
        if (isLog) {
          sql = hdr('ADD LOG FILE (.ldf)') + '\nUSE [master];\nGO\n\nALTER DATABASE ' + db + '\nADD LOG FILE\n' + body + ';\nGO';
          notes.push(['tip', 'Yeni log dosyası VLF sayısını artırabilir. Büyütmeyi tek adımda ve makul bir boyutta yapın.']);
        } else {
          sql = hdr('ADD DATA FILE (.ndf)') + '\nUSE [master];\nGO\n\nALTER DATABASE ' + db + '\nADD FILE\n' + body +
            '\nTO FILEGROUP ' + msIdent(f.filegroup.trim() || 'PRIMARY') + ';\nGO';
          notes.push(['info', 'Instant File Initialization (IFI) büyük veri dosyalarının oluşturulmasını hızlandırır; log dosyaları için geçerli değildir.']);
        }
        return { sql, notes, file: 'add_file.sql' };
      });

      const [shr, resetShr] = persisted('ms.st.shrink', {
        database: 'Production_DB', kind: 'DATA', fileName: 'Prod_Data_01', mode: 'TARGET', targetSizeMb: 5000
      });

      const shrOut = computed(() => {
        const s = shr, notes = [];
        const db = s.database.trim() || 'VeritabaniAdi';
        const DB = msIdent(db);
        const file = s.fileName.trim() || 'Dosya_Adi';
        const F = msLit(file);
        const isLog = s.kind === 'LOG';
        let mode = s.mode;
        if (isLog && mode === 'EMPTYFILE') {
          notes.push(['info', 'Log dosyası için EMPTYFILE kullanılamaz; TARGET moduna geçildi.']);
          mode = 'TARGET';
        }
        const target = posInt(s.targetSizeMb, 1, 10000000, 1024);
        const L = [];
        L.push(hdr('DBCC SHRINKFILE', ['Veritabanı: ' + db, 'Dosya: ' + file + ' (' + (isLog ? 'LOG' : 'DATA') + ')']));
        L.push('USE ' + DB + ';', 'GO', '');

        if (isLog) {
          notes.push(['warn', "Log küçültmek için kullanılmayan VLF'lerin serbest kalması gerekir. Önce `log_reuse_wait_desc` nedenine bakın: `LOG_BACKUP` ise log yedeği, `ACTIVE_TRANSACTION` ise açık transaction'ı kapatın; ardından `CHECKPOINT`."]);
          L.push('-- 1. Log neden küçülmüyor?');
          L.push('SELECT name, recovery_model_desc, log_reuse_wait_desc FROM sys.databases WHERE name = ' + msLit(db) + ';', 'GO', '');
          L.push('-- 2. Kullanılmayan log alanını serbest bırak');
          L.push('CHECKPOINT;', 'GO', '');
          L.push('-- FULL / BULK_LOGGED ve log_reuse_wait_desc = LOG_BACKUP ise log yedeği zorunludur:');
          L.push('-- BACKUP LOG ' + DB + ' TO DISK = ' + msLit(joinWin(DEFAULT_BK_DIR, db + '_before_shrink.trn')) + ' WITH COMPRESSION, CHECKSUM, STATS = 5;', '-- GO', '');
        }

        if (mode === 'TRUNCATEONLY') {
          notes.push(['info', 'TRUNCATEONLY sayfa taşımaz; yalnızca dosya sonundaki boş alanı işletim sistemine iade eder.']);
          L.push('-- Dosya sonundaki boş alanı iade et (sayfa taşımaz, indeks bozmaz)');
          L.push('DBCC SHRINKFILE (' + F + ', TRUNCATEONLY);', 'GO');
        } else if (mode === 'EMPTYFILE') {
          L.push('-- Tüm veriyi aynı filegroup\'taki diğer dosyalara taşır (dosya silme hazırlığı)');
          L.push('DBCC SHRINKFILE (' + F + ', EMPTYFILE);', 'GO', '');
          L.push('-- Veri taşındıktan sonra dosyayı kaldırmak için:');
          L.push('-- ALTER DATABASE ' + DB + ' REMOVE FILE ' + msIdent(file) + ';');
        } else {
          L.push('-- Sayfaları taşıyarak hedef boyuta (MB) küçültür');
          L.push('DBCC SHRINKFILE (' + F + ', ' + target + ');', 'GO', '');
          L.push('-- Küçültmeden sonra indeks fragmantasyonu oluşur; gerekirse yeniden düzenleyin:');
          L.push('-- ALTER INDEX ALL ON [Kritik_Tablo] REBUILD WITH (ONLINE = ON);  -- ONLINE: Enterprise / Developer');
        }

        if (!isLog && mode !== 'TRUNCATEONLY') notes.push(['danger', 'Veri dosyasını küçültmek sayfaları taşır ve **indeksleri parçalar (fragmantasyon)**; performans kaybı yaşanır. Gerekmedikçe küçültmeyin, büyütmeyi tercih edin.']);
        if (mode === 'TARGET') notes.push(['tip', 'SHRINKFILE hedefi MB cinsindendir ve dosyanın ulaşabileceği en küçük boyuttur. Veri hedeften büyükse dosya tamamen küçülmez.']);

        return { sql: L.join('\n'), notes, file: 'shrink_' + file + '.sql' };
      });

      const [rec, resetRec] = persisted('ms.st.recovery', {
        database: 'Production_DB', model: 'FULL', chainPath: 'D:\\SQLBackups\\Production_DB_ChainStart_Full.bak'
      });

      const recOut = computed(() => {
        const r = rec, notes = [];
        const db = r.database.trim() || 'VeritabaniAdi';
        const DB = msIdent(db);
        const L = [];
        L.push(hdr('KURTARMA MODELİ DEĞİŞTİRME', ['Veritabanı: ' + db, 'Yeni model: ' + r.model]));
        L.push('USE [master];', 'GO', '');
        L.push('ALTER DATABASE ' + DB + ' SET RECOVERY ' + r.model + ' WITH NO_WAIT;', 'GO', '');
        if (r.model === 'FULL') {
          notes.push(['warn', "FULL modelde log zinciri **ilk FULL yedekten** sonra başlar. Aşağıdaki yedeği hemen alın; aksi halde log şişmeye devam eder."]);
          L.push('-- ZORUNLU: log zincirini başlatan FULL yedek');
          L.push('BACKUP DATABASE ' + DB, 'TO DISK = ' + msLit(r.chainPath.trim() || DEFAULT_BK_DIR + db + '_ChainStart_Full.bak'),
            'WITH INIT, COMPRESSION, CHECKSUM, STATS = 5;', 'GO');
        } else if (r.model === 'BULK_LOGGED') {
          notes.push(['info', "BULK_LOGGED: toplu işlemler log'u küçültür ama o aralıkta point-in-time restore desteklenmez. Log yedeği yine gereklidir."]);
        } else {
          notes.push(['danger', 'SIMPLE modelde log yedeği alınamaz; log zinciri kopar ve point-in-time restore yapılamaz. Tekrar FULL\'a geçildiğinde yeni bir FULL yedek gerekir.']);
        }
        notes.push(['tip', 'Geçişten sonra durumu izleyin: `SELECT name, recovery_model_desc, log_reuse_wait_desc FROM sys.databases;`']);
        return { sql: L.join('\n'), notes, file: 'recovery_' + db + '.sql' };
      });

      const [tdb, resetTdb] = persisted('ms.st.tempdb', {
        cores: 8, targetMb: 8192, growthMb: 512, path: 'T:\\TempDB\\'
      });

      const tdbOut = computed(() => {
        const t = tdb, notes = [];
        const cores = posInt(t.cores, 1, 1024, 1);
        const count = Math.min(8, cores);
        const total = posInt(t.targetMb, 8, 10000000, 8192);
        const per = Math.max(8, Math.floor(total / count));
        const growth = posInt(t.growthMb, 1, 10000000, 512) + 'MB';
        const dir = t.path.trim() || 'T:\\TempDB\\';
        const L = [];
        L.push(hdr('TEMPDB YAPILANDIRMASI', [
          'Mantıksal çekirdek: ' + cores,
          'Veri dosyası sayısı: ' + count + ' (min(8, çekirdek))',
          'Her dosya: ' + per + ' MB, toplam ≈ ' + (per * count) + ' MB'
        ]));
        L.push('USE [master];', 'GO', '');
        L.push('-- Mevcut tempdb dosyaları');
        L.push('SELECT name, physical_name, size * 8 / 1024 AS size_mb FROM tempdb.sys.database_files;', 'GO', '');
        L.push('-- 1. Birincil veri dosyası (tempdev) eşit boyuta');
        L.push('ALTER DATABASE [tempdb] MODIFY FILE (NAME = N\'tempdev\', SIZE = ' + per + 'MB, FILEGROWTH = ' + growth + ');', 'GO', '');
        if (count > 1) {
          L.push('-- 2. Eksik veri dosyaları (hepsi aynı boyutta)');
          for (let i = 2; i <= count; i++) {
            L.push('ALTER DATABASE [tempdb] ADD FILE (NAME = ' + msLit('temp' + i) + ', FILENAME = ' +
              msLit(joinWin(dir, 'tempdb' + i + '.ndf')) + ', SIZE = ' + per + 'MB, FILEGROWTH = ' + growth + ');');
          }
          L.push('GO');
        }
        notes.push(['info', 'Dosya sayısı = min(8, mantıksal çekirdek). 8\'den fazla dosya genelde kazanç sağlamaz.']);
        notes.push(['info', 'Tüm tempdb veri dosyaları aynı boyutta olmalı (orantılı doldurma). Trace flag 1117 ve 1118, SQL Server 2016+ sürümlerinde tempdb için varsayılan davranıştır; ayrıca açmanız gerekmez.']);
        notes.push(['tip', 'Bazı değişiklikler (ör. dosya konumu, mevcut dosyayı küçültme) servis yeniden başlatılana kadar tam etkili olmayabilir. tempdb her açılışta yeniden oluşturulur.']);
        notes.push(['tip', 'Hedef klasör (' + dir + ') önceden var olmalı ve SQL Server servis hesabı yazabilmelidir; yoksa ADD FILE başarısız olur.']);
        return { sql: L.join('\n'), notes, file: 'tempdb_config.sql' };
      });

      const [ckd, resetCkd] = persisted('ms.st.checkdb', {
        database: 'Production_DB', noInfo: true, allErr: true, physicalOnly: false, dataPurity: true, maxdop: 0, tablock: false
      });

      const ckdOut = computed(() => {
        const c = ckd, notes = [];
        const db = c.database.trim() || 'VeritabaniAdi';
        const opts = [];
        if (c.noInfo) opts.push('NO_INFOMSGS');
        if (c.allErr) opts.push('ALL_ERRORMSGS');
        if (c.physicalOnly) {
          opts.push('PHYSICAL_ONLY');
          if (c.dataPurity) notes.push(['info', 'DATA_PURITY yalnızca tam kontrolde anlamlıdır (sütun değer kontrolü); PHYSICAL_ONLY ile üretilmedi.']);
        } else if (c.dataPurity) {
          opts.push('DATA_PURITY');
        }
        const mdop = posInt(c.maxdop, 0, 64, 0);
        if (mdop > 0) opts.push('MAXDOP = ' + mdop);
        if (c.tablock) opts.push('TABLOCK');

        const dbinfoLit = msLit('DBCC DBINFO (' + msLit(db) + ') WITH TABLERESULTS');
        const L = [];
        L.push(hdr('BÜTÜNLÜK KONTROLÜ (CHECKDB)', ['Veritabanı: ' + db]));
        L.push('-- Veritabanı bütünlük denetimi');
        L.push('DBCC CHECKDB (' + msLit(db) + ')' + (opts.length ? ' WITH ' + opts.join(', ') : '') + ';', 'GO', '');
        L.push('-- Şüpheli sayfalar (823 / 824 / 825 hataları)');
        L.push('SELECT * FROM msdb.dbo.suspect_pages;', 'GO', '');
        L.push('-- Son bilinen iyi CHECKDB zamanı (dbi_dbccLastKnownGood)');
        L.push('-- CREATE TABLE #dbinfo (ParentObject NVARCHAR(255), Object NVARCHAR(255), Field NVARCHAR(255), Value NVARCHAR(255));');
        L.push('-- INSERT INTO #dbinfo EXEC (' + dbinfoLit + ');');
        L.push("-- SELECT Value AS last_known_good FROM #dbinfo WHERE Field = N'dbi_dbccLastKnownGood';");
        notes.push(['info', 'CHECKDB CPU ve I/O yoğundur; yoğun olmayan saatte planlayın. `PHYSICAL_ONLY` çok daha hızlıdır ama mantıksal hataları yakalamaz.']);
        notes.push(['warn', 'Yedek doğrulaması (RESTORE VERIFYONLY) veritabanını doğrulamaz; bütünlük için CHECKDB gerekir.']);
        notes.push(['danger', 'REPAIR_ALLOW_DATA_LOSS / REPAIR_REBUILD onarım seçenekleri bu betikte üretilmez: veri kaybına yol açabilir. Önce yedekten dönüşü değerlendirin.']);
        if (mdop > 0) notes.push(['info', 'DBCC CHECKDB üzerinde MAXDOP yalnızca SQL Server 2016 SP2 ve sonrası sürümlerde desteklenir.']);
        return { sql: L.join('\n'), notes, file: 'checkdb_' + db + '.sql' };
      });

      // ==============================================================
      // 4. OTURUM & KILL
      // ==============================================================
      const [ss, resetSs] = persisted('ms.sess', {
        spid: 74, dbTarget: 'AdventureWorks2022', idleMins: 30
      });

      const ssOut = computed(() => {
        const spid = posInt(ss.spid, 0, 32767, 0);
        const db = ss.dbTarget.trim() || 'master';
        const DB = msIdent(db);
        const idle = posInt(ss.idleMins, 1, 100000, 30);
        const notes = [];
        if (spid > 0 && spid <= 50) notes.push(['danger', 'SPID 50 ve altı sistem oturumlarıdır. Bu oturumları **KILL etmeyin**; sunucu davranışını bozabilir.']);

        const inspect = hdr('SPID ' + spid + ' teşhisi (kill etmeden önce)') + `
SELECT
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    r.status,
    r.command,
    r.wait_type,
    r.wait_time / 1000.0 AS wait_time_sec,
    r.cpu_time,
    r.total_elapsed_time / 1000.0 AS elapsed_sec,
    r.logical_reads,
    r.open_transaction_count,
    SUBSTRING(qt.text, (r.statement_start_offset/2)+1,
        (((CASE r.statement_end_offset
            WHEN -1 THEN DATALENGTH(qt.text)
            ELSE r.statement_end_offset
        END) - r.statement_start_offset)/2) + 1) AS current_executing_statement,
    qt.text AS full_batch_text
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) qt
WHERE s.session_id = ${spid};
GO

-- Oturumun son gönderdiği batch (SQL Server 2016+)
SELECT * FROM sys.dm_exec_input_buffer(${spid}, NULL);
GO`;

        const killOne = `-- Oturumu sonlandır (açık transaction ROLLBACK edilir)
KILL ${spid};
GO`;

        const statusOnly = `-- Kill sonrası geri alma (rollback) ilerlemesi: oturumu yeniden öldürmeden izleyin
KILL ${spid} WITH STATUSONLY;
GO`;

        const single = `USE [master];
GO
-- Tüm aktif kullanıcı oturumlarını derhal sonlandırıp tek kullanıcıya al
ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
GO`;

        const multi = `USE [master];
GO
-- Veritabanını yeniden çok kullanıcılı erişime aç
ALTER DATABASE ${DB} SET MULTI_USER;
GO`;

        const killSleeping = hdr(idle + ' dakikadan uzun süredir uyuyan ve açık transaction tutan oturumlar') + `
DECLARE @kill NVARCHAR(MAX) = N'';

SELECT @kill += N'KILL ' + CAST(s.session_id AS NVARCHAR(10)) + N'; ' + CHAR(13) + CHAR(10)
FROM sys.dm_exec_sessions AS s
WHERE s.is_user_process = 1
  AND s.status = N'sleeping'
  AND s.session_id <> @@SPID
  AND EXISTS (
        SELECT 1
        FROM sys.dm_tran_session_transactions AS st
        JOIN sys.dm_tran_active_transactions AS at ON at.transaction_id = st.transaction_id
        WHERE st.session_id = s.session_id
          AND at.transaction_begin_time < DATEADD(MINUTE, -${idle}, GETDATE()));

PRINT @kill;
-- Listeyi inceledikten sonra çalıştırmak için aşağıdaki satırın yorumunu kaldırın:
-- EXEC sp_executesql @kill;
GO`;

        const killDb = hdr('Veritabanındaki tüm kullanıcı oturumları: ' + db) + `
DECLARE @kill NVARCHAR(MAX) = N'';

SELECT @kill += N'KILL ' + CAST(session_id AS NVARCHAR(10)) + N'; ' + CHAR(13) + CHAR(10)
FROM sys.dm_exec_sessions
WHERE database_id = DB_ID(${msLit(db)})
  AND is_user_process = 1
  AND session_id <> @@SPID;

PRINT @kill;
-- Listeyi inceledikten sonra çalıştırmak için aşağıdaki satırın yorumunu kaldırın:
-- EXEC sp_executesql @kill;
GO`;

        notes.push(['info', "Büyük bir transaction'ı kill ettiğinizde SQL Server veriyi geri almaya (rollback) başlar. Tekrar kill etmek süreci hızlandırmaz! `KILL n WITH STATUSONLY` rollback'in yüzde kaçının tamamlandığını ve tahmini kalan süreyi gösterir."]);
        notes.push(['tip', "Ayrıntılı oturum görünümü için `sp_WhoIsActive` (topluluk prosedürü) kullanılabilir. Oturumun gönderdiği son batch için `sys.dm_exec_input_buffer` (SQL Server 2016+) yeterlidir."]);
        return { spid, inspect, killOne, statusOnly, single, multi, killSleeping, killDb, idle, notes };
      });

      // ==============================================================
      // 5. DMV & SORGU KÜTÜPHANESİ
      // ==============================================================
      const qcats = [
        ['blocking', '🔒 Kilit & Deadlock'],
        ['perf', '🚀 CPU / I/O / Wait'],
        ['index', '⚡ İndeks & İstatistik'],
        ['storage', '💾 Alan, Log & TempDB'],
        ['backup', '🛟 Yedek & Job'],
        ['ha', '🔄 Always On'],
        ['server', '🖥️ Sunucu']
      ];

      const WAIT_EXCL = [
        'CLR_SEMAPHORE', 'LAZYWRITER_SLEEP', 'RESOURCE_QUEUE', 'SLEEP_TASK', 'SLEEP_SYSTEMTASK',
        'SQLTRACE_BUFFER_FLUSH', 'WAITFOR', 'LOGMGR_QUEUE', 'CHECKPOINT_QUEUE', 'REQUEST_FOR_DEADLOCK_SEARCH',
        'XE_TIMER_EVENT', 'BROKER_TO_FLUSH', 'BROKER_TASK_STOP', 'CLR_MANUAL_EVENT', 'CLR_AUTO_EVENT',
        'DISPATCHER_QUEUE_SEMAPHORE', 'FT_IFTS_SCHEDULER_IDLE_WAIT', 'XE_DISPATCHER_WAIT', 'XE_DISPATCHER_JOIN',
        'SQLTRACE_INCREMENTAL_FLUSH_SLEEP', 'DIRTY_PAGE_FLUSH', 'CXCONSUMER', 'HADR_FILESTREAM_IOMGR_IOCOMPLETION',
        'SLEEP_BPOOL_FLUSH', 'SP_SERVER_DIAGNOSTICS_SLEEP', 'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP', 'QDS_ASYNC_QUEUE',
        'HADR_WORK_QUEUE', 'HADR_TIMER_TASK', 'HADR_CLUSAPI_CALL', 'ONDEMAND_TASK_QUEUE',
        'PREEMPTIVE_XE_GETTARGETSTATE', 'PWAIT_ALL_COMPONENTS_INITIALIZED', 'WAIT_XTP_CKPT_CLOSE',
        'XE_LIVE_TARGET_TVF', 'BROKER_EVENTHANDLER', 'BROKER_RECEIVE_WAITFOR', 'BROKER_TRANSMITTER',
        'CHKPT', 'SOS_WORK_DISPATCHER', 'KSOURCE_WAKEUP'
      ].map(w => "'" + w + "'").join(', ');

      const queries = [
        {
          id: 'head_blocker', cat: 'blocking', ver: '2012+', title: 'Kilit zinciri: baş kilitleyici (HEAD BLOCKER) dahil',
          desc: 'Kimin kimi beklettiğini gösterir. Sorgu çalıştırmayan (uyuyan) ama açık transaction tutan baş kilitleyicileri de yakalar.',
          tip: 'role = **HEAD BLOCKER** olan oturum genelde `sleeping` ve `open_transaction_count > 0` durumundadır; commit edilmemiş bir uygulama işlemidir. Kill etmeden önce `login_name` ve `host_name` ile sahibine ulaşın.',
          sql: `SELECT s.session_id,
       r.blocking_session_id,
       s.status, s.login_name, s.host_name, s.program_name,
       DB_NAME(COALESCE(r.database_id, s.database_id)) AS database_name,
       r.wait_type, r.wait_time / 1000.0 AS wait_sec, r.wait_resource,
       s.open_transaction_count,
       CASE WHEN EXISTS (SELECT 1 FROM sys.dm_exec_requests r2 WHERE r2.blocking_session_id = s.session_id)
                 AND ISNULL(r.blocking_session_id, 0) = 0 THEN 'HEAD BLOCKER' ELSE '' END AS role,
       t.text AS sql_text
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t
WHERE s.session_id IN (SELECT blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id <> 0)
   OR r.blocking_session_id <> 0
ORDER BY role DESC, wait_sec DESC;
GO`
        },
        {
          id: 'deadlocks_ring', cat: 'blocking', ver: '2012+', title: 'Deadlock grafikleri: system_health ring buffer',
          desc: 'Varsayılan system_health oturumunun ring buffer hedefinden son deadlock XML raporlarını çıkarır.',
          tip: 'XML hücresine tıklayınca SSMS deadlock grafiğini (.xdl) açar. Ring buffer sınırlı tutulur; eski olaylar için aşağıdaki dosya sorgusunu kullanın.',
          sql: `-- Son deadlock olayları ve XML grafiği (ring buffer)
SELECT
    XEvent.value('(event/@timestamp)[1]', 'DATETIME2') AS DeadlockTime,
    XEvent.query('(event/data[@name="xml_report"]/value/deadlock)[1]') AS DeadlockGraphXml
FROM (
    SELECT CAST(target_data AS XML) AS TargetData
    FROM sys.dm_xe_session_targets st
    JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
    WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer'
) AS Data
CROSS APPLY TargetData.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS XEventData(XEvent)
ORDER BY DeadlockTime DESC;
GO`
        },
        {
          id: 'deadlocks_file', cat: 'blocking', ver: '2012+ (XE dosya)', title: 'Deadlock geçmişi: system_health dosyası (daha uzun geçmiş)',
          desc: 'Ring buffer dolduğunda eski kalmış deadlock olaylarını .xel dosyalarından okur.',
          tip: 'Dosyalar sunucunun varsayılan XE klasöründedir ve döngüsel olarak silinir; uzun geçmiş için ayrı bir XE oturumu tanımlayın.',
          sql: `SELECT x.value('(@timestamp)[1]', 'datetime2') AS deadlock_time_utc,
       x.query('(data/value/deadlock)[1]') AS deadlock_graph
FROM (SELECT CAST(event_data AS XML) AS ed
      FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL)
      WHERE object_name = 'xml_deadlock_report') d
CROSS APPLY d.ed.nodes('/event') AS n(x)
ORDER BY deadlock_time_utc DESC;
GO`
        },
        {
          id: 'top_cpu', cat: 'perf', ver: '2012+', title: 'En çok CPU tüketen Top 10 sorgu (worker time)',
          desc: 'Sunucu açıldığından (veya plan cache temizlendiğinden) bu yana işlemciyi en çok yoran sorgular ve planları.',
          tip: 'AvgCpuMs çok yüksek olan sorgular genellikle CPU ağırlıklı skaler UDF veya karmaşık hash join içerir.',
          sql: `-- Top 10 CPU tüketen sorgular
SELECT TOP 10
    qs.total_worker_time / 1000.0 AS TotalCpuMs,
    (qs.total_worker_time / qs.execution_count) / 1000.0 AS AvgCpuMs,
    qs.execution_count AS ExecCount,
    qs.total_elapsed_time / 1000.0 AS TotalDurationMs,
    (qs.total_elapsed_time / qs.execution_count) / 1000.0 AS AvgDurationMs,
    SUBSTRING(qt.text, (qs.statement_start_offset/2)+1,
        (((CASE qs.statement_end_offset
            WHEN -1 THEN DATALENGTH(qt.text)
            ELSE qs.statement_end_offset
        END) - qs.statement_start_offset)/2) + 1) AS ExecutingStatement,
    qp.query_plan AS QueryPlanXml
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
ORDER BY qs.total_worker_time DESC;
GO`
        },
        {
          id: 'top_io', cat: 'perf', ver: '2012+', title: 'En çok mantıksal okuma yapan Top 10 sorgu',
          desc: 'Buffer pool\'u ve diski milyonlarca sayfa okuyarak kirleten (cache churn) sorguları bulur.',
          tip: 'Yüksek logical reads neredeyse her zaman tarama (scan) ve eksik covering index demektir.',
          sql: `-- Top 10 mantıksal okuma yapan sorgular
SELECT TOP 10
    qs.total_logical_reads AS TotalLogicalReads,
    qs.total_logical_reads / qs.execution_count AS AvgLogicalReads,
    qs.execution_count AS ExecCount,
    qs.total_physical_reads AS TotalPhysicalReads,
    qs.total_logical_writes AS TotalWrites,
    SUBSTRING(qt.text, (qs.statement_start_offset/2)+1,
        (((CASE qs.statement_end_offset
            WHEN -1 THEN DATALENGTH(qt.text)
            ELSE qs.statement_end_offset
        END) - qs.statement_start_offset)/2) + 1) AS QueryText
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
ORDER BY qs.total_logical_reads DESC;
GO`
        },
        {
          id: 'running_requests', cat: 'perf', ver: '2012+ (percent_complete)', title: 'Çalışan istekler ve tahmini bitiş',
          desc: 'Şu an çalışan istekleri, yüzde ilerlemesini ve kalan süreyi gösterir.',
          tip: '`percent_complete` yalnızca BACKUP / RESTORE, DBCC ve ALTER INDEX REORGANIZE gibi komutlarda dolar; diğer sorgularda 0 görünür.',
          sql: `SELECT r.session_id, r.status, r.command,
       r.percent_complete,
       r.estimated_completion_time / 60000.0 AS eta_min,
       r.cpu_time,
       r.total_elapsed_time / 1000 AS elapsed_s,
       r.wait_type, r.blocking_session_id,
       DB_NAME(r.database_id) AS database_name,
       SUBSTRING(t.text, (r.statement_start_offset / 2) + 1,
           ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(t.text)
                 ELSE r.statement_end_offset END - r.statement_start_offset) / 2) + 1) AS current_statement
FROM sys.dm_exec_requests r
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id > 50
  AND r.session_id <> @@SPID
ORDER BY r.total_elapsed_time DESC;
GO`
        },
        {
          id: 'query_store_top', cat: 'perf', ver: '2016+ (Query Store açık)', title: 'Query Store: son 24 saatin en pahalı sorguları',
          desc: 'Query Store verisinden toplam süre, CPU ve plan sayısına göre sorgular.',
          tip: '`plan_count > 1` ise olası plan regresyonu vardır. Kötü planı sabitlemek için `sp_query_store_force_plan` kullanılabilir.',
          sql: `SELECT TOP 20 q.query_id, qt.query_sql_text,
       SUM(rs.count_executions) AS executions,
       SUM(rs.avg_duration * rs.count_executions) / 1000.0 AS total_duration_ms,
       SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS total_cpu_ms,
       COUNT(DISTINCT p.plan_id) AS plan_count
FROM sys.query_store_query q
JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan p ON p.query_id = q.query_id
JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
JOIN sys.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
WHERE i.start_time > DATEADD(HOUR, -24, SYSUTCDATETIME())
GROUP BY q.query_id, qt.query_sql_text
ORDER BY total_duration_ms DESC;
GO`
        },
        {
          id: 'wait_stats', cat: 'perf', ver: '2012+', title: 'Filtrelenmiş bekleme istatistikleri (Top 10 wait)',
          desc: 'Zararsız arka plan beklemelerini (CXCONSUMER, HADR_*, QDS_* vb.) hariç tutarak asıl darboğazı gösterir.',
          tip: '`PAGEIOLATCH_*` disk darboğazı, `CXPACKET` / `CXSYNC_PORT` paralellik (MAXDOP, cost threshold) sorunu, `SOS_SCHEDULER_YIELD` CPU darboğazı işaretidir.',
          sql: `-- Temizlenmiş Top 10 bekleme istatistiği
WITH Waits AS (
    SELECT
        wait_type,
        wait_time_ms / 1000.0 AS WaitTimeSec,
        waiting_tasks_count,
        ROW_NUMBER() OVER (ORDER BY wait_time_ms DESC) AS RowNum,
        100.0 * wait_time_ms / SUM(wait_time_ms) OVER () AS Pct
    FROM sys.dm_os_wait_stats
    WHERE wait_type NOT IN (
        ${WAIT_EXCL}
    )
)
SELECT TOP 10
    wait_type,
    WaitTimeSec,
    waiting_tasks_count,
    CAST(Pct AS DECIMAL(5,2)) AS PercentOfTotalWaits
FROM Waits
ORDER BY WaitTimeSec DESC;
GO`
        },
        {
          id: 'index_frag', cat: 'index', ver: '2012+', title: 'İndeks fragmantasyonu ve REBUILD / REORGANIZE üretici',
          desc: 'Geçerli veritabanında %10 üzeri parçalanmış indeksler için bakım komutu üretir (%30 üzeri REBUILD, %10-30 REORGANIZE).',
          tip: '1000 sayfadan küçük indekslerde fragmantasyon yüksek olsa da bakım gerekmez. `ONLINE = ON` yalnızca **Enterprise / Developer** sürümünde desteklenir; Standard\'da ONLINE\'ı kaldırın. Heap\'ler (index_id = 0) bu listeye alınmaz.',
          sql: `-- Otomatik indeks bakım betiği üretici (fragmantasyon > %10)
SELECT
    SCHEMA_NAME(t.schema_id) AS SchemaName,
    t.name AS TableName,
    i.name AS IndexName,
    ips.avg_fragmentation_in_percent AS FragPercent,
    ips.page_count AS PageCount,
    CASE
        WHEN ips.avg_fragmentation_in_percent > 30.0
        THEN 'ALTER INDEX [' + i.name + '] ON [' + SCHEMA_NAME(t.schema_id) + '].[' + t.name + '] REBUILD WITH (ONLINE = ON, MAXDOP = 4, SORT_IN_TEMPDB = ON);'
        WHEN ips.avg_fragmentation_in_percent BETWEEN 10.0 AND 30.0
        THEN 'ALTER INDEX [' + i.name + '] ON [' + SCHEMA_NAME(t.schema_id) + '].[' + t.name + '] REORGANIZE;'
    END AS GeneratedMaintenanceSql
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
JOIN sys.tables t ON ips.object_id = t.object_id
JOIN sys.indexes i ON ips.object_id = i.object_id AND ips.index_id = i.index_id
WHERE ips.page_count > 1000
  AND ips.avg_fragmentation_in_percent > 10.0
  AND i.index_id > 0
ORDER BY ips.avg_fragmentation_in_percent DESC;
GO`
        },
        {
          id: 'missing_indexes', cat: 'index', ver: '2012+', title: 'En yüksek etkili eksik indeksler (missing index DMV)',
          desc: 'Optimizer\'ın eksikliğini hissettiği indeksler için hazır CREATE INDEX betikleri ve tahmini etki skoru.',
          tip: 'Önerilen indeksi doğrudan oluşturmayın: mevcut indekslerle birleştirin (consolidate). Aksi halde INSERT / UPDATE performansı düşer.',
          sql: `-- Eksik indeksler ve hazır CREATE INDEX betikleri
SELECT TOP 20
    ROUND(migs.avg_total_user_cost * migs.avg_user_impact * (migs.user_seeks + migs.user_scans), 0) AS ImprovementScore,
    migs.user_seeks AS Seeks,
    migs.user_scans AS Scans,
    mid.statement AS TableName,
    'CREATE NONCLUSTERED INDEX [IX_' + REPLACE(REPLACE(REPLACE(REPLACE(mid.statement, '[', ''), ']', ''), '.', '_'), ' ', '') + '_' + CAST(migs.group_handle AS VARCHAR(10)) + '] ON ' +
    mid.statement + ' (' + ISNULL(mid.equality_columns, '') +
    CASE WHEN mid.equality_columns IS NOT NULL AND mid.inequality_columns IS NOT NULL THEN ', ' ELSE '' END +
    ISNULL(mid.inequality_columns, '') + ')' +
    ISNULL(' INCLUDE (' + mid.included_columns + ')', '') + ' WITH (ONLINE = ON, FILLFACTOR = 90);' AS CreateIndexScript
FROM sys.dm_db_missing_index_groups mig
JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle
JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
WHERE mid.database_id = DB_ID()
ORDER BY ImprovementScore DESC;
GO`
        },
        {
          id: 'stats_age', cat: 'index', ver: '2012+', title: 'Değişim sayacı yüksek istatistikler',
          desc: 'Son güncellemeden bu yana en çok satır değişikliği biriken kullanıcı tablosu istatistikleri.',
          tip: 'Yüksek `modification_counter` ve eski `last_updated` değeri, optimizer\'ın yanlış satır tahmini yapmasına yol açabilir. `UPDATE STATISTICS tablo WITH FULLSCAN;` ile yenileyin.',
          sql: `SELECT OBJECT_SCHEMA_NAME(s.object_id) + '.' + OBJECT_NAME(s.object_id) AS table_name,
       s.name AS stats_name, sp.last_updated, sp.rows, sp.rows_sampled, sp.modification_counter
FROM sys.stats s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE OBJECTPROPERTY(s.object_id, 'IsUserTable') = 1
  AND sp.modification_counter > 0
ORDER BY sp.modification_counter DESC;
GO`
        },
        {
          id: 'tempdb_hogs', cat: 'storage', ver: '2012+', title: 'TempDB alanını şişiren oturumlar ve sorgular',
          desc: 'TempDB\'yi dolduran kullanıcı nesnelerini (#temp) ve sort / hash dökülmelerini (internal) hangi oturumun yarattığını bulur.',
          tip: 'internal objects tahsisi yüksekse sorgular yetersiz memory grant nedeniyle TempDB\'ye döküyor (spill) demektir.',
          sql: `-- TempDB tüketimini oturum bazında analiz et
SELECT
    t.session_id,
    s.login_name,
    s.host_name,
    (t.user_objects_alloc_page_count * 8) / 1024.0 AS UserObjectsAllocMB,
    (t.internal_objects_alloc_page_count * 8) / 1024.0 AS InternalObjectsAllocMB,
    r.command,
    r.status,
    qt.text AS CurrentQueryText
FROM sys.dm_db_task_space_usage t
JOIN sys.dm_exec_sessions s ON t.session_id = s.session_id
LEFT JOIN sys.dm_exec_requests r ON t.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) qt
WHERE (t.user_objects_alloc_page_count + t.internal_objects_alloc_page_count) > 128
ORDER BY (t.user_objects_alloc_page_count + t.internal_objects_alloc_page_count) DESC;
GO`
        },
        {
          id: 'vlf_count', cat: 'storage', ver: '2016 SP2+', title: 'Sanal log dosyası (VLF) sayısı',
          desc: 'Veritabanı başına VLF sayısını ve toplam log boyutunu raporlar.',
          tip: 'VlfCount > 1000 ise kurtarma (recovery) ve yedekleme başlangıcı yavaşlar. Log\'u küçültüp tek adımda büyük boyuta (ör. 8192 MB) yeniden büyütün.',
          sql: `-- Veritabanı başına VLF sayısı (SQL Server 2016 SP2+)
SELECT
    DB_NAME(d.database_id) AS DatabaseName,
    COUNT(li.vlf_sequence_number) AS VlfCount,
    SUM(CAST(li.vlf_size_mb AS DECIMAL(10,2))) AS TotalLogSizeMB
FROM sys.databases d
CROSS APPLY sys.dm_db_log_info(d.database_id) li
GROUP BY d.database_id
ORDER BY VlfCount DESC;
GO`
        },
        {
          id: 'log_usage', cat: 'storage', ver: '2012+', title: 'Log boyutu ve log bekleme nedeni (log_reuse_wait_desc)',
          desc: 'Her veritabanının log boyutu, kurtarma modeli ve log\'un neden kesilemediği.',
          tip: '`LOG_BACKUP` → log yedeği alın. `ACTIVE_TRANSACTION` → uzun süren transaction\'ı bulun. `REPLICATION` / `AVAILABILITY_REPLICA` → dağıtım veya replika gecikmesine bakın.',
          sql: `SELECT d.name, d.recovery_model_desc, d.log_reuse_wait_desc,
       CAST(SUM(CASE WHEN mf.type = 1 THEN mf.size END) * 8 / 1024.0 AS DECIMAL(12,1)) AS log_size_mb
FROM sys.databases d
JOIN sys.master_files mf ON mf.database_id = d.database_id
GROUP BY d.name, d.recovery_model_desc, d.log_reuse_wait_desc
ORDER BY log_size_mb DESC;
GO

DBCC SQLPERF (LOGSPACE);
GO`
        },
        {
          id: 'file_space', cat: 'storage', ver: '2012+', title: 'Geçerli veritabanı dosyaları, boş alan ve disk boşluğu',
          desc: 'Her dosyanın boyutu, kullanılan ve boş alanı, büyüme ayarı ve bulunduğu diskin boş GB değeri.',
          tip: 'Disk boş alanı, dosyaların MAXSIZE\'a kadar büyüyebilmesi için yeterli olmalıdır. Yüzde büyüme yerine sabit MB büyümesi tercih edin.',
          sql: `SELECT f.name AS logical_name, f.type_desc, f.physical_name,
       CAST(f.size / 128.0 AS DECIMAL(12,1)) AS size_mb,
       CAST(FILEPROPERTY(f.name, 'SpaceUsed') / 128.0 AS DECIMAL(12,1)) AS used_mb,
       CAST((f.size - FILEPROPERTY(f.name, 'SpaceUsed')) / 128.0 AS DECIMAL(12,1)) AS free_mb,
       CASE WHEN f.is_percent_growth = 1 THEN CAST(f.growth AS VARCHAR(10)) + '%'
            ELSE CAST(f.growth / 128 AS VARCHAR(10)) + ' MB' END AS growth,
       vs.volume_mount_point, CAST(vs.available_bytes / 1048576.0 / 1024 AS DECIMAL(12,1)) AS disk_free_gb
FROM sys.database_files f
CROSS APPLY sys.dm_os_volume_stats(DB_ID(), f.file_id) vs;
GO`
        },
        {
          id: 'alwayson_sync', cat: 'ha', ver: '2012+ (AG)', title: 'Always On senkronizasyon sağlığı ve kuyruk gecikmesi',
          desc: 'İkincil replikalara giden log gönderme kuyruğunu ve yeniden oynatma (redo) kuyruğunu canlı izler.',
          tip: 'LogSendQueueKB yüksekse ağ darboğazı; RedoQueueKB yüksekse ikincil replikada disk I/O darboğazı vardır.',
          sql: `-- Always On replika durumu ve veri gecikmesi
SELECT
    ag.name AS AgName,
    ar.replica_server_name AS ReplicaServer,
    d.name AS DatabaseName,
    rs.synchronization_state_desc AS SyncState,
    rs.synchronization_health_desc AS HealthDesc,
    rs.log_send_queue_size AS LogSendQueueKB,
    rs.redo_queue_size AS RedoQueueKB,
    rs.redo_rate AS RedoRateKBperSec,
    rs.secondary_lag_seconds AS SecondaryLagSeconds
FROM sys.dm_hadr_database_replica_states rs
JOIN sys.availability_replicas ar ON rs.replica_id = ar.replica_id
JOIN sys.availability_groups ag ON ar.group_id = ag.group_id
JOIN sys.databases d ON rs.database_id = d.database_id
ORDER BY rs.log_send_queue_size DESC;
GO`
        },
        {
          id: 'last_backups', cat: 'backup', ver: '2012+', title: 'Veritabanı başına son FULL / DIFF / LOG yedek zamanları',
          desc: 'msdb geçmişinden her veritabanının son tam, fark ve log yedeğini gösterir.',
          tip: 'FULL kurtarma modeli ama log yedeği yok → log sürekli büyür (log_reuse_wait_desc = LOG_BACKUP).',
          sql: SQL_LAST_BACKUPS
        },
        {
          id: 'failed_jobs', cat: 'backup', ver: '2012+', title: 'Son 24 saatte başarısız SQL Agent job adımları',
          desc: 'msdb.sysjobhistory içinde run_status = 0 olan (başarısız) adımlar.',
          tip: 'Başarısız yedek job\'ları için `message` alanında genelde hata kodu (ör. Msg 3041) bulunur. Job geçmişini tekrar yazmadan önce inceleyin.',
          sql: `SELECT j.name AS job_name, h.step_id, h.step_name,
       msdb.dbo.agent_datetime(h.run_date, h.run_time) AS run_at,
       h.run_duration, LEFT(h.message, 400) AS message
FROM msdb.dbo.sysjobhistory h
JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id
WHERE h.run_status = 0
  AND msdb.dbo.agent_datetime(h.run_date, h.run_time) > DATEADD(DAY, -1, GETDATE())
ORDER BY run_at DESC;
GO`
        },
        {
          id: 'memory_ple', cat: 'server', ver: '2012+', title: 'Bellek baskısı: PLE, bekleyen grant ve bellek kullanımı',
          desc: 'Page life expectancy, bekleyen bellek grant\'ları ve en büyük bellek tüketicileri (clerk).',
          tip: 'Page life expectancy sürekli düşükse buffer pool yetersiz olabilir. Memory Grants Pending > 0 ise sorgular bellek için bekliyordur.',
          sql: `SELECT object_name, counter_name, cntr_value
FROM sys.dm_os_performance_counters
WHERE counter_name IN ('Page life expectancy', 'Memory Grants Pending', 'Target Server Memory (KB)', 'Total Server Memory (KB)');
GO

SELECT TOP 10 type, SUM(pages_kb) / 1024 AS mb
FROM sys.dm_os_memory_clerks
GROUP BY type
ORDER BY mb DESC;
GO`
        },
        {
          id: 'server_info', cat: 'server', ver: '2012+', title: 'Sunucu, sürüm ve donanım özeti',
          desc: 'Sürüm, sürüm seviyesi (CU), sürümün Always On durumu, CPU / RAM ve başlangıç zamanı.',
          tip: 'Sürüm ve CU bilgisini Microsoft\'un güncelleme listesi ile karşılaştırın. `cpu_count` ve `hyperthread_ratio` MAXDOP hesabında kullanılır.',
          sql: `SELECT SERVERPROPERTY('MachineName') AS machine, SERVERPROPERTY('ServerName') AS server_name,
       SERVERPROPERTY('Edition') AS edition, SERVERPROPERTY('ProductVersion') AS version,
       SERVERPROPERTY('ProductLevel') AS level, SERVERPROPERTY('ProductUpdateLevel') AS cu,
       SERVERPROPERTY('IsHadrEnabled') AS hadr, si.cpu_count, si.hyperthread_ratio,
       si.physical_memory_kb / 1024 AS ram_mb, si.sqlserver_start_time
FROM sys.dm_os_sys_info si;
GO`
        }
      ];

      // ==============================================================
      // 6. CONNECTION
      // ==============================================================
      const CN_FORMATS = {
        adonet: ['ADO.NET / C#', 'cs', 'cs'],
        sqlcmd: ['SQLCMD CLI', 'sh', 'sh'],
        jdbc: ['Java / JDBC', 'text', 'txt'],
        pyodbc: ['ODBC / Python (pyodbc)', 'py', 'py'],
        pymssql: ['Python (pymssql)', 'py', 'py'],
        nodejs: ['Node.js (mssql)', 'js', 'js'],
        powershell: ['PowerShell', 'ps', 'ps1'],
        appsettings: ['appsettings.json', 'js', 'json']
      };

      const [cn, resetCn] = persisted('ms.conn', {
        host: 'sqlserver.company.local', port: 1433, instance: '', database: 'Production_DB',
        appName: 'DBA-Cockpit', authType: 'SQL', user: 'app_user', password: '',
        encrypt: true, trustServerCert: false, readOnlyIntent: false, multiSubnet: false, format: 'adonet'
      }, ['password']);

      const cnOut = computed(() => {
        const c = cn, notes = [];
        const host = c.host.trim() || 'localhost';
        const inst = c.instance.trim();
        const port = posInt(c.port, 1, 65535, 1433);
        const isWin = c.authType === 'WINDOWS';
        const isMfa = c.authType === 'AZURE_MFA';
        const user = c.user.trim() || 'app_user';
        const pwd = c.password || '<şifre>';
        const db = c.database.trim() || 'master';
        const app = c.appName.trim();
        const intent = c.readOnlyIntent, multi = c.multiSubnet;

        let server;
        if (inst) {
          server = host + '\\' + inst;
          if (port !== 1433) notes.push(['info', 'Instance adı varken port yazılmaz (SQL Browser veya instance portu kullanılır). Sabit port gerekiyorsa instance yerine `,port` kullanın.']);
        } else {
          server = port !== 1433 ? host + ',' + port : host;
        }

        if (c.trustServerCert) notes.push(['warn', '`TrustServerCertificate=True` sunucu sertifikası doğrulamasını **kapatır** (ortadaki adam riski). Yalnızca test ortamında kullanın.']);
        if (c.format !== 'sqlcmd' && !c.encrypt) notes.push(['warn', 'Encrypt kapalı: bağlantı şifresiz gider. Mümkünse açık tutun.']);
        notes.push(['info', 'ODBC Driver 18 ve Microsoft.Data.SqlClient 4+ varsayılan olarak `Encrypt=Yes` kullanır; sertifika doğrulanamıyorsa bağlantı hata verir.']);

        // Parola kaçışları
        const pwdAdo = (v) => /[;"'\s]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        const pwdJdbc = (v) => /[;{}=]/.test(v) ? '{' + v.replace(/}/g, '}}') + '}' : v;
        const pwdOdbc = (v) => /[;{}]/.test(v) ? '{' + v.replace(/}/g, '}}') + '}' : v;

        // ADO.NET dizgesi (appsettings da bunu kullanır)
        const adoAuth = isWin ? 'Integrated Security=True'
          : isMfa ? 'Authentication=Active Directory Interactive;User Id=' + user
          : 'User Id=' + user + ';Password=' + pwdAdo(pwd);
        const ado = [
          'Server=' + server, 'Database=' + db, adoAuth,
          'Encrypt=' + (c.encrypt ? 'True' : 'False'),
          'TrustServerCertificate=' + (c.trustServerCert ? 'True' : 'False'),
          app ? 'Application Name=' + app : null,
          'Connection Timeout=30',
          intent ? 'ApplicationIntent=ReadOnly' : null,
          multi ? 'MultiSubnetFailover=True' : null
        ].filter(Boolean).join(';') + ';';

        const fmt = c.format;
        let code = '';

        if (fmt === 'adonet') {
          code = ado;
          if (/[;"'\s]/.test(pwd) && !isWin && !isMfa) notes.push(['tip', 'Parola `;` veya boşluk içeriyorsa ADO.NET dizgesinde çift tırnak içine alınmıştır.']);
        } else if (fmt === 'sqlcmd') {
          const sq = ['sqlcmd -S ' + q(server), '-d ' + q(db)];
          if (isWin) sq.push('-E');
          else if (isMfa) sq.push('-G', '-U ' + q(user));
          else sq.push('-U ' + q(user), '-P ' + q(pwd));
          if (c.encrypt) sq.push('-N');
          if (c.trustServerCert) sq.push('-C');
          if (intent) sq.push('-K ReadOnly');
          if (multi) sq.push('-M');
          code = sq.join(' ');
          if (isMfa) notes.push(['info', 'Entra / MFA ile sqlcmd `-G` (Entra kimlik doğrulama) gerektirir; yalnızca `-U` ve `-P` yetmez.']);
          if (!isWin && !isMfa) notes.push(['warn', '`-P` parolası komut satırında görünür. Mümkünse Windows kimlik doğrulama (`-E`) kullanın.']);
        } else if (fmt === 'jdbc') {
          let head = 'jdbc:sqlserver://' + host;
          if (inst) head += ';instanceName=' + inst;
          else if (port !== 1433) head += ':' + port;
          const jp = ['databaseName=' + db];
          if (isWin) jp.push('integratedSecurity=true');
          else if (isMfa) jp.push('authentication=ActiveDirectoryInteractive', 'user=' + user);
          else jp.push('user=' + user, 'password=' + pwdJdbc(pwd));
          if (app) jp.push('applicationName=' + app);
          jp.push('encrypt=' + (c.encrypt ? 'true' : 'false'), 'trustServerCertificate=' + (c.trustServerCert ? 'true' : 'false'));
          if (intent) jp.push('applicationIntent=ReadOnly');
          if (multi) jp.push('multiSubnetFailover=true');
          code = head + ';' + jp.join(';') + ';';
          if (isWin) notes.push(['info', '`integratedSecurity=true` için Windows\'ta `mssql-jdbc_auth` DLL\'i (x64/x86 ile uyumlu) java.library.path üzerinde olmalıdır.']);
          if (!isWin && !isMfa) notes.push(['tip', 'Parolada `;` veya `{` `}` varsa değer `{...}` içine alınmıştır (`}` → `}}`).']);
        } else if (fmt === 'pyodbc') {
          const odbcAuth = isWin ? 'Trusted_Connection=yes'
            : isMfa ? 'Authentication=ActiveDirectoryInteractive;UID=' + user
            : 'UID=' + user + ';PWD=' + pwdOdbc(pwd);
          const parts = [
            'DRIVER={ODBC Driver 18 for SQL Server}',
            'SERVER=' + server,
            'DATABASE=' + db,
            odbcAuth,
            'Encrypt=' + (c.encrypt ? 'yes' : 'no'),
            'TrustServerCertificate=' + (c.trustServerCert ? 'yes' : 'no'),
            app ? 'APP=' + app : null,
            intent ? 'ApplicationIntent=ReadOnly' : null,
            multi ? 'MultiSubnetFailover=yes' : null
          ].filter(Boolean);
          const pyLines = parts.map(p => '    "' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + ';"').join('\n');
          code = 'import pyodbc\n\nconn_str = (\n' + pyLines + '\n)\n' +
            'conn = pyodbc.connect(conn_str)\n' +
            'cursor = conn.cursor()\n' +
            'cursor.execute("SELECT @@VERSION")\n' +
            'print(cursor.fetchone()[0])';
          if (isMfa) notes.push(['info', 'pyodbc Entra MFA için `Authentication=ActiveDirectoryInteractive` ister; sürücü 17.x ve üzeri gerekir.']);
          notes.push(['tip', 'ODBC değerlerinde `;` veya `}` varsa parola `PWD={...}` içine alınır ve `}` karakteri `}}` yazılır.']);
        } else if (fmt === 'pymssql') {
          const pyServer = inst ? host + '\\\\' + inst : host;
          const lines = ['import pymssql', ''];
          if (isWin || isMfa) {
            lines.push('# pymssql Windows ve Entra kimlik doğrulamasını desteklemez; SQL login kullanın.');
            notes.push(['info', 'pymssql yalnızca SQL kimlik doğrulamasını destekler. Windows / Entra için pyodbc kullanın.']);
          }
          lines.push('conn = pymssql.connect(',
            "    server='" + pyServer + "',",
            '    port=' + port + ',',
            "    user='" + user + "',",
            "    password='" + pwd.replace(/'/g, "\\'") + "',",
            "    database='" + db + "'",
            ')',
            'cursor = conn.cursor()',
            "cursor.execute('SELECT @@VERSION')",
            'row = cursor.fetchone()',
            'print(row[0])',
            'conn.close()');
          code = lines.join('\n');
          if (inst) notes.push(['tip', 'pymssql instance adını `host\\\\instance` biçiminde alır; port yalnızca instance yoksa verilmelidir.']);
        } else if (fmt === 'nodejs') {
          const cfg = [];
          if (!isWin) cfg.push("  user: '" + user + "',");
          if (!isWin && !isMfa) cfg.push("  password: '" + pwd.replace(/'/g, "\\'") + "',");
          cfg.push("  server: '" + host + "',");
          if (!inst) cfg.push('  port: ' + port + ',');
          cfg.push("  database: '" + db + "',");
          const nopt = [];
          if (inst) nopt.push("instanceName: '" + inst + "'");
          nopt.push('encrypt: ' + c.encrypt, 'trustServerCertificate: ' + c.trustServerCert);
          if (intent) nopt.push('readOnlyIntent: true');
          if (isWin) nopt.push('trustedConnection: true');
          cfg.push('  options: { ' + nopt.join(', ') + ' },');
          if (isWin) {
            notes.push(['warn', 'Node mssql ile Windows kimlik doğrulama için `msnodesqlv8` sürücüsü gerekir (`npm i msnodesqlv8`) ve modül `require(\'mssql/msnodesqlv8\')` ile yüklenir; varsayılan tedious sürücüsü bunu desteklemez.']);
          }
          if (isMfa) {
            notes.push(['info', 'Node mssql Entra MFA etkileşimli girişini doğrudan desteklemez; erişim belirteci (access token) ile bağlanın.']);
            cfg.push("  authentication: { type: 'azure-active-directory-access-token', options: { token: '<erisim-belirteci>' } },");
          }
          code = "const sql = require('" + (isWin ? 'mssql/msnodesqlv8' : 'mssql') + "');\n\nconst config = {\n" + cfg.join('\n') + "\n};\n\n" +
            'async function testConnection() {\n' +
            '  try {\n' +
            '    const pool = await sql.connect(config);\n' +
            "    const result = await pool.request().query('SELECT @@VERSION AS version');\n" +
            '    console.log(result.recordset[0].version);\n' +
            "  } catch (err) {\n" +
            "    console.error('Bağlantı hatası:', err);\n" +
            '  }\n}\n\ntestConnection();';
        } else if (fmt === 'powershell') {
          // PowerShell'de $ ifadesi genişler; değerler tek tırnakla yazılır
          const psq = (v) => "'" + String(v).replace(/'/g, "''") + "'";
          let ps = '# SqlServer modülü (Install-Module SqlServer)\nInvoke-Sqlcmd -ServerInstance ' + psq(server) + ' -Database ' + psq(db);
          if (isMfa) {
            ps = '# Entra MFA: erişim belirteci alın (Az.Accounts modülü)\n$token = (Get-AzAccessToken -ResourceUrl https://database.windows.net/).Token\n' +
              'Invoke-Sqlcmd -ServerInstance ' + psq(server) + ' -Database ' + psq(db) + ' -AccessToken $token';
          } else if (!isWin) {
            ps += ' -Username ' + psq(user) + ' -Password ' + psq(pwd);
          }
          if (c.trustServerCert && !isMfa) ps += ' -TrustServerCertificate';
          notes.push(['info', 'SqlServer modülü v22+ varsayılan olarak şifreli bağlanır; sertifika doğrulanamıyorsa (test ortamı) `-TrustServerCertificate` ekleyin.']);
          ps += ' -Query "SELECT @@VERSION AS Version"';
          code = ps;
          if (!isWin && !isMfa) notes.push(['warn', 'PowerShell geçmişinde parola görünür; `Read-Host -AsSecureString` ile sorup `SecureString`e çevirmeyi düşünün.']);
        } else if (fmt === 'appsettings') {
          const cs = ado;
          code = JSON.stringify({ ConnectionStrings: { DefaultConnection: cs } }, null, 2);
          if (!isWin && !isMfa) notes.push(['warn', 'Parolayı appsettings.json içine düz yazmayın. `dotnet user-secrets`, ortam değişkeni veya Key Vault kullanın; buradaki değer yalnızca yer tutucudur.']);
          notes.push(['tip', 'Yazılan dizge, seçilen kimlik doğrulama tipine göre üretildi (SQL / Windows / Entra MFA).']);
        }

        const fmtInfo = CN_FORMATS[fmt] || CN_FORMATS.adonet;
        const fileName = 'connection.' + fmtInfo[2];
        return { code, notes, title: fmtInfo[0], lang: fmtInfo[1], file: fileName };
      });

      // ==============================================================
      // 7. MEMORY & MAXDOP
      // ==============================================================
      const [tu, resetTu] = persisted('ms.tune', {
        ramGb: 64, instances: 1, otherServices: false, logicalCores: 16, numaNodes: 2,
        workload: 'oltp', costThreshold: 50
      });

      // Kehayias / Microsoft bellek formülü (eski sayfadaki mantık korunmuştur)
      const memOut = computed(() => {
        const t = tu, notes = [];
        const total = Math.max(1, parseFloat(t.ramGb) || 1);
        let osReserved = 1;
        if (total <= 4) osReserved = 1;
        else if (total <= 16) osReserved += Math.floor((total - 4) / 4);
        else { osReserved += 3; osReserved += Math.floor((total - 16) / 8); }
        if (t.otherServices) osReserved += 4;

        const inst = posInt(t.instances, 1, 20, 1);
        let sqlMaxGb = Math.max(2, total - osReserved);
        if (inst > 1) sqlMaxGb = Math.floor(sqlMaxGb / inst);
        const sqlMaxMb = sqlMaxGb * 1024;
        const osPercent = Math.round((osReserved / total) * 100);
        const sqlPercent = Math.max(0, Math.min(100, Math.round((sqlMaxGb * inst / total) * 100)));

        if (sqlMaxGb <= 2) notes.push(['warn', 'Bu donanımda SQL Server\'a kalan bellek çok düşük. RAM artırın veya diğer servisleri ayırın.']);
        if (t.otherServices) notes.push(['info', 'SSIS / SSRS veya diğer servisler aynı sunucudaysa 4 GB ayrıldı.']);
        if (inst > 1) notes.push(['info', 'Birden fazla instance: her instance\'a verilen max server memory, toplam bellekten bölünerek hesaplandı. Başlangıç değeri olarak kullanın.']);
        notes.push(['tip', '**Lock Pages in Memory** (LPIM) hakkını SQL Server servis hesabına verin; bellek baskısında SQL sayfalarının diske alınmasını engeller.']);

        return { total, osReserved, sqlMaxGb, sqlMaxMb, osPercent, sqlPercent, inst, notes };
      });

      // MAXDOP: Microsoft'un güncel kılavuzu (tek NUMA ≤ 8 → LP; > 8 → 8; çoklu NUMA düğüm başına ≤ 16 → LP; > 16 → min(16, LP/2))
      const dopOut = computed(() => {
        const t = tu, notes = [];
        const cores = posInt(t.logicalCores, 1, 1024, 1);
        const nodes = posInt(t.numaNodes, 1, 64, 1);
        const perNode = Math.max(1, Math.floor(cores / nodes));
        let val, rule;
        if (nodes === 1) {
          if (cores <= 8) { val = cores; rule = 'Tek NUMA düğümü, ' + cores + ' LP ≤ 8 → MAXDOP = LP (' + cores + ')'; }
          else { val = 8; rule = 'Tek NUMA düğümü, ' + cores + ' LP > 8 → MAXDOP = 8'; }
        } else if (perNode <= 16) {
          val = perNode;
          rule = 'Çoklu NUMA (' + nodes + ' düğüm), düğüm başına ' + perNode + ' LP ≤ 16 → MAXDOP = düğüm başına LP (' + perNode + ')';
        } else {
          val = Math.min(16, Math.floor(perNode / 2));
          rule = 'Çoklu NUMA (' + nodes + ' düğüm), düğüm başına ' + perNode + ' LP > 16 → MAXDOP = min(16, LP/2) = ' + val;
        }
        if (t.workload === 'oltp' && val > 8) {
          val = 8;
          rule += ' → OLTP olduğu için 8 ile sınırlandı';
          notes.push(['info', 'OLTP iş yükünde MAXDOP 8 ile sınırlanır; paralellik sorgu başına CPU tüketimini ve kilit çekişmesini artırabilir.']);
        }
        if (nodes > 1 && cores % nodes !== 0) notes.push(['warn', 'LP sayısı NUMA düğüm sayısına tam bölünmüyor. Gerçek topolojiyi `SELECT node_id, online_scheduler_count FROM sys.dm_os_nodes WHERE node_state_desc <> N\'ONLINE DAC\';` ile doğrulayın.']);
        notes.push(['info', 'MAXDOP kuralı Microsoft\'un güncel yönergelerine göredir; NUMA düğüm sayısını `sys.dm_os_sys_info` ve sunucu donanım bilgisiyle doğrulayın.']);
        return { val, rule, cores, nodes, notes };
      });

      const tuneOut = computed(() => {
        const m = memOut.value, d = dopOut.value, t = tu;
        const cost = posInt(t.costThreshold, 0, 32767, 50);
        const tempFiles = Math.min(8, d.cores);
        const sql = hdr('Donanım ve performans optimizasyonu', [
          'RAM: ' + m.total + ' GB | LP: ' + d.cores + ' | NUMA: ' + d.nodes + ' | İş yükü: ' + (t.workload === 'oltp' ? 'OLTP' : 'DW / Raporlama'),
          'Gerekçe (MAXDOP): ' + d.rule
        ]) + `
USE [master];
GO

-- 1. Gelişmiş seçenekleri etkinleştir
EXEC sys.sp_configure N'show advanced options', N'1';
RECONFIGURE WITH OVERRIDE;
GO

-- 2. Max server memory: ${m.sqlMaxGb} GB (${m.sqlMaxMb} MB)
-- İşletim sistemi ve arka plan için ${m.osReserved} GB ayrıldı.
EXEC sys.sp_configure N'max server memory (MB)', N'${m.sqlMaxMb}';
RECONFIGURE WITH OVERRIDE;
GO

-- 3. MAXDOP
EXEC sys.sp_configure N'max degree of parallelism', N'${d.val}';
RECONFIGURE WITH OVERRIDE;
GO

-- 4. Cost threshold for parallelism (varsayılan 5; bu sunucu için ${cost})
EXEC sys.sp_configure N'cost threshold for parallelism', N'${cost}';
RECONFIGURE WITH OVERRIDE;
GO

-- 5. Önerilen ek ayarlar
-- Ad hoc iş yükü: tek kullanımlık planlar yalnızca küçük bir stub olarak önbelleğe alınır; plan cache şişmesi azalır.
EXEC sys.sp_configure N'optimize for ad hoc workloads', N'1';
RECONFIGURE WITH OVERRIDE;
GO

-- Yedek sıkıştırma varsayılanı: yeni yedekler sıkıştırılır (CPU maliyeti vardır, yedek boyutu düşer).
EXEC sys.sp_configure N'backup compression default', N'1';
RECONFIGURE WITH OVERRIDE;
GO

-- 6. TempDB veri dosyası önerisi: min(8, LP) = ${tempFiles} (ayrıntı: Storage > TempDB)

-- Doğrulama
SELECT name, value, value_in_use, description
FROM sys.configurations
WHERE name IN (N'max server memory (MB)', N'max degree of parallelism', N'cost threshold for parallelism',
               N'optimize for ad hoc workloads', N'backup compression default');
GO`;
        return { sql, file: 'sql_tuning.sql' };
      });

      // ==============================================================
      // Sıfırlama (modül bazlı)
      // ==============================================================
      const resetBackupSub = () => {
        if (bkSub.value === 'backup') resetBk();
        else if (bkSub.value === 'restore') resetRs();
        else resetBc();
        DBA.toast('Varsayılana döndürüldü');
      };
      const resetStorageSub = () => {
        const map = { create_db: resetCdb, addfile: resetAfl, shrink: resetShr, recovery: resetRec, tempdb: resetTdb, checkdb: resetCkd };
        (map[stSub.value] || (() => {}))();
        DBA.toast('Varsayılana döndürüldü');
      };

      // Kaynak sayfasındaki cheat sheet (statik içerik)
      const cheatDbcc = `-- Bütünlük denetimi
DBCC CHECKDB ('DBAdi') WITH NO_INFOMSGS;

-- Tüm veritabanlarının log boyutu ve doluluk oranı
DBCC SQLPERF (LOGSPACE);

-- En eski açık transaction ve SPID (log truncation'ı engelleyen oturum)
DBCC OPENTRAN ('DBAdi');

-- YALNIZCA TEST ORTAMI: buffer ve plan önbelleğini temizler
DBCC DROPCLEANBUFFERS;
DBCC FREEPROCCACHE;`;

      const cheatAg = `-- İkincil replikada çalıştırın (senkron replika, veri kaybı yok)
ALTER AVAILABILITY GROUP [AG_Adi] FAILOVER;

-- Senkron olmayan replika: VERİ KAYBI RİSKLİ zorla failover
ALTER AVAILABILITY GROUP [AG_Adi] FORCE_FAILOVER_ALLOW_DATA_LOSS;`;

      return {
        modules, tab,
        // Backup / Restore / BCP
        bkSub, resetBackupSub, bk, resetBk, autoBkPath, bkOut, lastBackupsSql: SQL_LAST_BACKUPS,
        rs, resetRs, addMove, removeMove, rsOut, rsHeader,
        bc, resetBc, bcOut,
        // Login & yetki
        sec, resetSec, regenPwd, secOut, secMaint,
        // Storage
        stSub, resetStorageSub,
        cdb, resetCdb, cdbOut,
        afl, resetAfl, aflOut,
        shr, resetShr, shrOut,
        rec, resetRec, recOut,
        tdb, resetTdb, tdbOut,
        ckd, resetCkd, ckdOut,
        // Oturum
        ss, resetSs, ssOut,
        // DMV
        qcats, queries, cheatDbcc, cheatAg,
        // Bağlantı
        cn, resetCn, cnOut,
        // Tuning
        tu, resetTu, memOut, dopOut, tuneOut
      };
    }
  });
})();
