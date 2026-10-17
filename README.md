# DBA Cockpit

Oracle, PostgreSQL ve SQL Server DBA'leri için tek sitede toplanmış, **tamamen istemci taraflı** komut üretici ve teşhis kokpiti.

- **Oracle** (`/oracle/`): Data Pump parfile, RMAN betikleri, kullanıcı & yetki (PDB / C## common), tablespace & datafile, oturum kill, 24 teşhis sorgusu, TNS / JDBC / python-oracledb, SGA / PGA / HugePages.
- **PostgreSQL** (`/postgres/`): pg_dump / pg_restore / pg_dumpall / pg_basebackup, rol & default privileges, CREATE DATABASE, autovacuum & VACUUM, oturum yönetimi, teşhis sorguları, URI / pgpass / pg_hba / PgBouncer, PGTune.
- **SQL Server** (`/sqlserver/`): BACKUP / RESTORE (point-in-time) / BCP, login & yetki, dosya / shrink / TempDB / CHECKDB, KILL helper, DMV sorguları, bağlantı cümleleri, max server memory & MAXDOP.
- **Ana sayfa**: motorlar arası karşılaştırma tablosu (aynı işin üç motordaki karşılığı).

## Önceki sürümlere göre neler değişti?

Üç ayrı sayfa (`oracle-dba-cockpit`, `postgres-dba-cockpit`, `sql-server-dba-cockpit`) tek siteye taşındı ve ortak bir altyapıya geçirildi:

- Ortak tasarım, açık/koyu tema, mobil uyum, URL ile modüle doğrudan bağlantı (`oracle/#rman`).
- Tüm kod kutularında sözdizimi renklendirme, kopyalama ve dosya olarak indirme.
- Uyumsuz seçenekler artık sessizce hatalı komut üretmiyor; uyarı kutularıyla açıklanıyor.
- Form tercihleri bu tarayıcıda hatırlanır (şifreler hariç).
- Şifreler `crypto.getRandomValues` ile, modulo sapması olmadan üretilir.
- Tailwind Play CDN kaldırıldı; Vue sürümü sabitlendi (`3.4.38`).

Düzeltilen hatalardan bazıları:

| Motor | Eski davranış | Yeni |
|---|---|---|
| Oracle | `impdp` komutuna `COMPRESSION=ALL` ekleniyordu | Sadece expdp'de, lisans uyarısıyla |
| Oracle | `MAXSIZE 32G` (ORA-03206) ve "Özel değer" seçilince `MAXSIZE CUSTOM` | `32767M`, gerçek özel değer, blok boyutuna göre kontrol |
| Oracle | `SGA_TARGET ... SCOPE=BOTH` (sga_max_size'dan büyükse hata) | SPFILE + kontrollü restart, PGA_AGGREGATE_LIMIT eklendi |
| PostgreSQL | `pg_restore -j` + `--single-transaction`, `pg_restore -Fp`, `-c` + `-a` | Çakışmalar engelleniyor, plain dump için `psql` üretiliyor |
| PostgreSQL | `VACUUM (FULL, PARALLEL n)` | PARALLEL FULL ile birlikte kullanılmıyor |
| PostgreSQL | `CREATE DATABASE` locale ile `template1` | `template0` |
| SQL Server | RESTORE, hedef DB yokken `SET SINGLE_USER` ile hata veriyordu | `IF DB_ID(...) IS NOT NULL` koruması, NORECOVERY sonrası MULTI_USER yok |
| SQL Server | `MUST_CHANGE` seçeneği hiç kullanılmıyordu, `OBJECT::[dbo.usp]` | Doğru söz dizimi, `[dbo].[usp]` |
| SQL Server | Blocking sorgusu uyuyan (sleeping) head blocker'ı kaçırıyordu | `most_recent_sql_handle` ile head blocker tespiti |

## Yerelde çalıştırma

```bash
python -m http.server 8000
```

Sonra `http://localhost:8000` adresini açın. (İnternet bağlantısı Vue ve fontlar için gerekir.)

## Güvenlik

Backend, analitik veya telemetri yoktur. Üretilen komutları canlıya uygulamadan önce test ortamında doğrulayın.

MIT Lisansı.
