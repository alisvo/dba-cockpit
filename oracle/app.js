/* Oracle DBA Cockpit – 11gR2 / 12c / 19c / 21c / 23ai */
(function () {
  const { computed, ref } = Vue;
  const { persisted, hashRoute, genPassword, list, oraIdent, oraLit, sh, stamp } = DBA;

  const modules = [
    { id: 'datapump', name: 'Data Pump', icon: '📦' },
    { id: 'rman', name: 'RMAN Yedekleme', icon: '🛟' },
    { id: 'user', name: 'Kullanıcı & Yetki', icon: '👤' },
    { id: 'storage', name: 'Tablespace & Datafile', icon: '💾' },
    { id: 'session', name: 'Oturum & Kill', icon: '⚡' },
    { id: 'queries', name: 'Teşhis Sorguları', icon: '🔍' },
    { id: 'tns', name: 'TNS & Bağlantı', icon: '🌐' },
    { id: 'memory', name: 'SGA / PGA / HugePages', icon: '🧮' }
  ];

  DBA.mount({
    setup() {
      const tab = hashRoute(modules.map(m => m.id), 'datapump');

      // ==============================================================
      // 1. DATA PUMP
      // ==============================================================
      const [dp, resetDp] = persisted('ora.dp', {
        type: 'expdp', mode: 'schemas', user: 'system', tns: 'ORCLPDB', targets: 'HR, SCOTT',
        directory: 'DATA_PUMP_DIR', dirPath: '/u01/app/oracle/dpdump', dumpfile: '', logfile: '',
        parallel: 4, filesize: '', content: 'ALL', compression: 'METADATA_ONLY', excludeStats: true,
        cluster: true, consistent: true, logtime: true, metrics: true, estimateOnly: false,
        exclude: '', include: '', query: '', networkLink: '', version: '',
        remapSchema: '', remapTablespace: '', tea: 'SKIP', archiveOff: true, sqlfile: false, transformOid: false
      });

      const dpOut = computed(() => {
        const d = dp, notes = [];
        const isExp = d.type === 'expdp';
        const tag = isExp ? 'exp' : 'imp';
        const par = parseInt(d.parallel) || 1;
        let dump = d.dumpfile.trim() || (par > 1 ? `${tag}_${stamp()}_%U.dmp` : `${tag}_${stamp()}.dmp`);
        if (!isExp && !d.dumpfile.trim()) dump = 'exp_%U.dmp';
        const log = d.logfile.trim() || `${tag}_${stamp()}.log`;
        const p = [];
        p.push(`DIRECTORY=${oraIdent(d.directory || 'DATA_PUMP_DIR')}`);
        if (!(isExp && d.estimateOnly)) p.push(`DUMPFILE=${dump}`);
        p.push(`LOGFILE=${log}`);
        const tg = list(d.targets).map(x => x.toUpperCase());
        if (d.mode === 'full') p.push('FULL=YES');
        else if (!tg.length) notes.push(['danger', 'Hedef şema/tablo/tablespace listesi boş.']);
        else p.push(`${{ schemas: 'SCHEMAS', tables: 'TABLES', tablespaces: 'TABLESPACES' }[d.mode]}=${tg.join(',')}`);
        if (d.content !== 'ALL') p.push(`CONTENT=${d.content}`);
        if (par > 1) {
          p.push(`PARALLEL=${par}`);
          if (d.cluster) p.push('CLUSTER=N');
          if (isExp && !/%[ULl]/.test(dump)) notes.push(['warn', 'PARALLEL > 1 iken DUMPFILE adında `%U` (veya 12.2+ `%L`) olmalı; aksi halde paralellik dosya başına tek işçiye düşer.']);
        }
        if (isExp) {
          if (d.filesize.trim()) p.push(`FILESIZE=${d.filesize.trim().toUpperCase()}`);
          if (d.compression !== 'NONE') p.push(`COMPRESSION=${d.compression}`);
          if (d.compression === 'ALL' || d.compression === 'DATA_ONLY') notes.push(['warn', '`COMPRESSION=' + d.compression + '` **Advanced Compression Option** lisansı gerektirir. Lisans yoksa `METADATA_ONLY` kullanın.']);
          if (d.consistent) p.push('FLASHBACK_TIME=SYSTIMESTAMP');
          if (d.estimateOnly) p.push('ESTIMATE_ONLY=YES');
          if (d.version.trim()) p.push(`VERSION=${d.version.trim()}`);
          if (d.consistent && d.mode === 'full') notes.push(['info', 'FULL modda tutarlı export için yeterli UNDO_RETENTION gerekir; aksi halde ORA-01555 alabilirsiniz.']);
        }
        if (d.excludeStats) p.push('EXCLUDE=STATISTICS');
        d.exclude.split(/\n/).map(s => s.trim()).filter(Boolean).forEach(x => p.push(`EXCLUDE=${x}`));
        d.include.split(/\n/).map(s => s.trim()).filter(Boolean).forEach(x => p.push(`INCLUDE=${x}`));
        if (d.include.trim() && d.exclude.trim()) notes.push(['danger', 'INCLUDE ve EXCLUDE aynı işte birlikte kullanılamaz (ORA-39001). `EXCLUDE=STATISTICS` da bir EXCLUDE sayılır.']);
        else if (d.include.trim() && d.excludeStats) notes.push(['danger', 'INCLUDE ile `EXCLUDE=STATISTICS` birlikte kullanılamaz; istatistik hariç seçeneğini kapatın.']);
        if (isExp && d.query.trim()) p.push(`QUERY=${d.query.trim()}`);
        if (d.networkLink.trim()) {
          p.push(`NETWORK_LINK=${oraIdent(d.networkLink)}`);
          if (!isExp) notes.push(['info', 'NETWORK_LINK ile impdp dump dosyası kullanmaz; veri doğrudan kaynaktan çekilir (DUMPFILE yok sayılır).']);
        }
        if (d.logtime) p.push('LOGTIME=ALL');
        if (d.metrics) p.push('METRICS=YES');
        if (!isExp) {
          list(d.remapSchema).forEach(x => p.push(`REMAP_SCHEMA=${x.toUpperCase()}`));
          list(d.remapTablespace).forEach(x => p.push(`REMAP_TABLESPACE=${x.toUpperCase()}`));
          if (d.content !== 'METADATA_ONLY') p.push(`TABLE_EXISTS_ACTION=${d.tea}`);
          const tr = [];
          if (d.archiveOff) tr.push('DISABLE_ARCHIVE_LOGGING:Y');
          if (d.transformOid) tr.push('OID:N');
          if (tr.length) p.push(`TRANSFORM=${tr.join(',')}`);
          if (d.sqlfile) p.push(`SQLFILE=${tag}_ddl_${stamp()}.sql`);
          if (d.archiveOff) notes.push(['info', '`DISABLE_ARCHIVE_LOGGING` (12c+) veritabanı **FORCE LOGGING** modundaysa (ör. Data Guard) etkisizdir.']);
          if (d.tea === 'REPLACE') notes.push(['warn', '`TABLE_EXISTS_ACTION=REPLACE` hedefteki tabloyu DROP edip yeniden yaratır; mevcut veri ve grant\'ler kaybolur.']);
          if (d.sqlfile) notes.push(['tip', 'SQLFILE açıkken import **yapılmaz**; sadece çalıştırılacak DDL bir dosyaya yazılır. Önizleme için idealdir.']);
        }
        if (d.mode === 'full') notes.push(['info', 'FULL mod için kullanıcıda `DATAPUMP_EXP_FULL_DATABASE` / `DATAPUMP_IMP_FULL_DATABASE` rolü olmalı.']);
        const parfile = `${tag}_${stamp()}.par`;
        const conn = `${d.user || 'system'}@${d.tns || 'ORCLPDB'}`;
        const parText = `# ${d.type} parametre dosyası – DBA Cockpit\n# Çalıştırma: ${d.type} ${conn} parfile=${parfile}\n` + p.join('\n');
        const cmd = `# Şifre komut satırına yazılmaz; ${d.type} sizden sorar (ps/history'de görünmez)\n${d.type} ${conn} parfile=${parfile}\n\n# Arka planda, oturum kopsa da devam etsin:\nnohup ${d.type} ${conn} parfile=${parfile} > /dev/null 2>&1 &`;
        const inline = `${d.type} ${conn} ` + p.map(x => /[\s"'()<>|&;*]/.test(x) ? sh(x) : x).join(' \\\n  ');
        return { parText, cmd, inline, notes, parfile };
      });

      const dpHelper = computed(() => {
        const dir = oraIdent(dp.directory || 'DATA_PUMP_DIR');
        const u = oraIdent(dp.user || 'SYSTEM');
        return `-- DIRECTORY nesnesi (bir kez, SYSDBA veya CREATE ANY DIRECTORY yetkisiyle)
CREATE OR REPLACE DIRECTORY ${dir} AS ${oraLit(dp.dirPath || '/u01/app/oracle/dpdump')};
GRANT READ, WRITE ON DIRECTORY ${dir} TO ${u};

-- Mevcut directory'ler
SELECT directory_name, directory_path FROM dba_directories ORDER BY 1;

-- Çalışan Data Pump işleri
SELECT owner_name, job_name, operation, job_mode, state, degree, attached_sessions
FROM dba_datapump_jobs ORDER BY 1, 2;

-- İlerleme (yüzde)
SELECT sid, serial#, opname, sofar, totalwork,
       ROUND(sofar / NULLIF(totalwork, 0) * 100, 1) AS pct_done, time_remaining
FROM v$session_longops
WHERE opname LIKE 'SYS_%PORT%' AND sofar <> totalwork;

-- İşe yeniden bağlanıp yönetme (STATUS / STOP_JOB=IMMEDIATE / START_JOB / KILL_JOB / PARALLEL=8)
-- ${dp.type} ${dp.user || 'system'}@${dp.tns || 'ORCLPDB'} attach=SYS_EXPORT_SCHEMA_01`;
      });

      // ==============================================================
      // 2. RMAN
      // ==============================================================
      const [rm, resetRm] = persisted('ora.rman', {
        kind: 'l0', device: 'DISK', channels: 4, format: '/backup/rman/%d_%T_%U', compress: 'BASIC',
        plusArch: true, deleteArchInput: false, ctlSpfile: true, sectionSize: '', retentionDays: 7,
        deleteObsolete: true, crosscheck: true, tag: '', checkLogical: true, sbtParms: ''
      });

      const rmOut = computed(() => {
        const r = rm, notes = [];
        const ch = Math.max(1, parseInt(r.channels) || 1);
        const fmt = r.format.trim() || '/backup/rman/%d_%T_%U';
        const tagMap = { l0: 'LEVEL0', l1: 'LEVEL1_DIFF', l1c: 'LEVEL1_CUM', full: 'FULL', arch: 'ARCH', validate: 'VALIDATE' };
        const tag = (r.tag.trim() || `${tagMap[r.kind]}_${stamp().slice(0, 8)}`).toUpperCase();
        const L = [];
        L.push(`# RMAN betiği – ${r.kind.toUpperCase()} – DBA Cockpit`);
        L.push('RUN {');
        for (let i = 1; i <= ch; i++) {
          if (r.device === 'DISK') L.push(`  ALLOCATE CHANNEL c${i} DEVICE TYPE DISK FORMAT '${fmt}${fmt.includes('%U') ? '' : '_%U'}';`);
          else L.push(`  ALLOCATE CHANNEL c${i} DEVICE TYPE SBT${r.sbtParms.trim() ? ` PARMS '${r.sbtParms.trim()}'` : ''};`);
        }
        const asComp = r.compress !== 'NONE' ? 'AS COMPRESSED BACKUPSET ' : '';
        const sec = r.sectionSize.trim() ? ` SECTION SIZE ${r.sectionSize.trim().toUpperCase()}` : '';
        const arch = r.plusArch ? ` PLUS ARCHIVELOG${r.deleteArchInput ? ' DELETE INPUT' : ''}` : '';
        if (r.kind === 'full') L.push(`  BACKUP ${asComp}DATABASE${sec} TAG '${tag}'${arch};`);
        if (r.kind === 'l0') L.push(`  BACKUP ${asComp}INCREMENTAL LEVEL 0 DATABASE${sec} TAG '${tag}'${arch};`);
        if (r.kind === 'l1') L.push(`  BACKUP ${asComp}INCREMENTAL LEVEL 1 DATABASE${sec} TAG '${tag}'${arch};`);
        if (r.kind === 'l1c') L.push(`  BACKUP ${asComp}INCREMENTAL LEVEL 1 CUMULATIVE DATABASE${sec} TAG '${tag}'${arch};`);
        if (r.kind === 'arch') L.push(`  BACKUP ${asComp}ARCHIVELOG ALL NOT BACKED UP 1 TIMES TAG '${tag}'${r.deleteArchInput ? ' DELETE INPUT' : ''};`);
        if (r.kind === 'validate') {
          L.push(`  BACKUP VALIDATE ${r.checkLogical ? 'CHECK LOGICAL ' : ''}DATABASE ARCHIVELOG ALL;`);
          L.push('  RESTORE DATABASE VALIDATE;');
          L.push('  RESTORE CONTROLFILE VALIDATE;');
        }
        if (r.ctlSpfile && r.kind !== 'validate') {
          L.push(r.device === 'DISK' ? `  BACKUP CURRENT CONTROLFILE FORMAT '${fmt.replace(/%U/, '')}ctl_%U' TAG '${tag}_CTL';` : `  BACKUP CURRENT CONTROLFILE TAG '${tag}_CTL';`);
          L.push(r.device === 'DISK' ? `  BACKUP SPFILE FORMAT '${fmt.replace(/%U/, '')}spf_%U' TAG '${tag}_SPF';` : `  BACKUP SPFILE TAG '${tag}_SPF';`);
        }
        for (let i = 1; i <= ch; i++) L.push(`  RELEASE CHANNEL c${i};`);
        L.push('}');
        if (r.kind !== 'validate') {
          if (r.crosscheck) { L.push('CROSSCHECK BACKUP;', 'CROSSCHECK ARCHIVELOG ALL;', 'DELETE NOPROMPT EXPIRED BACKUP;'); }
          if (r.deleteObsolete) L.push('DELETE NOPROMPT OBSOLETE;');
        }
        L.push('LIST BACKUP SUMMARY;');

        if (['MEDIUM', 'HIGH', 'LOW'].includes(r.compress)) notes.push(['warn', `${r.compress} sıkıştırma algoritması **Advanced Compression Option** lisansı ister. BASIC lisanssızdır.`]);
        if ((r.kind === 'l1' || r.kind === 'l1c')) notes.push(['tip', 'Incremental yedekleri hızlandırmak için Block Change Tracking açın (Enterprise Edition): `ALTER DATABASE ENABLE BLOCK CHANGE TRACKING USING FILE \'+DATA\';`']);
        if (r.deleteArchInput && !r.plusArch && r.kind !== 'arch') notes.push(['info', 'DELETE INPUT yalnızca PLUS ARCHIVELOG ile anlamlıdır.']);
        if (r.deleteArchInput) notes.push(['warn', 'Data Guard ortamında arşivleri silmeden önce `CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;` ayarlı olmalı.']);
        if (r.kind === 'full') notes.push(['info', '`BACKUP DATABASE` (FULL) incremental stratejiye taban olamaz; haftalık taban için LEVEL 0 tercih edin.']);
        if (r.sectionSize.trim()) notes.push(['tip', 'SECTION SIZE büyük (özellikle BIGFILE) datafile\'ları kanallar arasında paylaştırır; 12c+ incremental ile de çalışır.']);

        const cfg = `# Bir kez çalıştırılacak kalıcı RMAN ayarları
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF ${parseInt(r.retentionDays) || 7} DAYS;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE DEVICE TYPE ${r.device} PARALLELISM ${ch} BACKUP TYPE TO ${r.compress !== 'NONE' ? 'COMPRESSED ' : ''}BACKUPSET;${r.compress !== 'NONE' ? `\nCONFIGURE COMPRESSION ALGORITHM '${r.compress}';` : ''}
CONFIGURE ARCHIVELOG DELETION POLICY TO BACKED UP 1 TIMES TO ${r.device};
# RAC'ta snapshot controlfile paylaşımlı konumda olmalı:
# CONFIGURE SNAPSHOT CONTROLFILE NAME TO '+DATA/snapcf_<DB_UNIQUE_NAME>.f';
SHOW ALL;`;

        const file = `rman_${r.kind}.rcv`;
        const wrapper = `#!/bin/bash
# rman_${r.kind}.sh – cron'dan çağrılabilir RMAN sarmalayıcı
export ORACLE_SID=ORCL
export ORAENV_ASK=NO
. oraenv > /dev/null
LOG=/backup/rman/log/rman_${r.kind}_$(date +%Y%m%d_%H%M).log
mkdir -p "$(dirname "$LOG")"
rman target / cmdfile=/backup/scripts/${file} log="$LOG"
RC=$?
grep -E "RMAN-|ORA-" "$LOG" && RC=1
exit $RC

# crontab örneği (Pazar 01:00 L0, diğer günler 01:00 L1, her saat arşiv):
# 0 1 * * 0   /backup/scripts/rman_l0.sh
# 0 1 * * 1-6 /backup/scripts/rman_l1.sh
# 0 * * * *   /backup/scripts/rman_arch.sh`;
        return { script: L.join('\n'), cfg, wrapper, notes, file };
      });

      // ==============================================================
      // 3. USER & PRIVILEGES
      // ==============================================================
      const [usr, resetUsr] = persisted('ora.user', {
        username: 'REPORT_USER', password: '', scope: 'pdb', container: 'ORCLPDB1', defaultTs: 'USERS', tempTs: 'TEMP',
        quota: 'UNLIMITED', profile: 'DEFAULT', preset: 'readonly', targetSchema: 'HR', viaRole: true,
        readMode: 'loop', expire: false, svcProfile: false, devRole23: false
      }, ['password']);
      if (!usr.password) usr.password = genPassword(20, { symbols: '#_', letterFirst: true });
      const regenPwd = () => { usr.password = genPassword(20, { symbols: '#_', letterFirst: true }); DBA.toast('Yeni şifre üretildi'); };

      const usrOut = computed(() => {
        const u = usr, notes = [];
        let name = (u.username || 'APP_USER').trim().toUpperCase();
        if (u.scope === 'common' && !/^C##/.test(name)) { notes.push(['warn', 'CDB common kullanıcı adı `C##` ile başlamalı; otomatik eklendi.']); name = 'C##' + name; }
        const U = oraIdent(name);
        const tgt = oraIdent(u.targetSchema || 'HR');
        const L = [];
        if (u.scope === 'pdb' && u.container.trim()) L.push(`-- CDB root'tan bağlandıysanız önce PDB'ye geçin`, `ALTER SESSION SET CONTAINER = ${oraIdent(u.container)};`, '');
        if (u.scope === 'common') L.push('-- CDB$ROOT içinde çalıştırın', 'ALTER SESSION SET CONTAINER = CDB$ROOT;', '');
        if (u.svcProfile) {
          L.push('-- 0. Servis hesapları için şifre süresi dolmayan profil');
          L.push(`CREATE PROFILE APP_SVC_PROFILE LIMIT`);
          L.push(`  FAILED_LOGIN_ATTEMPTS 10`, `  PASSWORD_LOCK_TIME 1/24`, `  PASSWORD_LIFE_TIME UNLIMITED`, `  PASSWORD_REUSE_MAX 10`, `  PASSWORD_REUSE_TIME 365`, `  PASSWORD_GRACE_TIME 7${u.scope === 'common' ? '\n  CONTAINER = ALL' : ''};`, '');
        }
        const pwd = (u.password || '').replace(/"/g, '');
        if (/"/.test(u.password || '')) notes.push(['warn', 'Oracle şifresi çift tırnak içeremez; kaldırıldı.']);
        L.push('-- 1. Kullanıcı');
        L.push(`CREATE USER ${U}`);
        L.push(`  IDENTIFIED BY "${pwd}"`);
        L.push(`  DEFAULT TABLESPACE ${oraIdent(u.defaultTs || 'USERS')}`);
        L.push(`  TEMPORARY TABLESPACE ${oraIdent(u.tempTs || 'TEMP')}`);
        if (u.quota !== 'NONE') L.push(`  QUOTA ${u.quota} ON ${oraIdent(u.defaultTs || 'USERS')}`);
        L.push(`  PROFILE ${u.svcProfile ? 'APP_SVC_PROFILE' : oraIdent(u.profile || 'DEFAULT')}`);
        if (u.expire) L.push('  PASSWORD EXPIRE');
        L.push(`  ACCOUNT UNLOCK${u.scope === 'common' ? '\n  CONTAINER = ALL' : ''};`, '');
        const cont = u.scope === 'common' ? ' CONTAINER = ALL' : '';
        L.push('-- 2. Yetkiler');
        if (u.preset === 'readonly') {
          L.push(`GRANT CREATE SESSION TO ${U}${cont};`, '');
          const role = oraIdent(`${u.scope === 'common' ? 'C##' : ''}${(u.targetSchema || 'HR').toUpperCase()}_READ_ROLE`);
          if (u.scope === 'common') notes.push(['warn', 'Uygulama şemaları PDB içindedir: okuma yetkisi bloğunu ilgili PDB\'de çalıştırın (`ALTER SESSION SET CONTAINER = <PDB>;`). Common kullanıcı her PDB\'de vardır ama yetkiler PDB bazındadır.']);
          const grantee = u.viaRole ? role : U;
          if (u.readMode === 'schema23') {
            L.push(`-- 23ai: şema seviyesinde yetki – sonradan yaratılan tablolar da otomatik kapsanır`);
            L.push(`GRANT READ ANY TABLE ON SCHEMA ${tgt} TO ${U};`);
            notes.push(['tip', '23ai şema yetkisi yeni tabloları da kapsar; ayrıca döngü veya yeniden grant gerekmez.']);
          } else {
            if (u.viaRole) {
              L.push(`-- Yetkiler rol üzerinden: yeni okuyucu kullanıcılara sadece rolü vermeniz yeterli`);
              L.push(`CREATE ROLE ${role};`);
            }
            L.push(`-- ${tgt} şemasındaki mevcut tablo ve view'lara READ (SELECT FOR UPDATE ile kilit alamaz)`);
            L.push('BEGIN');
            L.push(`  FOR o IN (SELECT owner, object_name`);
            L.push(`              FROM dba_objects`);
            L.push(`             WHERE owner = ${oraLit((u.targetSchema || 'HR').toUpperCase())}`);
            L.push(`               AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')`);
            L.push(`               AND object_name NOT LIKE 'BIN$%') LOOP`);
            L.push(`    EXECUTE IMMEDIATE 'GRANT READ ON "' || o.owner || '"."' || o.object_name || '" TO ${grantee.replace(/"/g, '""')}';`);
            L.push('  END LOOP;');
            L.push('END;');
            L.push('/');
            if (u.viaRole) L.push('', `GRANT ${role} TO ${U};`);
            notes.push(['info', 'Döngü yalnızca **mevcut** nesnelere grant verir; şemaya sonradan eklenen tablolar için bloğu tekrar çalıştırın (veya 23ai şema yetkisini kullanın).']);
          }
        } else if (u.preset === 'developer') {
          if (u.devRole23) L.push(`GRANT DB_DEVELOPER_ROLE TO ${U};  -- 23ai`);
          else L.push(`GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE MATERIALIZED VIEW,\n      CREATE PROCEDURE, CREATE SEQUENCE, CREATE SYNONYM, CREATE TRIGGER,\n      CREATE TYPE, CREATE JOB TO ${U}${cont};`);
          if (u.quota === 'NONE') notes.push(['warn', 'Geliştirici kullanıcısının kotası yok; tablo yaratırken ORA-01950 alır.']);
        } else {
          L.push(`GRANT DBA TO ${U}${cont};`);
          notes.push(['danger', 'DBA rolü veritabanındaki her şeye erişim verir. Mümkünse ihtiyaç kadar sistem yetkisi tanımlayın ve hesabı denetime (audit) alın.']);
        }
        L.push('', '-- 3. Kontrol');
        L.push(`SELECT username, account_status, default_tablespace, profile, created FROM dba_users WHERE username = ${oraLit(name)};`);
        L.push(`SELECT * FROM dba_sys_privs WHERE grantee = ${oraLit(name)};`);
        L.push(`SELECT * FROM dba_role_privs WHERE grantee = ${oraLit(name)};`);
        const drop = `-- Önce açık oturum var mı?
SELECT inst_id, sid, serial#, status, machine FROM gv$session WHERE username = ${oraLit(name)};

-- Hesabı kilitle (silmeden önce güvenli adım)
ALTER USER ${U} ACCOUNT LOCK;

-- Kullanıcıyı ve TÜM nesnelerini sil (geri dönüşü yok!)
-- DROP USER ${U} CASCADE;

-- Şifre sıfırlama / kilit açma
ALTER USER ${U} IDENTIFIED BY "YeniSifre_2026" ACCOUNT UNLOCK;`;
        return { sql: L.join('\n'), drop, notes };
      });

      // ==============================================================
      // 4. STORAGE
      // ==============================================================
      const [st, resetSt] = persisted('ora.storage', {
        op: 'add_df', tsName: 'TBS_DATA_01', filePath: '+DATA', size: '10G', next: '1G',
        maxSize: '32767M', customMax: '', bigfile: false, blockSize: 8, encrypt: false, tempName: 'TEMP'
      });

      const stOut = computed(() => {
        const s = st, notes = [];
        const ts = oraIdent(s.tsName || 'TBS_DATA_01');
        const path = (s.filePath || '').trim();
        const isAsm = /^\+/.test(path);
        const file = !path ? '' : ` '${path.replace(/'/g, "''")}'`;
        if (isAsm && /\//.test(path)) notes.push(['warn', 'ASM\'de dosya adını kendiniz vermeyin; sadece disk grubunu (`+DATA`) yazın, Oracle OMF adını üretir.']);
        if (!path) notes.push(['info', 'Dosya yolu boş: OMF kullanılacak (`DB_CREATE_FILE_DEST` ayarlı olmalı).']);
        const max = s.maxSize === 'CUSTOM' ? (s.customMax.trim().toUpperCase() || 'UNLIMITED') : s.maxSize;
        const smallMaxMB = s.blockSize * 4194303 / 1024; // 4M-1 blok
        const toMB = (v) => { const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)$/i.exec(v || ''); if (!m) return NaN; return parseFloat(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024, T: 1048576, '': 1 / 1048576 })[m[2].toUpperCase()]; };
        if (!s.bigfile && max !== 'UNLIMITED' && toMB(max) > smallMaxMB) notes.push(['danger', `Smallfile datafile en fazla ${Math.floor(smallMaxMB)}M olabilir (${s.blockSize}K blok). ${max} → ORA-03206. BIGFILE kullanın veya MAXSIZE ${Math.floor(smallMaxMB)}M yapın.`]);
        if (toMB(s.size) > toMB(max)) notes.push(['danger', 'SIZE, MAXSIZE değerinden büyük olamaz.']);
        const auto = `AUTOEXTEND ON NEXT ${s.next || '1G'} MAXSIZE ${max}`;
        let sql = '';
        if (s.op === 'add_df') {
          sql = `ALTER TABLESPACE ${ts}\n  ADD DATAFILE${file}\n  SIZE ${s.size} ${auto};`;
          notes.push(['info', 'BIGFILE tablespace\'e ikinci datafile eklenemez; onun yerine mevcut dosyayı RESIZE edin.']);
        } else if (s.op === 'resize_df') {
          sql = `-- Dosya adı/ID için:\nSELECT file_id, file_name, ROUND(bytes/1024/1024) AS mb, autoextensible, ROUND(maxbytes/1024/1024) AS max_mb\nFROM dba_data_files WHERE tablespace_name = ${oraLit((s.tsName || '').toUpperCase())};\n\nALTER DATABASE DATAFILE${file || " '<dosya_yolu_veya_file_id>'"}\n  RESIZE ${s.size};\n\n-- BIGFILE tablespace için doğrudan:\n-- ALTER TABLESPACE ${ts} RESIZE ${s.size};`;
          if (isAsm && !/\//.test(path)) notes.push(['warn', 'RESIZE için disk grubu değil tam dosya adı veya FILE_ID gerekir (ör. `+DATA/ORCL/DATAFILE/users.271.1150`).']);
          notes.push(['info', 'Küçültme (shrink) yüksek su seviyesinin (HWM) altına inemez → ORA-03297. Aşağıdaki "Küçültülebilir boyut" sorgusunu kullanın.']);
        } else if (s.op === 'create_ts') {
          sql = `CREATE ${s.bigfile ? 'BIGFILE' : 'SMALLFILE'} TABLESPACE ${ts}\n  DATAFILE${file}\n  SIZE ${s.size} ${auto}${s.blockSize !== 8 ? `\n  BLOCKSIZE ${s.blockSize}K` : ''}\n  EXTENT MANAGEMENT LOCAL AUTOALLOCATE\n  SEGMENT SPACE MANAGEMENT AUTO${s.encrypt ? `\n  ENCRYPTION USING 'AES256' ENCRYPT` : ''};`;
          if (s.blockSize !== 8) notes.push(['warn', `${s.blockSize}K blok için önce \`DB_${s.blockSize}K_CACHE_SIZE\` parametresi ayarlanmalı.`]);
          if (s.encrypt) notes.push(['warn', 'TDE şifreleme Advanced Security lisansı ve açık bir keystore (wallet) gerektirir.']);
        } else if (s.op === 'temp') {
          const tt = oraIdent(s.tempName || 'TEMP');
          sql = `-- Mevcut TEMP'e tempfile ekle\nALTER TABLESPACE ${tt}\n  ADD TEMPFILE${file}\n  SIZE ${s.size} ${auto};\n\n-- Yeni temporary tablespace\n-- CREATE ${s.bigfile ? 'BIGFILE ' : ''}TEMPORARY TABLESPACE ${tt}2 TEMPFILE${file} SIZE ${s.size} ${auto};\n-- ALTER DATABASE DEFAULT TEMPORARY TABLESPACE ${tt}2;\n\n-- Tempfile küçültme (11g+)\n-- ALTER TABLESPACE ${tt} SHRINK SPACE KEEP 2G;`;
        } else if (s.op === 'drop_ts') {
          sql = `-- 1. İçinde ne var?\nSELECT owner, segment_type, COUNT(*) AS cnt, ROUND(SUM(bytes)/1024/1024) AS mb\nFROM dba_segments WHERE tablespace_name = ${oraLit((s.tsName || '').toUpperCase())}\nGROUP BY owner, segment_type;\n\n-- 2. Varsayılan tablespace olarak kullanan kullanıcılar\nSELECT username FROM dba_users WHERE default_tablespace = ${oraLit((s.tsName || '').toUpperCase())};\n\n-- 3. Önce OFFLINE (geri alınabilir), sonra DROP\nALTER TABLESPACE ${ts} OFFLINE NORMAL;\n-- DROP TABLESPACE ${ts} INCLUDING CONTENTS AND DATAFILES CASCADE CONSTRAINTS;`;
          notes.push(['danger', 'DROP ... INCLUDING CONTENTS AND DATAFILES geri alınamaz; fiziksel dosyalar da silinir. Önce yedeğinizi doğrulayın. Komut bilerek yorum satırı bırakıldı.']);
        }
        return { sql, notes };
      });

      const hwmSql = computed(() => `-- Datafile'ların küçültülebileceği minimum boyut (HWM) ve kazanılacak alan
SELECT f.file_id, f.file_name,
       CEIL(NVL(e.hwm, 1) * t.block_size / 1024 / 1024) AS min_size_mb,
       CEIL(f.bytes / 1024 / 1024) AS current_mb,
       CEIL(f.bytes / 1024 / 1024) - CEIL(NVL(e.hwm, 1) * t.block_size / 1024 / 1024) AS savings_mb,
       'ALTER DATABASE DATAFILE ''' || f.file_name || ''' RESIZE ' ||
         CEIL(NVL(e.hwm, 1) * t.block_size / 1024 / 1024) || 'M;' AS resize_cmd
FROM dba_data_files f
JOIN dba_tablespaces t ON t.tablespace_name = f.tablespace_name
LEFT JOIN (SELECT file_id, MAX(block_id + blocks - 1) AS hwm FROM dba_extents GROUP BY file_id) e
       ON e.file_id = f.file_id
WHERE f.tablespace_name = ${oraLit((st.tsName || '').toUpperCase())}
ORDER BY savings_mb DESC;`);

      // ==============================================================
      // 5. SESSION & KILL
      // ==============================================================
      const [ss, resetSs] = persisted('ora.session', {
        sid: '142', serial: '58219', instId: '1', spid: '18492', oraSid: 'ORCL', username: 'APP_USER', rac: false
      });
      const sessFind = computed(() => `-- Oturumu bul (SID/SERIAL#/SPID/SQL)
SELECT s.inst_id, s.sid, s.serial#, p.spid, s.username, s.status, s.osuser, s.machine,
       s.program, s.sql_id, s.event, s.last_call_et AS idle_or_active_sec, s.logon_time
FROM gv$session s
JOIN gv$process p ON p.addr = s.paddr AND p.inst_id = s.inst_id
WHERE s.sid = ${parseInt(ss.sid) || 0}${ss.rac ? ` AND s.inst_id = ${parseInt(ss.instId) || 1}` : ''}
   OR s.username = ${oraLit((ss.username || '').toUpperCase())}
ORDER BY s.last_call_et DESC;`);
      const sessKill = computed(() => {
        const at = ss.rac && ss.instId ? `,@${parseInt(ss.instId) || 1}` : '';
        const id = `'${parseInt(ss.sid) || 0},${parseInt(ss.serial) || 0}${at}'`;
        return `-- 1) Yumuşak: sadece çalışan SQL'i iptal et, oturum kalsın (18c+)
ALTER SYSTEM CANCEL SQL ${id};

-- 2) Transaction bitince bağlantıyı kopar
ALTER SYSTEM DISCONNECT SESSION ${id} POST_TRANSACTION;

-- 3) Hemen sonlandır (açık transaction ROLLBACK edilir)
ALTER SYSTEM KILL SESSION ${id} IMMEDIATE;

-- KILLED durumda takılı kaldıysa rollback ilerlemesi:
SELECT s.sid, t.used_ublk, t.used_urec FROM v$transaction t JOIN v$session s ON s.taddr = t.addr
WHERE s.sid = ${parseInt(ss.sid) || 0};`;
      });
      const sessOs = computed(() => `# Linux/Unix – sunucu prosesini (dedicated server) sonlandır
# Önce doğrula: ps -ef | grep ${parseInt(ss.spid) || 0}  → "oracle${ss.oraSid}" (LOCAL=NO) olmalı
kill -9 ${parseInt(ss.spid) || 0}

# Windows – orakill <ORACLE_SID> <THREAD_ID (=SPID)>
orakill ${ss.oraSid || 'ORCL'} ${parseInt(ss.spid) || 0}`);
      const sessMass = computed(() => {
        const u = oraLit((ss.username || '').toUpperCase());
        return `-- ${ss.username || 'KULLANICI'} kullanıcısının TÜM oturumları için kill komutu üret (önce gözden geçirin)
SELECT 'ALTER SYSTEM KILL SESSION ''' || sid || ',' || serial# || ',@' || inst_id || ''' IMMEDIATE;' AS cmd
FROM gv$session
WHERE username = ${u} AND type = 'USER';

-- Doğrudan çalıştır (dikkat!)
BEGIN
  FOR s IN (SELECT sid, serial#, inst_id FROM gv$session WHERE username = ${u} AND type = 'USER') LOOP
    EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.serial# || ',@' || s.inst_id || ''' IMMEDIATE';
  END LOOP;
END;
/

-- 1 saattir INACTIVE olanları listele
SELECT inst_id, sid, serial#, username, machine, program, ROUND(last_call_et/60) AS idle_min
FROM gv$session
WHERE type = 'USER' AND status = 'INACTIVE' AND last_call_et > 3600
ORDER BY last_call_et DESC;`;
      });

      // ==============================================================
      // 6. DIAGNOSTIC QUERIES
      // ==============================================================
      const qcats = [['lock', '🔒 Kilit'], ['perf', '🚀 Performans'], ['storage', '💾 Alan'], ['backup', '🛟 Yedek & DG'], ['maint', '🧰 Bakım & Genel']];
      const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
      const queries = [
        { id: 'blocking_tree', cat: 'lock', ver: '11g+ / RAC', title: 'Kilit ağacı (root blocker → bekleyenler)',
          desc: 'Kök kilitleyiciden başlayarak bekleyen oturumları girintili ağaç olarak gösterir; RAC instance farkını dikkate alır.',
          tip: 'Ağacın en üstündeki oturum genelde INACTIVE ve commit etmeyi unutmuş bir uygulamadır. Kill etmeden önce `sql_id` ve `machine` bilgisiyle sahibine ulaşın.',
          sql: `WITH s AS (
  SELECT inst_id, sid, serial#, username, status, event, seconds_in_wait,
         sql_id, machine, program, blocking_instance, blocking_session
  FROM gv$session
)
SELECT LPAD(' ', 3 * (LEVEL - 1)) || s.inst_id || ':' || s.sid AS session_tree,
       s.serial#, s.username, s.status, s.event,
       s.seconds_in_wait AS wait_sec, s.sql_id, s.machine, s.program
FROM s
START WITH s.blocking_session IS NULL
       AND (s.inst_id, s.sid) IN (SELECT blocking_instance, blocking_session
                                  FROM gv$session WHERE blocking_session IS NOT NULL)
CONNECT BY PRIOR s.sid = s.blocking_session
       AND PRIOR s.inst_id = s.blocking_instance
ORDER SIBLINGS BY s.seconds_in_wait DESC;` },
        { id: 'locked_objects', cat: 'lock', ver: '11g+', title: 'Kilitli nesneler ve kilit modları',
          desc: 'Hangi oturum hangi tabloyu hangi modda kilitliyor (Row-X, Exclusive…).',
          tip: 'Mode 6 (Exclusive) genelde DDL veya `LOCK TABLE`; mode 3 (Row-X) DML\'dir.',
          sql: `SELECT lo.inst_id, lo.session_id AS sid, s.serial#, lo.oracle_username, lo.os_user_name,
       o.owner, o.object_name, o.object_type,
       DECODE(lo.locked_mode, 0, 'None', 1, 'Null', 2, 'Row-S (SS)', 3, 'Row-X (SX)',
                              4, 'Share', 5, 'S/Row-X (SSX)', 6, 'Exclusive') AS lock_mode,
       s.status, s.sql_id, s.last_call_et AS sec_since_last_call
FROM gv$locked_object lo
JOIN dba_objects o ON o.object_id = lo.object_id
JOIN gv$session s ON s.sid = lo.session_id AND s.inst_id = lo.inst_id
ORDER BY o.owner, o.object_name;` },
        { id: 'active_sessions', cat: 'perf', ver: '11g+', title: 'Aktif kullanıcı oturumları ve bekledikleri olay',
          desc: 'Şu an çalışan oturumları ne kadar süredir aktif olduklarına göre sıralar.',
          sql: `SELECT s.inst_id, s.sid, s.serial#, s.username, s.sql_id, s.event, s.wait_class,
       s.last_call_et AS active_sec, s.machine, s.program, s.module
FROM gv$session s
WHERE s.type = 'USER'
  AND s.status = 'ACTIVE'
  AND s.username IS NOT NULL
  AND s.sid <> SYS_CONTEXT('USERENV', 'SID')
ORDER BY s.last_call_et DESC;` },
        { id: 'top_sql', cat: 'perf', ver: '11g+', title: 'En çok süre harcayan Top 15 SQL (shared pool)',
          desc: 'Toplam elapsed, CPU ve çalıştırma başına süreyle sistemi en çok yoran SQL\'ler.',
          tip: 'Yüksek `buffer_gets / executions` → kötü plan veya eksik indeks. Planı görmek için "SQL planı" sorgusunu kullanın.',
          sql: `SELECT * FROM (
  SELECT sql_id, parsing_schema_name AS schema_name, executions,
         ROUND(elapsed_time / 1e6, 1) AS elapsed_s,
         ROUND(cpu_time / 1e6, 1) AS cpu_s,
         ROUND(elapsed_time / 1e3 / NULLIF(executions, 0), 2) AS avg_ms,
         buffer_gets, disk_reads,
         ROUND(buffer_gets / NULLIF(executions, 0)) AS gets_per_exec,
         SUBSTR(sql_text, 1, 120) AS sql_text
  FROM v$sqlarea
  WHERE executions > 0
  ORDER BY elapsed_time DESC
) WHERE ROWNUM <= 15;` },
        { id: 'sql_plan', cat: 'perf', ver: '11g+', title: 'SQL_ID için gerçek çalışma planı',
          desc: 'Cursor cache\'teki son çalışmanın planını gerçek satır sayılarıyla gösterir.',
          tip: 'Gerçek satır sayılarını (A-Rows) görmek için sorguyu `/*+ GATHER_PLAN_STATISTICS */` ipucuyla çalıştırın veya `STATISTICS_LEVEL=ALL` yapın.',
          sql: `-- SQL*Plus &sql_id değerini sorar
SELECT *
FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('&sql_id', NULL, 'ALLSTATS LAST +PEEKED_BINDS +OUTLINE'));

-- AWR'daki geçmiş planlar (Diagnostics Pack lisansı gerekir)
-- SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('&sql_id'));` },
        { id: 'top_waits', cat: 'perf', ver: '11g+', title: 'Instance açılışından beri en büyük bekleme olayları',
          desc: 'Idle sınıfı hariç toplam bekleme süresi en yüksek 15 olay.',
          tip: '`db file sequential read` → indeks/tek blok I/O, `log file sync` → commit/redo diski, `enq: TX - row lock contention` → uygulama kilidi.',
          sql: `SELECT * FROM (
  SELECT event, wait_class, total_waits,
         ROUND(time_waited_micro / 1e6) AS time_waited_s,
         ROUND(time_waited_micro / NULLIF(total_waits, 0) / 1000, 2) AS avg_ms
  FROM v$system_event
  WHERE wait_class <> 'Idle'
  ORDER BY time_waited_micro DESC
) WHERE ROWNUM <= 15;` },
        { id: 'ash_30min', cat: 'perf', ver: '11g+ · Diag Pack', title: 'Son 30 dakikanın ASH özeti (SQL + olay)',
          desc: 'Active Session History örneklerinden son yarım saatte en çok zaman harcayan SQL/olay çiftleri.',
          tip: 'ASH sorgulamak **Diagnostics Pack** lisansı ister. Lisans yoksa `gv$session` örneklemesi yapın.',
          sql: `SELECT * FROM (
  SELECT sql_id, NVL(event, 'ON CPU') AS event, COUNT(*) AS samples,
         ROUND(100 * RATIO_TO_REPORT(COUNT(*)) OVER (), 1) AS pct
  FROM gv$active_session_history
  WHERE sample_time > SYSTIMESTAMP - INTERVAL '30' MINUTE
  GROUP BY sql_id, NVL(event, 'ON CPU')
  ORDER BY samples DESC
) WHERE ROWNUM <= 20;` },
        { id: 'longops', cat: 'perf', ver: '11g+', title: 'Uzun süren işlemler ve tahmini bitiş',
          desc: 'Full scan, index rebuild, RMAN, Data Pump gibi işlemlerin yüzdesi ve kalan süresi.',
          sql: `SELECT sl.inst_id, sl.sid, sl.serial#, sl.username, sl.opname, sl.target,
       ROUND(sl.sofar / NULLIF(sl.totalwork, 0) * 100, 1) AS pct_done,
       ROUND(sl.elapsed_seconds / 60, 1) AS elapsed_min,
       ROUND(sl.time_remaining / 60, 1) AS remaining_min,
       sl.message
FROM gv$session_longops sl
WHERE sl.time_remaining > 0
ORDER BY sl.time_remaining DESC;` },
        { id: 'stale_stats', cat: 'perf', ver: '12c+', title: 'Bayat (stale) istatistikli tablolar',
          desc: 'Optimizer\'ın yanlış plan seçmesine yol açabilecek güncel olmayan istatistikler.',
          sql: `SELECT owner, table_name, partition_name, num_rows, last_analyzed, stale_stats
FROM dba_tab_statistics
WHERE stale_stats = 'YES'
  AND owner NOT IN (SELECT username FROM dba_users WHERE oracle_maintained = 'Y')
ORDER BY owner, table_name;

-- Toplamak için:
-- EXEC DBMS_STATS.GATHER_SCHEMA_STATS(ownname => 'HR', options => 'GATHER STALE', cascade => TRUE, degree => 4);` },
        { id: 'ts_usage', cat: 'storage', ver: '11g+', title: 'Tablespace doluluğu (autoextend MAXSIZE\'a göre)',
          desc: 'Hem mevcut boyuta hem de autoextend ile ulaşılabilecek maksimuma göre doluluk yüzdesi.',
          tip: 'Alarm için `pct_of_max` sütununa bakın: dosya büyüyebiliyorsa `pct_of_size` %99 olsa da sorun olmayabilir.',
          sql: `SELECT df.tablespace_name,
       ROUND(df.bytes / 1024 / 1024 / 1024, 2) AS size_gb,
       ROUND((df.bytes - NVL(fs.bytes, 0)) / 1024 / 1024 / 1024, 2) AS used_gb,
       ROUND(df.maxbytes / 1024 / 1024 / 1024, 2) AS max_gb,
       ROUND(100 * (df.bytes - NVL(fs.bytes, 0)) / df.bytes, 1) AS pct_of_size,
       ROUND(100 * (df.bytes - NVL(fs.bytes, 0)) / df.maxbytes, 1) AS pct_of_max
FROM (SELECT tablespace_name, SUM(bytes) AS bytes,
             SUM(GREATEST(bytes, DECODE(autoextensible, 'YES', maxbytes, bytes))) AS maxbytes
      FROM dba_data_files
      GROUP BY tablespace_name) df
LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS bytes
           FROM dba_free_space
           GROUP BY tablespace_name) fs
       ON fs.tablespace_name = df.tablespace_name
ORDER BY pct_of_max DESC;` },
        { id: 'temp_usage', cat: 'storage', ver: '11g+', title: 'TEMP kullanımı: kim ne kadar tüketiyor?',
          desc: 'ORA-01652 anında TEMP\'i dolduran oturumlar (gerçek blok boyutuyla) ve toplam boş alan.',
          sql: `SELECT s.inst_id, s.sid, s.serial#, s.username, s.program, u.tablespace, u.segtype,
       ROUND(u.blocks * t.block_size / 1024 / 1024, 1) AS temp_mb, u.sql_id
FROM gv$tempseg_usage u
JOIN gv$session s ON s.saddr = u.session_addr AND s.inst_id = u.inst_id
JOIN dba_tablespaces t ON t.tablespace_name = u.tablespace
ORDER BY u.blocks DESC;

SELECT tablespace_name,
       ROUND(tablespace_size / 1024 / 1024) AS size_mb,
       ROUND(allocated_space / 1024 / 1024) AS allocated_mb,
       ROUND(free_space / 1024 / 1024) AS free_mb
FROM dba_temp_free_space;` },
        { id: 'top_segments', cat: 'storage', ver: '11g+', title: 'En büyük 25 segment',
          desc: 'Alanı en çok kaplayan tablo, indeks ve LOB segmentleri.',
          sql: `SELECT * FROM (
  SELECT owner, segment_name, partition_name, segment_type, tablespace_name,
         ROUND(bytes / 1024 / 1024 / 1024, 2) AS size_gb
  FROM dba_segments
  ORDER BY bytes DESC
) WHERE ROWNUM <= 25;` },
        { id: 'asm_dg', cat: 'storage', ver: 'ASM', title: 'ASM disk grubu doluluğu',
          desc: 'Redundancy dikkate alınarak kullanılabilir alan (USABLE_FILE_MB).',
          tip: '`usable_gb` negatifse disk grubu bir disk kaybını redundancy ile karşılayamaz; acilen disk ekleyin.',
          sql: `SELECT name, type AS redundancy, state,
       ROUND(total_mb / 1024) AS total_gb,
       ROUND(free_mb / 1024) AS free_gb,
       ROUND(usable_file_mb / 1024) AS usable_gb,
       ROUND(100 * (1 - free_mb / NULLIF(total_mb, 0)), 1) AS pct_used
FROM v$asm_diskgroup
ORDER BY name;` },
        { id: 'fra', cat: 'backup', ver: '11gR2+', title: 'FRA (Fast Recovery Area) doluluğu',
          desc: 'Arşiv logları durduran klasik "FRA doldu" (ORA-19809) problemini önceden yakalar.',
          tip: 'Reclaimable alan yüksekse RMAN `DELETE OBSOLETE` ile boşaltılabilir; değilse `DB_RECOVERY_FILE_DEST_SIZE` artırın.',
          sql: `SELECT name,
       ROUND(space_limit / 1024 / 1024 / 1024, 1) AS limit_gb,
       ROUND(space_used / 1024 / 1024 / 1024, 1) AS used_gb,
       ROUND(space_reclaimable / 1024 / 1024 / 1024, 1) AS reclaimable_gb,
       ROUND(100 * (space_used - space_reclaimable) / NULLIF(space_limit, 0), 1) AS real_pct_used,
       number_of_files
FROM v$recovery_file_dest;

SELECT file_type, percent_space_used, percent_space_reclaimable, number_of_files
FROM v$recovery_area_usage
ORDER BY percent_space_used DESC;` },
        { id: 'rman_jobs', cat: 'backup', ver: '11g+', title: 'Son 7 günün RMAN işleri',
          desc: 'FULL / INCR / ARCHIVELOG yedeklerinin durumu, süresi ve boyutu.',
          sql: `SELECT session_key, input_type, status,
       TO_CHAR(start_time, 'YYYY-MM-DD HH24:MI') AS start_time,
       TO_CHAR(end_time, 'YYYY-MM-DD HH24:MI') AS end_time,
       ROUND(elapsed_seconds / 60, 1) AS minutes,
       input_bytes_display AS input_size,
       output_bytes_display AS output_size,
       output_bytes_per_sec_display AS speed
FROM v$rman_backup_job_details
WHERE start_time > SYSDATE - 7
ORDER BY start_time DESC;` },
        { id: 'arch_per_day', cat: 'backup', ver: '11g+', title: 'Günlük arşiv log üretimi (son 14 gün)',
          desc: 'Redo/arşiv hacmindeki ani artışları ve FRA boyutlandırmasını görmek için.',
          sql: `SELECT TRUNC(completion_time) AS day,
       COUNT(*) AS files,
       ROUND(SUM(blocks * block_size) / 1024 / 1024 / 1024, 2) AS gb
FROM v$archived_log
WHERE completion_time > SYSDATE - 14
  AND dest_id = 1
GROUP BY TRUNC(completion_time)
ORDER BY day DESC;` },
        { id: 'log_switch_matrix', cat: 'backup', ver: '11g+', title: 'Saatlik redo log switch matrisi (son 7 gün)',
          desc: 'Saat başına log switch sayısı; saatte 4-6\'nın üzeri redo log dosyalarının küçük olduğunu gösterir.',
          tip: 'Hedef: yoğun saatte 15-20 dakikada bir switch. Sürekli yüksekse redo log gruplarını büyütün.',
          sql: `SELECT TO_CHAR(first_time, 'YYYY-MM-DD') AS day,\n${hours.map(h => `       SUM(DECODE(TO_CHAR(first_time, 'HH24'), '${h}', 1, 0)) AS h${h}`).join(',\n')},\n       COUNT(*) AS total\nFROM v$log_history\nWHERE first_time > TRUNC(SYSDATE) - 7\nGROUP BY TO_CHAR(first_time, 'YYYY-MM-DD')\nORDER BY day DESC;` },
        { id: 'dataguard_lag', cat: 'backup', ver: '11gR2+', title: 'Data Guard transport / apply gecikmesi',
          desc: 'Standby üzerinde gecikme; primary üzerinde hedeflerin hata ve gap durumu.',
          sql: `-- Standby'da:
SELECT name, value, unit, time_computed
FROM v$dataguard_stats
WHERE name IN ('transport lag', 'apply lag', 'apply finish time');

-- Primary'de:
SELECT dest_id, dest_name, status, type, database_mode, recovery_mode, gap_status, error
FROM v$archive_dest_status
WHERE status <> 'INACTIVE';` },
        { id: 'invalid_objects', cat: 'maint', ver: '11g+', title: 'Geçersiz (INVALID) nesneler ve toplu derleme',
          desc: 'Patch/upgrade veya DDL sonrası bozulan paket, view ve trigger\'lar.',
          sql: `SELECT owner, object_type, COUNT(*) AS cnt
FROM dba_objects
WHERE status = 'INVALID'
GROUP BY owner, object_type
ORDER BY owner, object_type;

-- Tek şemayı derle:
-- EXEC DBMS_UTILITY.COMPILE_SCHEMA(schema => 'HR', compile_all => FALSE);

-- Tüm veritabanı (SYSDBA ile SQL*Plus):
-- @?/rdbms/admin/utlrp.sql` },
        { id: 'expiring_users', cat: 'maint', ver: '12c+', title: 'Şifresi dolmak üzere olan / kilitli hesaplar',
          desc: '30 gün içinde süresi dolacak veya OPEN olmayan uygulama hesapları.',
          sql: `SELECT username, account_status, expiry_date, lock_date, profile, last_login
FROM dba_users
WHERE oracle_maintained = 'N'
  AND (expiry_date < SYSDATE + 30 OR account_status <> 'OPEN')
ORDER BY expiry_date NULLS LAST;` },
        { id: 'undo_usage', cat: 'maint', ver: '11g+', title: 'UNDO kullanımı ve ORA-01555 sayısı',
          desc: 'Undo extent durumları (ACTIVE / UNEXPIRED / EXPIRED) ve son 24 saatte snapshot too old hataları.',
          sql: `SELECT tablespace_name, status, ROUND(SUM(bytes) / 1024 / 1024) AS mb, COUNT(*) AS extents
FROM dba_undo_extents
GROUP BY tablespace_name, status
ORDER BY 1, 2;

SELECT MAX(maxquerylen) AS longest_query_sec,
       SUM(ssolderrcnt) AS ora_01555_count,
       SUM(nospaceerrcnt) AS no_space_errors
FROM v$undostat
WHERE begin_time > SYSDATE - 1;` },
        { id: 'db_info', cat: 'maint', ver: '12c+', title: 'Veritabanı ve instance özeti',
          desc: 'Rol, açılış modu, archivelog, force logging, CDB, sürüm ve uptime tek satırda.',
          sql: `SELECT d.name, d.db_unique_name, d.database_role, d.open_mode, d.log_mode,
       d.force_logging, d.flashback_on, d.cdb,
       i.instance_name, i.host_name, i.version, i.startup_time,
       ROUND(SYSDATE - i.startup_time, 1) AS uptime_days
FROM v$database d
CROSS JOIN v$instance i;

SELECT con_id, name, open_mode, restricted FROM v$pdbs ORDER BY con_id;` },
        { id: 'nondefault_params', cat: 'maint', ver: '11g+', title: 'Varsayılan dışı parametreler',
          desc: 'Instance\'ta elle değiştirilmiş tüm init parametreleri.',
          sql: `SELECT name, value, ismodified, issys_modifiable
FROM v$parameter
WHERE isdefault = 'FALSE'
ORDER BY name;` },
        { id: 'alert_errors', cat: 'maint', ver: '12c+', title: 'Alert log\'daki son 24 saatin ORA- hataları',
          desc: 'Sunucuya bağlanmadan alert log\'u SQL ile tarar.',
          tip: '`v$diag_alert_ext` büyük alert log\'larda yavaş olabilir; zaman filtresini dar tutun.',
          sql: `SELECT originating_timestamp, message_text
FROM v$diag_alert_ext
WHERE originating_timestamp > SYSTIMESTAMP - INTERVAL '1' DAY
  AND message_text LIKE '%ORA-%'
ORDER BY originating_timestamp DESC;` }
      ];

      // ==============================================================
      // 7. TNS & CONNECTION
      // ==============================================================
      const [tn, resetTn] = persisted('ora.tns', {
        hosts: 'db-scan.company.local', port: '1521', service: 'ORCLPDB1', idType: 'service', alias: 'PROD_DB',
        protocol: 'TCP', server: 'DEDICATED', failover: true, timeouts: true, user: 'app_user'
      });
      const tnsOut = computed(() => {
        const t = tn;
        const hosts = list(t.hosts);
        const hs = hosts.length ? hosts : ['localhost'];
        const port = parseInt(t.port) || 1521;
        const multi = hs.length > 1;
        const cd = t.idType === 'sid' ? `(SID = ${t.service})` : `(SERVICE_NAME = ${t.service})`;
        const addr = hs.map(h => `      (ADDRESS = (PROTOCOL = ${t.protocol})(HOST = ${h})(PORT = ${port}))`).join('\n');
        const tnsEntry = `${(t.alias || 'PROD_DB').toUpperCase()} =
  (DESCRIPTION =${t.timeouts ? '\n    (CONNECT_TIMEOUT = 5)(TRANSPORT_CONNECT_TIMEOUT = 3)(RETRY_COUNT = 3)' : ''}
    (ADDRESS_LIST =${multi && t.failover ? '\n      (LOAD_BALANCE = ON)(FAILOVER = ON)' : ''}
${addr}
    )
    (CONNECT_DATA =
      (SERVER = ${t.server})
      ${cd}
    )
  )`;
        const oneLine = `(DESCRIPTION=${t.timeouts ? '(CONNECT_TIMEOUT=5)(RETRY_COUNT=3)' : ''}(ADDRESS_LIST=${multi && t.failover ? '(LOAD_BALANCE=ON)(FAILOVER=ON)' : ''}${hs.map(h => `(ADDRESS=(PROTOCOL=${t.protocol})(HOST=${h})(PORT=${port}))`).join('')})(CONNECT_DATA=(SERVER=${t.server})${cd.replace(/\s/g, '')}))`;
        const ez = t.idType === 'sid' ? null : `${t.protocol === 'TCPS' ? 'tcps://' : ''}${hs.join(',')}:${port}/${t.service}`;
        const notes = [];
        if (t.idType === 'sid') notes.push(['info', 'SID ile Easy Connect kullanılamaz; tnsnames veya tam descriptor kullanın. Mümkünse SERVICE_NAME\'e geçin (PDB\'ler servisle açılır).']);
        if (t.protocol === 'TCPS') notes.push(['info', 'TCPS için istemcide wallet (`WALLET_LOCATION` / `MY_WALLET_DIRECTORY`) ve sunucu sertifikası tanımlı olmalı.']);
        if (multi && ez) notes.push(['tip', 'Çoklu host Easy Connect (EZConnect Plus) 19c+ istemci gerektirir.']);
        const ezc = `# Easy Connect\n${ez || '-- SID ile kullanılamaz'}\n\n# SQL*Plus (şifreyi sorar)\nsqlplus ${t.user}@"${ez || t.alias}"\n\n# tnsnames.ora tanımıyla\nsqlplus ${t.user}@${(t.alias || 'PROD_DB').toUpperCase()}\ntnsping ${(t.alias || 'PROD_DB').toUpperCase()}`;
        const jdbc = !multi && t.idType === 'service' && t.protocol === 'TCP'
          ? `jdbc:oracle:thin:@//${hs[0]}:${port}/${t.service}`
          : !multi && t.idType === 'sid' ? `jdbc:oracle:thin:@${hs[0]}:${port}:${t.service}` : `jdbc:oracle:thin:@${oneLine}`;
        const py = `# pip install oracledb   (thin mod: Instant Client gerekmez)
import getpass
import oracledb

conn = oracledb.connect(
    user="${t.user}",
    password=getpass.getpass("Şifre: "),
    dsn="${ez || oneLine}",
)
with conn.cursor() as cur:
    cur.execute("SELECT banner_full FROM v$version")
    print(cur.fetchone()[0])`;
        const net = `// ODP.NET Managed Driver
"User Id=${t.user};Password=<şifre>;Data Source=${ez || oneLine};Connection Timeout=15;"`;
        return { tnsEntry, ezc, jdbc, py, net, notes };
      });

      // ==============================================================
      // 8. MEMORY
      // ==============================================================
      const [mem, resetMem] = persisted('ora.mem', {
        ramGb: 64, oraPct: 80, workload: 'oltp', processes: 1000, hugepages: true, fromAmm: false, instances: 1
      });
      const memOut = computed(() => {
        const m = mem, notes = [];
        const ram = Math.max(1, parseFloat(m.ramGb) || 1);
        const inst = Math.max(1, parseInt(m.instances) || 1);
        const oraMB = Math.floor(ram * 1024 * (m.oraPct / 100) / inst);
        const sgaShare = m.workload === 'oltp' ? 0.8 : 0.5;
        const round = (mb, step) => Math.max(step, Math.floor(mb / step) * step);
        const step = oraMB >= 8192 ? 512 : 128;
        const sgaMB = round(oraMB * sgaShare, step);
        const pgaMB = round(oraMB - sgaMB, step === 512 ? 256 : 64);
        const procs = Math.max(50, parseInt(m.processes) || 300);
        const pgaLimitMB = Math.max(2048, pgaMB * 2, procs * 3);
        const pages = Math.ceil(sgaMB / 2) + 10 * inst; // 2MB sayfa + küçük pay
        const memlockKB = Math.ceil(ram * 1024 * 1024 * 0.9);
        if (oraMB < 2048) notes.push(['warn', 'Oracle\'a ayrılan bellek 2 GB\'ın altında; üretim için yetersiz olabilir.']);
        if (pgaLimitMB > oraMB) notes.push(['warn', `PGA_AGGREGATE_LIMIT (${pgaLimitMB} MB) Oracle'a ayrılan bellekten büyük çıktı; PROCESSES değeri (${procs}) RAM'e göre yüksek olabilir.`]);
        if (m.hugepages) notes.push(['info', 'HugePages, AMM (`MEMORY_TARGET`) ile birlikte çalışmaz; ASMM (SGA_TARGET + PGA_AGGREGATE_TARGET) kullanın.']);
        notes.push(['tip', 'Bu değerler başlangıç noktasıdır. Canlıda `V$SGA_TARGET_ADVICE` ve `V$PGA_TARGET_ADVICE` ile ince ayar yapın.']);
        const sql = `-- Oracle bellek ayarları (SYSDBA) – ${ram} GB RAM, ${m.workload.toUpperCase()}, ${inst} instance
-- Statik parametreler SPFILE'a yazılır; sonra kontrollü restart gerekir.
${m.fromAmm ? "ALTER SYSTEM SET memory_target = 0 SCOPE = SPFILE;\nALTER SYSTEM SET memory_max_target = 0 SCOPE = SPFILE;\n" : ''}ALTER SYSTEM SET sga_max_size = ${sgaMB}M SCOPE = SPFILE;
ALTER SYSTEM SET sga_target = ${sgaMB}M SCOPE = SPFILE;
ALTER SYSTEM SET pga_aggregate_target = ${pgaMB}M SCOPE = BOTH;
ALTER SYSTEM SET pga_aggregate_limit = ${pgaLimitMB}M SCOPE = BOTH;  -- 12c+
ALTER SYSTEM SET processes = ${procs} SCOPE = SPFILE;
${m.hugepages ? "ALTER SYSTEM SET use_large_pages = 'ONLY' SCOPE = SPFILE;  -- HugePages yoksa instance açılmaz\n" : ''}
-- Restart (RAC'ta: srvctl stop/start database -d <db>)
SHUTDOWN IMMEDIATE;
STARTUP;

-- Kontrol
SHOW PARAMETER sga_target
SHOW PARAMETER pga_aggregate
SELECT name, ROUND(bytes / 1024 / 1024) AS mb FROM v$sgainfo ORDER BY bytes DESC;`;
        const huge = `# /etc/sysctl.d/97-oracle-hugepages.conf  (2 MB Hugepagesize varsayımıyla)
vm.nr_hugepages = ${pages * inst}
# Uygula: sysctl --system   veya   sysctl -p /etc/sysctl.d/97-oracle-hugepages.conf

# /etc/security/limits.d/99-oracle-memlock.conf  (KB, RAM'in ~%90'ı)
oracle soft memlock ${memlockKB}
oracle hard memlock ${memlockKB}

# Transparent HugePages KAPALI olmalı (Oracle önerisi) – /etc/default/grub:
#   GRUB_CMDLINE_LINUX="... transparent_hugepage=never"
cat /sys/kernel/mm/transparent_hugepage/enabled

# Instance açıldıktan sonra doğrula: HugePages_Free düşmeli
grep -i huge /proc/meminfo`;
        return { oraMB, sgaMB, pgaMB, pgaLimitMB, pages: pages * inst, sql, huge, notes, osMB: Math.round(ram * 1024 - oraMB * inst) };
      });

      return {
        modules, tab,
        dp, resetDp, dpOut, dpHelper,
        rm, resetRm, rmOut,
        usr, resetUsr, usrOut, regenPwd,
        st, resetSt, stOut, hwmSql,
        ss, resetSs, sessFind, sessKill, sessOs, sessMass,
        qcats, queries,
        tn, resetTn, tnsOut,
        mem, resetMem, memOut
      };
    }
  });
})();
