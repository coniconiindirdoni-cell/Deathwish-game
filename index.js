// ╔══════════════════════════════════════════════════════════════╗
// ║         DeathWish Game Bot — TEK DOSYA                      ║
// ║  Özellikler: Seviye/XP, Ekonomi, Ses Takibi, Sohbet,       ║
// ║  Yazı Oyunu, Market, Evlilik, Balıkçılık, Blackjack,        ║
// ║  At Yarışı, Renk Rolleri, Gelişmiş Backup & Log             ║
// ║  Tüm komutlar SLASH (/) komutu                              ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  Gerekli paketler (npm install):                             ║
// ║    discord.js  better-sqlite3  express  archiver             ║
// ║    @octokit/rest  dotenv  adm-zip                            ║
// ║  adm-zip yalnızca /veriyukle (restore) için gereklidir.     ║
// ╚══════════════════════════════════════════════════════════════╝

require('dotenv').config();
const {
  Client, GatewayIntentBits, Collection, ActivityType, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  SlashCommandBuilder, PermissionFlagsBits, ComponentType, ChannelType,
} = require('discord.js');
const Database = require('better-sqlite3');
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');
const { Octokit } = require('@octokit/rest');

// ──────────────────────────────────────────────────────────────
//  AYARLAR
// ──────────────────────────────────────────────────────────────
const TOKEN  = process.env.DISCORD_TOKEN || '';
const OWNERS = (process.env.OWNERS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT   = process.env.PORT || 3000;

// GitHub yedekleme ayarları (/verikaydet komutu için)
const GITHUB_OWNER   = process.env.GITHUB_OWNER || '';
const GITHUB_REPO    = process.env.GITHUB_REPO  || '';
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN  || '';
// ⚠️ KRİTİK: Bu branch'e atılan HER commit, Render/Railway gibi platformlarda
// "Auto-Deploy" kuruluysa YENİ BİR DEPLOY tetikler. Eğer GITHUB_OWNER/GITHUB_REPO
// botun kaynak kodunun bulunduğu repo ise ve BACKUP_BRANCH o deploy'un izlediği
// branch (genelde "main") ile AYNIYSA, backup -> yeni commit -> yeni deploy ->
// bot yeniden başlar -> (kalıcı disk yoksa) veritabanı sıfırlanır -> boş DB
// otomatik geri yükleme tetikler -> o da yeni bir backup commit atar -> sonsuz
// döngü oluşur. Bu yüzden varsayılanı bilerek "main" DEĞİL, ayrı bir branch
// yaptık. Yine de en güvenlisi: GITHUB_REPO'yu botun kaynak koduyla PAYLAŞMAYAN,
// yalnızca yedekler için ayrılmış ayrı bir repo yapmaktır.
const BACKUP_BRANCH  = process.env.BACKUP_BRANCH || 'data-backups';
if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO && (BACKUP_BRANCH === 'main' || BACKUP_BRANCH === 'master')) {
  console.warn(
    `⚠️⚠️⚠️ DİKKAT: BACKUP_BRANCH="${BACKUP_BRANCH}" olarak ayarlı. Eğer barındırma ` +
    `platformunuz (Render/Railway/vb.) bu repodaki "${BACKUP_BRANCH}" branch'ini Auto-Deploy ` +
    `için izliyorsa, her otomatik yedek yeni bir deploy tetikleyip botu yeniden başlatır ve ` +
    `(kalıcı disk yoksa) TÜM VERİYİ SIFIRLAR. Ayrı bir backup branch/repo kullanın ve ` +
    `barındırma platformunda Auto-Deploy'un yalnızca kod branch'ini izlediğinden emin olun.`
  );
}
const octokit = GITHUB_TOKEN ? new Octokit({ auth: GITHUB_TOKEN }) : null;

// Bu role sahip olan herkes owner-only komutları da kullanabilir.
const OWNER_ROLE_ID = '1525831115972284587';
function hasOwnerAccess(userId, member) {
  if (OWNERS.includes(userId)) return true;
  if (member && member.roles && member.roles.cache && member.roles.cache.has(OWNER_ROLE_ID)) return true;
  return false;
}

// Tüm komutların çalışacağı tek kanal (ownerlar hariç her yerde kısıtlı)
const GAME_CHANNEL_ID = '1525046495127011388';

if (!TOKEN) { console.error('⛔ DISCORD_TOKEN bulunamadı!'); process.exit(1); }

// ──────────────────────────────────────────────────────────────
//  WEB SUNUCUSU (keepalive)
// ──────────────────────────────────────────────────────────────
const app = express();
app.get('/', (_, res) => res.send('DeathWish Game Bot aktif! 🔥'));
app.listen(PORT, () => console.log(`🌐 Web sunucusu: ${PORT}`));

// ──────────────────────────────────────────────────────────────
//  VERİTABANI (SQLite — lokal dosya)
// ──────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'deathwish-game.db');
let db;

// Tabloları (yoksa) oluşturur ve eski şemaları yeni kolonlarla tamamlar.
// initDatabase() içinde İLK açılışta, ayrıca restoreFromGithub() içinde HER
// geri yüklemeden SONRA da çağrılır — çünkü GitHub'daki bir yedek, botun en
// güncel kod sürümünden ÖNCE alınmış olabilir ve yeni tablo/kolonları
// (ör. bank_accounts, fish_cast_state, temp_xp_boosts.usesLeft) içermeyebilir.
// Bu çağrılmazsa, eski bir yedek geri yüklendiğinde yeni özellikler
// "no such table/column" hatasıyla kırılır.
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (guildId TEXT, key TEXT, value TEXT, PRIMARY KEY(guildId,key));
    CREATE TABLE IF NOT EXISTS economy (guildId TEXT, userId TEXT, balance INTEGER DEFAULT 0, bank INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS marriages (guildId TEXT, user1 TEXT, user2 TEXT, marriedAt TEXT, PRIMARY KEY(guildId,user1));
    CREATE TABLE IF NOT EXISTS rings (guildId TEXT, userId TEXT, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS voice_time (guildId TEXT, userId TEXT, totalSeconds INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS daily_claims (guildId TEXT, userId TEXT, date TEXT, claimType TEXT, PRIMARY KEY(guildId,userId,date,claimType));
    CREATE TABLE IF NOT EXISTS daily_counts (guildId TEXT, userId TEXT, date TEXT, claimType TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId,date,claimType));
    CREATE TABLE IF NOT EXISTS xp_boosts (guildId TEXT, userId TEXT, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS message_counts (guildId TEXT, channelId TEXT, userId TEXT, date TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(guildId,channelId,userId,date));
    CREATE TABLE IF NOT EXISTS market_roles (guildId TEXT, roleId TEXT, price INTEGER, isPremium INTEGER DEFAULT 0, PRIMARY KEY(guildId,roleId));
    CREATE TABLE IF NOT EXISTS level_data (guildId TEXT, userId TEXT, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));

    -- ── Yeni özellikler ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS theft_shields (guildId TEXT, userId TEXT, expiresAt INTEGER, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS temp_xp_boosts (guildId TEXT, userId TEXT, expiresAt INTEGER, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS color_roles (guildId TEXT, roleId TEXT, price INTEGER DEFAULT 50, PRIMARY KEY(guildId,roleId));
    CREATE TABLE IF NOT EXISTS fish_inventory (guildId TEXT, userId TEXT, fishKey TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId,fishKey));
    CREATE TABLE IF NOT EXISTS fish_boosts (guildId TEXT, userId TEXT, usesLeft INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS chat_coin_counter (guildId TEXT, userId TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));

    -- ── /banka sistemi + balıkçılık riskleri ─────────────────
    CREATE TABLE IF NOT EXISTS bank_accounts (guildId TEXT, userId TEXT, createdAt INTEGER, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS fish_cast_state (
      guildId TEXT, userId TEXT,
      sinceLine INTEGER DEFAULT 0, lineThreshold INTEGER DEFAULT 0,
      sinceRod  INTEGER DEFAULT 0, rodThreshold  INTEGER DEFAULT 0,
      sinceEmpty INTEGER DEFAULT 0, emptyThreshold INTEGER DEFAULT 0,
      PRIMARY KEY(guildId,userId)
    );
  `);

  // Boş olta çekme artık sabit bir ihtimalle değil, mısına kopması/olta
  // kırılmasıyla aynı mantıkta bir sayaç+eşik ile çalışıyor (2-10 atışta bir).
  // Eski veritabanlarında bu kolonlar yoksa ekliyoruz.
  const fishCastCols = db.prepare("PRAGMA table_info(fish_cast_state)").all().map(c => c.name);
  if (!fishCastCols.includes('sinceEmpty')) {
    db.exec('ALTER TABLE fish_cast_state ADD COLUMN sinceEmpty INTEGER DEFAULT 0');
  }
  if (!fishCastCols.includes('emptyThreshold')) {
    db.exec('ALTER TABLE fish_cast_state ADD COLUMN emptyThreshold INTEGER DEFAULT 0');
  }

  // Geçici XP Boost artık süreye değil kullanım hakkına dayanıyor.
  // Eski (expiresAt tabanlı) veritabanlarını sorunsuz taşımak için usesLeft kolonunu ekliyoruz.
  const tempBoostCols = db.prepare("PRAGMA table_info(temp_xp_boosts)").all().map(c => c.name);
  if (!tempBoostCols.includes('usesLeft')) {
    db.exec('ALTER TABLE temp_xp_boosts ADD COLUMN usesLeft INTEGER DEFAULT 0');
  }

  // ── Madencilik oyunu tabloları ──────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS mining_data (
      guildId TEXT, userId TEXT,
      miners INTEGER DEFAULT 2,
      miningLevel INTEGER DEFAULT 1,
      miningXp INTEGER DEFAULT 0,
      energyLevel INTEGER DEFAULT 1,
      energyXp INTEGER DEFAULT 0,
      energy INTEGER DEFAULT 20,
      lastEnergyRegen INTEGER DEFAULT 0,
      hungryUntil INTEGER DEFAULT 0,
      workerTier INTEGER DEFAULT 0,
      purchasesInTier INTEGER DEFAULT 0,
      totalOresMined INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId)
    );
    CREATE TABLE IF NOT EXISTS mining_inventory (
      guildId TEXT, userId TEXT, ore TEXT, amount INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, ore)
    );
  `);

  // Yemek sistemi kullanım bazlı hale getirildi — eski DB'lere yeni kolonlar ekleniyor
  const miningCols = db.prepare("PRAGMA table_info(mining_data)").all().map(c => c.name);
  if (!miningCols.includes('breadUses'))              db.exec('ALTER TABLE mining_data ADD COLUMN breadUses INTEGER DEFAULT 0');
  if (!miningCols.includes('soupUses'))               db.exec('ALTER TABLE mining_data ADD COLUMN soupUses INTEGER DEFAULT 0');
  if (!miningCols.includes('meatUses'))               db.exec('ALTER TABLE mining_data ADD COLUMN meatUses INTEGER DEFAULT 0');
  if (!miningCols.includes('energyCapTier'))          db.exec('ALTER TABLE mining_data ADD COLUMN energyCapTier INTEGER DEFAULT 0');
  if (!miningCols.includes('energyCapPurchasesInTier')) db.exec('ALTER TABLE mining_data ADD COLUMN energyCapPurchasesInTier INTEGER DEFAULT 0');
}

function initDatabase() {
  db = new Database(DB_PATH);
  ensureSchema();
  console.log('✅ Veritabanı hazır.');
}

// ──────────────────────────────────────────────────────────────
//  LOG YARDIMCISI
//  sendLog(gid, logType, embed) — ilgili log kanalına embed gönderir
//  logType örnekleri: 'xp', 'level', 'coin', 'economy', 'market',
//  'marriage', 'mission', 'voice', 'chat', 'setup', 'backup',
//  'error', 'slash'
// ──────────────────────────────────────────────────────────────
async function sendLog(gid, logType, embed) {
  try {
    if (!gid) return;
    // Mevcut log_voice_channel ile geriye dönük uyumluluk
    const settingKey = logType === 'voice' ? 'log_voice_channel' : `log_${logType}_channel`;
    const chId = getSetting(gid, settingKey);
    if (!chId) return;
    const guild = client.guilds.cache.get(gid);
    if (!guild) return;
    const ch = guild.channels.cache.get(chId);
    if (ch?.isTextBased?.()) await ch.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}

// ──────────────────────────────────────────────────────────────
//  GITHUB YEDEKLEME
// ──────────────────────────────────────────────────────────────
const BACKUP_MAX_BYTES = 45 * 1024 * 1024;

// Eşzamanlı backup kilidi — aynı anda yalnızca bir backup çalışabilir
let backupInProgress = false;

function zipDatabase() {
  return new Promise((resolve, reject) => {
    const tmpPath = DB_PATH + `.backup-tmp-${Date.now()}.db`;
    db.backup(tmpPath)
      .then(() => {
        if (!fs.existsSync(tmpPath)) return reject(new Error('Geçici yedek dosyası oluşturulamadı.'));
        const chunks = [];
        const archive = archiver('zip', { zlib: { level: 9 } });
        const cleanup = () => fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath);
        archive.on('data', (chunk) => chunks.push(chunk));
        archive.on('error', (err) => { cleanup(); reject(err); });
        archive.on('end', () => { cleanup(); resolve(Buffer.concat(chunks)); });
        archive.file(tmpPath, { name: 'deathwish-game.db' });
        archive.finalize();
      })
      .catch(reject);
  });
}

/**
 * GitHub'a yedek yükler.
 * @param {string} [customLabel] — Commit mesajına eklenecek özel etiket
 * @returns {{ filePath, commitUrl, size, fileName }}
 */
async function backupToGithub(customLabel) {
  if (!octokit)              throw new Error('GITHUB_TOKEN tanımlı değil.');
  if (!GITHUB_OWNER || !GITHUB_REPO) throw new Error('GITHUB_OWNER / GITHUB_REPO tanımlı değil.');
  if (backupInProgress)      throw new Error('Başka bir yedekleme zaten çalışıyor. Lütfen bekleyin.');

  backupInProgress = true;
  const startTime = Date.now();

  try {
    // 5 dakika timeout koruması
    const timeoutPromise = new Promise((_, r) => setTimeout(() => r(new Error('Backup zaman aşımı (5 dakika).')), 5 * 60 * 1000));
    const zipBuffer = await Promise.race([zipDatabase(), timeoutPromise]);

    if (!zipBuffer || zipBuffer.length === 0) throw new Error('ZIP oluşturulamadı (boş buffer).');
    if (zipBuffer.length > BACKUP_MAX_BYTES) throw new Error(`Yedek çok büyük (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB). Güvenli sınır ~45 MB.`);

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const dd   = String(now.getDate()).padStart(2, '0');
    const HH   = String(now.getHours()).padStart(2, '0');
    const MIN  = String(now.getMinutes()).padStart(2, '0');
    const fileName = `${yyyy}-${mm}-${dd}_${HH}-${MIN}.zip`;
    const filePath = `Backups/${yyyy}/${mm}/${fileName}`;
    const label    = customLabel || `${yyyy}-${mm}-${dd} ${HH}:${MIN}`;

    let sha;
    try {
      const existing = await octokit.repos.getContent({
        owner: GITHUB_OWNER, repo: GITHUB_REPO, path: filePath, ref: BACKUP_BRANCH,
      });
      sha = existing.data.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    // GitHub yüklenemezse ZIP silinmez — sadece hata fırlatılır (finally kilidi açar)
    const res = await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: filePath,
      message: `Backup - ${label}`,
      content: zipBuffer.toString('base64'),
      branch: BACKUP_BRANCH,
      ...(sha ? { sha } : {}),
    });

    const duration = Math.round((Date.now() - startTime) / 1000);
    return { filePath, fileName, commitUrl: res.data.commit?.html_url, size: zipBuffer.length, duration };
  } finally {
    // Her durumda kilidi serbest bırak — kayıp finally yok
    backupInProgress = false;
  }
}

/**
 * GitHub'daki Backups/ klasöründeki tüm zip dosyalarını listeler.
 * @returns {Array<{name, path, sha, size, url}>}
 */
async function listBackupsFromGithub() {
  if (!octokit)              throw new Error('GITHUB_TOKEN tanımlı değil.');
  if (!GITHUB_OWNER || !GITHUB_REPO) throw new Error('GITHUB_OWNER / GITHUB_REPO tanımlı değil.');

  // Tüm yılları tara
  let yearDirs = [];
  try {
    const root = await octokit.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: 'Backups', ref: BACKUP_BRANCH });
    yearDirs = Array.isArray(root.data) ? root.data.filter(d => d.type === 'dir') : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }

  const files = [];
  for (const yearDir of yearDirs) {
    let monthDirs = [];
    try {
      const yr = await octokit.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: yearDir.path, ref: BACKUP_BRANCH });
      monthDirs = Array.isArray(yr.data) ? yr.data.filter(d => d.type === 'dir') : [];
    } catch {}
    for (const monthDir of monthDirs) {
      try {
        const mo = await octokit.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: monthDir.path, ref: BACKUP_BRANCH });
        if (Array.isArray(mo.data)) {
          for (const f of mo.data) {
            if (f.type === 'file' && f.name.endsWith('.zip')) {
              files.push({ name: f.name, path: f.path, sha: f.sha, size: f.size, url: f.html_url });
            }
          }
        }
      } catch {}
    }
  }
  // En yeniden en eskiye sırala
  files.sort((a, b) => b.name.localeCompare(a.name));
  return files;
}

/**
 * GitHub'dan seçilen backup'ı indirip DB'yi geri yükler.
 * Restore öncesi otomatik bir yedek alır.
 * @param {string} filePath — GitHub'daki dosya yolu
 */
// En son yedeğin dosya adından (YYYY-MM-DD_HH-MM.zip) tarihini çıkarır.
function parseBackupTimestamp(fileName) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})\.zip$/.exec(fileName);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
}

async function restoreFromGithub(filePath, opts = {}) {
  if (!octokit)              throw new Error('GITHUB_TOKEN tanımlı değil.');
  if (!GITHUB_OWNER || !GITHUB_REPO) throw new Error('GITHUB_OWNER / GITHUB_REPO tanımlı değil.');
  if (backupInProgress)      throw new Error('Şu an başka bir backup/restore işlemi çalışıyor.');

  // Dosya doğrulaması
  if (!filePath.startsWith('Backups/') || !filePath.endsWith('.zip')) {
    throw new Error('Geçersiz backup yolu.');
  }

  // ⚠️ Sonsuz döngü freni: eğer en güncel yedek çok yakın zamanda (ör. son 5
  // dakika içinde) alınmışsa, restore öncesi YENİ bir "pre-restore" yedeği
  // ALMA. Aksi halde şu döngü oluşabilir: boş DB -> restore -> pre-restore
  // backup commit -> (Auto-Deploy varsa) yeni deploy -> restart -> yine boş
  // DB -> restore -> ... Bu kontrol, backup'ın GitHub'a yeni commit atmasını
  // (ve dolayısıyla olası bir Auto-Deploy tetiklenmesini) engelleyerek
  // döngüyü kırar. `opts.skipPreBackup` ile manuel çağrılarda da atlanabilir.
  let shouldPreBackup = opts.skipPreBackup !== true;
  if (shouldPreBackup) {
    try {
      const backups = await listBackupsFromGithub();
      const mostRecent = backups[0];
      const ts = mostRecent ? parseBackupTimestamp(mostRecent.name) : null;
      if (ts && Date.now() - ts < 5 * 60 * 1000) {
        shouldPreBackup = false;
        console.warn('⚠️ En güncel yedek 5 dakikadan daha yeni — döngüyü önlemek için pre-restore yedeği atlanıyor.');
      }
    } catch (checkErr) {
      console.warn('⚠️ Yedek listesi kontrol edilemedi, pre-restore yedeği yine de denenecek:', checkErr.message);
    }
  }

  // Restore öncesi otomatik yedek al (yalnızca yukarıdaki döngü freni izin verirse)
  if (shouldPreBackup) {
    try {
      await backupToGithub('pre-restore otomatik yedek');
    } catch (preErr) {
      console.warn('⚠️ Pre-restore yedek alınamadı:', preErr.message);
      // Pre-restore başarısız olsa bile restore devam eder (kilidi serbest bıraktı)
    }
  }

  backupInProgress = true;
  try {
    // İndir
    const res = await octokit.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: filePath, ref: BACKUP_BRANCH });
    const content = Buffer.from(res.data.content, 'base64');

    // Doğrulama: zip magic bytes
    if (content.length < 4 || content[0] !== 0x50 || content[1] !== 0x4B) {
      throw new Error('İndirilen dosya geçerli bir ZIP değil.');
    }

    // Geçici zip dosyasına yaz
    const tmpZip = DB_PATH + `.restore-tmp-${Date.now()}.zip`;
    fs.writeFileSync(tmpZip, content);

    // Zip'i aç ve DB dosyasını bul
    const AdmZip = (() => {
      try { return require('adm-zip'); } catch { return null; }
    })();

    if (!AdmZip) {
      // adm-zip yoksa ham db'yi yedekten kopyalamayi dene (backup zaten .db içeriyor)
      fs.unlinkSync(tmpZip);
      throw new Error('adm-zip modülü bulunamadı. `npm install adm-zip` çalıştırın.');
    }

    const zip = new AdmZip(tmpZip);
    const dbEntry = zip.getEntry('deathwish-game.db');
    if (!dbEntry) { fs.unlinkSync(tmpZip); throw new Error('ZIP içinde deathwish-game.db bulunamadı.'); }

    // Mevcut DB'yi kapat, yeni dosyayı yaz, yeniden aç
    db.close();
    const tmpDb = DB_PATH + `.old-${Date.now()}.db`;
    fs.renameSync(DB_PATH, tmpDb); // mevcut DB'yi sakla
    try {
      zip.extractEntryTo(dbEntry, path.dirname(DB_PATH), false, true);
      db = new Database(DB_PATH);
      ensureSchema(); // eski bir yedek geri yüklendiyse eksik tablo/kolonları tamamla
    } catch (writeErr) {
      // Başarısız olursa eski DB'yi geri yükle
      fs.renameSync(tmpDb, DB_PATH);
      db = new Database(DB_PATH);
      ensureSchema();
      throw writeErr;
    }
    // Eski backup DB'sini sil
    try { fs.unlinkSync(tmpDb); } catch {}
    try { fs.unlinkSync(tmpZip); } catch {}
  } finally {
    backupInProgress = false;
  }
}

/**
 * GitHub'dan backup dosyasını siler.
 * @param {string} filePath
 * @param {string} sha
 */
async function deleteBackupFromGithub(filePath, sha) {
  if (!octokit)              throw new Error('GITHUB_TOKEN tanımlı değil.');
  if (!GITHUB_OWNER || !GITHUB_REPO) throw new Error('GITHUB_OWNER / GITHUB_REPO tanımlı değil.');
  if (!filePath.startsWith('Backups/') || !filePath.endsWith('.zip')) throw new Error('Geçersiz backup yolu.');

  await octokit.repos.deleteFile({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: filePath,
    message: `Backup silindi: ${path.basename(filePath)}`,
    sha,
    branch: BACKUP_BRANCH,
  });
}

// Otomatik yedekleme aralığı: ENV ile ayarlanabilir, varsayılan 15 dakika.
// NOT: Barındırma ortamı disk üzerinde kalıcılık sağlamıyorsa (ör. her birkaç
// dakikada bir yeniden başlıyorsa), 6 saatlik eski aralık veri kaybını çok
// büyütüyordu — 15 dakikaya indirmek kayıp penceresini önemli ölçüde azaltır.
// Ek olarak aşağıdaki autoRestoreIfEmpty() ile açılışta otomatik kurtarma yapılıyor.
const AUTO_BACKUP_INTERVAL_MS = (parseInt(process.env.AUTO_BACKUP_INTERVAL_MINUTES, 10) || 15) * 60 * 1000;

function startAutoBackup() {
  if (!octokit || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn('⚠️ GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO tanımlı değil, otomatik yedekleme kapalı.');
    return;
  }
  setInterval(async () => {
    try {
      const { filePath } = await backupToGithub('otomatik yedek');
      console.log(`✅ Otomatik yedek alındı: ${filePath}`);
    } catch (err) {
      console.error('⛔ Otomatik yedekleme hatası:', err.message);
    }
  }, AUTO_BACKUP_INTERVAL_MS);
  console.log(`🕒 Otomatik GitHub yedeklemesi başlatıldı (${Math.round(AUTO_BACKUP_INTERVAL_MS / 60000)} dakikada bir).`);
}

/**
 * Açılışta veritabanı "boş" görünüyorsa (ör. barındırma ortamı diski sıfırladıysa)
 * GitHub'daki en güncel yedeği otomatik olarak geri yükler. Bu, kullanıcıların
 * her seferinde elle /veriyukle çalıştırma zorunluluğunu kaldırır ve disk
 * kalıcılığı olmayan ortamlarda veri kaybı penceresini minimuma indirir.
 */
async function autoRestoreIfEmpty() {
  if (!octokit || !GITHUB_OWNER || !GITHUB_REPO) return;
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM economy').get();
    if (row && row.c > 0) return; // veritabanında zaten veri var, dokunma

    const backups = await listBackupsFromGithub();
    if (!backups.length) {
      console.log('ℹ️ Veritabanı boş ve GitHub üzerinde yedek bulunamadı, temiz başlanıyor.');
      return;
    }
    console.log(`♻️ Veritabanı boş görünüyor, en güncel yedek otomatik geri yükleniyor: ${backups[0].path}`);
    await restoreFromGithub(backups[0].path);
    console.log('✅ Otomatik geri yükleme tamamlandı.');
  } catch (err) {
    console.error('⛔ Otomatik geri yükleme hatası:', err.message);
  }
}

// ── DB yardımcıları ───────────────────────────────────────────
function getSetting(gid, key)          { const r = db.prepare('SELECT value FROM guild_settings WHERE guildId=? AND key=?').get(gid, key); return r ? r.value : null; }
function setSetting(gid, key, value)   { db.prepare('INSERT OR REPLACE INTO guild_settings (guildId,key,value) VALUES(?,?,?)').run(gid, key, value); }
function getAllSettings(gid)            { const rows = db.prepare('SELECT key,value FROM guild_settings WHERE guildId=?').all(gid); const o = {}; for (const r of rows) o[r.key] = r.value; return o; }

function getBalance(gid, uid)          { return db.prepare('SELECT balance,bank FROM economy WHERE guildId=? AND userId=?').get(gid, uid) || { balance: 0, bank: 0 }; }
function addBalance(gid, uid, amt)     { db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid, uid); db.prepare('UPDATE economy SET balance=MAX(0,balance+?) WHERE guildId=? AND userId=?').run(amt, gid, uid); return getBalance(gid, uid); }
function addBank(gid, uid, amt)        { db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid, uid); db.prepare('UPDATE economy SET bank=MAX(0,bank+?) WHERE guildId=? AND userId=?').run(amt, gid, uid); return getBalance(gid, uid); }
function transfer(gid, from, to, amt)  { if (getBalance(gid, from).balance < amt) return false; addBalance(gid, from, -amt); addBalance(gid, to, amt); return true; }
function topBalance(gid, n = 10)       { return db.prepare('SELECT userId,balance FROM economy WHERE guildId=? ORDER BY balance DESC LIMIT ?').all(gid, n); }

function getMarriage(gid, uid)         { return db.prepare('SELECT * FROM marriages WHERE guildId=? AND (user1=? OR user2=?)').get(gid, uid, uid); }
function setMarriage(gid, u1, u2)      { const now = nowTR(); db.prepare('INSERT OR IGNORE INTO marriages(guildId,user1,user2,marriedAt)VALUES(?,?,?,?)').run(gid, u1, u2, now); db.prepare('INSERT OR IGNORE INTO marriages(guildId,user1,user2,marriedAt)VALUES(?,?,?,?)').run(gid, u2, u1, now); }
function removeMarriage(gid, uid)      { const m = getMarriage(gid, uid); if (!m) return; db.prepare('DELETE FROM marriages WHERE guildId=? AND (user1=? OR user2=? OR user1=? OR user2=?)').run(gid, m.user1, m.user1, m.user2, m.user2); }
function allMarriages(gid)             { const seen = new Set(); return db.prepare('SELECT * FROM marriages WHERE guildId=?').all(gid).filter(r => { const k = [r.user1, r.user2].sort().join(':'); if (seen.has(k)) return false; seen.add(k); return true; }); }
function hasRing(gid, uid)             { return !!db.prepare('SELECT 1 FROM rings WHERE guildId=? AND userId=?').get(gid, uid); }
function giveRing(gid, uid)            { db.prepare('INSERT OR IGNORE INTO rings(guildId,userId)VALUES(?,?)').run(gid, uid); }
function consumeRing(gid, uid)         { db.prepare('DELETE FROM rings WHERE guildId=? AND userId=?').run(gid, uid); }

function addVoiceTime(gid, uid, secs)  { db.prepare('INSERT OR IGNORE INTO voice_time(guildId,userId,totalSeconds)VALUES(?,?,0)').run(gid, uid); db.prepare('UPDATE voice_time SET totalSeconds=totalSeconds+? WHERE guildId=? AND userId=?').run(secs, gid, uid); }
function getVoiceTime(gid, uid)        { const r = db.prepare('SELECT totalSeconds FROM voice_time WHERE guildId=? AND userId=?').get(gid, uid); return r ? r.totalSeconds : 0; }
function topVoice(gid, n = 10)         { return db.prepare('SELECT userId,totalSeconds FROM voice_time WHERE guildId=? ORDER BY totalSeconds DESC LIMIT ?').all(gid, n); }
function resetVoice(gid)               { db.prepare('DELETE FROM voice_time WHERE guildId=?').run(gid); }

function hasClaimed(gid, uid, date, type) { return !!db.prepare('SELECT 1 FROM daily_claims WHERE guildId=? AND userId=? AND date=? AND claimType=?').get(gid, uid, date, type); }
function setClaimed(gid, uid, date, type) { db.prepare('INSERT OR IGNORE INTO daily_claims(guildId,userId,date,claimType)VALUES(?,?,?,?)').run(gid, uid, date, type); }
function getDailyCount(gid, uid, date, type) { const r = db.prepare('SELECT count FROM daily_counts WHERE guildId=? AND userId=? AND date=? AND claimType=?').get(gid, uid, date, type); return r ? r.count : 0; }
function incDailyCount(gid, uid, date, type, n = 1) { db.prepare('INSERT OR IGNORE INTO daily_counts(guildId,userId,date,claimType,count)VALUES(?,?,?,?,0)').run(gid, uid, date, type); db.prepare('UPDATE daily_counts SET count=count+? WHERE guildId=? AND userId=? AND date=? AND claimType=?').run(n, gid, uid, date, type); return getDailyCount(gid, uid, date, type); }

function hasBoost(gid, uid)            { return !!db.prepare('SELECT 1 FROM xp_boosts WHERE guildId=? AND userId=?').get(gid, uid); }
function setBoost(gid, uid)            { db.prepare('INSERT OR IGNORE INTO xp_boosts(guildId,userId)VALUES(?,?)').run(gid, uid); }

function addMsgCount(gid, cid, uid, date) { db.prepare('INSERT OR IGNORE INTO message_counts(guildId,channelId,userId,date,count)VALUES(?,?,?,?,0)').run(gid, cid, uid, date); db.prepare('UPDATE message_counts SET count=count+1 WHERE guildId=? AND channelId=? AND userId=? AND date=?').run(gid, cid, uid, date); }
function getMsgCount(gid, cid, uid, date) { const r = db.prepare('SELECT count FROM message_counts WHERE guildId=? AND channelId=? AND userId=? AND date=?').get(gid, cid, uid, date); return r ? r.count : 0; }
function topMsgs(gid, cid, date, n = 10) { return db.prepare('SELECT userId,count FROM message_counts WHERE guildId=? AND channelId=? AND date=? ORDER BY count DESC LIMIT ?').all(gid, cid, date, n); }
function resetSohbet(gid)              { db.prepare('DELETE FROM message_counts WHERE guildId=?').run(gid); }

function getMarketRoles(gid)           { return db.prepare('SELECT * FROM market_roles WHERE guildId=?').all(gid); }
function addMarketRole(gid, rid, price, prem) { db.prepare('INSERT OR REPLACE INTO market_roles(guildId,roleId,price,isPremium)VALUES(?,?,?,?)').run(gid, rid, price, prem ? 1 : 0); }
function removeMarketRole(gid, rid)    { db.prepare('DELETE FROM market_roles WHERE guildId=? AND roleId=?').run(gid, rid); }

function getLevel(gid, uid)            { return db.prepare('SELECT xp,level FROM level_data WHERE guildId=? AND userId=?').get(gid, uid) || { xp: 0, level: 0 }; }
function addXp(gid, uid, amt)          { db.prepare('INSERT OR IGNORE INTO level_data(guildId,userId,xp,level)VALUES(?,?,0,0)').run(gid, uid); db.prepare('UPDATE level_data SET xp=xp+? WHERE guildId=? AND userId=?').run(amt, gid, uid); const d = getLevel(gid, uid); const needed = Math.round((d.level + 1) * 100 * 0.595); if (d.xp >= needed) { db.prepare('UPDATE level_data SET level=level+1,xp=xp-? WHERE guildId=? AND userId=?').run(needed, gid, uid); return { leveled: true, newLevel: d.level + 1, xpGained: amt }; } return { leveled: false, xpGained: amt }; }
function topLevels(gid, n = 10)        { return db.prepare('SELECT userId,level,xp FROM level_data WHERE guildId=? ORDER BY level DESC,xp DESC LIMIT ?').all(gid, n); }

// ── Yeni özellik yardımcıları ───────────────────────────────────
// Hırsızlık Kalkanı (45 coin, 4 saat, /oyunlar cal komutundan korur)
function hasShield(gid, uid) {
  const r = db.prepare('SELECT expiresAt FROM theft_shields WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) return false;
  if (r.expiresAt < Date.now()) { db.prepare('DELETE FROM theft_shields WHERE guildId=? AND userId=?').run(gid, uid); return false; }
  return true;
}
function setShield(gid, uid, ms) { db.prepare('INSERT OR REPLACE INTO theft_shields(guildId,userId,expiresAt)VALUES(?,?,?)').run(gid, uid, Date.now() + ms); }

// Geçici XP Boost — süreye değil kullanım hakkına dayanır (400 coin, 50 kullanım, 2x)
function getTempBoostUses(gid, uid) { const r = db.prepare('SELECT usesLeft FROM temp_xp_boosts WHERE guildId=? AND userId=?').get(gid, uid); return r ? (r.usesLeft || 0) : 0; }
function hasTempBoost(gid, uid) { return getTempBoostUses(gid, uid) > 0; }
function addTempBoostUses(gid, uid, n) {
  db.prepare('INSERT OR IGNORE INTO temp_xp_boosts(guildId,userId,usesLeft)VALUES(?,?,0)').run(gid, uid);
  db.prepare('UPDATE temp_xp_boosts SET usesLeft=usesLeft+? WHERE guildId=? AND userId=?').run(n, gid, uid);
}
function consumeTempBoost(gid, uid) {
  if (!hasTempBoost(gid, uid)) return false;
  db.prepare('UPDATE temp_xp_boosts SET usesLeft=usesLeft-1 WHERE guildId=? AND userId=?').run(gid, uid);
  return true;
}

// Kalıcı (2x) + geçici (2x) boostları birleştiren çarpan.
// consume=true olduğunda (gerçek bir ödül verilirken) geçici boost hakkı 1 azalır.
// Sadece durum göstermek için (ör. /voice durum) consume=false kullan.
function getBoostMultiplier(gid, uid, consume = true) {
  let m = 1;
  if (hasBoost(gid, uid)) m *= 2;
  if (hasTempBoost(gid, uid)) {
    m *= 2;
    if (consume) consumeTempBoost(gid, uid);
  }
  return m;
}

// ── /banka sistemi ────────────────────────────────────────────
// Bir üye /banka olustur demeden hiçbir oyun komutu çalışmaz.
// Banka hesabı açılınca yeni üyeler otomatik 6 saatlik hırsızlık koruması kazanır.
function hasBankAccount(gid, uid) { return !!db.prepare('SELECT 1 FROM bank_accounts WHERE guildId=? AND userId=?').get(gid, uid); }
function createBankAccount(gid, uid) {
  db.prepare('INSERT OR IGNORE INTO bank_accounts(guildId,userId,createdAt)VALUES(?,?,?)').run(gid, uid, Date.now());
  db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid, uid);
}

// Komutlardan hangilerinin banka hesabı olmadan da çalışabileceği (yönetimsel/owner komutları)
const BANK_EXEMPT_COMMANDS = new Set(['setup', 'yardim', 'banka', 'verikaydet', 'backuplist', 'veriyukle', 'backupsil', 'madencilik']);

// İsim Rengi Rolleri (admin /setup üzerinden ekler, kullanıcı /renk al ile satın alır)
function getColorRoles(gid)              { return db.prepare('SELECT * FROM color_roles WHERE guildId=?').all(gid); }
function addColorRole(gid, rid, price = 4000) { db.prepare('INSERT OR REPLACE INTO color_roles(guildId,roleId,price)VALUES(?,?,?)').run(gid, rid, price); }
function removeColorRole(gid, rid)       { db.prepare('DELETE FROM color_roles WHERE guildId=? AND roleId=?').run(gid, rid); }

// Sohbet — her 2 mesajda 1 coin (pasif, otomatik, günlük görev sistemi yerine)
function incChatCoinCounter(gid, uid) {
  db.prepare('INSERT OR IGNORE INTO chat_coin_counter(guildId,userId,count)VALUES(?,?,0)').run(gid, uid);
  db.prepare('UPDATE chat_coin_counter SET count=count+1 WHERE guildId=? AND userId=?').run(gid, uid);
  return db.prepare('SELECT count FROM chat_coin_counter WHERE guildId=? AND userId=?').get(gid, uid).count;
}

// Balıkçılık envanteri
function addFish(gid, uid, key, n = 1) {
  db.prepare('INSERT OR IGNORE INTO fish_inventory(guildId,userId,fishKey,count)VALUES(?,?,?,0)').run(gid, uid, key);
  db.prepare('UPDATE fish_inventory SET count=count+? WHERE guildId=? AND userId=? AND fishKey=?').run(n, gid, uid, key);
}
function getFishCount(gid, uid, key) { const r = db.prepare('SELECT count FROM fish_inventory WHERE guildId=? AND userId=? AND fishKey=?').get(gid, uid, key); return r ? r.count : 0; }
function removeFish(gid, uid, key, n) { const cur = getFishCount(gid, uid, key); if (cur < n) return false; db.prepare('UPDATE fish_inventory SET count=count-? WHERE guildId=? AND userId=? AND fishKey=?').run(n, gid, uid, key); return true; }
function getInventory(gid, uid) { return db.prepare('SELECT fishKey,count FROM fish_inventory WHERE guildId=? AND userId=? AND count>0').all(gid, uid); }

// Balıkçılık Şansı Boost — 2000 coin, süre sınırı yok, 100 kullanım hakkı
function getFishBoostUses(gid, uid) { const r = db.prepare('SELECT usesLeft FROM fish_boosts WHERE guildId=? AND userId=?').get(gid, uid); return r ? r.usesLeft : 0; }
function addFishBoostUses(gid, uid, n) {
  db.prepare('INSERT OR IGNORE INTO fish_boosts(guildId,userId,usesLeft)VALUES(?,?,0)').run(gid, uid);
  db.prepare('UPDATE fish_boosts SET usesLeft=usesLeft+? WHERE guildId=? AND userId=?').run(n, gid, uid);
}
function consumeFishBoost(gid, uid) {
  const u = getFishBoostUses(gid, uid);
  if (u <= 0) return false;
  db.prepare('UPDATE fish_boosts SET usesLeft=usesLeft-1 WHERE guildId=? AND userId=?').run(gid, uid);
  return true;
}

// Seviye ödül rolleri
const LEVEL_ROLE_REWARDS = {
  5:  '1524109066929045626',
  10: '1524109231719190678',
  20: '1524110815907811609',
  30: '1524112620976869446',
  45: '1524885044055773345',
  55: '1524885000112177203',
  70: '1524886153873068092',
};

// ── Tarih / Saat yardımcıları ─────────────────────────────────
function todayTR()    { return new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-'); }
function nowTR()      { return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }); }
function fmtVoice(s)  { return `${Math.floor(s / 3600)}sa ${Math.floor((s % 3600) / 60)}dk ${s % 60}sn`; }
function fmtMin(s)    { return `${Math.floor(s / 60)} dk ${s % 60} sn`; }
function pick(arr)    { return arr[Math.floor(Math.random() * arr.length)]; }
function trL(s)       { return (s || '').toLocaleLowerCase('tr').trim(); }
function fmtBytes(b)  { if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`; return `${(b / 1024).toFixed(1)} KB`; }

// İstanbul saat aralığı kontrolü (13:00 – 03:59)
function isWithinIstanbulWindow() {
  const h = (new Date().getUTCHours() + 3) % 24;
  return h >= 13 || h < 4;
}

// ──────────────────────────────────────────────────────────────
//  OYUN VERİLERİ
// ──────────────────────────────────────────────────────────────
const TYPING_SENTENCES = [
  'Gölgelerin arasından doğan ışığa asla sırtını dönme.',
  'Bugün, dünün pişmanlıklarını değil yarının umutlarını büyüt.',
  'Kahveni al, hedeflerini yaz ve başla.',
  'Rüzgârın yönünü değiştiremezsin ama yelkenini ayarlayabilirsin.',
  'Sabır, sessizliğin en yüksek sesidir.',
  'Küçük adımlar büyük kapıları açar.',
  'Düşmeden koşmayı kimse öğrenemez.',
  'Bir plan, rastgeleliğin panzehiridir.',
  'Zaman, hak edeni ortaya çıkarır.',
  'Hayal kurmak başlangıçtır; emek bitiriştir.',
  'Başlamak için mükemmel olman gerekmez, ama mükemmel olmak için başlaman gerekir.',
  'Düşlediğin şey için çalışmaya başla, çünkü kimse senin yerine yapmayacak.',
  'Her başarısızlık bir sonraki denemeye hazırlıktır.',
  'Kendine inan, çünkü en büyük güç orada gizlidir.',
  'İmkansız sadece biraz daha zamana ihtiyaç duyan şeydir.',
  'Cesaret, korkuya rağmen devam edebilmektir.',
  'Bir hedefin yoksa, hiçbir rüzgar işine yaramaz.',
  'Mutluluk, küçük şeyleri fark ettiğinde başlar.',
  'Karanlık olmadan yıldızları göremezsin.',
  'Büyük düşün, küçük adımlarla ilerle.',
  'Zaman seni değil, sen zamanı yönet.',
  'Bugün atılan adım, yarının başarısıdır.',
  'Azim, başarının en sessiz anahtarıdır.',
  'Hayat bir oyun değil, ama bazen oynamayı öğrenmelisin.',
  'Denemekten korkan, kaybetmeyi çoktan seçmiştir.',
  'Bir gün değil, her gün çalış.',
  'Düşün, planla, uygula, başla.',
  'Motivasyon biter ama disiplin kalır.',
  'Her yeni gün, bir fırsattır.',
  'Kendin ol, çünkü herkes zaten alınmış.',
];

// NOT: Bu dosyada daha önce yer alan gif linkleri (uydurma tenor ID'leri)
// gerçekte hiç var olmayan/404 dönen linklerdi; hepsi gerçek, çalıştığı
// doğrulanmış tenor linkleriyle değiştirildi.
const DICE_GIFS   = [
  'https://media1.tenor.com/m/oOStgR8Xfd8AAAAC/dice-dice-roll.gif',
  'https://media1.tenor.com/m/wmXw4IwUrB8AAAAC/dice-roll-the-dice.gif',
];
const COOKED_GIFS = [
  'https://media1.tenor.com/m/4Je-dlgy1-MAAAAC/getting-cooked-you-got-cooked-bro.gif',
];
const PROPOSAL_HAPPY_GIFS = [
  'https://media.tenor.com/-YBoNtfhc0UAAAAM/kai-and-afine-kiss.gif',
];
const PROPOSAL_SAD_GIFS = [
  'https://media.tenor.com/_qDh7tYIsSoAAAAM/son-im-crine.gif',
];

// /çal GIFleri
const STEAL_START_GIF  = 'https://media.tenor.com/jL1f0JCmZEkAAAAM/ill-be-taking-that-spongebob.gif';
const STEAL_SUCCESS_GIF = 'https://media.tenor.com/HzQkgpZ0neQAAAAM/madman-kazuma.gif';
const STEAL_FAIL_GIF    = 'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExbXMzdW0wbHFzc29iZ2J2ZzM2YTJjbnNxM3l4OGN6emZ2aGlrbjhwMiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/59d1zo8SUSaUU/giphy.gif';

// Balık türleri — 4 nadirlik katmanına ayrılmış, her katmanın TOPLAM çıkma
// oranı (weight toplamı) sabit bir yüzdeye denk gelir, katman içindeki
// balıklara eşit bölünür:
//   30-40 coin (3 balık)  -> toplam %2   çıkma oranı (en nadir)
//   10-25 coin (4 balık)  -> toplam %6   çıkma oranı (~%5-7)
//    5-10 coin (10 balık) -> toplam %30  çıkma oranı
//    1-2  coin (15 balık) -> toplam %62  çıkma oranı (en yüksek, en yaygın)
// weight'lerin toplamı tam 100 olduğu için weight = yüzde olarak okunabilir.
const FISH_TIERS = [
  {
    totalWeight: 62, // en yaygın, en düşük değerli katman
    fish: [
      { key: 'sardalya',  name: 'Sardalya',        emoji: '🐟', value: 10  },
      { key: 'hamsi',     name: 'Hamsi',            emoji: '🐠', value: 10  },
      { key: 'istavrit',  name: 'İstavrit',         emoji: '🐡', value: 10  },
      { key: 'caca',      name: 'Çaça',             emoji: '🐟', value: 10  },
      { key: 'gumus',     name: 'Gümüş Balığı',     emoji: '🐠', value: 10  },
      { key: 'kayabaligi',name: 'Kaya Balığı',      emoji: '🐡', value: 10  },
      { key: 'tekir',     name: 'Tekir',            emoji: '🐟', value: 10  },
      { key: 'igneli',    name: 'İğneli Balık',     emoji: '🐠', value: 10  },
      { key: 'kefal',     name: 'Kefal',            emoji: '🐡', value: 20  },
      { key: 'mezgit',    name: 'Mezgit',           emoji: '🐟', value: 20  },
      { key: 'barbunya',  name: 'Barbunya',         emoji: '🐠', value: 20  },
      { key: 'kolyoz',    name: 'Kolyoz',           emoji: '🐡', value: 20  },
      { key: 'uskumru',   name: 'Uskumru',          emoji: '🐟', value: 20  },
      { key: 'sarpa',     name: 'Sarpa',            emoji: '🐠', value: 20  },
      { key: 'zargana',   name: 'Zargana',          emoji: '🐡', value: 20  },
    ],
  },
  {
    totalWeight: 30,
    fish: [
      { key: 'levrek',   name: 'Levrek',          emoji: '🐟', value: 50  },
      { key: 'cupra',    name: 'Çipura',          emoji: '🐠', value: 50  },
      { key: 'karagoz',  name: 'Karagöz',         emoji: '🐡', value: 60  },
      { key: 'sinarit',  name: 'Sinarit',         emoji: '🐟', value: 60  },
      { key: 'mercan',   name: 'Mercan',          emoji: '🐠', value: 70  },
      { key: 'sargoz',   name: 'Sargoz',          emoji: '🐡', value: 70  },
      { key: 'lahoz',    name: 'Lahoz',           emoji: '🐟', value: 80  },
      { key: 'palamut',  name: 'Palamut',         emoji: '🐠', value: 80  },
      { key: 'lufer',    name: 'Lüfer',           emoji: '🐡', value: 90  },
      { key: 'somon',    name: 'Somon',           emoji: '🍣', value: 100 },
    ],
  },
  {
    totalWeight: 6, // ~%5-7 aralığı, orta nokta %6
    fish: [
      { key: 'orfoz',    name: 'Orfoz',           emoji: '🐋', value: 120 },
      { key: 'yilanbal', name: 'Yılan Balığı',    emoji: '🐍', value: 160 },
      { key: 'kilic',    name: 'Kılıç Balığı',    emoji: '⚔️', value: 200 },
      { key: 'ton',      name: 'Ton Balığı',      emoji: '🐬', value: 250 },
    ],
  },
  {
    totalWeight: 2, // en nadir katman
    fish: [
      { key: 'orkinos',  name: 'Dev Orkinos',           emoji: '🐳', value: 320 },
      { key: 'kopekbal', name: 'Köpekbalığı',           emoji: '🦈', value: 360 },
      { key: 'ejder',    name: 'Efsanevi Ejder Balığı', emoji: '🐉', value: 400 },
    ],
  },
];

// FISH_TIERS'i düz bir listeye açar; her balığa, kendi katmanının toplam
// ağırlığını katmandaki balık sayısına eşit bölerek weight atar.
const FISH_TYPES = FISH_TIERS.flatMap(tier =>
  tier.fish.map(f => ({ ...f, weight: tier.totalWeight / tier.fish.length }))
);

function pickFish(boosted) {
  let pool = FISH_TYPES.map(f => ({ ...f }));
  if (boosted) pool = pool.map(f => ({ ...f, weight: f.value >= 14 ? f.weight * 3 : f.weight }));
  const total = pool.reduce((a, f) => a + f.weight, 0);
  let r = Math.random() * total;
  for (const f of pool) {
    if (r < f.weight) return f;
    r -= f.weight;
  }
  return pool[0];
}

// ── Balık Market Fiyat Havuzu ────────────────────────────────
// Her 6 saatte bir yeniden karılıyor, böylece fiyatlar günden güne değişiyor.
// Bazı turlarda nadir balıklar bile 30-50 coin'e fırlayabiliyor, bazı turlarda
// çoğu balık sadece 1 coin ediyor — piyasa gerçekten dalgalı hissettiriyor.
const FISH_MARKET_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 saat
let fishMarketPool = null;
let fishMarketGeneratedAt = 0;

function generateFishMarketPool() {
  const pool = {};
  for (const f of FISH_TYPES) {
    const roll = Math.random();
    let value;
    if (roll < 0.05) {
      // Fiyat patlaması: bu turda balıklar (nadir olsun olmasın) çok değerli
      value = 300 + Math.floor(Math.random() * 201); // 300-500 coin
    } else if (roll < 0.35) {
      // Piyasa çöküşü: bu turda balıkların çoğu neredeyse değersiz
      value = 1;
    } else {
      // Normal dalgalanma: temel değerin ±%40'ı kadar oynar
      const variance = f.value * 0.4;
      value = Math.max(1, Math.round(f.value + (Math.random() * 2 - 1) * variance));
    }
    pool[f.key] = value;
  }
  fishMarketPool = pool;
  fishMarketGeneratedAt = Date.now();
  return pool;
}

function ensureFishMarketPool() {
  if (!fishMarketPool || Date.now() - fishMarketGeneratedAt >= FISH_MARKET_REFRESH_MS) {
    generateFishMarketPool();
  }
  return fishMarketPool;
}

function getFishValue(key) {
  const pool = ensureFishMarketPool();
  const v = pool[key];
  if (v !== undefined) return v;
  return FISH_TYPES.find(f => f.key === key)?.value ?? 1;
}

function startFishMarketRefresh() {
  ensureFishMarketPool();
  setInterval(generateFishMarketPool, FISH_MARKET_REFRESH_MS);
  console.log('🎣 Balık market fiyat havuzu başlatıldı (6 saatte bir yenilenir).');
}

// ── Balık Tutma Riskleri: boş atma / mısına kopma / olta kırılması ──
// sinceLine/sinceRod/sinceEmpty sayaçları her /balik tut denemesinde artar.
// Sayaç rastgele belirlenmiş eşiğe ulaşınca olay tetiklenir ve sayaç
// sıfırlanıp yeni bir rastgele eşik seçilir. Boş olta çekme artık (mısına
// kopma/olta kırılmasıyla aynı mantıkla) 2-10 atışta bir garanti şekilde
// tetiklenen bir sayaç, sabit bir ihtimal DEĞİL.
const LINE_SNAP_COST     = 20;   // mısına kopunca kesilen coin
const ROD_BREAK_COST     = 50;   // olta kırılınca kesilen coin
function randBetween(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

function getFishCastState(gid, uid) {
  let r = db.prepare('SELECT * FROM fish_cast_state WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) {
    r = {
      guildId: gid, userId: uid,
      sinceLine: 0, lineThreshold: randBetween(4, 8),
      sinceRod: 0, rodThreshold: randBetween(20, 30),
      sinceEmpty: 0, emptyThreshold: randBetween(2, 10),
    };
    db.prepare('INSERT INTO fish_cast_state(guildId,userId,sinceLine,lineThreshold,sinceRod,rodThreshold,sinceEmpty,emptyThreshold)VALUES(?,?,?,?,?,?,?,?)')
      .run(gid, uid, r.sinceLine, r.lineThreshold, r.sinceRod, r.rodThreshold, r.sinceEmpty, r.emptyThreshold);
  }
  // Eski (migrate edilmiş) satırlarda emptyThreshold varsayılan olarak 0
  // gelir — bu durumda ilk atışta hemen "boş" tetiklenmesini önlemek için
  // taze bir rastgele eşik ata.
  if (!r.emptyThreshold) r.emptyThreshold = randBetween(2, 10);
  return r;
}
function saveFishCastState(gid, uid, state) {
  db.prepare('UPDATE fish_cast_state SET sinceLine=?, lineThreshold=?, sinceRod=?, rodThreshold=?, sinceEmpty=?, emptyThreshold=? WHERE guildId=? AND userId=?')
    .run(state.sinceLine, state.lineThreshold, state.sinceRod, state.rodThreshold, state.sinceEmpty, state.emptyThreshold, gid, uid);
}

/**
 * Bir /balik tut denemesinin sonucunu belirler.
 * @returns {{ type: 'rod_break'|'line_snap'|'empty'|'catch', fish?: object }}
 */
function resolveFishCast(gid, uid, boosted) {
  const state = getFishCastState(gid, uid);
  state.sinceLine++;
  state.sinceRod++;
  state.sinceEmpty++;

  // Olta kırılması önce kontrol edilir (daha nadir ama daha ciddi bir olay)
  if (state.sinceRod >= state.rodThreshold) {
    state.sinceRod = 0;
    state.rodThreshold = randBetween(20, 30);
    state.sinceLine = 0;
    state.lineThreshold = randBetween(4, 8);
    saveFishCastState(gid, uid, state);
    return { type: 'rod_break' };
  }

  if (state.sinceLine >= state.lineThreshold) {
    state.sinceLine = 0;
    state.lineThreshold = randBetween(4, 8);
    saveFishCastState(gid, uid, state);
    return { type: 'line_snap' };
  }

  // Boş olta: 2-10 atışta bir garanti tetiklenir (sabit ihtimal değil)
  if (state.sinceEmpty >= state.emptyThreshold) {
    state.sinceEmpty = 0;
    state.emptyThreshold = randBetween(2, 10);
    saveFishCastState(gid, uid, state);
    return { type: 'empty' };
  }

  saveFishCastState(gid, uid, state);

  return { type: 'catch', fish: pickFish(boosted) };
}

// Blackjack / At Yarışı ortak ödül hesaplayıcı — %2x kazanç, ~%0.1 ihtimalle 5x
function resolveWinAmount(bet) {
  if (Math.random() < 0.001) return bet * 8;
  return bet * 4;
}

// ──────────────────────────────────────────────────────────────
//  OYUN DURUM HARİTALARI (in-memory)
// ──────────────────────────────────────────────────────────────
const diceLossStreak    = new Map();
const activeTypingGames = new Map();
const dailyTypingWins   = new Map();
const activeSteals      = new Set();
const proposalCooldown  = new Map();
const voiceJoinTimes    = new Map();
const voiceDailySec     = new Map();
const voiceDailyClaimed = new Map();
const voiceSystemPaused = new Set(); // guild id'leri — ses takibi kapalı olanlar
let stealUseCounter     = 0;

// Yeni özellikler için in-memory durumlar
const fishCooldown   = new Map(); // `${gid}:${uid}` -> son tutma zamanı (ms)
const activeBlackjack = new Map(); // `${gid}:${uid}` -> oyun durumu
const activeRaces    = new Map(); // channelId -> yarış durumu

function normalizeTR(s) {
  return String(s || '').toLocaleLowerCase('tr').replace(/[.,;:!?'"~^_()[\]{}<>/@#$%&=+\\|-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────────────────────
//  MADENCİLİK OYUNU SABİTLERİ & YARDIMCILARI
// ──────────────────────────────────────────────────────────────
const MINING_CHANNEL_ID = '1525528825247830126';

const ORES = [
  { key: 'coal',    name: 'Kömür',   emoji: '⬛', value: 10,  weight: 35   },
  { key: 'copper',  name: 'Bakır',   emoji: '🟤', value: 10,  weight: 28   },
  { key: 'iron',    name: 'Demir',   emoji: '⚙️',  value: 20,  weight: 18   },
  { key: 'silver',  name: 'Gümüş',  emoji: '🩶', value: 20,  weight: 8    },
  { key: 'steel',   name: 'Çelik',  emoji: '🔩', value: 20,  weight: 6    },
  { key: 'gold',    name: 'Altın',  emoji: '🟡', value: 30,  weight: 3    },
  { key: 'lignite', name: 'Linyit', emoji: '🔵', value: 50,  weight: 1.5  },
  { key: 'diamond', name: 'Elmas',  emoji: '💎', value: 70,  weight: 0.35 },
  { key: 'uranium', name: 'Uranyum',emoji: '☢️',  value: 100, weight: 0.15 },
];

const MINING_FOODS = [
  { key: 'bread', name: 'Ekmek', emoji: '🍞', price: 50,  uses: 20, desc: '20 kullanım hakkı verir' },
  { key: 'soup',  name: 'Çorba', emoji: '🍲', price: 100, uses: 30, desc: '30 kullanım hakkı verir' },
  { key: 'meat',  name: 'Et',    emoji: '🥩', price: 300, uses: 60, desc: '60 kullanım hakkı verir' },
];

// Enerji kapasitesi yükseltme tierleri — her alım +5 max enerji verir
const ENERGY_CAP_TIERS = [
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
];

// Başlangıç: 2 işçi bedava
// Tier 0: 50 coin (Lv.1 gerekli, 1 alım → max 3 işçi)
// Tier 1: 200 coin (Lv.10 gerekli, 5 alım → max 8 işçi)
// Tier 2: 400 coin (Lv.20 gerekli, 5 alım → max 13 işçi)
const WORKER_TIERS = [
  { price: 500,  minLevel: 1,  maxPurchases: 1 },
  { price: 2000, minLevel: 10, maxPurchases: 5 },
  { price: 4000, minLevel: 20, maxPurchases: 5 },
];

const MINING_COOLDOWNS = new Map(); // key: guildId:userId → timestamp

function miningCooldownCheck(gid, uid) {
  const key = `${gid}:${uid}`;
  const last = MINING_COOLDOWNS.get(key) || 0;
  const remaining = 10000 - (Date.now() - last);
  if (remaining > 0) return Math.ceil(remaining / 1000);
  MINING_COOLDOWNS.set(key, Date.now());
  return 0;
}

function getMiningData(gid, uid) {
  let r = db.prepare('SELECT * FROM mining_data WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) {
    db.prepare(
      `INSERT OR IGNORE INTO mining_data(guildId,userId,miners,miningLevel,miningXp,energyLevel,energyXp,energy,lastEnergyRegen,hungryUntil,workerTier,purchasesInTier,totalOresMined,breadUses,soupUses,meatUses,energyCapTier,energyCapPurchasesInTier)
       VALUES(?,?,2,1,0,1,0,20,?,0,0,0,0,0,0,0,0,0)`
    ).run(gid, uid, Date.now());
    r = db.prepare('SELECT * FROM mining_data WHERE guildId=? AND userId=?').get(gid, uid);
  }
  // Eski kayıtlarda yeni alanlar null gelebilir — varsayılan değer ata
  r.breadUses               = r.breadUses               ?? 0;
  r.soupUses                = r.soupUses                ?? 0;
  r.meatUses                = r.meatUses                ?? 0;
  r.energyCapTier           = r.energyCapTier           ?? 0;
  r.energyCapPurchasesInTier = r.energyCapPurchasesInTier ?? 0;
  return r;
}

function saveMiningData(gid, uid, data) {
  db.prepare(
    `UPDATE mining_data SET miners=?,miningLevel=?,miningXp=?,energyLevel=?,energyXp=?,energy=?,lastEnergyRegen=?,hungryUntil=?,workerTier=?,purchasesInTier=?,totalOresMined=?,breadUses=?,soupUses=?,meatUses=?,energyCapTier=?,energyCapPurchasesInTier=?
     WHERE guildId=? AND userId=?`
  ).run(
    data.miners, data.miningLevel, data.miningXp,
    data.energyLevel, data.energyXp,
    data.energy, data.lastEnergyRegen, data.hungryUntil,
    data.workerTier, data.purchasesInTier, data.totalOresMined,
    data.breadUses, data.soupUses, data.meatUses,
    data.energyCapTier, data.energyCapPurchasesInTier,
    gid, uid
  );
}

// Temel max enerji: Lv.1=20, Lv.2=21 … + enerji kapasitesi yükseltmesi (her alım +5)
function getMiningMaxEnergy(data) {
  const capBonus = (data.energyCapTier * 5 * 5) + (data.energyCapPurchasesInTier * 5);
  return 19 + (data.energyLevel ?? 1) + capBonus;
}
function getMiningCapacity(level)   { return level >= 20 ? 5 : level >= 10 ? 3 : 2; }
function getMiningXpNeeded(level)   { return level * 3; }
function getEnergyXpNeeded(level)   { return level * 10; }

function getMiningRank(level) {
  if (level >= 20) return { name: 'Master', emoji: '👑', color: 0xE74C3C };
  if (level >= 15) return { name: 'Gold',   emoji: '🥇', color: 0xF1C40F };
  if (level >= 10) return { name: 'Iron',   emoji: '⚙️', color: 0x95A5A6 };
  if (level >= 5)  return { name: 'Bronze', emoji: '🥉', color: 0xCD7F32 };
  return { name: 'Beginner', emoji: '⛏️', color: 0x3498DB };
}

function regenEnergy(data) {
  const now = Date.now();
  const elapsed = now - (data.lastEnergyRegen || now);
  const regenCount = Math.floor(elapsed / (2 * 60 * 1000));
  if (regenCount > 0) {
    const maxEnergy = getMiningMaxEnergy(data);
    data.energy = Math.min(maxEnergy, data.energy + regenCount);
    data.lastEnergyRegen = (data.lastEnergyRegen || now) + regenCount * 2 * 60 * 1000;
  }
  return data;
}

function pickOre() {
  const total = ORES.reduce((a, o) => a + o.weight, 0);
  let r = Math.random() * total;
  for (const o of ORES) { if (r < o.weight) return o; r -= o.weight; }
  return ORES[0];
}

function getMiningInventory(gid, uid) {
  return db.prepare('SELECT * FROM mining_inventory WHERE guildId=? AND userId=?').all(gid, uid);
}
function addMiningOre(gid, uid, oreKey, amount) {
  db.prepare('INSERT OR IGNORE INTO mining_inventory(guildId,userId,ore,amount)VALUES(?,?,?,0)').run(gid, uid, oreKey);
  db.prepare('UPDATE mining_inventory SET amount=amount+? WHERE guildId=? AND userId=? AND ore=?').run(amount, gid, uid, oreKey);
}
function clearMiningInventory(gid, uid) {
  db.prepare('DELETE FROM mining_inventory WHERE guildId=? AND userId=?').run(gid, uid);
}
function getMiningLeaderboard(gid, limit = 10) {
  return db.prepare(
    'SELECT userId,miningLevel,totalOresMined FROM mining_data WHERE guildId=? ORDER BY miningLevel DESC, totalOresMined DESC LIMIT ?'
  ).all(gid, limit);
}

function buildMiningPanel() {
  const embed = new EmbedBuilder()
    .setTitle('⛏️ Madencilik Oyunu')
    .setColor(0x8B4513)
    .setDescription(
      '**Madene işçi gönder, maden çıkar, envanterini sat!**\n\n' +
      '🔒 Tüm oyun verilerin yalnızca sana görünür.\n' +
      '⏱️ Her eylem için **10 saniye** bekleme süresi var.\n' +
      '⚡ Enerji her **2 dakikada bir** 1 adet yenilenir.\n' +
      '🍽️ Madencilerin aç kalırsa verim düşer!'
    )
    .addFields(
      { name: '⛏️ Madene Gönder', value: 'İşçilerini madene yolla, maden çıkar', inline: true },
      { name: '⚡ Enerji',         value: 'Enerji durumunu kontrol et',           inline: true },
      { name: '🎒 Envanter',       value: 'Çıkardığın madenleri gör',             inline: true },
      { name: '💰 Sat',            value: 'Tüm envanteri coin\'e çevir',          inline: true },
      { name: '🛒 Market',         value: 'İşçi, enerji ve yemek satın al',       inline: true },
      { name: '📊 Profil',         value: 'Madencilik istatistiklerini gör',      inline: true },
    )
    .setFooter({ text: 'Başlangıç: 2 işçi | Rütbeler: Bronze(Lv5) • Iron(Lv10) • Gold(Lv15) • Master(Lv20)' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mine_dig').setLabel('⛏️ Madene Gönder').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mine_energy').setLabel('⚡ Enerji').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mine_inventory').setLabel('🎒 Envanter').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mine_sell').setLabel('💰 Sat').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mine_market').setLabel('🛒 Market').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mine_profile').setLabel('📊 Profil').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mine_help').setLabel('📖 Nasıl Oynanır?').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2, row3] };
}

async function handleMineButton(interaction) {
  const gid = interaction.guild?.id;
  const uid = interaction.user.id;
  if (!gid) return interaction.reply({ ephemeral: true, content: '⛔ Bu bir sunucu içinde kullanılabilir.' });

  const cd = miningCooldownCheck(gid, uid);
  if (cd > 0) return interaction.reply({ ephemeral: true, content: `⏳ **${cd}** saniye beklemelisin!` });

  if (!hasBankAccount(gid, uid)) {
    return interaction.reply({ ephemeral: true, content: '🏦 Önce `/banka olustur` ile hesap açman gerekiyor!' });
  }

  const id = interaction.customId;

  // ── ⛏️ MADENE GÖNDER ───────────────────────────────────────
  if (id === 'mine_dig') {
    let data = getMiningData(gid, uid);
    data = regenEnergy(data);

    const sendCount  = data.miners;
    const energyCost = sendCount;

    if (data.energy < energyCost) {
      saveMiningData(gid, uid, data);
      const maxE = getMiningMaxEnergy(data);
      const secToNext = Math.ceil((2 * 60 * 1000 - (Date.now() - data.lastEnergyRegen) % (2 * 60 * 1000)) / 1000);
      return interaction.reply({
        ephemeral: true,
        content: `⚡ Yeterli enerji yok!\nGerekli: **${energyCost}**, Mevcut: **${data.energy}/${maxE}**\n⏱️ Sonraki yenilenme: **${secToNext}s** | 🛒 Marketten de alabilirsin.`,
      });
    }

    // Açlık kontrolü: yiyecek kullanım hakkı kalmamışsa aç
    const totalFoodUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    const isHungry = totalFoodUses <= 0;
    const effectiveSend = isHungry ? Math.max(1, Math.floor(sendCount / 2)) : sendCount;

    data.energy -= energyCost;

    // Yiyecek tüket (önce ekmek, sonra çorba, sonra et)
    if (!isHungry) {
      if (data.breadUses > 0)      data.breadUses--;
      else if (data.soupUses > 0)  data.soupUses--;
      else if (data.meatUses > 0)  data.meatUses--;
    }
    const newTotalFoodUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    const justRanOut = !isHungry && newTotalFoodUses <= 0;

    // Maden çıkarma
    const results = [];
    for (let i = 0; i < effectiveSend; i++) results.push(pickOre());
    for (const ore of results) addMiningOre(gid, uid, ore.key, 1);
    data.totalOresMined += effectiveSend;

    // Madencilik XP
    data.miningXp += effectiveSend;
    let leveledUp = false;
    while (data.miningXp >= getMiningXpNeeded(data.miningLevel)) {
      data.miningXp -= getMiningXpNeeded(data.miningLevel);
      data.miningLevel++;
      leveledUp = true;
    }

    saveMiningData(gid, uid, data);

    const rank     = getMiningRank(data.miningLevel);
    const maxEnergy = getMiningMaxEnergy(data);
    const oreLines  = results.map(o => `${o.emoji} ${o.name}`).join('\n') || '—';
    const foodStr   = isHungry
      ? '😫 Aç (0 kullanım)'
      : `🍽️ Tok (${newTotalFoodUses} kullanım kaldı)`;

    const embed = new EmbedBuilder()
      .setTitle('⛏️ Madencilik Sonucu')
      .setColor(rank.color)
      .addFields(
        { name: '🏭 Çıkarılan Madenler',  value: oreLines,                                               inline: true },
        { name: '👷 Gönderilen İşçi',     value: `**${effectiveSend}** / ${data.miners}${isHungry ? ' *(aç 😫)*' : ''}`, inline: true },
        { name: '⚡ Kalan Enerji',         value: `**${data.energy}** / ${maxEnergy}`,                    inline: true },
        { name: '🏅 Rütbe / Seviye',       value: `${rank.emoji} **${rank.name}** Lv.${data.miningLevel}`, inline: true },
        { name: '📈 Madencilik XP',        value: `${data.miningXp} / ${getMiningXpNeeded(data.miningLevel)}`, inline: true },
        { name: '🍽️ İşçi Durumu',        value: foodStr,                                                 inline: true },
      );

    if (leveledUp)    embed.addFields({ name: '🎉 SEVİYE ATLADI!',    value: `Madencilik Lv.**${data.miningLevel}** oldun!`,                    inline: false });
    if (justRanOut)   embed.addFields({ name: '🍽️ Yiyecek Bitti!',   value: 'Tüm yiyecek kullanımları tükendi! Marketten yenisini al.',       inline: false });
    if (isHungry)     embed.addFields({ name: '😫 İşçiler Aç!',       value: 'Yiyecek yok — verimlilik %50 düştü! Marketten yemek al.',        inline: false });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── ⚡ ENERJİ ───────────────────────────────────────────────
  if (id === 'mine_energy') {
    let data = getMiningData(gid, uid);
    data = regenEnergy(data);
    saveMiningData(gid, uid, data);

    const maxEnergy = getMiningMaxEnergy(data);
    const msToNext  = 2 * 60 * 1000 - (Date.now() - data.lastEnergyRegen) % (2 * 60 * 1000);
    const secToNext = Math.ceil(msToNext / 1000);

    const embed = new EmbedBuilder()
      .setTitle('⚡ Enerji Durumu')
      .setColor(0xF39C12)
      .addFields(
        { name: '⚡ Mevcut Enerji',   value: `**${data.energy}** / ${maxEnergy}`,                           inline: true },
        { name: '⏱️ Sonraki Yenilenme', value: `**${secToNext}** saniye`,                                  inline: true },
        { name: '⚡ Enerji Seviyesi', value: `Lv.**${data.energyLevel}** (Max: ${maxEnergy})`,              inline: true },
        { name: '📈 Enerji XP',       value: `${data.energyXp} / ${getEnergyXpNeeded(data.energyLevel)}`,  inline: true },
      )
      .setFooter({ text: '2 dk = +1 enerji otomatik | Market: 2 coin/enerji (tam doldurur) | 🔋 Kapasite: 2000 coin = +5 max enerji' });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 🎒 ENVANTER ─────────────────────────────────────────────
  if (id === 'mine_inventory') {
    const inv = getMiningInventory(gid, uid).filter(r => r.amount > 0);
    if (!inv.length) return interaction.reply({ ephemeral: true, content: '🎒 Envanterin boş! Madene işçi gönder.' });

    let totalValue = 0;
    const lines = inv.map(r => {
      const ore = ORES.find(o => o.key === r.ore);
      if (!ore) return null;
      const val = ore.value * r.amount;
      totalValue += val;
      return `${ore.emoji} **${ore.name}** × ${r.amount} — ${val} coin`;
    }).filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🎒 Madencilik Envanteri')
      .setColor(0x8B4513)
      .setDescription(lines.join('\n'))
      .addFields({ name: '💰 Toplam Değer', value: `**${totalValue} coin**`, inline: true })
      .setFooter({ text: 'Satmak için "Sat" düğmesine bas' });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 💰 SAT ──────────────────────────────────────────────────
  if (id === 'mine_sell') {
    const inv = getMiningInventory(gid, uid).filter(r => r.amount > 0);
    if (!inv.length) return interaction.reply({ ephemeral: true, content: '🎒 Satacak maden yok! Önce madene gönder.' });

    let totalValue = 0;
    const lines = [];
    for (const r of inv) {
      const ore = ORES.find(o => o.key === r.ore);
      if (!ore) continue;
      const earned = ore.value * r.amount;
      totalValue += earned;
      lines.push(`${ore.emoji} ${ore.name} × ${r.amount} = ${earned} coin`);
    }
    clearMiningInventory(gid, uid);
    addBalance(gid, uid, totalValue);

    const embed = new EmbedBuilder()
      .setTitle('💰 Madenler Satıldı!')
      .setColor(0x2ECC71)
      .setDescription(lines.join('\n'))
      .addFields({ name: '💰 Kazanılan', value: `**+${totalValue} coin**`, inline: true },
                 { name: '💳 Yeni Bakiye', value: `**${getBalance(gid, uid).balance} coin**`, inline: true });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 🛒 MARKET ───────────────────────────────────────────────
  if (id === 'mine_market') {
    let data = getMiningData(gid, uid);
    data = regenEnergy(data);
    const bal         = getBalance(gid, uid).balance;
    const tierIdx     = Math.min(data.workerTier, WORKER_TIERS.length - 1);
    const tier        = WORKER_TIERS[tierIdx];
    const nextTier    = WORKER_TIERS[tierIdx + 1] || null;
    const allWorkersBought = data.workerTier >= WORKER_TIERS.length;
    const canBuyWorker = !allWorkersBought && data.miningLevel >= tier.minLevel;
    const maxEnergy   = getMiningMaxEnergy(data);
    const remaining   = allWorkersBought ? 0 : tier.maxPurchases - data.purchasesInTier;

    // Enerji kapasitesi yükseltme bilgisi
    const capTierIdx      = Math.min(data.energyCapTier, ENERGY_CAP_TIERS.length - 1);
    const capTier         = ENERGY_CAP_TIERS[capTierIdx];
    const allCapBought    = data.energyCapTier >= ENERGY_CAP_TIERS.length;
    const capRemaining    = allCapBought ? 0 : capTier.maxPurchases - data.energyCapPurchasesInTier;
    const totalFoodUses   = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);

    const workerLines = allWorkersBought
      ? ['**👷 İşçi Satın Al**', '  ✅ Maksimum işçi sayısına ulaştın! (**13 işçi**)']
      : [
          '**👷 İşçi Satın Al**',
          `  Fiyat: **${tier.price} coin** | Mevcut: **${data.miners}** işçi`,
          canBuyWorker ? `  ✅ Seviye yeterli (Lv.${data.miningLevel})` : `  ❌ Gereken seviye: Lv.${tier.minLevel}`,
          `  Bu tier'dan kalan: **${remaining}** alım`,
          nextTier ? `  Sonraki tier: **${nextTier.price}** coin (Lv.${nextTier.minLevel} gerekli)` : '  📌 Bu son tier',
        ];

    const capLines = allCapBought
      ? ['**🔋 Enerji Kapasitesi** — ✅ Maksimum kapasiteye ulaştın! (+75 enerji)']
      : [
          `**🔋 Enerji Kapasitesi** — 2000 coin / +5 max enerji`,
          `  Mevcut max: **${maxEnergy}** | Bu tier'dan kalan: **${capRemaining}** alım`,
        ];

    const infoLines = [
      ...workerLines,
      '',
      `**⚡ Enerji Doldur** — 2 coin/enerji (tam doldurur)`,
      `  Mevcut: ${data.energy}/${maxEnergy} | Eksik: ${maxEnergy - data.energy} enerji = ${(maxEnergy - data.energy) * 2} coin`,
      '',
      ...capLines,
      '',
      '**🍞 Ekmek** — 50 coin (+20 kullanım hakkı)',
      '**🍲 Çorba** — 100 coin (+30 kullanım hakkı)',
      '**🥩 Et** — 300 coin (+60 kullanım hakkı)',
      `  🍽️ Mevcut yiyecek kullanımı: **${totalFoodUses}**`,
      '',
      `💰 Bakiye: **${bal} coin**`,
    ].join('\n');

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mine_buy_worker').setLabel('👷 İşçi Al').setStyle(ButtonStyle.Primary).setDisabled(!canBuyWorker || bal < tier.price),
      new ButtonBuilder().setCustomId('mine_buy_energy').setLabel('⚡ Enerji Doldur').setStyle(ButtonStyle.Secondary).setDisabled(data.energy >= maxEnergy || bal < (maxEnergy - data.energy) * 2),
      new ButtonBuilder().setCustomId('mine_buy_energy_cap').setLabel('🔋 Kapasite +5').setStyle(ButtonStyle.Secondary).setDisabled(allCapBought || bal < 2000),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mine_buy_bread').setLabel('🍞 Ekmek 50c').setStyle(ButtonStyle.Success).setDisabled(bal < 50),
      new ButtonBuilder().setCustomId('mine_buy_soup').setLabel('🍲 Çorba 100c').setStyle(ButtonStyle.Success).setDisabled(bal < 100),
      new ButtonBuilder().setCustomId('mine_buy_meat').setLabel('🥩 Et 300c').setStyle(ButtonStyle.Success).setDisabled(bal < 300),
    );

    return interaction.reply({ ephemeral: true, content: infoLines, components: [row1, row2] });
  }

  // ── 👷 İŞÇİ SATIN AL ─────────────────────────────────────
  if (id === 'mine_buy_worker') {
    let data = getMiningData(gid, uid);
    data = regenEnergy(data);

    if (data.workerTier >= WORKER_TIERS.length)
      return interaction.reply({ ephemeral: true, content: '✅ Zaten maksimum işçi sayısına ulaştın! (**13 işçi**)' });

    const tierIdx = Math.min(data.workerTier, WORKER_TIERS.length - 1);
    const tier    = WORKER_TIERS[tierIdx];
    const bal     = getBalance(gid, uid).balance;

    if (data.miningLevel < tier.minLevel)
      return interaction.reply({ ephemeral: true, content: `❌ İşçi almak için Madencilik Lv.**${tier.minLevel}** gerekiyor! (Şu an: Lv.${data.miningLevel})` });
    if (bal < tier.price)
      return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! Gerekli: **${tier.price}**, Bakiye: **${bal}**` });

    addBalance(gid, uid, -tier.price);
    data.miners++;
    data.purchasesInTier++;

    if (data.purchasesInTier >= tier.maxPurchases) {
      data.workerTier++;
      data.purchasesInTier = 0;
    }

    saveMiningData(gid, uid, data);

    const newBal = getBalance(gid, uid).balance;
    const allDone = data.workerTier >= WORKER_TIERS.length;
    const nextInfo = allDone
      ? '✅ Maksimum işçi sayısına ulaştın! (13/13)'
      : (() => {
          const nt = WORKER_TIERS[data.workerTier];
          return `📌 Sonraki işçi: **${nt.price}** coin (Lv.${nt.minLevel} gerekli)`;
        })();

    return interaction.reply({
      ephemeral: true,
      content: `✅ Yeni işçi alındı! Toplam işçi: **${data.miners}**\n💰 Kalan: **${newBal}** coin\n${nextInfo}`,
    });
  }

  // ── ⚡ ENERJİ SATIN AL (tam doldurur) ───────────────────
  if (id === 'mine_buy_energy') {
    let data = getMiningData(gid, uid);
    data = regenEnergy(data);
    const maxEnergy = getMiningMaxEnergy(data);
    const bal       = getBalance(gid, uid).balance;
    const missing   = maxEnergy - data.energy;
    // Her eksik enerji başına 2 coin (40 coin = 20 enerji oranı korunur)
    const cost      = missing * 2;

    if (data.energy >= maxEnergy) return interaction.reply({ ephemeral: true, content: `⚡ Enerji zaten dolu! (${data.energy}/${maxEnergy})` });
    if (bal < cost)               return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! Enerjini doldurmak için **${cost} coin** gerekli (${missing} enerji eksik). Bakiye: **${bal}**` });

    addBalance(gid, uid, -cost);
    data.energy = maxEnergy;

    // Enerji XP (doldurulan miktar kadar)
    data.energyXp += missing;
    let energyLvlUp = false;
    while (data.energyXp >= getEnergyXpNeeded(data.energyLevel)) {
      data.energyXp -= getEnergyXpNeeded(data.energyLevel);
      data.energyLevel++;
      energyLvlUp = true;
    }

    saveMiningData(gid, uid, data);
    const newMaxE = getMiningMaxEnergy(data);
    let msg = `✅ Enerji tam dolduruldu! **${data.energy}/${newMaxE}** ⚡\n💰 Harcanan: **${cost} coin** | Kalan: **${getBalance(gid, uid).balance} coin**`;
    if (energyLvlUp) msg += `\n🎉 **Enerji Lv.${data.energyLevel}!** Maksimum enerji **${newMaxE}** oldu!`;
    return interaction.reply({ ephemeral: true, content: msg });
  }

  // ── ⚡ ENERJİ KAPASİTESİ SATIN AL ───────────────────────
  if (id === 'mine_buy_energy_cap') {
    let data = getMiningData(gid, uid);
    data = regenEnergy(data);
    const bal = getBalance(gid, uid).balance;

    if (data.energyCapTier >= ENERGY_CAP_TIERS.length)
      return interaction.reply({ ephemeral: true, content: '✅ Zaten maksimum enerji kapasitesine ulaştın! (+75 enerji)' });

    const capTierIdx = Math.min(data.energyCapTier, ENERGY_CAP_TIERS.length - 1);
    const capTier    = ENERGY_CAP_TIERS[capTierIdx];

    if (bal < capTier.price)
      return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! Enerji kapasitesi için **2000 coin** gerekli. Bakiye: **${bal}**` });

    addBalance(gid, uid, -capTier.price);
    data.energyCapPurchasesInTier++;

    if (data.energyCapPurchasesInTier >= capTier.maxPurchases) {
      data.energyCapTier++;
      data.energyCapPurchasesInTier = 0;
    }

    saveMiningData(gid, uid, data);
    const newMaxE = getMiningMaxEnergy(data);
    const allDone = data.energyCapTier >= ENERGY_CAP_TIERS.length;

    return interaction.reply({
      ephemeral: true,
      content: `✅ Enerji kapasitesi yükseltildi! Yeni max enerji: **${newMaxE}**\n💰 Kalan: **${getBalance(gid, uid).balance}** coin${allDone ? '\n🎉 Maksimum kapasiteye ulaştın!' : ''}`,
    });
  }

  // ── 🍽️ YEMEK SATIN AL ────────────────────────────────────
  if (id === 'mine_buy_bread' || id === 'mine_buy_soup' || id === 'mine_buy_meat') {
    const foodMap = { mine_buy_bread: 'bread', mine_buy_soup: 'soup', mine_buy_meat: 'meat' };
    const food    = MINING_FOODS.find(f => f.key === foodMap[id]);
    const bal     = getBalance(gid, uid).balance;

    if (bal < food.price)
      return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! **${food.emoji} ${food.name}** için **${food.price} coin** gerekli. Bakiye: **${bal}**` });

    let data = getMiningData(gid, uid);
    addBalance(gid, uid, -food.price);

    // Kullanım hakkı ekle (süre bazlı değil, kullanım bazlı)
    if (food.key === 'bread') data.breadUses += food.uses;
    else if (food.key === 'soup') data.soupUses += food.uses;
    else if (food.key === 'meat') data.meatUses += food.uses;

    const totalUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    saveMiningData(gid, uid, data);

    return interaction.reply({
      ephemeral: true,
      content: `✅ **${food.emoji} ${food.name}** satın alındı! +**${food.uses}** kullanım hakkı kazandın.\n🍽️ Toplam yiyecek kullanımı: **${totalUses}**\n💰 Kalan: **${getBalance(gid, uid).balance}** coin`,
    });
  }

  // ── 📖 NASIL OYNANIR? ────────────────────────────────────
  if (id === 'mine_help') {
    const embed = new EmbedBuilder()
      .setTitle('📖 Madencilik — Nasıl Oynanır?')
      .setColor(0x8B4513)
      .addFields(
        {
          name: '⛏️ Madene Gönder',
          value: [
            'İşçilerini madene yollar, maden çıkarırsın.',
            '• Her gezi **işçi başına 1 enerji** harcar',
            '• Lv.1-9: gezi başına **2 maden** | Lv.10-19: **3** | Lv.20+: **5**',
            '• Kaç işçin varsa o kadar maden çıkar (kapasite kadar)',
            '• %40 ihtimalle işçiler acıkır → verim **yarıya düşer**',
          ].join('\n'),
        },
        {
          name: '⚡ Enerji',
          value: [
            '• Başlangıç: **20 enerji** | Her 2 dakikada **+1** otomatik yenilenir',
            '• Enerji XP kazanarak Enerji Level atla → max enerji **+1** artar',
            '• Marketten **2 coin/enerji** ile enerjini tamamen doldurabilirsin',
            '• 🔋 **Enerji Kapasitesi**: 2000 coin = +5 max enerji (max 50 alım, +250 toplam)',
          ].join('\n'),
        },
        {
          name: '👷 İşçi Sistemi',
          value: [
            '• **Başlangıç:** 2 işçi (bedava)',
            '• **1. alım:** 50 coin (Lv.1 gerekli) → 3 işçi',
            '• **2-6. alım:** 200 coin her biri (Lv.10 gerekli) → 8 işçi',
            '• **7-11. alım:** 400 coin her biri (Lv.20 gerekli) → **max 13 işçi**',
          ].join('\n'),
        },
        {
          name: '🍽️ Yemek Sistemi',
          value: [
            'Yiyecek kullanımı bitince işçiler acıkır → verim yarıya düşer.',
            'Her madene gönderimde **1 kullanım** tüketilir. Marketten al:',
            '• 🍞 **Ekmek** — 50 coin → **+20 kullanım hakkı**',
            '• 🍲 **Çorba** — 100 coin → **+30 kullanım hakkı**',
            '• 🥩 **Et** — 300 coin → **+60 kullanım hakkı**',
            '*(Tüketim sırası: ekmek → çorba → et)*',
          ].join('\n'),
        },
        {
          name: '⬛ Maden Değerleri',
          value: [
            '`Kömür/Bakır` → **1** 🪙 | `Demir/Gümüş/Çelik` → **2** 🪙',
            '`Altın` → **3** 🪙 | `Linyit` → **5** 🪙',
            '`Elmas` → **7** 🪙 | `Uranyum` → **10** 🪙',
            '*(Değerli madenler çok nadir düşer)*',
          ].join('\n'),
        },
        {
          name: '🏅 Rütbeler',
          value: [
            '⛏️ Beginner (Lv.1) → 🥉 Bronze (Lv.5) → ⚙️ Iron (Lv.10)',
            '🥇 Gold (Lv.15) → 👑 Master (Lv.20)',
          ].join('\n'),
        },
        {
          name: '⏱️ Cooldown',
          value: 'Her buton için **10 saniye** bekleme süresi vardır.',
        },
      )
      .setFooter({ text: '/madencilik siralama — Sunucu sıralamasını gör' });
    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 📊 PROFİL ────────────────────────────────────────────
  if (id === 'mine_profile') {
    let data = getMiningData(gid, uid);
    data = regenEnergy(data);
    saveMiningData(gid, uid, data);

    const rank      = getMiningRank(data.miningLevel);
    const maxEnergy = getMiningMaxEnergy(data);
    const capacity  = getMiningCapacity(data.miningLevel);
    const totalFoodUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    const isHungry  = totalFoodUses <= 0;
    const hungryStr = isHungry
      ? '😫 Aç — marketten yemek al!'
      : `🍽️ Tok (**${data.breadUses}** 🍞 + **${data.soupUses}** 🍲 + **${data.meatUses}** 🥩 = **${totalFoodUses}** kullanım)`;

    const tierIdx   = Math.min(data.workerTier, WORKER_TIERS.length - 1);
    const tier      = WORKER_TIERS[tierIdx];
    const capTotalPurchases = data.energyCapTier * 5 + (data.energyCapPurchasesInTier || 0);

    const embed = new EmbedBuilder()
      .setTitle(`⛏️ ${interaction.user.username} — Madencilik Profili`)
      .setColor(rank.color)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: '🏅 Rütbe',               value: `${rank.emoji} **${rank.name}** Lv.${data.miningLevel}`, inline: true },
        { name: '📈 Madencilik XP',        value: `${data.miningXp} / ${getMiningXpNeeded(data.miningLevel)}`,    inline: true },
        { name: '👷 İşçi Sayısı',         value: `**${data.miners}** işçi`,                              inline: true },
        { name: '⚡ Enerji',               value: `**${data.energy}** / ${maxEnergy}`,                   inline: true },
        { name: '⚡ Enerji Seviyesi',      value: `Lv.**${data.energyLevel}** (${data.energyXp}/${getEnergyXpNeeded(data.energyLevel)} XP)`, inline: true },
        { name: '🔋 Enerji Kapasitesi',   value: `**${capTotalPurchases}/15** alım (+${capTotalPurchases * 5} max enerji)`, inline: true },
        { name: '🏭 Gezi Kapasitesi',     value: `Gezi başına **${capacity}** maden`,                   inline: true },
        { name: '🍽️ İşçi Durumu',       value: hungryStr,                                              inline: false },
        { name: '📦 Toplam Maden',        value: `**${data.totalOresMined}** adet`,                     inline: true },
        { name: '💰 Sonraki İşçi',        value: `**${tier.price}** coin (Lv.${tier.minLevel})`,        inline: true },
      )
      .setFooter({ text: 'Rütbeler: Bronze(Lv5) • Iron(Lv10) • Gold(Lv15) • Master(Lv20)' });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }
}

// ──────────────────────────────────────────────────────────────
//  SLASH KOMUT TANIMLARI
// ──────────────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  // /setup
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Bot ayar panelini aç (sadece yöneticiler)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // /banka — sisteme katılmak için zorunlu ilk adım
  new SlashCommandBuilder()
    .setName('banka')
    .setDescription('Banka hesabı işlemleri')
    .addSubcommand(s => s.setName('olustur').setDescription('Banka hesabı oluştur (diğer tüm komutlar için zorunlu)')),

  // /yardim
  new SlashCommandBuilder()
    .setName('yardim')
    .setDescription('DeathWish Game komut rehberi'),

  // /bakiye
  new SlashCommandBuilder()
    .setName('bakiye')
    .setDescription('Coin bakiyeni gör')
    .addUserOption(o => o.setName('kullanici').setDescription('Kullanıcı (boş=kendin)')),

  // /ekonomi
  new SlashCommandBuilder()
    .setName('ekonomi')
    .setDescription('Ekonomi komutları')
    .addSubcommand(s => s.setName('gunluk').setDescription('Günlük ödülü al'))
    .addSubcommand(s => s.setName('yatir').setDescription('Bankaya coin yatır').addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('cek').setDescription('Bankadan coin çek').addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('gonder').setDescription('Başka birine coin gönder').addUserOption(o => o.setName('hedef').setDescription('Hedef kullanıcı').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('siralama').setDescription('Coin sıralamasını gör'))
    .addSubcommand(s => s.setName('ver').setDescription('[OWNER] Kullanıcıya coin ver').addUserOption(o => o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('al').setDescription('[OWNER] Kullanıcıdan coin al').addUserOption(o => o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1))),

  // /xp
  new SlashCommandBuilder()
    .setName('xp')
    .setDescription('XP ve seviye komutları')
    .addSubcommand(s => s.setName('seviye').setDescription('Seviye bilgisi').addUserOption(o => o.setName('hedef').setDescription('Kullanıcı (boş=kendin)')))
    .addSubcommand(s => s.setName('siralama').setDescription('Seviye sıralaması'))
    .addSubcommand(s => s.setName('ver').setDescription('[OWNER] Kullanıcıya XP ver').addUserOption(o => o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1))),

  // /ses
  new SlashCommandBuilder()
    .setName('ses')
    .setDescription('Ses süresi komutları')
    .addSubcommand(s => s.setName('benim').setDescription('Kendi ses süren'))
    .addSubcommand(s => s.setName('siralama').setDescription('Ses süresi sıralaması'))
    .addSubcommand(s => s.setName('gorev').setDescription('Günlük ses görevi durumu'))
    .addSubcommand(s => s.setName('sifirla').setDescription('[OWNER] Ses verilerini sıfırla'))
    .addSubcommand(s => s.setName('kapat').setDescription('[OWNER] Ses takip sistemini durdur'))
    .addSubcommand(s => s.setName('ac').setDescription('[OWNER] Ses takip sistemini başlat / mevcut kanalları tara'))
    .addSubcommand(s => s.setName('yeniden-baslat').setDescription('[OWNER] Ses sistemini yeniden başlat (offline → online, mevcut üyeleri senkronize eder)')),

  // /sohbet — günlük mesaj görevi kaldırıldı, artık pasif "her 2 mesaj = 1 coin" sistemi var
  new SlashCommandBuilder()
    .setName('sohbet')
    .setDescription('Sohbet mesaj sayacı komutları')
    .addSubcommand(s => s.setName('siralama').setDescription('Bugünkü mesaj liderliği'))
    .addSubcommand(s => s.setName('durum').setDescription('Pasif coin kazanımı hakkında bilgi'))
    .addSubcommand(s => s.setName('sifirla').setDescription('[OWNER] Sohbet sayaçlarını sıfırla')),

  // /zar
  new SlashCommandBuilder()
    .setName('zar')
    .setDescription('Zar oyunu')
    .addSubcommand(s => s.setName('ust').setDescription('Zarı üst için at (4–6 = üst)'))
    .addSubcommand(s => s.setName('alt').setDescription('Zarı alt için at (1–3 = alt)'))
    .addSubcommand(s => s.setName('bonus').setDescription('Günlük zar bonusu al (+15 coin)')),

  // /yazitura
  new SlashCommandBuilder()
    .setName('yazitura')
    .setDescription('Yazı/tura oyunu (kazanırsan +2, kaybedersen -1 coin)')
    .addStringOption(o => o.setName('secim').setDescription('yazı veya tura').setRequired(true)
      .addChoices({ name: 'yazı', value: 'yazı' }, { name: 'tura', value: 'tura' })),

  // /yazioyunu
  new SlashCommandBuilder()
    .setName('yazioyunu')
    .setDescription('Yazı oyunu komutları')
    .addSubcommand(s => s.setName('baslat').setDescription('Yazı oyununu başlat'))
    .addSubcommand(s => s.setName('iptal').setDescription('Aktif yazı oyununu iptal et (yetkili)'))
    .addSubcommand(s => s.setName('bonus').setDescription('Günlük yazı bonusu al (+15 coin)')),

  // /evlilik (evlen ve eşim artık ayrı, kısa üst düzey komutlar: /evlen, /eşim)
  new SlashCommandBuilder()
    .setName('evlilik')
    .setDescription('Evlilik komutları')
    .addSubcommand(s => s.setName('yuzuk-al').setDescription('Evlilik yüzüğü satın al (150 coin)'))
    .addSubcommand(s => s.setName('yuzugum').setDescription('Yüzük durumunu gör'))
    .addSubcommand(s => s.setName('bosan').setDescription('Eşinden boşan (50 coin ücret + 80 coin nafaka)'))
    .addSubcommand(s => s.setName('liste').setDescription('Tüm evlilik listesi'))
    .addSubcommand(s => s.setName('ciftyazitura').setDescription('Evlilere özel çift yazı tura (günlük 10 kez)').addStringOption(o => o.setName('secim').setDescription('yazı veya tura').setRequired(true).addChoices({ name: 'yazı', value: 'yazı' }, { name: 'tura', value: 'tura' }))),

  // /evlen — kısa komut (eskiden /evlilik evlen)
  new SlashCommandBuilder()
    .setName('evlen')
    .setDescription('Evlilik teklifi et')
    .addUserOption(o => o.setName('hedef').setDescription('Teklif etmek istediğin kişi').setRequired(true)),

  // /esim — kısa komut (eskiden /evlilik esim)
  new SlashCommandBuilder()
    .setName('esim')
    .setDescription('Eşini gör'),

  // /market
  new SlashCommandBuilder()
    .setName('market')
    .setDescription('Market komutları')
    .addSubcommand(s => s.setName('liste').setDescription('Market listesi'))
    .addSubcommand(s => s.setName('al').setDescription('Marketten rol satın al').addStringOption(o => o.setName('rolid').setDescription('Rol ID\'si').setRequired(true)))
    .addSubcommand(s => s.setName('iade').setDescription('Marketten aldığın rolü iade et').addStringOption(o => o.setName('rolid').setDescription('Rol ID\'si').setRequired(true)))
    .addSubcommand(s => s.setName('esyalar').setDescription('Özel eşyaları gör (Hırsızlık Kalkanı, Geçici XP Boost)'))
    .addSubcommand(s => s.setName('esya-al').setDescription('Özel eşya satın al').addStringOption(o => o.setName('esya').setDescription('Eşya').setRequired(true)
      .addChoices(
        { name: '🛡️ Hırsızlık Kalkanı (450 coin, 4 saat)', value: 'kalkan' },
        { name: '⚡ Geçici XP Boost (400 coin, 50 kullanım, 2x)', value: 'gecici_boost' },
      ))),

  // /market-yonet (admin)
  new SlashCommandBuilder()
    .setName('market-yonet')
    .setDescription('Market rol yönetimi (yönetici)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('ekle').setDescription('Markete rol ekle').addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true)).addIntegerOption(o => o.setName('fiyat').setDescription('Coin fiyatı').setRequired(true).setMinValue(1)).addBooleanOption(o => o.setName('premium').setDescription('Premium?')))
    .addSubcommand(s => s.setName('cikar').setDescription('Marketten rol çıkar').addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand(s => s.setName('liste').setDescription('Market rol listesi')),

  // /renkrolekle (owner-only, normal rol ekle gibi — rol seç/ID yapıştır)
  new SlashCommandBuilder()
    .setName('renkrolekle')
    .setDescription('[OWNER] Renk rolleri listesine rol ekle')
    .addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true))
    .addIntegerOption(o => o.setName('fiyat').setDescription('Coin fiyatı (boş=50)').setMinValue(1)),

  // /oyunlar (çal artık ayrı, kısa üst düzey komut: /çal)
  new SlashCommandBuilder()
    .setName('oyunlar')
    .setDescription('Eğlence / oyun komutları')
    .addSubcommand(s => s.setName('sanskutusu').setDescription('Şans kutusu aç (8 coin, günlük 5 hak)')),

  // /çal — kısa komut (eskiden /oyunlar cal)
  new SlashCommandBuilder()
    .setName('çal')
    .setDescription('Birinin coinini çalmaya çalış')
    .addUserOption(o => o.setName('hedef').setDescription('Hedef kullanıcı').setRequired(true)),

  // /xpboost (kalıcı)
  new SlashCommandBuilder()
    .setName('xpboost')
    .setDescription('Kalıcı 2x XPBoost satın al (4000 coin)'),

  // /renk — isim rengi rolleri
  new SlashCommandBuilder()
    .setName('renk')
    .setDescription('İsim rengi rolü komutları')
    .addSubcommand(s => s.setName('al').setDescription('Renk rolü satın al (4000 coin, sadece 1 tane sahip olabilirsin)'))
    .addSubcommand(s => s.setName('liste').setDescription('Mevcut renk rollerini gör')),

  // /balik — balıkçılık
  new SlashCommandBuilder()
    .setName('balik')
    .setDescription('Balıkçılık komutları')
    .addSubcommand(s => s.setName('tut').setDescription('Balık tutmayı dene'))
    .addSubcommand(s => s.setName('envanter').setDescription('Balık envanterini gör'))
    .addSubcommand(s => s.setName('boost-al').setDescription('Balıkçılık Şansı Boost satın al (2000 coin, 100 kullanım)'))
    .addSubcommand(s => s.setName('durum').setDescription('Boost durumunu gör')),

  // /balik-market
  new SlashCommandBuilder()
    .setName('balik-market')
    .setDescription('Balık marketi')
    .addSubcommand(s => s.setName('liste').setDescription('Balık fiyat listesi')),

  // /balik-sat
  new SlashCommandBuilder()
    .setName('balik-sat')
    .setDescription('Envanterindeki tüm balıkları markete sat'),

  // /yirmibir — blackjack
  new SlashCommandBuilder()
    .setName('yirmibir')
    .setDescription('Blackjack (21) oyna — botla')
    .addIntegerOption(o => o.setName('bahis').setDescription('Bahis miktarı').setRequired(true).setMinValue(1)),

  // /atyarisi — at yarışı (çok oyunculu bahis)
  new SlashCommandBuilder()
    .setName('atyarisi')
    .setDescription('At yarışına bahis koy (20 saniyelik paylaşımlı yarış penceresi)')
    .addIntegerOption(o => o.setName('at').setDescription('At numarası (1-6)').setRequired(true).setMinValue(1).setMaxValue(6))
    .addIntegerOption(o => o.setName('bahis').setDescription('Bahis miktarı').setRequired(true).setMinValue(1)),

  // /sifirla (owner)
  new SlashCommandBuilder()
    .setName('sifirla')
    .setDescription('[OWNER] Sunucu verilerini sıfırla')
    .addSubcommand(s => s.setName('hersey').setDescription('[OWNER] Tüm sunucu verilerini sil')),

  // /verikaydet (owner)
  new SlashCommandBuilder()
    .setName('verikaydet')
    .setDescription('[OWNER] Veritabanını GitHub reposuna yedekle'),

  // /backuplist (owner)
  new SlashCommandBuilder()
    .setName('backuplist')
    .setDescription('[OWNER] GitHub\'daki tüm backup dosyalarını listele'),

  // /veriyukle (owner)
  new SlashCommandBuilder()
    .setName('veriyukle')
    .setDescription('[OWNER] GitHub\'dan seçilen backup\'ı geri yükle')
    .addStringOption(o => o.setName('dosya').setDescription('Backup dosyasının tam yolu (backuplist\'ten kopyala)').setRequired(true)),

  // /backupsil (owner)
  new SlashCommandBuilder()
    .setName('backupsil')
    .setDescription('[OWNER] GitHub\'daki bir backup dosyasını sil')
    .addStringOption(o => o.setName('dosya').setDescription('Backup dosyasının tam yolu (backuplist\'ten kopyala)').setRequired(true)),

  // /madencilik
  new SlashCommandBuilder()
    .setName('madencilik')
    .setDescription('Madencilik oyunu komutları')
    .addSubcommand(s => s.setName('panel').setDescription('[OWNER] Madencilik panelini kanala gönder'))
    .addSubcommand(s => s.setName('siralama').setDescription('Madencilik sıralamasını gör')),

].map(c => c.toJSON());

// ──────────────────────────────────────────────────────────────
//  CLIENT
// ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ──────────────────────────────────────────────────────────────
//  READY
// ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot aktif: ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'DeathWish Game | /yardim', type: ActivityType.Playing }], status: 'online' });

  try {
    const rest = new REST().setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: SLASH_COMMANDS });
    console.log(`✅ ${SLASH_COMMANDS.length} slash komutu kaydedildi.`);
  } catch (e) { console.error('⛔ Slash kayıt hatası:', e); }

  // Bot yeniden başladığında o an seste olan herkesi voiceJoinTimes'a kaydet.
  // Böylece bot restart sonrası devam eden oturumların süresi kaybolmaz.
  try {
    let toplam = 0;
    for (const guild of client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.type !== 2) continue; // 2 = GuildVoice
        for (const [memberId, member] of channel.members) {
          if (member.user.bot) continue;
          const key = `${guild.id}:${memberId}`;
          voiceJoinTimes.set(key, Date.now());
          toplam++;
        }
      }
    }
    if (toplam > 0) console.log(`🎙️ Başlangıç ses taraması: ${toplam} aktif üye senkronize edildi.`);
  } catch (e) { console.error('⛔ Ses tarama hatası:', e); }
});

// Her 14 dakikada presence yenile
setInterval(() => {
  client.user?.setPresence({ activities: [{ name: 'DeathWish Game | /yardim', type: ActivityType.Playing }], status: 'online' });
}, 14 * 60 * 1000);

// ──────────────────────────────────────────────────────────────
//  SES TAKİBİ + GÜNLÜK SES GÖREVİ
// ──────────────────────────────────────────────────────────────
const VOICE_TIERS = [
  { needSec: 3600, reward: 160, label: '60 dk → +160 coin' },
  { needSec: 1800, reward: 80,  label: '30 dk → +80 coin'  },
  { needSec:  600, reward: 40,  label: '10 dk → +40 coin'  },
];

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    const gid = guild?.id;
    const uid = newState.id || oldState.id;
    if (!gid || !uid) return;
    if (voiceSystemPaused.has(gid)) return;
    const key = `${gid}:${uid}`;
    const was = oldState.channelId, now = newState.channelId;
    const day = todayTR();

    // Çıkış
    if (was && (!now || now !== was)) {
      const start = voiceJoinTimes.get(key);
      if (start) {
        const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
        addVoiceTime(gid, uid, diffSec);
        voiceJoinTimes.delete(key);
        const prev = voiceDailySec.get(`${key}:${day}`) || 0;
        voiceDailySec.set(`${key}:${day}`, prev + diffSec);
        await checkVoiceReward(guild, uid, prev + diffSec, day);
      }
    }
    // Katılış
    if (now && (!was || was !== now)) voiceJoinTimes.set(key, Date.now());

    // Ses logu (log_voice_channel = mevcut anahtar; log_voice_channel da aynı)
    const logCh = getSetting(gid, 'log_voice_channel');
    if (logCh) {
      const ch = guild.channels.cache.get(logCh);
      if (ch) {
        const embed = new EmbedBuilder().setColor(0xEB459E).setTimestamp();
        if (!was && now) {
          embed.setTitle('🎙️ Ses Kanalı — Katılım').addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Kanal', value: `<#${now}>`, inline: true },
          );
        } else if (was && !now) {
          embed.setTitle('🔇 Ses Kanalı — Ayrılış').addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Kanal', value: `<#${was}>`, inline: true },
          );
        } else if (was && now && was !== now) {
          embed.setTitle('🔀 Ses Kanalı — Geçiş').addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Eski', value: `<#${was}>`, inline: true },
            { name: 'Yeni', value: `<#${now}>`, inline: true },
          );
        }
        if (embed.data.title) ch.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (e) {
    sendErrorLog(null, 'voiceStateUpdate', e);
  }
});

async function checkVoiceReward(guild, uid, totalSec, day) {
  const gid = guild.id;
  if (!hasBankAccount(gid, uid)) return; // banka hesabı yoksa ses ödülü de birikmesin
  const claimKey = `${gid}:${uid}:${day}`;
  if (voiceDailyClaimed.get(claimKey)) return;
  const tier = VOICE_TIERS.find(t => totalSec >= t.needSec);
  if (!tier) return;
  const boost = getBoostMultiplier(gid, uid);
  const reward = Math.round(tier.reward * boost);
  addBalance(gid, uid, reward);
  voiceDailyClaimed.set(claimKey, true);

  // Coin log
  sendLog(gid, 'coin', new EmbedBuilder()
    .setTitle('💰 Coin — Ses Görevi Ödülü')
    .setColor(0xF1C40F)
    .addFields(
      { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
      { name: 'Ödül', value: `+${reward} coin`, inline: true },
      { name: 'Tier', value: tier.label, inline: true },
    )
    .setTimestamp()
  );

  const voiceLogCh = getSetting(gid, 'log_voice_channel');
  if (voiceLogCh) {
    const ch = guild.channels.cache.get(voiceLogCh);
    if (ch?.isTextBased?.()) {
      ch.send(`🎧 <@${uid}> günlük ses görevini tamamladı! **+${reward} coin** (${tier.label}${boost > 1 ? ' • Boost 🔥' : ''})`).catch(() => {});
    }
  }
}

// Aktif ses oturumlarını 30 saniyede bir kontrol et
setInterval(async () => {
  try {
    for (const [key, startedAt] of voiceJoinTimes.entries()) {
      const [gid, uid] = key.split(':');
      if (voiceSystemPaused.has(gid)) continue;
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const day = todayTR();
      const base = voiceDailySec.get(`${key}:${day}`) || 0;
      const live = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      await checkVoiceReward(guild, uid, base + live, day);
    }
  } catch {}
}, 30_000);

// ──────────────────────────────────────────────────────────────
//  HATA LOG YARDIMCISI (tüm try/catch'lerde kullanılır)
// ──────────────────────────────────────────────────────────────
function sendErrorLog(gid, context, err) {
  try {
    const stack = err?.stack || String(err);
    const embed = new EmbedBuilder()
      .setTitle('⛔ Hata Logu')
      .setColor(0xED4245)
      .addFields(
        { name: 'Bağlam', value: String(context || 'bilinmiyor') },
        { name: 'Hata', value: `\`\`\`${String(err?.message || err).slice(0, 500)}\`\`\`` },
        { name: 'Stack', value: `\`\`\`${stack.slice(0, 800)}\`\`\`` },
      )
      .setTimestamp();

    // Tüm guild'lere gönder (gid yoksa)
    if (gid) {
      sendLog(gid, 'error', embed);
    } else {
      for (const guild of client.guilds.cache.values()) {
        sendLog(guild.id, 'error', embed);
      }
    }
  } catch {}
}

// ──────────────────────────────────────────────────────────────
//  SLASH COMMAND LOG YARDIMCISI
// ──────────────────────────────────────────────────────────────
function sendSlashLog(interaction) {
  try {
    const gid = interaction.guild?.id;
    if (!gid) return;
    const sub = interaction.options?.getSubcommand?.(false) || '';
    const fullCmd = sub ? `/${interaction.commandName} ${sub}` : `/${interaction.commandName}`;
    const embed = new EmbedBuilder()
      .setTitle('📝 Slash Komut Logu')
      .setColor(0x5865F2)
      .addFields(
        { name: 'Kullanıcı', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: 'Komut', value: `\`${fullCmd}\``, inline: true },
        { name: 'Sunucu', value: interaction.guild?.name || 'DM', inline: true },
        { name: 'Kanal', value: `<#${interaction.channelId}>`, inline: true },
        { name: 'Saat', value: nowTR(), inline: true },
      )
      .setTimestamp();
    sendLog(gid, 'slash', embed);
  } catch {}
}

// ──────────────────────────────────────────────────────────────
//  MESAJ CREATE — XP KAZANMA + SOHBET SAYACI (pasif, ! YOK)
// ──────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const gid = message.guild.id;
  const uid = message.author.id;
  const cid = message.channel.id;

  // ── XP KAZANMA (pasif, otomatik) ────────────────────────────
  // Not: XP kazanma ve seviye atlayınca verilen rol, banka hesabı olmasa
  // da çalışır — sadece coin ile ilgili sistemler banka hesabı istiyor.
  try {
    const xpGained = Math.round((Math.floor(Math.random() * 5) + 1) * 1.15);
    const result = addXp(gid, uid, xpGained);

    // XP Log
    sendLog(gid, 'xp', new EmbedBuilder()
      .setTitle('⚡ XP Kazanıldı')
      .setColor(0x57F287)
      .addFields(
        { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
        { name: 'XP', value: `+${xpGained}`, inline: true },
        { name: 'Toplam', value: `${getLevel(gid, uid).xp} XP`, inline: true },
      )
      .setTimestamp()
    );

    if (result.leveled) {
      const lvlCh = getSetting(gid, 'level_channel');
      const ch = lvlCh ? message.guild.channels.cache.get(lvlCh) : message.channel;
      if (ch) ch.send(`🎉 <@${uid}> seviye atladı! Yeni seviye: **${result.newLevel}** 🏆`).catch(() => {});

      // Level Log
      sendLog(gid, 'level', new EmbedBuilder()
        .setTitle('🏆 Seviye Atlandı!')
        .setColor(0xFFD700)
        .addFields(
          { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
          { name: 'Yeni Seviye', value: `${result.newLevel}`, inline: true },
        )
        .setTimestamp()
      );

      const rewardRoleId = LEVEL_ROLE_REWARDS[result.newLevel];
      if (rewardRoleId) {
        try {
          const member = message.member || await message.guild.members.fetch(uid);
          if (member && !member.roles.cache.has(rewardRoleId)) {
            await member.roles.add(rewardRoleId);
          }
        } catch (e) { console.error('Seviye rol ödülü verilemedi:', e); }
      }
    }
  } catch {}

  // ── SOHBET MESAJ SAYACI + PASİF COIN (her 2 mesaj = 1 coin) ─
  // Coin ödülü banka hesabı ister — hesabı yoksa mesaj sayılır ama coin verilmez.
  const sohbetCh = getSetting(gid, 'sohbet_channel');
  if (sohbetCh && cid === sohbetCh && hasBankAccount(gid, uid)) {
    addMsgCount(gid, cid, uid, todayTR());
    const total = incChatCoinCounter(gid, uid);
    if (total % 2 === 0) {
      const mult = getBoostMultiplier(gid, uid);
      const reward = Math.max(1, Math.round(10 * mult));
      addBalance(gid, uid, reward);
      sendLog(gid, 'coin', new EmbedBuilder()
        .setTitle('💰 Coin — Sohbet (pasif)')
        .setColor(0xF1C40F)
        .addFields(
          { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
          { name: 'Ödül', value: `+${reward} coin`, inline: true },
          { name: 'Mesaj Sayısı', value: `${total}`, inline: true },
        )
        .setTimestamp()
      );
    }
  }

  // ── YAZIYOYUNU CEVAP DİNLEME (pasif) ────────────────────────
  const yaziCh = getSetting(gid, 'yazi_oyunu_channel');
  if (yaziCh && cid === yaziCh && activeTypingGames.has(cid) && !message.content.startsWith('/')) {
    const game  = activeTypingGames.get(cid);
    const guess = normalizeTR(message.content);
    const target = normalizeTR(game.sentence);
    if (guess && guess === target) {
      clearTimeout(game.timeoutId);
      activeTypingGames.delete(cid);
      const day = todayTR();
      const winsKey = `${gid}:${uid}:${day}`;
      const winsToday = dailyTypingWins.get(winsKey) || 0;
      if (winsToday >= 4) {
        return void message.channel.send(`⛔ **${message.author.username}**, bugün yazı oyunundan **4 ödül** aldın. Yarın tekrar dene!`);
      }
      dailyTypingWins.set(winsKey, winsToday + 1);
      addBalance(gid, uid, 30);

      // Coin log
      sendLog(gid, 'coin', new EmbedBuilder()
        .setTitle('💰 Coin — Yazı Oyunu')
        .setColor(0xF1C40F)
        .addFields(
          { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
          { name: 'Ödül', value: '+30 coin', inline: true },
        )
        .setTimestamp()
      );

      return void message.channel.send(`🏆 **${message.author.username}** doğru yazdı ve **+30 coin** kazandı! (Günlük: **${winsToday + 1}/4**)\n> _${game.sentence}_`);
    }
  }
});

// ──────────────────────────────────────────────────────────────
//  INTERACTION CREATE (slash + buton + select menu)
// ──────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {

    // ── KANAL KISITLAMASI ────────────────────────────────────
    // Tüm slash komutları yalnızca GAME_CHANNEL_ID kanalında çalışır.
    // Ownerlar (OWNERS listesi veya OWNER_ROLE_ID rolü) her kanaldan kullanabilir.
    if (interaction.isChatInputCommand() && interaction.guild) {
      const _uid = interaction.user.id;
      if (interaction.channelId !== GAME_CHANNEL_ID && !hasOwnerAccess(_uid, interaction.member)) {
        return interaction.reply({
          ephemeral: true,
          content: `⛔ Komutları yalnızca <#${GAME_CHANNEL_ID}> kanalında kullanabilirsin.`,
        });
      }
    }

    // ── SETUP PANELİ ─────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      return sendSetupPanel(interaction);
    }

    // ── RENK ROLÜ SEÇİM MENÜSÜ ────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('renkpick_')) {
      const ownerUid = interaction.customId.split('_')[1];
      if (interaction.user.id !== ownerUid) return interaction.reply({ ephemeral: true, content: 'Bu menü sana ait değil.' });
      const roleId = interaction.values[0];
      const gid2 = interaction.guild.id;
      const cr = getColorRoles(gid2).find(r => r.roleId === roleId);
      if (!cr) return interaction.update({ content: '⛔ Bu rol artık listede yok.', components: [] });
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) return interaction.update({ content: '⛔ Rol sunucuda bulunamadı.', components: [] });
      const me = interaction.guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
        return interaction.update({ content: '⛔ Bu rolü yönetemiyorum (hiyerarşi/izin).', components: [] });
      }
      const member = interaction.member;
      if (member.roles.cache.has(roleId)) return interaction.update({ content: 'ℹ️ Bu role zaten sahipsin.', components: [] });
      const bal = getBalance(gid2, ownerUid);
      if (bal.balance < cr.price) return interaction.update({ content: `⛔ Yetersiz coin! Gerekli: **${cr.price}**, Bakiye: **${bal.balance}**`, components: [] });

      // Önceki renk rolünü kaldır (sadece 1 tane sahip olunabilir)
      const allColorRoleIds = getColorRoles(gid2).map(r => r.roleId);
      const owned = allColorRoleIds.filter(rid => member.roles.cache.has(rid));
      for (const rid of owned) await member.roles.remove(rid).catch(() => {});
      await member.roles.add(roleId).catch(() => {});
      addBalance(gid2, ownerUid, -cr.price);

      sendLog(gid2, 'market', new EmbedBuilder()
        .setTitle('🎨 Renk Rolü Satın Alındı')
        .setColor(0xEB459E)
        .addFields(
          { name: 'Kullanıcı', value: `<@${ownerUid}>`, inline: true },
          { name: 'Rol', value: `<@&${roleId}>`, inline: true },
          { name: 'Fiyat', value: `${cr.price} coin`, inline: true },
        ).setTimestamp()
      );

      return interaction.update({ content: `✅ <@&${roleId}> renk rolünü aldın! **-${cr.price}** coin. Bakiye: **${getBalance(gid2, ownerUid).balance}**`, components: [] });
    }

    // ── SETUP SELECT MENÜ / BUTON ─────────────────────────────
    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      const [prefix, ...rest] = (interaction.customId || '').split('_');
      if (prefix === 'setup') return handleSetupInteraction(interaction, rest.join('_'));
    }

    // ── EVLİLİK / ÇALMA BUTONLARI — collector'da işleniyor ───
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('macc_') || id.startsWith('mrej_')) return;
      if (id.startsWith('cancel_steal_')) return;
      if (id.startsWith('restore_yes_') || id.startsWith('restore_no_')) return;
      if (id.startsWith('backupsil_yes_') || id.startsWith('backupsil_no_')) return;
      if (id.startsWith('bj_hit_') || id.startsWith('bj_stand_')) return;
    }

    // ── MADENCİLİK BUTONLARI ─────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('mine_')) {
      return handleMineButton(interaction);
    }

    if (!interaction.isChatInputCommand()) return;
    const gid = interaction.guild?.id;
    const uid = interaction.user.id;
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand?.(false) || null;

    // Slash command log — tüm komutlar için
    sendSlashLog(interaction);

    // ─────────────────────────────────────────────────────────
    //  /banka — hesap açmadan diğer hiçbir komut çalışmaz
    // ─────────────────────────────────────────────────────────
    if (gid && !BANK_EXEMPT_COMMANDS.has(cmd) && !hasBankAccount(gid, uid)) {
      return interaction.reply({
        ephemeral: true,
        content: '🏦 Önce bir banka hesabı açman gerekiyor! `/banka olustur` komutunu kullan.',
      });
    }

    if (cmd === 'banka') {
      if (sub === 'olustur') {
        if (interaction.channelId !== GAME_CHANNEL_ID) {
          return interaction.reply({ ephemeral: true, content: `⛔ Bu komutu yalnızca <#${GAME_CHANNEL_ID}> kanalında kullanabilirsin.` });
        }
        if (hasBankAccount(gid, uid)) {
          return interaction.reply({ ephemeral: true, content: '🏦 Zaten bir banka hesabın var.' });
        }
        createBankAccount(gid, uid);
        setShield(gid, uid, 6 * 60 * 60 * 1000); // yeni hesaplara 6 saat hırsızlık koruması
        sendLog(gid, 'economy', new EmbedBuilder().setTitle('🏦 Banka Hesabı Açıldı').setColor(0x2ECC71)
          .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
        return interaction.reply(`🏦 Banka hesabın oluşturuldu! Artık tüm komutları kullanabilirsin.\n🛡️ Ayrıca **6 saatlik hırsızlık koruması** kazandın.`);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /yardim
    // ─────────────────────────────────────────────────────────
    if (cmd === 'yardim') {
      const embed = new EmbedBuilder()
        .setTitle('📘 DeathWish Game — Komut Rehberi')
        .setColor(0x5865F2)
        .setDescription('Tüm komutlar `/` ile çalışır.')
        .addFields(
          {
            name: '🏦 Başlangıç',
            value: '`/banka olustur` — Banka hesabı aç (**zorunlu**, açmadan diğer komutlar çalışmaz). 6 saatlik hırsızlık koruması hediye!',
          },
          {
            name: '💰 Ekonomi',
            value: [
              '`/bakiye` — Coin bakiyesi',
              '`/ekonomi gunluk` — Günlük ödül',
              '`/ekonomi yatir/cek` — Banka işlemleri',
              '`/ekonomi gonder` — Coin gönder',
              '`/ekonomi siralama` — Coin sıralaması',
            ].join('\n'),
          },
          {
            name: '📊 Seviye / XP',
            value: [
              '`/xp seviye` — Seviye bilgisi',
              '`/xp siralama` — Seviye sıralaması',
            ].join('\n'),
          },
          {
            name: '🎙️ Ses Takibi',
            value: [
              '`/ses benim` — Kendi ses süren',
              '`/ses siralama` — Ses sıralaması',
              '`/ses gorev` — Günlük ses görevi',
            ].join('\n'),
          },
          {
            name: '💬 Sohbet',
            value: [
              '`/sohbet siralama` — Bugünkü mesaj liderleri',
              '`/sohbet durum` — Pasif coin kazanımı (her 2 mesaj = 10 coin)',
            ].join('\n'),
          },
          {
            name: '🎮 Oyunlar',
            value: [
              '`/zar ust` / `/zar alt` — Zar oyunu (+3/-1 coin)',
              '`/yazitura secim:` — Yazı/tura oyunu (+20/-10 coin)',
              '`/zar bonus` — Günlük +120 coin',
              '`/yazioyunu baslat` — Yazı oyunu (günlük 4 ödül)',
              '`/yazioyunu bonus` — Günlük +120 coin',
              '`/oyunlar sanskutusu` — Şans kutusu (8 coin)',
              '`/çal @hedef` — Coinini çal',
              '`/yirmibir bahis:` — Blackjack (botla, 2x / ~%0.1 ihtimalle 5x)',
              '`/atyarisi at: bahis:` — At yarışı (paylaşımlı, 2x / ~%0.1 ihtimalle 5x)',
            ].join('\n'),
          },
          {
            name: '🎣 Balıkçılık',
            value: [
              '`/balik tut` — Balık tutmayı dene',
              '`/balik envanter` — Envanterini gör',
              '`/balik boost-al` — Şans Boost (2000 coin, 100 kullanım)',
              '`/balik-market liste` — Balık fiyat listesi',
              '`/balik-sat` — Tüm balıkları markete sat',
            ].join('\n'),
          },
          {
            name: '💍 Evlilik',
            value: [
              '`/evlilik yuzuk-al` — Yüzük al (150 coin)',
              '`/evlen @kişi` — Evlilik teklifi et',
              '`/esim` — Eşini gör',
              '`/evlilik bosan` — Boşan (130 coin)',
              '`/evlilik liste` — Tüm evlilikler',
              '`/evlilik ciftyazitura` — Evlilere özel oyun',
            ].join('\n'),
          },
          {
            name: '🛒 Market',
            value: [
              '`/market liste` — Market listesi',
              '`/market al <rolid>` — Rol satın al',
              '`/market iade <rolid>` — Rol iade et',
              '`/market esyalar` — Özel eşyalar (Kalkan, Geçici Boost)',
              '`/market esya-al` — Özel eşya satın al',
              '`/xpboost` — Kalıcı 2x boost (4000 coin)',
              '`/renk al` — İsim rengi rolü satın al (4000 coin)',
              '`/renk liste` — Renk rollerini listele',
            ].join('\n'),
          },
          {
            name: '⚙️ Yönetim',
            value: [
              '`/setup` — Bot ayarları (admin)',
              '`/renkrolekle` — Renk rolü ekle (owner)',
              '`/market-yonet ekle/cikar/liste` — Market yönetimi',
              '`/ses sifirla` — Ses verisi sıfırla (owner)',
              '`/sohbet sifirla` — Sohbet verisi sıfırla (owner)',
              '`/xp ver` — XP ver (owner)',
              '`/ekonomi ver/al` — Coin ver/al (owner)',
              '`/sifirla hersey` — Tüm veri sıfırla (owner)',
              '`/verikaydet` — GitHub\'a yedekle (owner)',
              '`/backuplist` — Backup listesi (owner)',
              '`/veriyukle` — Backup geri yükle (owner)',
              '`/backupsil` — Backup sil (owner)',
            ].join('\n'),
          },
          {
            name: '⛏️ Madencilik',
            value: [
              '`/madencilik panel` — Madencilik panelini kanala gönder (owner)',
              '`/madencilik siralama` — Madencilik sıralaması',
              '',
              '**Panel butonları** (Madencilik kanalı):',
              '`⛏️ Madene Gönder` — İşçileri madene yolla (her maden gezisi enerji harcar)',
              '`⚡ Enerji` — Enerji durumunu görüntüle (2 dk = +1 enerji)',
              '`🎒 Envanter` — Çıkardığın madenleri gör',
              '`💰 Sat` — Tüm madenleri coin\'e çevir',
              '`🛒 Market` — İşçi/enerji/yemek satın al',
              '`📊 Profil` — Madencilik profilini gör',
              '',
              '**Maden değerleri:** Kömür/Bakır=1🪙 • Demir/Gümüş/Çelik=2🪙 • Altın=3🪙 • Linyit=5🪙 • Elmas=7🪙 • Uranyum=10🪙',
              '**Rütbeler:** ⛏️Beginner → 🥉Bronze(Lv5) → ⚙️Iron(Lv10) → 🥇Gold(Lv15) → 👑Master(Lv20)',
            ].join('\n'),
          }
        )
        .setFooter({ text: 'XP mesaj yazarak otomatik kazanılır • Her 2 mesajda 10 coin otomatik verilir' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ─────────────────────────────────────────────────────────
    //  /bakiye
    // ─────────────────────────────────────────────────────────
    if (cmd === 'bakiye') {
      const target = interaction.options.getUser('kullanici') || interaction.user;
      const bal = getBalance(gid, target.id);
      const embed = new EmbedBuilder()
        .setTitle(`💰 ${target.username} — Bakiye`)
        .setColor(0xF1C40F)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '🪙 Cüzdan', value: `**${bal.balance}** coin`, inline: true },
          { name: '🏦 Banka', value: `**${bal.bank}** coin`, inline: true },
          { name: '💎 Toplam', value: `**${bal.balance + bal.bank}** coin`, inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    // ─────────────────────────────────────────────────────────
    //  /ekonomi
    // ─────────────────────────────────────────────────────────
    if (cmd === 'ekonomi') {
      if (sub === 'gunluk') {
        const day = todayTR();
        const base = parseInt(getSetting(gid, 'daily_reward') || '640');
        if (hasClaimed(gid, uid, day, 'daily')) return interaction.reply({ ephemeral: true, content: '⛔ Bugün zaten aldın. Yarın tekrar gel!' });
        setClaimed(gid, uid, day, 'daily');
        const boost = getBoostMultiplier(gid, uid);
        const reward = Math.floor(base * boost);
        addBalance(gid, uid, reward);

        sendLog(gid, 'coin', new EmbedBuilder()
          .setTitle('💰 Coin — Günlük Ödül')
          .setColor(0xF1C40F)
          .addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Ödül', value: `+${reward} coin`, inline: true },
          )
          .setTimestamp()
        );

        return interaction.reply(`✅ Günlük **+${reward} coin** aldın! ${boost > 1 ? '(Boost 🔥)' : ''}\n💰 Bakiye: **${getBalance(gid, uid).balance}**`);
      }

      if (sub === 'yatir') {
        const amt = interaction.options.getInteger('miktar');
        const bal = getBalance(gid, uid);
        if (bal.balance < amt) return interaction.reply({ ephemeral: true, content: '⛔ Yetersiz cüzdan bakiyesi.' });
        addBalance(gid, uid, -amt);
        addBank(gid, uid, amt);
        sendLog(gid, 'economy', new EmbedBuilder()
          .setTitle('🏦 Ekonomi — Banka Yatırma')
          .setColor(0x3498DB)
          .addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Miktar', value: `${amt} coin`, inline: true },
          ).setTimestamp()
        );
        return interaction.reply(`🏦 **${amt}** coin bankaya yatırıldı.\n💰 Cüzdan: **${getBalance(gid, uid).balance}** | 🏦 Banka: **${getBalance(gid, uid).bank}**`);
      }

      if (sub === 'cek') {
        const amt = interaction.options.getInteger('miktar');
        const bal = getBalance(gid, uid);
        if (bal.bank < amt) return interaction.reply({ ephemeral: true, content: '⛔ Yetersiz banka bakiyesi.' });
        addBank(gid, uid, -amt);
        addBalance(gid, uid, amt);
        sendLog(gid, 'economy', new EmbedBuilder()
          .setTitle('🏦 Ekonomi — Banka Çekme')
          .setColor(0x3498DB)
          .addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Miktar', value: `${amt} coin`, inline: true },
          ).setTimestamp()
        );
        return interaction.reply(`💸 **${amt}** coin bankadan çekildi.\n💰 Cüzdan: **${getBalance(gid, uid).balance}** | 🏦 Banka: **${getBalance(gid, uid).bank}**`);
      }

      if (sub === 'gonder') {
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        if (target.id === uid) return interaction.reply({ ephemeral: true, content: '⛔ Kendine coin gönderemezsin.' });
        if (target.bot) return interaction.reply({ ephemeral: true, content: '⛔ Botlara coin gönderemezsin.' });
        if (!transfer(gid, uid, target.id, amt)) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz bakiye! Bakiye: **${getBalance(gid, uid).balance}**` });
        sendLog(gid, 'economy', new EmbedBuilder()
          .setTitle('💸 Ekonomi — Transfer')
          .setColor(0x3498DB)
          .addFields(
            { name: 'Gönderen', value: `<@${uid}>`, inline: true },
            { name: 'Alan', value: `<@${target.id}>`, inline: true },
            { name: 'Miktar', value: `${amt} coin`, inline: true },
          ).setTimestamp()
        );
        return interaction.reply(`✅ <@${target.id}> kullanıcısına **${amt}** coin gönderildi!\n💰 Kalan bakiyeniz: **${getBalance(gid, uid).balance}**`);
      }

      if (sub === 'siralama') {
        const top = topBalance(gid, 10);
        if (!top.length) return interaction.reply('🏁 Henüz coin verisi yok.');
        const embed = new EmbedBuilder()
          .setTitle('💰 Coin Sıralaması')
          .setColor(0xF1C40F)
          .setDescription(top.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.balance}** coin`).join('\n'));
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'ver') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        addBalance(gid, target.id, amt);
        sendLog(gid, 'coin', new EmbedBuilder()
          .setTitle('💰 Coin — Owner Ekleme')
          .setColor(0xF1C40F)
          .addFields(
            { name: 'Yetkili', value: `<@${uid}>`, inline: true },
            { name: 'Kullanıcı', value: `<@${target.id}>`, inline: true },
            { name: 'Eklenen', value: `+${amt} coin`, inline: true },
          ).setTimestamp()
        );
        return interaction.reply(`✅ <@${target.id}> kullanıcısına **${amt}** coin verildi. Bakiye: **${getBalance(gid, target.id).balance}**`);
      }

      if (sub === 'al') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        addBalance(gid, target.id, -amt);
        sendLog(gid, 'coin', new EmbedBuilder()
          .setTitle('💰 Coin — Owner Çıkarma')
          .setColor(0xED4245)
          .addFields(
            { name: 'Yetkili', value: `<@${uid}>`, inline: true },
            { name: 'Kullanıcı', value: `<@${target.id}>`, inline: true },
            { name: 'Çıkarılan', value: `-${amt} coin`, inline: true },
          ).setTimestamp()
        );
        return interaction.reply(`✅ <@${target.id}> kullanıcısından **${amt}** coin alındı. Bakiye: **${getBalance(gid, target.id).balance}**`);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /xp
    // ─────────────────────────────────────────────────────────
    if (cmd === 'xp') {
      if (sub === 'seviye') {
        const target = interaction.options.getUser('hedef') || interaction.user;
        const lvl = getLevel(gid, target.id);
        const needed = Math.round((lvl.level + 1) * 100 * 0.85);
        const embed = new EmbedBuilder()
          .setTitle(`📊 ${target.username} — Seviye`)
          .setColor(0x57F287)
          .setThumbnail(target.displayAvatarURL())
          .addFields(
            { name: '🏆 Seviye', value: `**${lvl.level}**`, inline: true },
            { name: '⚡ XP', value: `**${lvl.xp} / ${needed}**`, inline: true },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'siralama') {
        const top = topLevels(gid, 10);
        if (!top.length) return interaction.reply('🏁 Henüz seviye verisi yok.');
        const embed = new EmbedBuilder()
          .setTitle('📊 Seviye Sıralaması')
          .setColor(0x57F287)
          .setDescription(top.map((r, i) => `**${i + 1}.** <@${r.userId}> — Seviye **${r.level}**`).join('\n'));
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'ver') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        const result = addXp(gid, target.id, amt);
        let reply = `✅ <@${target.id}> kullanıcısına **${amt}** XP verildi.`;

        sendLog(gid, 'xp', new EmbedBuilder()
          .setTitle('⚡ XP — Owner Ekleme')
          .setColor(0x57F287)
          .addFields(
            { name: 'Yetkili', value: `<@${uid}>`, inline: true },
            { name: 'Kullanıcı', value: `<@${target.id}>`, inline: true },
            { name: 'XP', value: `+${amt}`, inline: true },
          ).setTimestamp()
        );

        if (result.leveled) {
          reply += `\n🎉 Seviye atladı! Yeni seviye: **${result.newLevel}** 🏆`;
          sendLog(gid, 'level', new EmbedBuilder()
            .setTitle('🏆 Seviye Atlandı!')
            .setColor(0xFFD700)
            .addFields(
              { name: 'Kullanıcı', value: `<@${target.id}>`, inline: true },
              { name: 'Yeni Seviye', value: `${result.newLevel}`, inline: true },
            ).setTimestamp()
          );
          const rewardRoleId = LEVEL_ROLE_REWARDS[result.newLevel];
          if (rewardRoleId) {
            try {
              const mbr = interaction.guild.members.cache.get(target.id) || await interaction.guild.members.fetch(target.id);
              if (mbr && !mbr.roles.cache.has(rewardRoleId)) {
                await mbr.roles.add(rewardRoleId);
                reply += `\n🏆 Seviye ödül rolü verildi.`;
              }
            } catch (e) { console.error('Seviye rol ödülü verilemedi:', e); }
          }
        }
        return interaction.reply(reply);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /ses
    // ─────────────────────────────────────────────────────────
    if (cmd === 'ses') {
      if (sub === 'benim') {
        const key = `${gid}:${uid}`;
        let secs = getVoiceTime(gid, uid);
        if (voiceJoinTimes.has(key)) secs += Math.max(0, Math.floor((Date.now() - voiceJoinTimes.get(key)) / 1000));
        return interaction.reply(`🎧 **${interaction.user.username}** — Toplam ses süresi: **${fmtVoice(secs)}**`);
      }

      if (sub === 'siralama') {
        const top = topVoice(gid, 10);
        if (!top.length) return interaction.reply('Ses kanalları bomboş... yankı bile yok 😴');
        const embed = new EmbedBuilder()
          .setTitle('🎙️ Ses Süresi Sıralaması')
          .setColor(0xEB459E)
          .setDescription(top.map((r, i) => `**${i + 1}.** <@${r.userId}> — ${fmtVoice(r.totalSeconds)}`).join('\n'));
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'gorev') {
        const key = `${gid}:${uid}`;
        const day = todayTR();
        const base = voiceDailySec.get(`${key}:${day}`) || 0;
        let total = base;
        if (voiceJoinTimes.has(key)) total += Math.max(0, Math.floor((Date.now() - voiceJoinTimes.get(key)) / 1000));
        const claimed = voiceDailyClaimed.get(`${key}:${day}`);
        const embed = new EmbedBuilder()
          .setTitle('🎧 Günlük Ses Görevi')
          .setColor(0xEB459E)
          .addFields(
            { name: '⏱️ Bugünkü Süre', value: `**${fmtMin(total)}**`, inline: true },
            { name: '📊 Durum', value: claimed ? '✅ Ödül alındı' : '🕒 Devam ediyor', inline: true },
            { name: '🔥 Boost', value: `${getBoostMultiplier(gid, uid, false)}x`, inline: true },
            { name: '🎯 Eşikler', value: VOICE_TIERS.map(t => t.label).join('\n') },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'sifirla') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        resetVoice(gid);
        for (const k of [...voiceJoinTimes.keys()]) {
          if (k.startsWith(`${gid}:`)) voiceJoinTimes.delete(k);
        }
        return interaction.reply('🎙️ Ses verileri sıfırlandı!');
      }

      if (sub === 'kapat') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        // Bellekteki aktif süreleri DB'ye kaydet, sonra map'i temizle
        const day = todayTR();
        for (const [key, startedAt] of voiceJoinTimes.entries()) {
          if (!key.startsWith(`${gid}:`)) continue;
          const [, memberId] = key.split(':');
          const diffSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          if (diffSec > 0) {
            addVoiceTime(gid, memberId, diffSec);
            const prev = voiceDailySec.get(`${key}:${day}`) || 0;
            voiceDailySec.set(`${key}:${day}`, prev + diffSec);
          }
          voiceJoinTimes.delete(key);
        }
        voiceSystemPaused.add(gid);
        sendLog(gid, 'voice', new EmbedBuilder()
          .setTitle('🔴 Ses Sistemi — Kapatıldı')
          .setColor(0xED4245)
          .addFields({ name: 'Yetkili', value: `<@${uid}>` })
          .setTimestamp()
        );
        return interaction.reply({ ephemeral: true, content: '🔴 Ses takip sistemi **kapatıldı**. Aktif süreler DB\'ye kaydedildi. Açmak için `/ses ac` kullan.' });
      }

      if (sub === 'ac') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        voiceSystemPaused.delete(gid);
        // Mevcut ses kanallarındaki tüm üyeleri tara ve voiceJoinTimes'a ekle
        const guild = interaction.guild;
        let tarananUye = 0;
        for (const channel of guild.channels.cache.values()) {
          if (channel.type !== 2) continue; // 2 = GuildVoice
          for (const [memberId, member] of channel.members) {
            if (member.user.bot) continue;
            const key = `${gid}:${memberId}`;
            if (!voiceJoinTimes.has(key)) {
              voiceJoinTimes.set(key, Date.now());
              tarananUye++;
            }
          }
        }
        sendLog(gid, 'voice', new EmbedBuilder()
          .setTitle('🟢 Ses Sistemi — Açıldı')
          .setColor(0x57F287)
          .addFields(
            { name: 'Yetkili', value: `<@${uid}>`, inline: true },
            { name: 'Senkronize Üye', value: `${tarananUye}`, inline: true },
          )
          .setTimestamp()
        );
        return interaction.reply({ ephemeral: true, content: `🟢 Ses takip sistemi **açıldı**. Şu an seste olan **${tarananUye}** üye senkronize edildi.` });
      }

      if (sub === 'yeniden-baslat') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        await interaction.deferReply({ ephemeral: true });
        const day = todayTR();
        // 1. Mevcut bellekteki süreleri DB'ye kaydet
        for (const [key, startedAt] of voiceJoinTimes.entries()) {
          if (!key.startsWith(`${gid}:`)) continue;
          const [, memberId] = key.split(':');
          const diffSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          if (diffSec > 0) {
            addVoiceTime(gid, memberId, diffSec);
            const prev = voiceDailySec.get(`${key}:${day}`) || 0;
            voiceDailySec.set(`${key}:${day}`, prev + diffSec);
          }
          voiceJoinTimes.delete(key);
        }
        // 2. Sistemi kısa süre durdur, sonra yeniden aç
        voiceSystemPaused.add(gid);
        await new Promise(r => setTimeout(r, 500));
        voiceSystemPaused.delete(gid);
        // 3. Mevcut ses kanallarını tara
        const guild = interaction.guild;
        let tarananUye = 0;
        for (const channel of guild.channels.cache.values()) {
          if (channel.type !== 2) continue;
          for (const [memberId, member] of channel.members) {
            if (member.user.bot) continue;
            const key = `${gid}:${memberId}`;
            voiceJoinTimes.set(key, Date.now());
            tarananUye++;
          }
        }
        sendLog(gid, 'voice', new EmbedBuilder()
          .setTitle('🔄 Ses Sistemi — Yeniden Başlatıldı')
          .setColor(0xFEE75C)
          .addFields(
            { name: 'Yetkili', value: `<@${uid}>`, inline: true },
            { name: 'Senkronize Üye', value: `${tarananUye}`, inline: true },
          )
          .setTimestamp()
        );
        return interaction.editReply(`🔄 Ses sistemi yeniden başlatıldı! Şu an seste olan **${tarananUye}** üye senkronize edildi. Sıralama ve süreler artık güncel.`);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /sohbet (günlük görev sistemi kaldırıldı)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'sohbet') {
      const sohbetCh = getSetting(gid, 'sohbet_channel');

      if (sub === 'siralama') {
        if (!sohbetCh) return interaction.reply({ ephemeral: true, content: '⛔ Sohbet kanalı ayarlanmamış. `/setup` ile ayarla.' });
        const top = topMsgs(gid, sohbetCh, todayTR(), 10);
        if (!top.length) return interaction.reply('💬 Bugün mesaj yok.');
        const embed = new EmbedBuilder()
          .setTitle(`💬 Bugünkü Sohbet Liderliği`)
          .setColor(0x3498DB)
          .setDescription(top.map((r, i) => `**${i + 1}.** <@${r.userId}> — ${r.count} mesaj`).join('\n'))
          .setFooter({ text: `Kanal: #${sohbetCh}` });
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'durum') {
        if (!sohbetCh) return interaction.reply({ ephemeral: true, content: '⛔ Sohbet kanalı ayarlanmamış. `/setup` ile ayarla.' });
        return interaction.reply({ ephemeral: true, content: `💬 Sohbet kanalında (**<#${sohbetCh}>**) attığın her **2 mesajda 10 coin** otomatik olarak hesabına ekleniyor. Herhangi bir komuta gerek yok, sadece sohbet et!` });
      }

      if (sub === 'sifirla') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        resetSohbet(gid);
        return interaction.reply('💬 Sohbet liderliği sıfırlandı!');
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /zar
    // ─────────────────────────────────────────────────────────
    if (cmd === 'zar') {
      if (sub === 'bonus') {
        const day = todayTR();
        if (hasClaimed(gid, uid, day, 'zar_bonus')) return interaction.reply({ ephemeral: true, content: '⛔ Bugün zar bonusunu aldın. Yarın gel!' });
        setClaimed(gid, uid, day, 'zar_bonus');
        addBalance(gid, uid, 120);
        sendLog(gid, 'coin', new EmbedBuilder()
          .setTitle('💰 Coin — Zar Bonusu').setColor(0xF1C40F)
          .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }, { name: 'Ödül', value: '+120 coin', inline: true })
          .setTimestamp()
        );
        return interaction.reply(`✅ **+120** zar bonusu eklendi!\n💰 Bakiye: **${getBalance(gid, uid).balance}**`);
      }

      if (sub === 'ust' || sub === 'alt') {
        const secim = sub === 'ust' ? 'üst' : 'alt';
        const roll   = Math.floor(Math.random() * 6) + 1;
        const sonuc  = roll <= 3 ? 'alt' : 'üst';
        const kazandi = secim === sonuc;
        const key    = `${gid}:${uid}`;
        let delta = kazandi ? 30 : -10;
        let extraMsg = '';
        let gifUrl = pick(DICE_GIFS);

        if (!kazandi) {
          const streak = (diceLossStreak.get(key) || 0) + 1;
          diceLossStreak.set(key, streak);
          if (streak >= 2) {
            delta = -40;
            extraMsg = '\n🔥 **Cooked!** İki kez üst üste kaybettin, **-30 ek ceza.**';
            gifUrl = pick(COOKED_GIFS);
            diceLossStreak.set(key, 0);
          }
        } else {
          diceLossStreak.set(key, 0);
        }

        addBalance(gid, uid, delta);
        const newBal = getBalance(gid, uid);
        return interaction.reply({
          content: `🎲 Zar: **${roll}** → **${sonuc.toUpperCase()}** ${kazandi ? 'Kazandın 🎉 (**+30** coin)' : 'Kaybettin 😿 (**-10** coin)'}\n💰 Bakiye: **${newBal.balance}**${extraMsg}`,
          files: [gifUrl],
        });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /yazitura
    // ─────────────────────────────────────────────────────────
    if (cmd === 'yazitura') {
      const secim = interaction.options.getString('secim');
      const sonuc = Math.random() < 0.5 ? 'yazı' : 'tura';
      const kazandi = secim === sonuc;
      const delta = kazandi ? 20 : -10;
      addBalance(gid, uid, delta);
      const newBal = getBalance(gid, uid);
      return interaction.reply(`🪙 **${sonuc.toUpperCase()}** geldi! ${kazandi ? 'Kazandın 🎉 (**+20** coin)' : 'Kaybettin 😿 (**-10** coin)'}\n💰 Bakiye: **${newBal.balance}**`);
    }

    // ─────────────────────────────────────────────────────────
    //  /yazioyunu
    // ─────────────────────────────────────────────────────────
    if (cmd === 'yazioyunu') {
      if (sub === 'bonus') {
        const day = todayTR();
        if (hasClaimed(gid, uid, day, 'yazi_bonus')) return interaction.reply({ ephemeral: true, content: '⛔ Bugün yazı bonusunu aldın. Yarın gel!' });
        setClaimed(gid, uid, day, 'yazi_bonus');
        addBalance(gid, uid, 120);
        return interaction.reply(`✅ **+120** yazı bonusu eklendi!\n💰 Bakiye: **${getBalance(gid, uid).balance}**`);
      }

      if (sub === 'baslat') {
        const yaziCh = getSetting(gid, 'yazi_oyunu_channel');
        const cid = interaction.channelId;
        if (yaziCh && cid !== yaziCh) {
          return interaction.reply({ ephemeral: true, content: `⛔ Yazı oyununu sadece <#${yaziCh}> kanalında başlatabilirsin.` });
        }
        if (activeTypingGames.has(cid)) return interaction.reply({ ephemeral: true, content: '⏳ Bu kanalda zaten aktif bir yazı oyunu var.' });
        const sentence = pick(TYPING_SENTENCES);
        await interaction.reply(`⌨️ **Yazı Oyunu** başlıyor! Aşağıdaki cümleyi **ilk ve doğru** yazan kazanır.\n> ${sentence}\n⏱️ Süre: **60 saniye** • Günlük limit: **4 ödül**`);
        const timeoutId = setTimeout(() => {
          if (activeTypingGames.has(cid)) {
            activeTypingGames.delete(cid);
            interaction.channel.send('⏰ Süre doldu! Kimse doğru yazamadı.').catch(() => {});
          }
        }, 60_000);
        activeTypingGames.set(cid, { sentence, timeoutId });
        return;
      }

      if (sub === 'iptal') {
        if (!hasOwnerAccess(uid, interaction.member) && !interaction.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply({ ephemeral: true, content: '⛔ Bu komutu kullanamazsın.' });
        }
        const cid = interaction.channelId;
        if (!activeTypingGames.has(cid)) return interaction.reply({ ephemeral: true, content: 'ℹ️ Aktif yazı oyunu yok.' });
        clearTimeout(activeTypingGames.get(cid).timeoutId);
        activeTypingGames.delete(cid);
        return interaction.reply('🛑 Yazı oyunu iptal edildi.');
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /evlilik
    // ─────────────────────────────────────────────────────────
    if (cmd === 'evlilik') {
      if (sub === 'yuzuk-al') {
        if (getMarriage(gid, uid)) return interaction.reply({ ephemeral: true, content: 'Zaten evlisin babuş, yüzüğe gerek kalmadı 😅' });
        if (hasRing(gid, uid)) return interaction.reply({ ephemeral: true, content: 'Zaten bir yüzüğün var 💍 Teklif etmeyi dene: `/evlilik evlen`' });
        const bal = getBalance(gid, uid);
        if (bal.balance < 1500) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **1500 coin**, Bakiye: **${bal.balance}**` });
        addBalance(gid, uid, -1500);
        giveRing(gid, uid);
        return interaction.reply('✅ **-1500 coin** ile **tek kullanımlık** bir yüzük aldın! `/evlilik evlen @kişi` ile teklif et 💍');
      }

      if (sub === 'yuzugum') {
        if (hasRing(gid, uid)) return interaction.reply('💍 Bir yüzüğün var. Şansını dene: `/evlilik evlen`');
        if (getMarriage(gid, uid)) return interaction.reply('💍 Evlisin zaten; yüzüğün kalbinde ✨');
        return interaction.reply('💍 Henüz yüzüğün yok. Almak için: `/evlilik yuzuk-al` (1500 coin)');
      }

      if (sub === 'evlen') {
        const target = interaction.options.getUser('hedef');
        if (target.bot) return interaction.reply({ ephemeral: true, content: 'Botlarla evlenemezsin babuş 😅' });
        if (target.id === uid) return interaction.reply({ ephemeral: true, content: 'Kendinle evlenemezsin… ama kendini sevmen güzel 😌' });
        const now2 = Date.now();
        const cdKey = `${gid}:${uid}`;
        if ((now2 - (proposalCooldown.get(cdKey) || 0)) < 5 * 60 * 1000) {
          return interaction.reply({ ephemeral: true, content: '⏳ Biraz bekle. 5 dakikada bir teklif edebilirsin.' });
        }
        if (!hasRing(gid, uid)) return interaction.reply({ ephemeral: true, content: '💍 Önce yüzük al: `/evlilik yuzuk-al` (**1500 coin**)' });
        if (getMarriage(gid, uid)) return interaction.reply({ ephemeral: true, content: 'Zaten evlisin babuş.' });
        if (getMarriage(gid, target.id)) return interaction.reply({ ephemeral: true, content: 'Hedef kişi zaten evli görünüyor.' });
        const accId = `macc_${uid}_${target.id}_${Date.now()}`;
        const rejId = `mrej_${uid}_${target.id}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(accId).setLabel('Kabul Et').setStyle(ButtonStyle.Success).setEmoji('💍'),
          new ButtonBuilder().setCustomId(rejId).setLabel('Reddet').setStyle(ButtonStyle.Danger).setEmoji('❌'),
        );
        await interaction.reply({
          content: `${target}, **${interaction.user.username}** sana **evlilik teklifi** ediyor! 💞`,
          files: [pick(PROPOSAL_HAPPY_GIFS)],
          components: [row],
        });
        const m2 = await interaction.fetchReply();
        let resolved = false;
        const coll = m2.createMessageComponentCollector({
          time: 30000,
          componentType: ComponentType.Button,
          filter: i => (i.customId === accId || i.customId === rejId) && i.user.id === target.id,
        });
        coll.on('collect', async i => {
          resolved = true;
          proposalCooldown.set(cdKey, Date.now());
          if (i.customId === rejId) {
            await i.update({ content: `💔 ${target.username} teklifi **reddetti**.`, files: [pick(PROPOSAL_SAD_GIFS)], components: [] });
            sendLog(gid, 'marriage', new EmbedBuilder().setTitle('💔 Evlilik Teklifi Reddedildi').setColor(0xED4245)
              .addFields({ name: 'Teklif Eden', value: `<@${uid}>`, inline: true }, { name: 'Reddeden', value: `<@${target.id}>`, inline: true }).setTimestamp());
          } else {
            if (!hasRing(gid, uid) || getMarriage(gid, uid) || getMarriage(gid, target.id)) {
              return i.update({ content: '⛔ Teklif geçersiz (durum değişti).', components: [] });
            }
            setMarriage(gid, uid, target.id);
            consumeRing(gid, uid);
            await i.update({ content: `💍 **${interaction.user.username}** ve **${target.username}** artık **EVLİ!** 🎉`, components: [] });
            sendLog(gid, 'marriage', new EmbedBuilder().setTitle('💍 Yeni Evlilik!').setColor(0xFF73FA)
              .addFields({ name: 'Eş 1', value: `<@${uid}>`, inline: true }, { name: 'Eş 2', value: `<@${target.id}>`, inline: true }, { name: 'Tarih', value: nowTR(), inline: true }).setTimestamp());
          }
        });
        coll.on('end', async () => {
          if (!resolved) {
            proposalCooldown.set(cdKey, Date.now());
            await m2.edit({ content: '⏰ Süre doldu, teklif geçersiz oldu.', components: [] }).catch(() => {});
          }
        });
        return;
      }

      if (sub === 'esim') {
        const m = getMarriage(gid, uid);
        if (!m) return interaction.reply('Bekârsın babuş. Belki bugün değişir? `/evlilik evlen`');
        const spouse = m.user1 === uid ? m.user2 : m.user1;
        return interaction.reply(`💞 Eşin: <@${spouse}>\n📅 Evlilik tarihi: **${m.marriedAt}**`);
      }

      if (sub === 'bosan') {
        const m = getMarriage(gid, uid);
        if (!m) return interaction.reply({ ephemeral: true, content: 'Zaten bekârsın babuş.' });
        const spouse = m.user1 === uid ? m.user2 : m.user1;
        const bal = getBalance(gid, uid);
        if (bal.balance < 1300) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin. Boşanma: **500 coin** ücret + **800 coin** nafaka = **1300 coin** gerekir. Bakiye: **${bal.balance}**` });
        addBalance(gid, uid, -500);
        addBalance(gid, uid, -800);
        addBalance(gid, spouse, 800);
        removeMarriage(gid, uid);
        sendLog(gid, 'marriage', new EmbedBuilder().setTitle('📄 Boşanma').setColor(0xED4245)
          .addFields({ name: 'Boşanan', value: `<@${uid}>`, inline: true }, { name: 'Diğer Eş', value: `<@${spouse}>`, inline: true }, { name: 'Nafaka', value: '800 coin', inline: true }).setTimestamp());
        return interaction.reply(`📄 **Boşanma tamam.** **-500 coin** ücret kesildi ve <@${spouse}> kullanıcısına **800 coin** nafaka ödendi. Yolunuz açık olsun 💔`);
      }

      if (sub === 'liste') {
        const couples = allMarriages(gid);
        if (!couples.length) return interaction.reply('Bu sunucuda aktif evlilik yok.');
        const embed = new EmbedBuilder()
          .setTitle('👩‍❤️‍👨 Evlilik Listesi')
          .setColor(0xFF73FA)
          .setDescription(couples.slice(0, 10).map((c, i) => `**${i + 1}.** <@${c.user1}> ❤️ <@${c.user2}> (${c.marriedAt || ''})`).join('\n'));
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'ciftyazitura') {
        const secim = interaction.options.getString('secim');
        if (!getMarriage(gid, uid)) return interaction.reply({ ephemeral: true, content: '⛔ Bu oyun **sadece evliler** için. `/evlilik evlen` ile başlayabilirsin.' });
        const day  = todayTR();
        const used = getDailyCount(gid, uid, day, 'ciftyazitura');
        if (used >= 10) return interaction.reply({ ephemeral: true, content: '⛔ Günlük oyun limitine ulaştın (**10**). Yarın tekrar gel!' });
        const sonuc   = Math.random() < 0.5 ? 'yazı' : 'tura';
        const kazandi = secim === sonuc;
        const delta   = kazandi ? 50 : -30;
        incDailyCount(gid, uid, day, 'ciftyazitura');
        addBalance(gid, uid, delta);
        return interaction.reply(
          `🪙 Çift Yazı/Tura: **${sonuc.toUpperCase()}** ` +
          (kazandi ? `→ Kazandın! **+50 coin**` : `→ Kaybettin… **-30 coin**`) +
          `\n💰 Bakiye: **${getBalance(gid, uid).balance}** • Günlük: **${used + 1}/10**`
        );
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /evlen — kısa komut (eskiden /evlilik evlen)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'evlen') {
      const target = interaction.options.getUser('hedef');
      if (target.bot) return interaction.reply({ ephemeral: true, content: 'Botlarla evlenemezsin babuş 😅' });
      if (target.id === uid) return interaction.reply({ ephemeral: true, content: 'Kendinle evlenemezsin… ama kendini sevmen güzel 😌' });
      const now2 = Date.now();
      const cdKey = `${gid}:${uid}`;
      if ((now2 - (proposalCooldown.get(cdKey) || 0)) < 5 * 60 * 1000) {
        return interaction.reply({ ephemeral: true, content: '⏳ Biraz bekle. 5 dakikada bir teklif edebilirsin.' });
      }
      if (!hasRing(gid, uid)) return interaction.reply({ ephemeral: true, content: '💍 Önce yüzük al: `/evlilik yuzuk-al` (**1500 coin**)' });
      if (getMarriage(gid, uid)) return interaction.reply({ ephemeral: true, content: 'Zaten evlisin babuş.' });
      if (getMarriage(gid, target.id)) return interaction.reply({ ephemeral: true, content: 'Hedef kişi zaten evli görünüyor.' });
      const accId = `macc_${uid}_${target.id}_${Date.now()}`;
      const rejId = `mrej_${uid}_${target.id}_${Date.now()}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(accId).setLabel('Kabul Et').setStyle(ButtonStyle.Success).setEmoji('💍'),
        new ButtonBuilder().setCustomId(rejId).setLabel('Reddet').setStyle(ButtonStyle.Danger).setEmoji('❌'),
      );
      await interaction.reply({
        content: `${target}, **${interaction.user.username}** sana **evlilik teklifi** ediyor! 💞`,
        files: [pick(PROPOSAL_HAPPY_GIFS)],
        components: [row],
      });
      const m2 = await interaction.fetchReply();
      let resolved = false;
      const coll = m2.createMessageComponentCollector({
        time: 30000,
        componentType: ComponentType.Button,
        filter: i => (i.customId === accId || i.customId === rejId) && i.user.id === target.id,
      });
      coll.on('collect', async i => {
        resolved = true;
        proposalCooldown.set(cdKey, Date.now());
        if (i.customId === rejId) {
          await i.update({ content: `💔 ${target.username} teklifi **reddetti**.`, files: [pick(PROPOSAL_SAD_GIFS)], components: [] });
          sendLog(gid, 'marriage', new EmbedBuilder().setTitle('💔 Evlilik Teklifi Reddedildi').setColor(0xED4245)
            .addFields({ name: 'Teklif Eden', value: `<@${uid}>`, inline: true }, { name: 'Reddeden', value: `<@${target.id}>`, inline: true }).setTimestamp());
        } else {
          if (!hasRing(gid, uid) || getMarriage(gid, uid) || getMarriage(gid, target.id)) {
            return i.update({ content: '⛔ Teklif geçersiz (durum değişti).', components: [] });
          }
          setMarriage(gid, uid, target.id);
          consumeRing(gid, uid);
          await i.update({ content: `💍 **${interaction.user.username}** ve **${target.username}** artık **EVLİ!** 🎉`, files: [pick(PROPOSAL_HAPPY_GIFS)], components: [] });
          sendLog(gid, 'marriage', new EmbedBuilder().setTitle('💍 Yeni Evlilik!').setColor(0xFF73FA)
            .addFields({ name: 'Eş 1', value: `<@${uid}>`, inline: true }, { name: 'Eş 2', value: `<@${target.id}>`, inline: true }, { name: 'Tarih', value: nowTR(), inline: true }).setTimestamp());
        }
      });
      coll.on('end', async () => {
        if (!resolved) {
          proposalCooldown.set(cdKey, Date.now());
          await m2.edit({ content: '⏰ Süre doldu, teklif geçersiz oldu.', components: [] }).catch(() => {});
        }
      });
      return;
    }

    // ─────────────────────────────────────────────────────────
    //  /esim — kısa komut (eskiden /evlilik esim)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'esim') {
      const m = getMarriage(gid, uid);
      if (!m) return interaction.reply('Bekârsın babuş. Belki bugün değişir? `/evlen @kişi`');
      const spouse = m.user1 === uid ? m.user2 : m.user1;
      return interaction.reply(`💞 Eşin: <@${spouse}>\n📅 Evlilik tarihi: **${m.marriedAt}**`);
    }

    // ─────────────────────────────────────────────────────────
    //  /market
    // ─────────────────────────────────────────────────────────
    if (cmd === 'market') {
      if (sub === 'liste') {
        const roles   = getMarketRoles(gid);
        const normal  = roles.filter(r => !r.isPremium);
        const premium = roles.filter(r => r.isPremium);
        const embed = new EmbedBuilder()
          .setTitle('🛒 Market')
          .setColor(0xE67E22)
          .addFields(
            {
              name: '🎁 Eşyalar',
              value: [
                '🎲 **Şans Kutusu** — 80 coin • `/oyunlar sanskutusu`',
                '💍 **Evlilik Yüzüğü** — 1500 coin • `/evlilik yuzuk-al`',
                '💎 **XPBoost** (Kalıcı 2x) — 4000 coin • `/xpboost`',
                '🛡️ **Hırsızlık Kalkanı** (4 saat) — 450 coin • `/market esya-al esya:kalkan`',
                '⚡ **Geçici XP Boost** (50 kullanım, 2x) — 400 coin • `/market esya-al esya:gecici_boost`',
                '🎨 **İsim Rengi Rolü** — 4000 coin • `/renk al`',
                '🎣 **Balıkçılık Şansı Boost** (100 kullanım) — 2000 coin • `/balik boost-al`',
              ].join('\n'),
            }
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'al') {
        const roleId = (interaction.options.getString('rolid') || '').replace(/\D/g, '');
        if (!roleId) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz rol ID.' });
        const mRoles = getMarketRoles(gid);
        const mRole  = mRoles.find(r => r.roleId === roleId);
        if (!mRole) return interaction.reply({ ephemeral: true, content: '⛔ Bu rol markette yok. `/market liste` ile listele.' });
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) return interaction.reply({ ephemeral: true, content: '⛔ Rol sunucuda bulunamadı (silinmiş olabilir).' });
        const me = interaction.guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
          return interaction.reply({ ephemeral: true, content: '⛔ Bu rolü yönetemiyorum (hiyerarşi/izin).' });
        }
        const member = interaction.member;
        if (member.roles.cache.has(roleId)) return interaction.reply({ ephemeral: true, content: 'ℹ️ Bu role zaten sahipsin.' });
        const owned = mRoles.find(r => member.roles.cache.has(r.roleId));
        if (owned) return interaction.reply({ ephemeral: true, content: `⛔ Zaten bir market rolün var: <@&${owned.roleId}>. Önce iade et: \`/market iade ${owned.roleId}\`` });
        const bal = getBalance(gid, uid);
        if (bal.balance < mRole.price) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${mRole.price}**, Bakiye: **${bal.balance}**` });
        await member.roles.add(roleId, 'Market satın alma').catch(() => {});
        addBalance(gid, uid, -mRole.price);
        sendLog(gid, 'market', new EmbedBuilder()
          .setTitle('🛒 Market — Satın Alma')
          .setColor(0xE67E22)
          .addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Rol', value: `<@&${roleId}>`, inline: true },
            { name: 'Fiyat', value: `${mRole.price} coin`, inline: true },
          ).setTimestamp()
        );
        return interaction.reply(`✅ <@&${roleId}> rolünü aldın! **-${mRole.price}** coin. Yeni bakiye: **${getBalance(gid, uid).balance}**`);
      }

      if (sub === 'iade') {
        const roleId = (interaction.options.getString('rolid') || '').replace(/\D/g, '');
        if (!roleId) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz rol ID.' });
        const mRoles = getMarketRoles(gid);
        const mRole  = mRoles.find(r => r.roleId === roleId);
        if (!mRole) return interaction.reply({ ephemeral: true, content: '⛔ Bu rol markette yok.' });
        const member = interaction.member;
        if (!member.roles.cache.has(roleId)) return interaction.reply({ ephemeral: true, content: 'ℹ️ Bu role sahip değilsin.' });
        const refund = Math.floor(mRole.price / 2);
        await member.roles.remove(roleId, 'Market iade').catch(() => {});
        addBalance(gid, uid, refund);
        sendLog(gid, 'market', new EmbedBuilder()
          .setTitle('↩️ Market — İade')
          .setColor(0xE67E22)
          .addFields(
            { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
            { name: 'Rol', value: `<@&${roleId}>`, inline: true },
            { name: 'İade', value: `+${refund} coin`, inline: true },
          ).setTimestamp()
        );
        return interaction.reply(`↩️ <@&${roleId}> iade edildi. **+${refund}** coin geri yüklendi. Bakiye: **${getBalance(gid, uid).balance}**`);
      }

      if (sub === 'esyalar') {
        const embed = new EmbedBuilder()
          .setTitle('🎁 Özel Eşyalar')
          .setColor(0xE67E22)
          .addFields(
            { name: '🛡️ Hırsızlık Kalkanı', value: '**450 coin** — 4 saat boyunca `/oyunlar cal` komutundan korur.\nSatın al: `/market esya-al esya:kalkan`' },
            { name: '⚡ Geçici XP Boost', value: '**400 coin** — sonraki 50 kullanımda **2 katı** kazanç sağlar.\nSatın al: `/market esya-al esya:gecici_boost`' },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'esya-al') {
        const esya = interaction.options.getString('esya');
        if (esya === 'kalkan') {
          if (hasShield(gid, uid)) return interaction.reply({ ephemeral: true, content: '🛡️ Zaten aktif bir kalkanın var.' });
          const bal = getBalance(gid, uid);
          if (bal.balance < 450) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **450**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -450);
          setShield(gid, uid, 4 * 60 * 60 * 1000);
          sendLog(gid, 'market', new EmbedBuilder().setTitle('🛡️ Hırsızlık Kalkanı Satın Alındı').setColor(0xE67E22)
            .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
          return interaction.reply('🛡️ **Hırsızlık Kalkanı** aktif! 4 saat boyunca `/oyunlar cal` komutundan korunuyorsun.');
        }
        if (esya === 'gecici_boost') {
          const bal = getBalance(gid, uid);
          const price = 400;
          if (bal.balance < price) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${price}**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -price);
          addTempBoostUses(gid, uid, 50);
          sendLog(gid, 'market', new EmbedBuilder().setTitle('⚡ Geçici XP Boost Satın Alındı').setColor(0xE67E22)
            .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
          return interaction.reply(`⚡ **Geçici XP Boost (2x)** satın alındı! Kalan kullanım: **${getTempBoostUses(gid, uid)}**`);
        }
        return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz eşya.' });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /renkrolekle (owner-only)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'renkrolekle') {
      if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
      const role  = interaction.options.getRole('rol');
      const price = interaction.options.getInteger('fiyat') || 50;
      addColorRole(gid, role.id, price);
      sendLog(gid, 'setup', new EmbedBuilder().setTitle('🎨 Renk Rolü Eklendi').setColor(0xEB459E)
        .addFields(
          { name: 'Yetkili', value: `<@${uid}>`, inline: true },
          { name: 'Rol', value: `<@&${role.id}>`, inline: true },
          { name: 'Fiyat', value: `${price} coin`, inline: true },
        ).setTimestamp());
      return interaction.reply(`✅ <@&${role.id}> renk rolü listesine eklendi. Fiyat: **${price} coin**`);
    }

    // ─────────────────────────────────────────────────────────
    //  /market-yonet
    // ─────────────────────────────────────────────────────────
    if (cmd === 'market-yonet') {
      if (sub === 'ekle') {
        const role    = interaction.options.getRole('rol');
        const price   = interaction.options.getInteger('fiyat');
        const premium = interaction.options.getBoolean('premium') || false;
        addMarketRole(gid, role.id, price, premium);
        return interaction.reply(`✅ <@&${role.id}> markete eklendi. Fiyat: **${price} coin**${premium ? ' 👑 Premium' : ''}`);
      }
      if (sub === 'cikar') {
        const role = interaction.options.getRole('rol');
        removeMarketRole(gid, role.id);
        return interaction.reply(`✅ <@&${role.id}> marketten çıkarıldı.`);
      }
      if (sub === 'liste') {
        const roles = getMarketRoles(gid);
        if (!roles.length) return interaction.reply('🛒 Market boş.');
        const embed = new EmbedBuilder()
          .setTitle('🛒 Market Rolleri')
          .setColor(0xE67E22)
          .setDescription(roles.map((r, i) => `**${i + 1}.** <@&${r.roleId}> — **${r.price} coin**${r.isPremium ? ' 👑' : ''}`).join('\n'));
        return interaction.reply({ embeds: [embed] });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /oyunlar
    // ─────────────────────────────────────────────────────────
    if (cmd === 'oyunlar') {
      if (sub === 'sanskutusu') {
        const day  = todayTR();
        const used = getDailyCount(gid, uid, day, 'sanskutusu');
        if (used >= 5) return interaction.reply({ ephemeral: true, content: '⛔ Bugün **5** kez kullandın babuş. Yarın tekrar dene!' });
        const bal = getBalance(gid, uid);
        if (bal.balance < 80) return interaction.reply({ ephemeral: true, content: '⛔ Şans kutusu **80 coin** ister. Bakiyen yetersiz!' });
        addBalance(gid, uid, -80);
        incDailyCount(gid, uid, day, 'sanskutusu');
        const roll = Math.random() * 100;
        let reward = 0, resultMsg = '';
        if      (roll < 40)   { resultMsg = '😔 Kutudan boş çıktı, şansına küs babuş.'; }
        else if (roll < 75)   { reward = 100; resultMsg = `🪙 Küçük ödül! **${reward} coin** kazandın.`; }
        else if (roll < 95)   { reward = 280; resultMsg = `💰 Orta ödül! **${reward} coin** kazandın!`; }
        else if (roll < 99.5) { reward = 490; resultMsg = `💎 Büyük ödül! **${reward} coin** senin babuş!`; }
        else                  { reward = 3000; resultMsg = `🔥 **JACKPOT!** **${reward} coin** kazandın!!`; }
        if (reward > 0) addBalance(gid, uid, reward);
        const embed = new EmbedBuilder()
          .setTitle('🎁 Şans Kutusu')
          .setColor(reward >= 100 ? 0xFFD700 : reward > 0 ? 0x57F287 : 0xED4245)
          .addFields(
            { name: '🎲 Sonuç', value: resultMsg },
            { name: '📆 Günlük Hak', value: `**${used + 1}/5**`, inline: true },
            { name: '💰 Bakiye', value: `**${getBalance(gid, uid).balance}** coin`, inline: true },
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'cal') {
        const calCh = getSetting(gid, 'cal_channel');
        if (calCh && interaction.channelId !== calCh) {
          return interaction.reply({ ephemeral: true, content: `⛔ Bu komutu sadece <#${calCh}> kanalında kullanabilirsin.` });
        }
        const victim = interaction.options.getUser('hedef');
        if (victim.bot) return interaction.reply({ ephemeral: true, content: 'Botlardan çalamazsın 😅' });
        if (victim.id === uid) return interaction.reply({ ephemeral: true, content: 'Kendinden çalamazsın 🙂' });
        if (hasShield(gid, victim.id)) return interaction.reply({ ephemeral: true, content: `🛡️ ${victim.username} şu anda **Hırsızlık Kalkanı** ile korunuyor, çalamazsın.` });
        const key = `${uid}:${victim.id}`;
        if (activeSteals.has(key)) return interaction.reply({ ephemeral: true, content: 'Bu kullanıcıyla zaten aktif bir çalma denemen var, bekle.' });
        if (getBalance(gid, victim.id).balance < 100) return interaction.reply({ ephemeral: true, content: 'Hedefin coin\'i yetersiz.' });
        activeSteals.add(key);
        const cancelId = `cancel_steal_${Date.now()}_${uid}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(cancelId).setLabel('İptal Et (30s)').setStyle(ButtonStyle.Danger).setEmoji('⛔')
        );
        await interaction.reply({
          content: `${victim}, **${interaction.user.username}** senden **100 coin** çalmaya çalışıyor! 30 saniye içinde butona basmazsan para gider 😈`,
          components: [row],
        });
        const m2 = await interaction.fetchReply();
        let prevented = false;
        const coll = m2.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 30000,
          filter: i => i.customId === cancelId && i.user.id === victim.id,
        });
        coll.on('collect', async i => {
          prevented = true;
          activeSteals.delete(key);
          await i.update({ content: `🛡️ ${victim.username} çalmayı **iptal etti**! ${interaction.user.username} eli boş döndü.`, components: [] });
        });
        coll.on('end', async () => {
          if (prevented) return;
          activeSteals.delete(key);
          if (getBalance(gid, victim.id).balance < 100) return m2.edit({ content: '⚠️ Hedef zaten fakirleşmiş.', components: [] });
          transfer(gid, victim.id, uid, 100);
          await m2.edit({ content: `💰 **${interaction.user.username}**, **${victim.username}**'den **100 coin** çaldı!`, components: [] });
          stealUseCounter++;
          if (stealUseCounter >= 50) {
            stealUseCounter = 0;
            if (calCh) {
              const ch = await client.channels.fetch(calCh).catch(() => null);
              if (ch?.isTextBased?.()) {
                const fetched = await ch.messages.fetch({ limit: 100 }).catch(() => null);
                if (fetched) {
                  const botMsgs = fetched.filter(m => m.author.id === client.user.id);
                  if (botMsgs.size) await ch.bulkDelete(botMsgs, true).catch(() => {});
                }
              }
            }
          }
        });
        return;
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /çal — kısa komut (eskiden /oyunlar cal)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'çal') {
      const calCh = getSetting(gid, 'cal_channel');
      if (calCh && interaction.channelId !== calCh) {
        return interaction.reply({ ephemeral: true, content: `⛔ Bu komutu sadece <#${calCh}> kanalında kullanabilirsin.` });
      }
      const victim = interaction.options.getUser('hedef');
      if (victim.bot) return interaction.reply({ ephemeral: true, content: 'Botlardan çalamazsın 😅' });
      if (victim.id === uid) return interaction.reply({ ephemeral: true, content: 'Kendinden çalamazsın 🙂' });
      if (hasShield(gid, victim.id)) return interaction.reply({ ephemeral: true, content: `🛡️ ${victim.username} şu anda **Hırsızlık Kalkanı** ile korunuyor, çalamazsın.` });
      const key = `${uid}:${victim.id}`;
      if (activeSteals.has(key)) return interaction.reply({ ephemeral: true, content: 'Bu kullanıcıyla zaten aktif bir çalma denemen var, bekle.' });
      if (getBalance(gid, victim.id).balance < 100) return interaction.reply({ ephemeral: true, content: 'Hedefin coin\'i yetersiz.' });
      activeSteals.add(key);
      const cancelId = `cancel_steal_${Date.now()}_${uid}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(cancelId).setLabel('İptal Et (30s)').setStyle(ButtonStyle.Danger).setEmoji('⛔')
      );
      await interaction.reply({
        content: `${victim}, **${interaction.user.username}** senden **100 coin** çalmaya çalışıyor! 30 saniye içinde butona basmazsan para gider 😈`,
        files: [STEAL_START_GIF],
        components: [row],
      });
      const m2 = await interaction.fetchReply();
      let prevented = false;
      const coll = m2.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30000,
        filter: i => i.customId === cancelId && i.user.id === victim.id,
      });
      coll.on('collect', async i => {
        prevented = true;
        activeSteals.delete(key);
        await i.update({ content: `🛡️ ${victim.username} çalmayı **iptal etti**! ${interaction.user.username} eli boş döndü.`, files: [STEAL_FAIL_GIF], components: [] });
      });
      coll.on('end', async () => {
        if (prevented) return;
        activeSteals.delete(key);
        if (getBalance(gid, victim.id).balance < 100) return m2.edit({ content: '⚠️ Hedef zaten fakirleşmiş.', components: [] });
        transfer(gid, victim.id, uid, 100);
        await m2.edit({ content: `💰 **${interaction.user.username}**, **${victim.username}**'den **100 coin** çaldı!`, files: [STEAL_SUCCESS_GIF], components: [] });
        stealUseCounter++;
        if (stealUseCounter >= 50) {
          stealUseCounter = 0;
          if (calCh) {
            const ch = await client.channels.fetch(calCh).catch(() => null);
            if (ch?.isTextBased?.()) {
              const fetched = await ch.messages.fetch({ limit: 100 }).catch(() => null);
              if (fetched) {
                const botMsgs = fetched.filter(m => m.author.id === client.user.id);
                if (botMsgs.size) await ch.bulkDelete(botMsgs, true).catch(() => {});
              }
            }
          }
        }
      });
      return;
    }

    // ─────────────────────────────────────────────────────────
    //  /xpboost (kalıcı)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'xpboost') {
      if (hasBoost(gid, uid)) return interaction.reply({ ephemeral: true, content: '⚡ Zaten kalıcı **XPBoost (2x)** sahibisin babuş!' });
      const bal = getBalance(gid, uid);
      if (bal.balance < 4000) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **4000**, Bakiye: **${bal.balance}**` });
      addBalance(gid, uid, -4000);
      setBoost(gid, uid);
      return interaction.reply('✅ **Kalıcı XPBoost (2x)** satın alındı! 🔥 Artık görev ödüllerin 2x!');
    }

    // ─────────────────────────────────────────────────────────
    //  /renk — isim rengi rolleri
    // ─────────────────────────────────────────────────────────
    if (cmd === 'renk') {
      const colorRoles = getColorRoles(gid);
      if (sub === 'liste') {
        if (!colorRoles.length) return interaction.reply({ ephemeral: true, content: '🎨 Henüz renk rolü eklenmemiş. Bir yönetici `/setup` üzerinden ekleyebilir.' });
        const embed = new EmbedBuilder()
          .setTitle('🎨 Renk Rolleri')
          .setColor(0xEB459E)
          .setDescription(colorRoles.map(r => `<@&${r.roleId}> — **${r.price} coin**`).join('\n'));
        return interaction.reply({ embeds: [embed] });
      }
      if (sub === 'al') {
        if (!colorRoles.length) return interaction.reply({ ephemeral: true, content: '⛔ Henüz renk rolü eklenmemiş. Bir yönetici `/setup` üzerinden ekleyebilir.' });
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`renkpick_${uid}`)
          .setPlaceholder('Bir renk rolü seç...')
          .addOptions(colorRoles.slice(0, 25).map(r => {
            const role = interaction.guild.roles.cache.get(r.roleId);
            return { label: role ? role.name : r.roleId, value: r.roleId, description: `${r.price} coin` };
          }));
        return interaction.reply({ ephemeral: true, content: '🎨 Almak istediğin renk rolünü seç (sadece 1 tane sahip olabilirsin, yenisi öncekinin yerine geçer):', components: [new ActionRowBuilder().addComponents(menu)] });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /balik — balıkçılık
    // ─────────────────────────────────────────────────────────
    if (cmd === 'balik') {
      if (sub === 'tut') {
        const key = `${gid}:${uid}`;
        const last = fishCooldown.get(key) || 0;
        const cd = 15_000;
        if (Date.now() - last < cd) {
          const wait = Math.ceil((cd - (Date.now() - last)) / 1000);
          return interaction.reply({ ephemeral: true, content: `⏳ Oltanı topla, **${wait}** saniye sonra tekrar dene.` });
        }
        fishCooldown.set(key, Date.now());
        const boosted = consumeFishBoost(gid, uid);
        const result = resolveFishCast(gid, uid, boosted);

        if (result.type === 'rod_break') {
          addBalance(gid, uid, -ROD_BREAK_COST);
          return interaction.reply(`💥 **Oltan kırıldı!** Tamir masrafı olarak **-${ROD_BREAK_COST} coin** kesildi. Bakiye: **${getBalance(gid, uid).balance}**`);
        }
        if (result.type === 'line_snap') {
          addBalance(gid, uid, -LINE_SNAP_COST);
          return interaction.reply(`✂️ **Mısıra koptu!** **-${LINE_SNAP_COST} coin** kesildi. Bakiye: **${getBalance(gid, uid).balance}**`);
        }
        if (result.type === 'empty') {
          return interaction.reply('🎣 Oltanı attın... uzun süre bekledin ama olta **boş** döndü. Şansını tekrar dene!');
        }

        const fish = result.fish;
        addFish(gid, uid, fish.key, 1);
        const marketValue = getFishValue(fish.key);
        return interaction.reply(`🎣 Oltanı attın... ${fish.emoji} **${fish.name}** yakaladın! (şu an ~${marketValue} coin değerinde)${boosted ? ' ⚡ *Şans Boostu aktifti*' : ''}`);
      }

      if (sub === 'envanter') {
        const inv = getInventory(gid, uid);
        if (!inv.length) return interaction.reply({ ephemeral: true, content: '🎣 Envanterin boş. `/balik tut` ile balık tutmayı dene!' });
        const lines = inv.map(i => {
          const f = FISH_TYPES.find(x => x.key === i.fishKey);
          return f ? `${f.emoji} **${f.name}** x${i.count} (${getFishValue(f.key)} coin/adet)` : `${i.fishKey} x${i.count}`;
        });
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🎒 ${interaction.user.username} — Balık Envanteri`).setColor(0x3498DB).setDescription(lines.join('\n')).setFooter({ text: 'Fiyatlar piyasaya göre günlük dalgalanır.' })] });
      }

      if (sub === 'boost-al') {
        const bal = getBalance(gid, uid);
        if (bal.balance < 2000) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **2000**, Bakiye: **${bal.balance}**` });
        addBalance(gid, uid, -2000);
        addFishBoostUses(gid, uid, 100);
        sendLog(gid, 'market', new EmbedBuilder().setTitle('🎣 Balıkçılık Şansı Boost Satın Alındı').setColor(0xE67E22)
          .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
        return interaction.reply(`⚡ **Balıkçılık Şansı Boost** aktif! Sonraki **100** tutma denemende nadir balık şansın artacak. Kalan: **${getFishBoostUses(gid, uid)}**`);
      }

      if (sub === 'durum') {
        return interaction.reply({ ephemeral: true, content: `⚡ Kalan balıkçılık boost kullanımı: **${getFishBoostUses(gid, uid)}**` });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /balik-market
    // ─────────────────────────────────────────────────────────
    if (cmd === 'balik-market') {
      if (sub === 'liste') {
        const embed = new EmbedBuilder()
          .setTitle('🐟 Balık Marketi — Güncel Fiyatlar')
          .setColor(0x1ABC9C)
          .setDescription(FISH_TYPES.map(f => `${f.emoji} **${f.name}** — **${getFishValue(f.key)} coin**`).join('\n'))
          .setFooter({ text: 'Fiyatlar 6 saatte bir yenilenir • Tüm balıklarını satmak için: /balik-sat' });
        return interaction.reply({ embeds: [embed] });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /balik-sat
    // ─────────────────────────────────────────────────────────
    if (cmd === 'balik-sat') {
      const inv = getInventory(gid, uid);
      if (!inv.length) return interaction.reply({ ephemeral: true, content: '🎒 Envanterinde satacak balık yok!' });
      let total = 0;
      const lines = [];
      for (const row of inv) {
        const fish = FISH_TYPES.find(f => f.key === row.fishKey);
        if (!fish || row.count <= 0) continue;
        const earned = getFishValue(row.fishKey) * row.count;
        total += earned;
        lines.push(`${fish.emoji} **${row.count}x ${fish.name}** → **${earned} coin**`);
        db.prepare('UPDATE fish_inventory SET count=0 WHERE guildId=? AND userId=? AND fishKey=?').run(gid, uid, row.fishKey);
      }
      if (total === 0) return interaction.reply({ ephemeral: true, content: '🎒 Envanterinde satacak balık yok!' });
      addBalance(gid, uid, total);
      const embed = new EmbedBuilder()
        .setTitle('🐟 Balık Marketi — Tüm Balıklar Satıldı!')
        .setColor(0x1ABC9C)
        .setDescription(lines.join('\n'))
        .addFields(
          { name: '💰 Toplam Kazanç', value: `**+${total} coin**`, inline: true },
          { name: '💳 Yeni Bakiye', value: `**${getBalance(gid, uid).balance} coin**`, inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ─────────────────────────────────────────────────────────
    //  /yirmibir — blackjack
    // ─────────────────────────────────────────────────────────
    if (cmd === 'yirmibir') {
      const bet = interaction.options.getInteger('bahis');
      const bkey = `${gid}:${uid}`;
      if (activeBlackjack.has(bkey)) return interaction.reply({ ephemeral: true, content: '⛔ Zaten aktif bir blackjack elin var.' });
      const bal = getBalance(gid, uid);
      if (bal.balance < bet) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Bakiye: **${bal.balance}**` });

      let betCharged = false;
      try {
        addBalance(gid, uid, -bet);
        betCharged = true;

        const drawCard = () => pick([2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11]);
        const handValue = (cards) => { let sum = cards.reduce((a, b) => a + b, 0); let aces = cards.filter(c => c === 11).length; while (sum > 21 && aces > 0) { sum -= 10; aces--; } return sum; };
        const cardsStr = (cards) => cards.join(' + ');

        const player = [drawCard(), drawCard()];
        const dealer = [drawCard(), drawCard()];
        activeBlackjack.set(bkey, { player, dealer, bet });

        const buildEmbed = (reveal = false, desc) => {
          const e = new EmbedBuilder()
            .setTitle('🃏 Blackjack (21)')
            .setColor(0x2ECC71)
            .addFields(
              { name: `${interaction.user.username} (${handValue(player)})`, value: cardsStr(player), inline: true },
              { name: `Bot (${reveal ? handValue(dealer) : '?'})`, value: reveal ? cardsStr(dealer) : `${dealer[0]} + ?`, inline: true },
            )
            .setFooter({ text: `Bahis: ${bet} coin` });
          if (desc) e.setDescription(desc);
          return e;
        };

        if (handValue(player) === 21) {
          activeBlackjack.delete(bkey);
          const win = resolveWinAmount(bet);
          addBalance(gid, uid, win);
          return await interaction.reply({ embeds: [buildEmbed(true, `🎉 **BLACKJACK!** Kazandın: **+${win} coin**`)] });
        }

        const hitId = `bj_hit_${uid}_${Date.now()}`;
        const standId = `bj_stand_${uid}_${Date.now()}`;
        const cancelId = `bj_cancel_${uid}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(hitId).setLabel('Çek (Hit)').setStyle(ButtonStyle.Primary).setEmoji('🃏'),
          new ButtonBuilder().setCustomId(standId).setLabel('Dur (Stand)').setStyle(ButtonStyle.Secondary).setEmoji('✋'),
          new ButtonBuilder().setCustomId(cancelId).setLabel('Vazgeç (İptal)').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
        );
        await interaction.reply({ embeds: [buildEmbed(false)], components: [row] });
        const m2 = await interaction.fetchReply();

        const finish = async (i, resultText, won) => {
          activeBlackjack.delete(bkey);
          await i.update({ embeds: [buildEmbed(true, resultText).setColor(won ? 0x2ECC71 : 0xED4245)], components: [] });
        };

        const coll = m2.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000, filter: i => i.user.id === uid && (i.customId === hitId || i.customId === standId || i.customId === cancelId) });
        coll.on('collect', async i => {
          try {
            if (i.customId === hitId) {
              player.push(drawCard());
              if (handValue(player) > 21) {
                coll.stop();
                return await finish(i, `💥 **Battın!** ${handValue(player)} puan. **-${bet} coin** kaybettin.`, false);
              }
              return await i.update({ embeds: [buildEmbed(false)], components: [row] });
            }
            if (i.customId === standId) {
              coll.stop();
              while (handValue(dealer) < 17) dealer.push(drawCard());
              const pv = handValue(player), dv = handValue(dealer);
              if (dv > 21 || pv > dv) {
                const win = resolveWinAmount(bet);
                addBalance(gid, uid, win);
                return await finish(i, `🎉 **Kazandın!** ${pv} vs ${dv}. **+${win} coin**`, true);
              } else if (pv === dv) {
                addBalance(gid, uid, bet);
                return await finish(i, `🤝 **Berabere.** ${pv} vs ${dv}. Bahsin iade edildi.`, true);
              } else {
                return await finish(i, `😿 **Kaybettin.** ${pv} vs ${dv}. **-${bet} coin**`, false);
              }
            }
            if (i.customId === cancelId) {
              coll.stop();
              addBalance(gid, uid, bet);
              return await finish(i, `🚫 **Vazgeçtin.** El iptal edildi, **${bet} coin** bahsin iade edildi.`, true);
            }
          } catch (err) {
            activeBlackjack.delete(bkey);
            addBalance(gid, uid, bet);
            sendErrorLog(gid, '/yirmibir (collect)', err);
            m2.edit({ content: '⛔ Bir hata oluştu, el iptal edildi ve bahsin iade edildi.', components: [] }).catch(() => {});
          }
        });
        coll.on('end', (_, reason) => {
          if (reason === 'time' && activeBlackjack.has(bkey)) {
            activeBlackjack.delete(bkey);
            addBalance(gid, uid, bet);
            m2.edit({ content: '⏰ Süre doldu, bahis iade edildi.', components: [] }).catch(() => {});
          }
        });
        return;
      } catch (err) {
        activeBlackjack.delete(bkey);
        if (betCharged) addBalance(gid, uid, bet);
        sendErrorLog(gid, '/yirmibir', err);
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ ephemeral: true, content: '⛔ Bir hata oluştu, bahsin iade edildi.' });
          } else {
            await interaction.followUp({ ephemeral: true, content: '⛔ Bir hata oluştu, bahsin iade edildi.' });
          }
        } catch {}
        return;
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /atyarisi — at yarışı (çok oyunculu)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'atyarisi') {
      const horse = interaction.options.getInteger('at');
      const bet = interaction.options.getInteger('bahis');
      const bal = getBalance(gid, uid);
      if (bal.balance < bet) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Bakiye: **${bal.balance}**` });
      const cid = interaction.channelId;
      let race = activeRaces.get(cid);
      const isNew = !race;
      if (!race) {
        race = { participants: [] };
        activeRaces.set(cid, race);
      }
      if (race.participants.find(p => p.uid === uid)) return interaction.reply({ ephemeral: true, content: '⛔ Bu yarışa zaten bahis koydun.' });
      addBalance(gid, uid, -bet);
      race.participants.push({ uid, horse, bet });

      if (isNew) {
        await interaction.reply(`🐎 **At Yarışı** başladı! Katılmak için **20 saniye** içinde \`/atyarisi at:<1-6> bahis:<miktar>\` komutunu kullan.\n🏇 **${interaction.user.username}** → At **${horse}** — **${bet} coin**`);
        setTimeout(async () => {
          const winner = Math.floor(Math.random() * 6) + 1;
          const lines = race.participants.map(p => {
            if (p.horse === winner) {
              const win = resolveWinAmount(p.bet);
              addBalance(gid, p.uid, win);
              return `🏆 <@${p.uid}> — At ${p.horse} ✅ **+${win} coin**`;
            }
            return `💨 <@${p.uid}> — At ${p.horse} ❌ **-${p.bet} coin**`;
          });
          activeRaces.delete(cid);
          const embed = new EmbedBuilder()
            .setTitle('🏁 At Yarışı Sonuçlandı!')
            .setColor(0xF1C40F)
            .setDescription(`🐎 Kazanan at: **${winner}**\n\n${lines.join('\n') || '_Katılımcı yok._'}`);
          const ch = await client.channels.fetch(cid).catch(() => null);
          if (ch?.isTextBased?.()) ch.send({ embeds: [embed] }).catch(() => {});
        }, 20_000);
        return;
      } else {
        return interaction.reply({ ephemeral: true, content: `✅ Yarışa katıldın! At **${horse}** — **${bet} coin** bahis koydun. Sonuç 20 saniyelik pencere bitince açıklanacak.` });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /sifirla
    // ─────────────────────────────────────────────────────────
    if (cmd === 'sifirla') {
      if (sub === 'hersey') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        db.prepare('DELETE FROM economy WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM marriages WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM rings WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM xp_boosts WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM daily_claims WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM daily_counts WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM message_counts WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM voice_time WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM level_data WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM theft_shields WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM temp_xp_boosts WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM color_roles WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM fish_inventory WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM fish_boosts WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM chat_coin_counter WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM bank_accounts WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM fish_cast_state WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM mining_data WHERE guildId=?').run(gid);
        db.prepare('DELETE FROM mining_inventory WHERE guildId=?').run(gid);
        return interaction.reply('🧨 Bu sunucuya ait tüm veriler temizlendi.');
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /madencilik
    // ─────────────────────────────────────────────────────────
    if (cmd === 'madencilik') {
      if (sub === 'panel') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const mineCh = await client.channels.fetch(MINING_CHANNEL_ID).catch(() => null);
        if (!mineCh?.isTextBased()) return interaction.reply({ ephemeral: true, content: `⛔ Madencilik kanalı bulunamadı (<#${MINING_CHANNEL_ID}>).` });
        await mineCh.send(buildMiningPanel());
        return interaction.reply({ ephemeral: true, content: `✅ Madencilik paneli <#${MINING_CHANNEL_ID}> kanalına gönderildi!` });
      }

      if (sub === 'siralama') {
        const rows = getMiningLeaderboard(gid);
        if (!rows.length) return interaction.reply({ ephemeral: true, content: '⛏️ Henüz kimse madencilik yapmamış!' });
        const lines = rows.map((r, i) => {
          const rank = getMiningRank(r.miningLevel);
          return `**${i + 1}.** <@${r.userId}> — ${rank.emoji} **${rank.name}** Lv.${r.miningLevel} (${r.totalOresMined} maden)`;
        });
        const embed = new EmbedBuilder()
          .setTitle('⛏️ Madencilik Sıralaması')
          .setColor(0x8B4513)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Rütbeler: Bronze(Lv5) • Iron(Lv10) • Gold(Lv15) • Master(Lv20)' });
        return interaction.reply({ ephemeral: true, embeds: [embed] });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /verikaydet (owner)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'verikaydet') {
      if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
      if (backupInProgress) return interaction.reply({ ephemeral: true, content: '⏳ Şu an başka bir yedekleme işlemi çalışıyor. Lütfen bekleyin.' });
      await interaction.deferReply({ ephemeral: true });
      const startedAt = nowTR();
      const startMs   = Date.now();
      try {
        const { filePath, fileName, commitUrl, size, duration } = await backupToGithub(`Manuel — ${interaction.user.tag}`);

        // Backup Log — setup panelindeki log_backup_channel'a gönder
        const backupEmbed = new EmbedBuilder()
          .setTitle('📦 Veri Kaydı')
          .setColor(0x57F287)
          .addFields(
            { name: '👤 Yetkili',        value: `<@${uid}>`,                    inline: true },
            { name: '🏠 Sunucu',         value: interaction.guild?.name || '-',  inline: true },
            { name: '⏱️ Başlangıç',      value: startedAt,                       inline: true },
            { name: '🏁 Bitiş',          value: nowTR(),                         inline: true },
            { name: '⌚ Süre',           value: `${duration} saniye`,            inline: true },
            { name: '📦 Backup Boyutu',  value: fmtBytes(size),                  inline: true },
            { name: '📁 Dosya Sayısı',   value: '1 (DB)',                        inline: true },
            { name: '☁️ GitHub Durumu',  value: commitUrl ? `[✅ Başarılı](${commitUrl})` : '✅ Yüklendi', inline: true },
            { name: '🆔 Backup ID',      value: `\`${fileName}\``,               inline: true },
          )
          .setTimestamp();

        sendLog(gid, 'backup', backupEmbed);

        return interaction.editReply({
          content: `✅ **Veriler kaydedildi!**\n📁 Yol: \`${filePath}\`\n📦 Boyut: ${fmtBytes(size)} • ⌚ Süre: ${duration}s${commitUrl ? `\n🔗 [Commit'i gör](${commitUrl})` : ''}`,
        });
      } catch (err) {
        sendErrorLog(gid, '/verikaydet', err);
        // Hata embed'ini backup log'a da yaz
        sendLog(gid, 'backup', new EmbedBuilder()
          .setTitle('📦 Veri Kaydı — HATA')
          .setColor(0xED4245)
          .addFields(
            { name: '👤 Yetkili', value: `<@${uid}>`, inline: true },
            { name: '🏠 Sunucu', value: interaction.guild?.name || '-', inline: true },
            { name: '⏱️ Başlangıç', value: startedAt, inline: true },
            { name: '☁️ GitHub Durumu', value: `❌ Hata: ${err.message}`, inline: false },
          )
          .setTimestamp()
        );
        return interaction.editReply(`⛔ Yedekleme başarısız: ${err.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /backuplist (owner)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'backuplist') {
      if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
      await interaction.deferReply({ ephemeral: true });
      try {
        const files = await listBackupsFromGithub();
        if (!files.length) return interaction.editReply('📦 GitHub\'da henüz backup yok.');

        const lines = files.map((f, i) => `**${i + 1}.** \`${f.name}\` — ${fmtBytes(f.size)}\n└ Yol: \`${f.path}\``);
        // Discord 4096 karakter limiti — parçalara böl
        const chunks = [];
        let chunk = '';
        for (const line of lines) {
          if ((chunk + line + '\n').length > 3800) { chunks.push(chunk); chunk = ''; }
          chunk += line + '\n';
        }
        if (chunk) chunks.push(chunk);

        const embeds = chunks.map((desc, i) => new EmbedBuilder()
          .setTitle(i === 0 ? '📦 Backup Listesi' : '📦 Backup Listesi (devam)')
          .setColor(0x5865F2)
          .setDescription(desc)
          .setFooter({ text: `Toplam ${files.length} backup` })
        );
        return interaction.editReply({ content: '**Restore:** `/veriyukle dosya:<yol>`\n**Sil:** `/backupsil dosya:<yol>`', embeds });
      } catch (err) {
        sendErrorLog(gid, '/backuplist', err);
        return interaction.editReply(`⛔ Hata: ${err.message}`);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /veriyukle (owner)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'veriyukle') {
      if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
      if (backupInProgress) return interaction.reply({ ephemeral: true, content: '⏳ Şu an başka bir backup/restore işlemi çalışıyor.' });

      const dosya = interaction.options.getString('dosya').trim();
      if (!dosya.startsWith('Backups/') || !dosya.endsWith('.zip')) {
        return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz dosya yolu. `/backuplist` ile doğru yolu kopyalayın.' });
      }

      // Onay butonu
      const yesId = `restore_yes_${Date.now()}_${uid}`;
      const noId  = `restore_no_${Date.now()}_${uid}`;
      const row   = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(yesId).setLabel('Evet, Geri Yükle').setStyle(ButtonStyle.Danger).setEmoji('✅'),
        new ButtonBuilder().setCustomId(noId).setLabel('Hayır, İptal').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
      );

      await interaction.reply({
        content: `⚠️ **Dikkat!** \`${dosya}\` dosyası geri yüklenecek.\n• Restore öncesi **otomatik yedek** alınır.\n• Mevcut veriler **üzerine yazılır**.\n• Devam etmek istiyor musunuz?`,
        components: [row],
        ephemeral: true,
      });
      const m2 = await interaction.fetchReply();

      const coll = m2.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30_000,
        filter: i => (i.customId === yesId || i.customId === noId) && i.user.id === uid,
      });
      coll.on('collect', async i => {
        coll.stop();
        if (i.customId === noId) {
          return i.update({ content: '🛑 Restore iptal edildi.', components: [] });
        }
        await i.update({ content: `⏳ \`${dosya}\` geri yükleniyor... (önce otomatik yedek alınıyor)`, components: [] });
        const restoreStart = nowTR();
        try {
          await restoreFromGithub(dosya);
          const embed = new EmbedBuilder()
            .setTitle('📦 Veri Yüklemesi — Başarılı')
            .setColor(0x57F287)
            .addFields(
              { name: '👤 Yetkili', value: `<@${uid}>`, inline: true },
              { name: '📁 Dosya', value: `\`${dosya}\``, inline: false },
              { name: '⏱️ Başlangıç', value: restoreStart, inline: true },
              { name: '🏁 Bitiş', value: nowTR(), inline: true },
              { name: '☁️ Durum', value: '✅ Başarıyla geri yüklendi', inline: false },
            ).setTimestamp();
          sendLog(gid, 'backup', embed);
          await interaction.editReply({ content: `✅ **Geri yükleme tamamlandı!** \`${dosya}\``, components: [] });
        } catch (err) {
          sendErrorLog(gid, '/veriyukle', err);
          sendLog(gid, 'backup', new EmbedBuilder()
            .setTitle('📦 Veri Yüklemesi — HATA')
            .setColor(0xED4245)
            .addFields(
              { name: '👤 Yetkili', value: `<@${uid}>`, inline: true },
              { name: '📁 Dosya', value: `\`${dosya}\``, inline: false },
              { name: '⛔ Hata', value: err.message, inline: false },
            ).setTimestamp()
          );
          await interaction.editReply({ content: `⛔ Restore başarısız: ${err.message}`, components: [] });
        }
      });
      coll.on('end', (_, reason) => {
        if (reason === 'time') interaction.editReply({ content: '⏰ Süre doldu, restore iptal edildi.', components: [] }).catch(() => {});
      });
      return;
    }

    // ─────────────────────────────────────────────────────────
    //  /backupsil (owner)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'backupsil') {
      if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });

      const dosya = interaction.options.getString('dosya').trim();
      if (!dosya.startsWith('Backups/') || !dosya.endsWith('.zip')) {
        return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz dosya yolu.' });
      }

      // Önce sha'yı al
      await interaction.deferReply({ ephemeral: true });
      let sha;
      try {
        const res = await octokit.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path: dosya, ref: BACKUP_BRANCH });
        sha = res.data.sha;
      } catch (e) {
        return interaction.editReply(`⛔ Dosya bulunamadı: ${e.message}`);
      }

      // Onay butonu
      const yesId = `backupsil_yes_${Date.now()}_${uid}`;
      const noId  = `backupsil_no_${Date.now()}_${uid}`;
      const row   = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(yesId).setLabel('Evet, Sil').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId(noId).setLabel('İptal').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
      );
      await interaction.editReply({ content: `⚠️ **\`${dosya}\`** kalıcı olarak silinecek. Emin misiniz?`, components: [row] });
      const m2 = await interaction.fetchReply();

      const coll = m2.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30_000,
        filter: i => (i.customId === yesId || i.customId === noId) && i.user.id === uid,
      });
      coll.on('collect', async i => {
        coll.stop();
        if (i.customId === noId) return i.update({ content: '🛑 Silme iptal edildi.', components: [] });
        await i.update({ content: `⏳ Siliniyor...`, components: [] });
        try {
          await deleteBackupFromGithub(dosya, sha);
          sendLog(gid, 'backup', new EmbedBuilder()
            .setTitle('🗑️ Backup Silindi')
            .setColor(0xED4245)
            .addFields(
              { name: '👤 Yetkili', value: `<@${uid}>`, inline: true },
              { name: '📁 Dosya', value: `\`${dosya}\``, inline: false },
            ).setTimestamp()
          );
          await interaction.editReply({ content: `✅ \`${dosya}\` silindi.`, components: [] });
        } catch (err) {
          sendErrorLog(gid, '/backupsil', err);
          await interaction.editReply({ content: `⛔ Silme başarısız: ${err.message}`, components: [] });
        }
      });
      coll.on('end', (_, reason) => {
        if (reason === 'time') interaction.editReply({ content: '⏰ Süre doldu, silme iptal edildi.', components: [] }).catch(() => {});
      });
      return;
    }

  } catch (e) {
    sendErrorLog(interaction.guild?.id || null, `interactionCreate (${interaction.commandName || 'unknown'})`, e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⛔ Bir hata oluştu.', ephemeral: true });
      }
    } catch {}
  }
});

// ──────────────────────────────────────────────────────────────
//  SETUP PANELİ
// ──────────────────────────────────────────────────────────────
async function sendSetupPanel(interaction) {
  const gid = interaction.guild.id;
  const s   = getAllSettings(gid);
  const fmt  = key => s[key] ? `<#${s[key]}>` : '_(ayarlanmamış)_';
  const colorRoles = getColorRoles(gid);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ DeathWish Game — Ayar Paneli')
    .setColor(0x5865F2)
    .setDescription('Aşağıdaki menüden ayarlamak istediğin bölümü seç.')
    .addFields(
      { name: '📊 Seviye',        value: `Kanal: ${fmt('level_channel')}` },
      { name: '💬 Sohbet',        value: `Kanal: ${fmt('sohbet_channel')}` },
      { name: '⌨️ Yazı Oyunu',   value: `Kanal: ${fmt('yazi_oyunu_channel')}` },
      { name: '💰 Çal Kanalı',   value: `Kanal: ${fmt('cal_channel')}` },
      { name: '🎨 Renk Rolleri', value: colorRoles.length ? colorRoles.map(r => `<@&${r.roleId}> — ${r.price} coin`).join('\n') : '_(henüz eklenmedi)_' },
      { name: '📋 Log Kanalları', value: [
        `⚡ XP: ${fmt('log_xp_channel')}`,
        `🏆 Level: ${fmt('log_level_channel')}`,
        `💰 Coin: ${fmt('log_coin_channel')}`,
        `💸 Ekonomi: ${fmt('log_economy_channel')}`,
        `🛒 Market: ${fmt('log_market_channel')}`,
        `💍 Evlilik: ${fmt('log_marriage_channel')}`,
        `🎙️ Ses: ${fmt('log_voice_channel')}`,
        `💬 Sohbet: ${fmt('log_chat_channel')}`,
        `⚙️ Setup: ${fmt('log_setup_channel')}`,
        `🎯 Mission: ${fmt('log_mission_channel')}`,
        `📦 Backup: ${fmt('log_backup_channel')}`,
        `⛔ Hata: ${fmt('log_error_channel')}`,
        `📝 Slash: ${fmt('log_slash_channel')}`,
      ].join('\n') },
      { name: '💰 Ekonomi', value: `Başlangıç Coin: **${s.start_coin || '0'}**\nGünlük Ödül: **${s.daily_reward || '80'}**` },
    );

  const mainMenu = new StringSelectMenuBuilder()
    .setCustomId('setup_category')
    .setPlaceholder('Ayarlamak istediğin bölümü seç...')
    .addOptions([
      { label: '📊 Seviye Kanalı',        value: 'level_channel',       description: 'Seviye atlama mesajı kanalı' },
      { label: '💬 Sohbet Kanalı',        value: 'sohbet_channel',       description: 'Mesaj sayacı ve pasif coin kanalı' },
      { label: '⌨️ Yazı Oyunu Kanalı',   value: 'yazi_oyunu_channel',   description: '/yazioyunu baslat için özel kanal' },
      { label: '💰 Çal Komutu Kanalı',   value: 'cal_channel',           description: '/oyunlar cal komutunun kanalı' },
      { label: '🎨 Renk Rolü Çıkar', value: '__color_remove__', description: 'Listeden renk rolü çıkar' },
      { label: '🎨 Renk Rollerini Listele', value: '__color_list__', description: 'Mevcut renk rollerini gör' },
      { label: '📋 Log Kanallarını Ayarla', value: '__log_submenu__',    description: 'XP, Coin, Backup, Error vb. log kanalları' },
    ]);

  const row = new ActionRowBuilder().addComponents(mainMenu);
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// Log alt menüsü
function buildLogSubmenu() {
  return new StringSelectMenuBuilder()
    .setCustomId('setup_logcategory')
    .setPlaceholder('Log türünü seç...')
    .addOptions([
      { label: '⚡ XP Log',           value: 'log_xp_channel',       description: 'XP kazanıldığında log at' },
      { label: '🏆 Level Log',        value: 'log_level_channel',    description: 'Seviye atlandığında log at' },
      { label: '💰 Coin Log',         value: 'log_coin_channel',     description: 'Coin ödülleri ve değişimleri' },
      { label: '💸 Ekonomi Log',      value: 'log_economy_channel',  description: 'Transfer, banka işlemleri' },
      { label: '🛒 Market Log',       value: 'log_market_channel',   description: 'Market satın alımları ve iadeler' },
      { label: '💍 Evlilik Log',      value: 'log_marriage_channel', description: 'Evlilik ve boşanma olayları' },
      { label: '🎙️ Ses Log',          value: 'log_voice_channel',    description: 'Ses kanalı giriş/çıkış ve ödüller' },
      { label: '💬 Sohbet Log',       value: 'log_chat_channel',     description: 'Sohbet mesajları (pasif)' },
      { label: '⚙️ Setup Log',        value: 'log_setup_channel',    description: 'Setup değişiklikleri' },
      { label: '🎯 Mission Log',      value: 'log_mission_channel',  description: 'Görev tamamlama olayları' },
      { label: '📦 Backup Log',       value: 'log_backup_channel',   description: 'Yedekleme işlemleri' },
      { label: '⛔ Hata Log',         value: 'log_error_channel',    description: 'Tüm hatalar (stack trace dahil)' },
      { label: '📝 Slash Komut Log',  value: 'log_slash_channel',    description: 'Kullanılan slash komutları' },
    ]);
}

async function handleSetupInteraction(interaction, key) {
  if (key === 'category') {
    const val = interaction.values[0];

    if (val === '__log_submenu__') {
      const logMenu = buildLogSubmenu();
      return interaction.update({ content: '📋 **Log Kanalları** — Ayarlamak istediğin log türünü seç:', components: [new ActionRowBuilder().addComponents(logMenu)], embeds: [] });
    }

    if (val === '__color_remove__') {
      const menu2 = new RoleSelectMenuBuilder().setCustomId('setup_removeColorRoles').setPlaceholder('Çıkarılacak rolleri seç...').setMinValues(1).setMaxValues(10);
      return interaction.update({ content: '🎨 Renk rolleri listesinden çıkarmak istediğin rolleri seç:', components: [new ActionRowBuilder().addComponents(menu2)], embeds: [] });
    }
    if (val === '__color_list__') {
      const roles = getColorRoles(interaction.guild.id);
      return interaction.update({ content: roles.length ? `🎨 **Renk Rolleri:**\n${roles.map(r => `<@&${r.roleId}> — ${r.price} coin`).join('\n')}` : '🎨 Henüz renk rolü eklenmemiş.', components: [], embeds: [] });
    }

    const isRole = ['welcome_auto_role'].includes(val);
    if (isRole) {
      const menu2 = new RoleSelectMenuBuilder().setCustomId(`setup_setRole_${val}`).setPlaceholder('Rol seç...');
      return interaction.update({ content: `**${val}** için rol seç:`, components: [new ActionRowBuilder().addComponents(menu2)], embeds: [] });
    }
    const menu2 = new ChannelSelectMenuBuilder().setCustomId(`setup_setChannel_${val}`).setPlaceholder('Kanal seç...').addChannelTypes(ChannelType.GuildText);
    return interaction.update({ content: `**${val}** için kanal seç:`, components: [new ActionRowBuilder().addComponents(menu2)], embeds: [] });
  }

  // Log alt menüsü seçimi
  if (key === 'logcategory') {
    const val = interaction.values[0];
    const menu2 = new ChannelSelectMenuBuilder().setCustomId(`setup_setChannel_${val}`).setPlaceholder('Kanal seç...').addChannelTypes(ChannelType.GuildText);
    return interaction.update({ content: `**${val}** için kanal seç:`, components: [new ActionRowBuilder().addComponents(menu2)], embeds: [] });
  }

  if (key === 'removeColorRoles') {
    const roleIds = interaction.values;
    for (const rid of roleIds) removeColorRole(interaction.guild.id, rid);
    return interaction.update({ content: `✅ ${roleIds.length} rol renk rolü listesinden çıkarıldı.`, components: [], embeds: [] });
  }

  if (key.startsWith('setChannel_')) {
    const settingKey = key.replace('setChannel_', '');
    const chId = interaction.values[0];
    setSetting(interaction.guild.id, settingKey, chId);

    // Setup log
    sendLog(interaction.guild.id, 'setup', new EmbedBuilder()
      .setTitle('⚙️ Setup Değişikliği')
      .setColor(0x5865F2)
      .addFields(
        { name: 'Değiştiren', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Ayar', value: settingKey, inline: true },
        { name: 'Yeni Kanal', value: `<#${chId}>`, inline: true },
      ).setTimestamp()
    );

    return interaction.update({ content: `✅ **${settingKey}** → <#${chId}> olarak ayarlandı.`, components: [], embeds: [] });
  }
  if (key.startsWith('setRole_')) {
    const settingKey = key.replace('setRole_', '');
    const roleId = interaction.values[0];
    setSetting(interaction.guild.id, settingKey, roleId);
    return interaction.update({ content: `✅ **${settingKey}** → <@&${roleId}> olarak ayarlandı.`, components: [], embeds: [] });
  }
}

// ──────────────────────────────────────────────────────────────
//  HATA YÖNETİMİ
// ──────────────────────────────────────────────────────────────
client.on('shardError',          e  => { console.error('🔌 ShardError:', e); sendErrorLog(null, 'shardError', e); });
client.on('error',               e  => { console.error('🧨 Client error:', e); sendErrorLog(null, 'clientError', e); });
client.on('warn',                m  => console.warn('⚠️ Warn:', m));
client.on('resume',              () => console.log('🔁 Session resumed'));
client.on('shardDisconnect', (ev, id) => console.warn(`🔌 Shard ${id} bağlantı koptu`));
client.on('shardReconnecting',   id  => console.log(`♻️ Shard ${id} yeniden bağlanıyor...`));
client.on('shardReady',          id  => console.log(`✅ Shard ${id} hazır`));

process.on('unhandledRejection', r => {
  console.error('UnhandledRejection:', r);
  sendErrorLog(null, 'unhandledRejection', r instanceof Error ? r : new Error(String(r)));
});
process.on('uncaughtException', e => {
  console.error('UncaughtException:', e);
  sendErrorLog(null, 'uncaughtException', e);
});

// ──────────────────────────────────────────────────────────────
//  BOOTSTRAP
// ──────────────────────────────────────────────────────────────
async function startBot() {
  try {
    console.log('🔑 Login deneniyor...');
    await client.login(TOKEN);
    console.log('✅ Login başarılı!');
  } catch (err) {
    console.error('⛔ Login başarısız! 15 sn sonra tekrar denenecek.\nHata:', err?.message || err);
    setTimeout(startBot, 15_000);
  }
}

(async () => {
  initDatabase();
  await autoRestoreIfEmpty();
  startFishMarketRefresh();
  await startBot();
  startAutoBackup();
})();
