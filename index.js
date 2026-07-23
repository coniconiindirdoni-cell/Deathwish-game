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
  ModalBuilder, TextInputBuilder, TextInputStyle,
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
    CREATE TABLE IF NOT EXISTS coin_boosts (guildId TEXT, userId TEXT, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS message_counts (guildId TEXT, channelId TEXT, userId TEXT, date TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(guildId,channelId,userId,date));
    CREATE TABLE IF NOT EXISTS market_roles (guildId TEXT, roleId TEXT, price INTEGER, isPremium INTEGER DEFAULT 0, PRIMARY KEY(guildId,roleId));
    CREATE TABLE IF NOT EXISTS level_data (guildId TEXT, userId TEXT, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));

    -- ── Yeni özellikler ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS theft_shields (guildId TEXT, userId TEXT, expiresAt INTEGER, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS theft_levels (guildId TEXT, userId TEXT, level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));
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

  // ── Odunculuk oyunu tabloları ──────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS woodcutting_data (
      guildId TEXT, userId TEXT,
      lumberjacks INTEGER DEFAULT 2,
      woodLevel INTEGER DEFAULT 1,
      woodXp INTEGER DEFAULT 0,
      energyLevel INTEGER DEFAULT 1,
      energyXp INTEGER DEFAULT 0,
      energy INTEGER DEFAULT 20,
      lastEnergyRegen INTEGER DEFAULT 0,
      workerTier INTEGER DEFAULT 0,
      purchasesInTier INTEGER DEFAULT 0,
      totalLogsCut INTEGER DEFAULT 0,
      breadUses INTEGER DEFAULT 0,
      soupUses INTEGER DEFAULT 0,
      meatUses INTEGER DEFAULT 0,
      energyCapTier INTEGER DEFAULT 0,
      energyCapPurchasesInTier INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId)
    );
    CREATE TABLE IF NOT EXISTS woodcutting_inventory (
      guildId TEXT, userId TEXT, wood TEXT, amount INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, wood)
    );
  `);

  // Yemek sistemi kullanım bazlı hale getirildi — eski DB'lere yeni kolonlar ekleniyor
  const miningCols = db.prepare("PRAGMA table_info(mining_data)").all().map(c => c.name);
  if (!miningCols.includes('breadUses'))              db.exec('ALTER TABLE mining_data ADD COLUMN breadUses INTEGER DEFAULT 0');
  if (!miningCols.includes('soupUses'))               db.exec('ALTER TABLE mining_data ADD COLUMN soupUses INTEGER DEFAULT 0');
  if (!miningCols.includes('meatUses'))               db.exec('ALTER TABLE mining_data ADD COLUMN meatUses INTEGER DEFAULT 0');
  if (!miningCols.includes('energyCapTier'))          db.exec('ALTER TABLE mining_data ADD COLUMN energyCapTier INTEGER DEFAULT 0');
  if (!miningCols.includes('energyCapPurchasesInTier')) db.exec('ALTER TABLE mining_data ADD COLUMN energyCapPurchasesInTier INTEGER DEFAULT 0');

  // ── Yeni sistemler: Pet, Antika, Kraliyet, Mülk ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pets (
      guildId TEXT, userId TEXT, petKey TEXT, level INTEGER DEFAULT 1,
      PRIMARY KEY(guildId, userId, petKey)
    );
    CREATE TABLE IF NOT EXISTS active_pet (
      guildId TEXT, userId TEXT, petKey TEXT,
      PRIMARY KEY(guildId, userId)
    );
    CREATE TABLE IF NOT EXISTS antique_inventory (
      guildId TEXT, userId TEXT, antiqueKey TEXT, count INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, antiqueKey)
    );
    CREATE TABLE IF NOT EXISTS active_antique (
      guildId TEXT, userId TEXT, antiqueKey TEXT,
      PRIMARY KEY(guildId, userId)
    );
    CREATE TABLE IF NOT EXISTS antique_upgrades (
      guildId TEXT, userId TEXT, antiqueKey TEXT, upgradeLevel INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, antiqueKey)
    );
    CREATE TABLE IF NOT EXISTS royal_items (
      guildId TEXT, itemKey TEXT, ownerId TEXT, price INTEGER DEFAULT 2000,
      PRIMARY KEY(guildId, itemKey)
    );
    CREATE TABLE IF NOT EXISTS properties (
      guildId TEXT, userId TEXT, houseLevel INTEGER DEFAULT 0, carLevel INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId)
    );
    CREATE TABLE IF NOT EXISTS daily_antique_market (
      guildId TEXT, date TEXT, antique1 TEXT, antique2 TEXT,
      PRIMARY KEY(guildId, date)
    );
    CREATE TABLE IF NOT EXISTS relics (
      guildId TEXT, userId TEXT, relicKey TEXT,
      PRIMARY KEY(guildId, userId, relicKey)
    );
    CREATE TABLE IF NOT EXISTS relic_upgrades (
      guildId TEXT, userId TEXT, relicKey TEXT, level INTEGER DEFAULT 1,
      PRIMARY KEY(guildId, userId, relicKey)
    );
    -- Aynı anda en fazla RELIC_SET_MAX_EQUIPPED (2) set kuşanılabilir.
    -- Parça sahipliği (relics tablosu) ayrı bir şey; bonus SADECE burada
    -- kayıtlı (kuşanılmış) setler için hesaplanır.
    CREATE TABLE IF NOT EXISTS active_relic_sets (
      guildId TEXT, userId TEXT, setKey TEXT,
      PRIMARY KEY(guildId, userId, setKey)
    );
    CREATE TABLE IF NOT EXISTS pet_food (
      guildId TEXT, userId TEXT, petKey TEXT, lastFedAt TEXT,
      PRIMARY KEY(guildId, userId, petKey)
    );
    CREATE TABLE IF NOT EXISTS player_tools (
      guildId TEXT, userId TEXT, toolKey TEXT, quantity INTEGER DEFAULT 1,
      PRIMARY KEY(guildId, userId, toolKey)
    );
    CREATE TABLE IF NOT EXISTS player_market (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId TEXT, sellerId TEXT, itemType TEXT, itemKey TEXT,
      quantity INTEGER DEFAULT 1, price INTEGER, listedAt TEXT
    );
  `);

  ensureMMORPGSchema();
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
    _ownedRelicsCache.clear(); // DB değişecek (başarı ya da rollback fark etmez), eski cache güvenilmez
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
function addBalance(gid, uid, amt)     {
  db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid, uid);
  if (amt >= 0) {
    // Ödül / kazanç — bakiye her zaman artmalı, sıfırlanmamalı
    db.prepare('UPDATE economy SET balance=balance+? WHERE guildId=? AND userId=?').run(amt, gid, uid);
  } else {
    // Harcama — bakiye sıfırın altına düşemez
    db.prepare('UPDATE economy SET balance=MAX(0,balance+?) WHERE guildId=? AND userId=?').run(amt, gid, uid);
  }
  return getBalance(gid, uid);
}
function addBank(gid, uid, amt)        { db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid, uid); db.prepare('UPDATE economy SET bank=MAX(0,bank+?) WHERE guildId=? AND userId=?').run(amt, gid, uid); return getBalance(gid, uid); }
function transfer(gid, from, to, amt)  { if (getBalance(gid, from).balance < amt) return false; addBalance(gid, from, -amt); addBalance(gid, to, amt); return true; }
function topBalance(gid, n = 10)       { return db.prepare('SELECT userId,balance,bank FROM economy WHERE guildId=? ORDER BY (balance+bank) DESC LIMIT ?').all(gid, n); }

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
function hasCoinBoost(gid, uid)        { return !!db.prepare('SELECT 1 FROM coin_boosts WHERE guildId=? AND userId=?').get(gid, uid); }
function setCoinBoost(gid, uid)        { db.prepare('INSERT OR IGNORE INTO coin_boosts(guildId,userId)VALUES(?,?)').run(gid, uid); }

function addMsgCount(gid, cid, uid, date) { db.prepare('INSERT OR IGNORE INTO message_counts(guildId,channelId,userId,date,count)VALUES(?,?,?,?,0)').run(gid, cid, uid, date); db.prepare('UPDATE message_counts SET count=count+1 WHERE guildId=? AND channelId=? AND userId=? AND date=?').run(gid, cid, uid, date); }
function getMsgCount(gid, cid, uid, date) { const r = db.prepare('SELECT count FROM message_counts WHERE guildId=? AND channelId=? AND userId=? AND date=?').get(gid, cid, uid, date); return r ? r.count : 0; }
function topMsgs(gid, cid, date, n = 10) { return db.prepare('SELECT userId,count FROM message_counts WHERE guildId=? AND channelId=? AND date=? ORDER BY count DESC LIMIT ?').all(gid, cid, date, n); }
function resetSohbet(gid)              { db.prepare('DELETE FROM message_counts WHERE guildId=?').run(gid); }

function getMarketRoles(gid)           { return db.prepare('SELECT * FROM market_roles WHERE guildId=?').all(gid); }
function addMarketRole(gid, rid, price, prem) { db.prepare('INSERT OR REPLACE INTO market_roles(guildId,roleId,price,isPremium)VALUES(?,?,?,?)').run(gid, rid, price, prem ? 1 : 0); }
function removeMarketRole(gid, rid)    { db.prepare('DELETE FROM market_roles WHERE guildId=? AND roleId=?').run(gid, rid); }

function getLevel(gid, uid)            { return db.prepare('SELECT xp,level FROM level_data WHERE guildId=? AND userId=?').get(gid, uid) || { xp: 0, level: 0 }; }
function addXp(gid, uid, amt) {
  db.prepare('INSERT OR IGNORE INTO level_data(guildId,userId,xp,level)VALUES(?,?,0,0)').run(gid, uid);
  const d = getLevel(gid, uid);
  if (d.level >= NORMAL_MAX_LEVEL) return { leveled: false, xpGained: 0, coinReward: 0 };
  db.prepare('UPDATE level_data SET xp=xp+? WHERE guildId=? AND userId=?').run(amt, gid, uid);
  const d2 = getLevel(gid, uid);
  const needed = Math.round((d2.level + 1) * 100 * 0.7809375);
  if (d2.xp >= needed && d2.level < NORMAL_MAX_LEVEL) {
    const newLevel = d2.level + 1;
    db.prepare('UPDATE level_data SET level=level+1,xp=xp-? WHERE guildId=? AND userId=?').run(needed, gid, uid);
    const coinReward = getLevelUpCoinReward(newLevel);
    addBalance(gid, uid, coinReward);
    if (newLevel >= NORMAL_MAX_LEVEL) {
      db.prepare('UPDATE level_data SET xp=0 WHERE guildId=? AND userId=?').run(gid, uid);
    }
    return { leveled: true, newLevel, xpGained: amt, coinReward };
  }
  return { leveled: false, xpGained: amt, coinReward: 0 };
}
function topLevels(gid, n = 10)        { return db.prepare('SELECT userId,level,xp FROM level_data WHERE guildId=? ORDER BY level DESC,xp DESC LIMIT ?').all(gid, n); }

// ── Yeni özellik yardımcıları ───────────────────────────────────
// Hırsızlık Kalkanı (900 coin, 4 saat, /oyunlar cal komutundan korur)
function hasShield(gid, uid) {
  const r = db.prepare('SELECT expiresAt FROM theft_shields WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) return false;
  if (r.expiresAt < Date.now()) { db.prepare('DELETE FROM theft_shields WHERE guildId=? AND userId=?').run(gid, uid); return false; }
  return true;
}
function setShield(gid, uid, ms) { db.prepare('INSERT OR REPLACE INTO theft_shields(guildId,userId,expiresAt)VALUES(?,?,?)').run(gid, uid, Date.now() + ms); }

// ── Hırsızlık Seviyesi (/çal ve /oyunlar cal başarılı olunca 3 XP kazanılır) ──
// Lv0->Lv1: 30xp, sonraki her seviye +6xp gerektirir (Lv1->Lv2: 36, Lv2->Lv3: 42, ...).
// Maks seviye 20. Lv10+'da çalınan miktar 100'den 200'e, Lv20 (maks) 300'e çıkar.
const THEFT_MAX_LEVEL   = 20;
const THEFT_XP_PER_WIN  = 3;
const THEFT_BASE_XP_NEED = 30;
const THEFT_XP_NEED_STEP = 6;
function getTheftXpNeeded(level) { return THEFT_BASE_XP_NEED + THEFT_XP_NEED_STEP * level; } // level = mevcut (henüz atlanmamış) seviye
function getTheftLevel(gid, uid) {
  const r = db.prepare('SELECT level,xp FROM theft_levels WHERE guildId=? AND userId=?').get(gid, uid);
  return r || { level: 0, xp: 0 };
}
function addTheftXp(gid, uid, amt = THEFT_XP_PER_WIN) {
  db.prepare('INSERT OR IGNORE INTO theft_levels(guildId,userId,level,xp)VALUES(?,?,0,0)').run(gid, uid);
  let d = getTheftLevel(gid, uid);
  if (d.level >= THEFT_MAX_LEVEL) return { leveled: false, newLevel: d.level };
  db.prepare('UPDATE theft_levels SET xp=xp+? WHERE guildId=? AND userId=?').run(amt, gid, uid);
  d = getTheftLevel(gid, uid);
  let leveled = false;
  while (d.level < THEFT_MAX_LEVEL && d.xp >= getTheftXpNeeded(d.level)) {
    const needed = getTheftXpNeeded(d.level);
    d.xp -= needed;
    d.level += 1;
    leveled = true;
  }
  if (leveled) {
    db.prepare('UPDATE theft_levels SET level=?, xp=? WHERE guildId=? AND userId=?').run(d.level, d.level >= THEFT_MAX_LEVEL ? 0 : d.xp, gid, uid);
  }
  return { leveled, newLevel: d.level };
}
// Hırsızlık seviyesine göre çalınan coin miktarı: Lv1-9 → 100, Lv10-19 → 200, Lv20 (maks) → 300
function getTheftStealAmount(gid, uid) {
  const { level } = getTheftLevel(gid, uid);
  if (level >= THEFT_MAX_LEVEL) return 300;
  if (level >= 10) return 200;
  return 100;
}

// Geçici XP Boost — süreye değil kullanım hakkına dayanır (2000 coin, 50 kullanım, 2x)
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

// Ses ödülleri için kullanılan genel çarpan (kalıcı boost 1.5x).
// Kalıcı XP Boost günlük ve coin ödüllerini ETKİLEMEZ — bunlar için
// getTotalCoinBonusPct / getTotalDailyBonusPct kullanılır.
function getBoostMultiplier(gid, uid, consume = true) {
  let m = 1;
  if (hasBoost(gid, uid)) m *= 1.5;
  else if (hasTempBoost(gid, uid)) {
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
const BANK_EXEMPT_COMMANDS = new Set(['setup', 'yardim', 'banka', 'verikaydet', 'backuplist', 'veriyukle', 'backupsil', 'madencilik', 'odunculuk', 'hakkimda', 'siralama', 'mulk-siralama', 'rpg', 'envanter']);

// İsim Rengi Rolleri (admin /setup üzerinden ekler, kullanıcı /renk al ile satın alır)
function getColorRoles(gid)              { return db.prepare('SELECT * FROM color_roles WHERE guildId=?').all(gid); }
function addColorRole(gid, rid, price = 4000) { db.prepare('INSERT OR REPLACE INTO color_roles(guildId,roleId,price)VALUES(?,?,?)').run(gid, rid, price); }
function removeColorRole(gid, rid)       { db.prepare('DELETE FROM color_roles WHERE guildId=? AND roleId=?').run(gid, rid); }

// Sohbet — her 2 mesajda 8 coin (pasif, otomatik, günlük görev sistemi yerine)
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

// Normal seviye sistemi max seviyesi
const NORMAL_MAX_LEVEL = 100;

// Seviye atlandığında verilecek coin ödülü
function getLevelUpCoinReward(level) {
  if (level >= 40) return 700;
  if (level >= 30) return 500;
  if (level >= 20) return 300;
  if (level >= 10) return 200;
  return 100;
}

// ──────────────────────────────────────────────────────────────
//  ANTİKA SİSTEMİ
// ──────────────────────────────────────────────────────────────
const ANTIQUES = [
  // Normal antikalar (7 adet) — 4600 coin, +5% XP, +5% Coin
  { key: 'vaz',      name: 'Eski Vazo',       emoji: '🏺', rarity: 'normal',   price: 4600,  xpBonus: 5,  coinBonus: 5,  dailyBonus: 0  },
  { key: 'saat',     name: 'Eskitme Saat',    emoji: '⏰', rarity: 'normal',   price: 4600,  xpBonus: 5,  coinBonus: 5,  dailyBonus: 0  },
  { key: 'tablo',    name: 'Antika Tablo',    emoji: '🖼️', rarity: 'normal',   price: 4600,  xpBonus: 5,  coinBonus: 5,  dailyBonus: 0  },
  { key: 'radyo',    name: 'Eski Radyo',      emoji: '📻', rarity: 'normal',   price: 4600,  xpBonus: 5,  coinBonus: 5,  dailyBonus: 0  },
  { key: 'kazan',    name: 'Bakır Kazan',     emoji: '🫕', rarity: 'normal',   price: 4600,  xpBonus: 5,  coinBonus: 5,  dailyBonus: 0  },
  { key: 'anahtar',  name: 'Eski Anahtar',    emoji: '🗝️', rarity: 'normal',   price: 4600,  xpBonus: 5,  coinBonus: 5,  dailyBonus: 0  },
  { key: 'heykel',   name: 'Taş Heykel',      emoji: '🗿', rarity: 'normal',   price: 4600,  xpBonus: 5,  coinBonus: 5,  dailyBonus: 0  },
  // Nadir antikalar (5 adet, %5 çıkma şansı) — 10000 coin, +10% XP, +10% Coin
  { key: 'samdan',   name: 'Gümüş Şamdan',   emoji: '🕯️', rarity: 'uncommon', price: 10000, xpBonus: 10, coinBonus: 10, dailyBonus: 0  },
  { key: 'kilic',    name: 'Osmanlı Kılıcı',  emoji: '⚔️', rarity: 'uncommon', price: 10000, xpBonus: 10, coinBonus: 10, dailyBonus: 0  },
  { key: 'pipo',     name: 'Antika Pipo',     emoji: '🪈', rarity: 'uncommon', price: 10000, xpBonus: 10, coinBonus: 10, dailyBonus: 0  },
  { key: 'kristal',  name: 'Kristal Top',     emoji: '🔮', rarity: 'uncommon', price: 10000, xpBonus: 10, coinBonus: 10, dailyBonus: 0  },
  { key: 'yazma',    name: 'Eski Yazma',      emoji: '📜', rarity: 'uncommon', price: 10000, xpBonus: 10, coinBonus: 10, dailyBonus: 0  },
  // Çok nadir antikalar (3 adet, %1 çıkma şansı) — 22500 coin, +20% XP, +20% Coin, +10% Günlük
  { key: 'madalyon', name: 'Altın Madalyon',  emoji: '🏅', rarity: 'rare',     price: 22500, xpBonus: 20, coinBonus: 20, dailyBonus: 10 },
  { key: 'bros',     name: 'Elmas Broş',      emoji: '💎', rarity: 'rare',     price: 22500, xpBonus: 20, coinBonus: 20, dailyBonus: 10 },
  { key: 'asa',      name: 'Kutsal Asa',      emoji: '🪄', rarity: 'rare',     price: 22500, xpBonus: 20, coinBonus: 20, dailyBonus: 10 },
];

// Günlük antika marketi ağırlıkları
const ANTIQUE_WEIGHTS = { normal: 94 / 7, uncommon: 5 / 5, rare: 1 / 3 };

function pickDailyAntique(exclude = []) {
  const pool = ANTIQUES.filter(a => !exclude.includes(a.key));
  const totalW = pool.reduce((s, a) => s + ANTIQUE_WEIGHTS[a.rarity], 0);
  let r = Math.random() * totalW;
  for (const a of pool) { r -= ANTIQUE_WEIGHTS[a.rarity]; if (r <= 0) return a; }
  return pool[0];
}
function getDailyAntiqueMarket(gid) {
  const date = todayTR();
  const row = db.prepare('SELECT antique1, antique2 FROM daily_antique_market WHERE guildId=? AND date=?').get(gid, date);
  if (row) return [ANTIQUES.find(a => a.key === row.antique1), ANTIQUES.find(a => a.key === row.antique2)].filter(Boolean);
  const a1 = pickDailyAntique(); const a2 = pickDailyAntique([a1.key]);
  db.prepare('INSERT OR REPLACE INTO daily_antique_market(guildId,date,antique1,antique2)VALUES(?,?,?,?)').run(gid, date, a1.key, a2.key);
  return [a1, a2];
}
function getAntiqueInventory(gid, uid) {
  return db.prepare('SELECT antiqueKey, count FROM antique_inventory WHERE guildId=? AND userId=? AND count>0').all(gid, uid);
}
function addAntique(gid, uid, key) {
  db.prepare('INSERT OR IGNORE INTO antique_inventory(guildId,userId,antiqueKey,count)VALUES(?,?,?,0)').run(gid, uid, key);
  db.prepare('UPDATE antique_inventory SET count=count+1 WHERE guildId=? AND userId=? AND antiqueKey=?').run(gid, uid, key);
}
function getActiveAntique(gid, uid) {
  const r = db.prepare('SELECT antiqueKey FROM active_antique WHERE guildId=? AND userId=?').get(gid, uid);
  return r ? (ANTIQUES.find(a => a.key === r.antiqueKey) || null) : null;
}
function setActiveAntique(gid, uid, key) { db.prepare('INSERT OR REPLACE INTO active_antique(guildId,userId,antiqueKey)VALUES(?,?,?)').run(gid, uid, key); }
function clearActiveAntique(gid, uid)    { db.prepare('DELETE FROM active_antique WHERE guildId=? AND userId=?').run(gid, uid); }
function getAntiqueUpgradeLevel(gid, uid, key) {
  const r = db.prepare('SELECT upgradeLevel FROM antique_upgrades WHERE guildId=? AND userId=? AND antiqueKey=?').get(gid, uid, key);
  return r ? r.upgradeLevel : 0;
}
function setAntiqueUpgradeLevel(gid, uid, key, level) {
  db.prepare('INSERT OR REPLACE INTO antique_upgrades(guildId,userId,antiqueKey,upgradeLevel)VALUES(?,?,?,?)').run(gid, uid, key, level);
}
function getAntiqueWithUpgrade(gid, uid) {
  const a = getActiveAntique(gid, uid);
  if (!a) return null;
  const upg = getAntiqueUpgradeLevel(gid, uid, a.key);
  return { ...a, xpBonus: a.xpBonus + upg * 5, coinBonus: a.coinBonus + upg * 5, dailyBonus: a.dailyBonus + upg * 5, upgradeLevel: upg };
}
function getAntiqueXpBonus(gid, uid)     { const a = getAntiqueWithUpgrade(gid, uid); return a ? a.xpBonus : 0; }
function getAntiqueCoinBonus(gid, uid)   { const a = getAntiqueWithUpgrade(gid, uid); return a ? a.coinBonus : 0; }
function getAntiqueDailyBonus(gid, uid)  { const a = getAntiqueWithUpgrade(gid, uid); return a ? a.dailyBonus : 0; }

// ──────────────────────────────────────────────────────────────
//  KRALİYET SİSTEMİ
// ──────────────────────────────────────────────────────────────
const ROYAL_ITEMS = [
  { key: 'kral_taci',    name: 'Kral Tacı',          emoji: '👑' },
  { key: 'kralice_taci', name: 'Kraliçe Tacı',        emoji: '👑' },
  { key: 'pelerin',      name: 'Kraliyet Pelerini',   emoji: '🧥' },
  { key: 'mucevher',     name: 'Kraliyet Mücevheri',  emoji: '💎' },
];
function getRoyalItem(gid, itemKey) {
  return db.prepare('SELECT ownerId, price FROM royal_items WHERE guildId=? AND itemKey=?').get(gid, itemKey) || { ownerId: null, price: 2000 };
}
function buyRoyalItem(gid, itemKey, buyerId) {
  const cur = getRoyalItem(gid, itemKey);
  db.prepare('INSERT OR REPLACE INTO royal_items(guildId,itemKey,ownerId,price)VALUES(?,?,?,?)').run(gid, itemKey, buyerId, cur.price + 1000);
  return { prevOwner: cur.ownerId, price: cur.price };
}
function getUserRoyalItems(gid, uid) {
  return ROYAL_ITEMS.filter(ri => { const r = db.prepare('SELECT ownerId FROM royal_items WHERE guildId=? AND itemKey=?').get(gid, ri.key); return r && r.ownerId === uid; });
}

// ──────────────────────────────────────────────────────────────
//  MÜLK SİSTEMİ
// ──────────────────────────────────────────────────────────────
const PROPERTY_MAX_LEVEL = 15;
const PROPERTY_COST = 5000;
function getProperties(gid, uid) {
  return db.prepare('SELECT houseLevel, carLevel FROM properties WHERE guildId=? AND userId=?').get(gid, uid) || { houseLevel: 0, carLevel: 0 };
}
function saveProperties(gid, uid, houseLevel, carLevel) {
  db.prepare('INSERT OR IGNORE INTO properties(guildId,userId,houseLevel,carLevel)VALUES(?,?,0,0)').run(gid, uid);
  db.prepare('UPDATE properties SET houseLevel=?, carLevel=? WHERE guildId=? AND userId=?').run(houseLevel, carLevel, gid, uid);
}
function getPropertyLeaderboard(gid) {
  return db.prepare('SELECT userId, houseLevel, carLevel FROM properties WHERE guildId=? ORDER BY (houseLevel+carLevel) DESC LIMIT 10').all(gid);
}

// ──────────────────────────────────────────────────────────────
//  PET SİSTEMİ
// ──────────────────────────────────────────────────────────────
const PETS = [
  { key: 'kedi',   name: 'Kedi',   emoji: '🐱', price: 4500, bonusType: 'xp',    bonusBase: 10 },
  { key: 'kopek',  name: 'Köpek',  emoji: '🐶', price: 4500, bonusType: 'coin',  bonusBase: 10 },
  { key: 'baykus', name: 'Baykuş', emoji: '🦉', price: 6300, bonusType: 'daily', bonusBase: 10 },
];
const PET_UPGRADE_COSTS = [0, 2000, 2500, 3000, 3500]; // Lv1→Lv2=2000, …, Lv4→Lv5=3500
const PET_MAX_LEVEL = 5;
const PET_BONUS_PER_LEVEL = 4; // her seviyede +4%
const RELIC_MAX_LEVEL = 5;
const RELIC_UPGRADE_COST = 2000; // her seviyede 2000 coin
const RELIC_BONUS_PER_LEVEL = 5; // her seviyede +5%

// Ejder Seti ayrı bir yükseltme sistemine sahiptir: set tamamlanmadan
// (3 parça bir arada olmadan) yükseltilemez. Tamamlandığında Lv.1 olarak
// başlar ve her yükseltme (max Lv.5) verdiği TÜM bonuslara +%7 ekler.
const EJDER_MAX_LEVEL = 5;
const EJDER_UPGRADE_COST = 3000; // her seviyede 3000 coin
const EJDER_BONUS_PER_LEVEL = 7; // her seviyede +7%
const EJDER_BASE_COIN_BONUS = 30; // Lv1 Coin bonusu (%)
const EJDER_BASE_XP_BONUS   = 20; // Lv1 XP bonusu (%)

// ──────────────────────────────────────────────────────────────
//  RELİK SİSTEMİ
// ──────────────────────────────────────────────────────────────
const RELICS = [
  { key: 'madenci',       name: 'Madenci Reliği',  emoji: '⛏️', price: 10000, group: 'single',
    description: 'Çıkardığın madenlerin satış değeri **+%20** artar.' },
  { key: 'deniz',         name: 'Deniz Reliği',    emoji: '🎣', price: 10000, group: 'single',
    description: '**+%30** daha yüksek değerli balık yakalama şansı (nadir balıklar daha sık gelir).' },
  { key: 'bilgelik',      name: 'Bilgelik Reliği', emoji: '📚', price: 10000, group: 'single',
    description: 'Tüm XP kazanımları **+%15** artar.' },
  { key: 'tuccar',        name: 'Tüccar Reliği',   emoji: '💰', price: 10000, group: 'single',
    description: 'Balık ve maden satışından **+%10** coin kazanırsın. Pazar vergisi **%50** azalır.' },
  { key: 'sansli_kazma',  name: 'Şanslı Kazma Reliği', emoji: '🍀', price: 10000, group: 'single',
    description: 'Madende craft malzemesi düşme oranı **2 kat (x2)** artar. Set değil, tek parça — satın alındığı an otomatik aktif olur.' },
  { key: 'ejder_pence',   name: 'Ejder Pençesi',   emoji: '🐉', price: 10000, group: 'ejder',
    description: 'Ejder Setinin bir parçası. Tüm 3 parça takılınca aktifleşir.' },
  { key: 'ejder_disi',    name: 'Ejder Dişi',      emoji: '🦷', price: 10000, group: 'ejder',
    description: 'Ejder Setinin bir parçası. Tüm 3 parça takılınca aktifleşir.' },
  { key: 'ejder_gozu',    name: 'Ejder Gözü',      emoji: '👁️', price: 10000, group: 'ejder',
    description: 'Ejder Setinin bir parçası. Tüm 3 parça takılınca aktifleşir.' },
];
const EJDER_SET_KEYS = ['ejder_pence', 'ejder_disi', 'ejder_gozu'];

// ──────────────────────────────────────────────────────────────
//  HAYVAN MAMASI
// ──────────────────────────────────────────────────────────────
const PET_FOODS = [
  { key: 'kedi_mama',   name: 'Kedi Maması',   emoji: '🐱', petKey: 'kedi',   price: 400 },
  { key: 'kopek_mama',  name: 'Köpek Maması',  emoji: '🐶', petKey: 'kopek',  price: 400 },
  { key: 'baykus_mama', name: 'Baykuş Maması', emoji: '🦉', petKey: 'baykus', price: 400 },
];

// ──────────────────────────────────────────────────────────────
//  MADENCİLİK ARAÇLARI (sadece oyuncu pazarından/drop)
// ──────────────────────────────────────────────────────────────
const MINING_TOOLS = [
  { key: 'demir_kazma',  name: 'Demir Kazma',   emoji: '⛏️',  bonus: 5,  type: 'kazma', dropWeight: 50 },
  { key: 'altin_kazma',  name: 'Altın Kazma',   emoji: '🪙',  bonus: 10, type: 'kazma', dropWeight: 30 },
  { key: 'elmas_kazma',  name: 'Elmas Kazma',   emoji: '💎',  bonus: 15, type: 'kazma', dropWeight: 15 },
  { key: 'buyulu_kazma', name: 'Büyülü Kazma',  emoji: '✨',  bonus: 20, type: 'kazma', dropWeight: 5  },
];

// ──────────────────────────────────────────────────────────────
//  ODUNCULUK ARAÇLARI (sadece oyuncu pazarından/drop)
// ──────────────────────────────────────────────────────────────
const WOOD_TOOLS = [
  { key: 'demir_balta',  name: 'Demir Balta',   emoji: '🪓',  bonus: 5,  type: 'balta', dropWeight: 50 },
  { key: 'altin_balta',  name: 'Altın Balta',   emoji: '🪙',  bonus: 10, type: 'balta', dropWeight: 30 },
  { key: 'elmas_balta',  name: 'Elmas Balta',   emoji: '💎',  bonus: 15, type: 'balta', dropWeight: 15 },
  { key: 'buyulu_balta', name: 'Büyülü Balta',  emoji: '✨',  bonus: 20, type: 'balta', dropWeight: 5  },
];
const ALL_TOOLS = [...MINING_TOOLS, ...WOOD_TOOLS];

function getPetBonusByLevel(petDef, level) { return petDef.bonusBase + (level - 1) * PET_BONUS_PER_LEVEL; }
function getPetRows(gid, uid) { return db.prepare('SELECT petKey, level FROM pets WHERE guildId=? AND userId=?').all(gid, uid); }
function hasPet(gid, uid, petKey) { return !!db.prepare('SELECT 1 FROM pets WHERE guildId=? AND userId=? AND petKey=?').get(gid, uid, petKey); }
function buyPet(gid, uid, petKey) { db.prepare('INSERT OR IGNORE INTO pets(guildId,userId,petKey,level)VALUES(?,?,?,1)').run(gid, uid, petKey); }
function getPetLevel(gid, uid, petKey) { const r = db.prepare('SELECT level FROM pets WHERE guildId=? AND userId=? AND petKey=?').get(gid, uid, petKey); return r ? r.level : 0; }
function upgradePet(gid, uid, petKey) { db.prepare('UPDATE pets SET level=level+1 WHERE guildId=? AND userId=? AND petKey=?').run(gid, uid, petKey); }
function getActivePet(gid, uid) {
  const r = db.prepare('SELECT petKey FROM active_pet WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) return null;
  const def = PETS.find(p => p.key === r.petKey); if (!def) return null;
  const lv = getPetLevel(gid, uid, r.petKey);
  return { ...def, level: lv };
}
function setActivePet(gid, uid, petKey) { db.prepare('INSERT OR REPLACE INTO active_pet(guildId,userId,petKey)VALUES(?,?,?)').run(gid, uid, petKey); }
function clearActivePet(gid, uid)        { db.prepare('DELETE FROM active_pet WHERE guildId=? AND userId=?').run(gid, uid); }
// Tüm sahip olunan petlerin bonusları toplanır (aktif/pasif ayrımı yok)
function getPetXpBonus(gid, uid) {
  const rows = getPetRows(gid, uid);
  const base = rows.reduce((sum, r) => {
    const def = PETS.find(p => p.key === r.petKey);
    return (def && def.bonusType === 'xp') ? sum + getPetBonusByLevel(def, r.level) : sum;
  }, 0);
  // Güneş Seti (full) — petXpPct, sahip olunan petlerin verdiği XP bonusunu güçlendirir
  const setBonusPct = getRelicSetPetXpBonus(gid, uid);
  return base * (1 + setBonusPct / 100);
}
function getPetCoinBonus(gid, uid) {
  const rows = getPetRows(gid, uid);
  return rows.reduce((sum, r) => {
    const def = PETS.find(p => p.key === r.petKey);
    return (def && def.bonusType === 'coin') ? sum + getPetBonusByLevel(def, r.level) : sum;
  }, 0);
}
// Basit petlerin zindan katkısı (beslenmişse her pet +3 başarı puanı)
function getSimplePetDungeonBonus(gid, uid) {
  const rows = getPetRows(gid, uid);
  let bonus = 0;
  for (const r of rows) {
    if (isPetAlive(gid, uid, r.petKey)) bonus += 3;
  }
  return bonus;
}

function getPetDailyBonus(gid, uid) {
  const rows = getPetRows(gid, uid);
  return rows.reduce((sum, r) => {
    const def = PETS.find(p => p.key === r.petKey);
    return (def && def.bonusType === 'daily') ? sum + getPetBonusByLevel(def, r.level) : sum;
  }, 0);
}

// ──────────────────────────────────────────────────────────────
//  ARAÇ & OYUNCU PAZARI YARDIMCILARI
// ──────────────────────────────────────────────────────────────
function getPlayerTools(gid, uid)            { return db.prepare('SELECT toolKey, quantity FROM player_tools WHERE guildId=? AND userId=?').all(gid, uid); }
function getPlayerTool(gid, uid, key)        { return db.prepare('SELECT quantity FROM player_tools WHERE guildId=? AND userId=? AND toolKey=?').get(gid, uid, key); }
function addPlayerTool(gid, uid, key, qty=1) {
  const row = getPlayerTool(gid, uid, key);
  if (row) db.prepare('UPDATE player_tools SET quantity=quantity+? WHERE guildId=? AND userId=? AND toolKey=?').run(qty, gid, uid, key);
  else      db.prepare('INSERT INTO player_tools(guildId,userId,toolKey,quantity)VALUES(?,?,?,?)').run(gid, uid, key, qty);
}
function removePlayerTool(gid, uid, key, qty=1) {
  const row = getPlayerTool(gid, uid, key);
  if (!row || row.quantity < qty) return false;
  if (row.quantity === qty) db.prepare('DELETE FROM player_tools WHERE guildId=? AND userId=? AND toolKey=?').run(gid, uid, key);
  else db.prepare('UPDATE player_tools SET quantity=quantity-? WHERE guildId=? AND userId=? AND toolKey=?').run(qty, gid, uid, key);
  return true;
}

function getBestMiningToolBonus(gid, uid) {
  const tools = getPlayerTools(gid, uid);
  let best = 0;
  for (const t of tools) {
    const def = MINING_TOOLS.find(x => x.key === t.toolKey);
    if (def && def.bonus > best) best = def.bonus;
  }
  return best;
}
function getBestWoodToolBonus(gid, uid) {
  const tools = getPlayerTools(gid, uid);
  let best = 0;
  for (const t of tools) {
    const def = WOOD_TOOLS.find(x => x.key === t.toolKey);
    if (def && def.bonus > best) best = def.bonus;
  }
  return best;
}
function getBestMiningToolDef(gid, uid) {
  const tools = getPlayerTools(gid, uid);
  let best = null;
  for (const t of tools) {
    const def = MINING_TOOLS.find(x => x.key === t.toolKey);
    if (def && (!best || def.bonus > best.bonus)) best = def;
  }
  return best;
}
function getBestWoodToolDef(gid, uid) {
  const tools = getPlayerTools(gid, uid);
  let best = null;
  for (const t of tools) {
    const def = WOOD_TOOLS.find(x => x.key === t.toolKey);
    if (def && (!best || def.bonus > best.bonus)) best = def;
  }
  return best;
}

// Ağırlıklı rastgele seçim
function pickWeighted(arr) {
  const total = arr.reduce((s, x) => s + x.dropWeight, 0);
  let r = Math.random() * total;
  for (const x of arr) { if (r < x.dropWeight) return x; r -= x.dropWeight; }
  return arr[arr.length - 1];
}

// Şans eseri drop (madencilik veya odunculuk) — genişletilmiş ağırlıklı loot havuzu
function giveRareDrop(gid, uid, toolPool) {
  // Tek bir ağırlıklı havuzda tüm loot tiplerini topla — nadirlik arttıkça ağırlık düşer
  const pool = [];

  // Antikalar (yaygın — w:25)
  for (const a of ANTIQUES) {
    pool.push({ weight: 25, type: 'antique', data: a });
  }

  // Eski relikler — single: w:12, ejder: w:5 (nadir)
  for (const r of RELICS) {
    pool.push({ weight: r.group === 'ejder' ? 5 : 12, type: 'relic_old', data: r });
  }

  // Araçlar (dropWeight değerini kullan)
  for (const t of toolPool) {
    pool.push({ weight: t.dropWeight || 15, type: 'tool', data: t });
  }

  // Yeni relic set parçaları (çok nadir — w:3 her parça)
  for (const [, setDef] of Object.entries(RELIC_SETS)) {
    for (const piece of setDef.pieces) {
      pool.push({ weight: 3, type: 'relic_new', data: { ...piece, setEmoji: setDef.emoji } });
    }
  }

  // Craft malzemeleri — tier bazlı ağırlık
  const _craftW = { 1: 20, 2: 15, 3: 10, 4: 6 };
  for (const m of CRAFT_MATERIALS) {
    pool.push({ weight: _craftW[m.tier] || 8, type: 'craft_mat', data: m });
  }

  // Ağırlıklı seçim
  const total = pool.reduce((s, x) => s + x.weight, 0);
  let roll = Math.random() * total;
  let picked = pool[pool.length - 1];
  for (const item of pool) { if (roll < item.weight) { picked = item; break; } roll -= item.weight; }

  if (picked.type === 'antique') {
    const a = picked.data;
    addAntique(gid, uid, a.key);
    return `✨ **Şans Eseri!** ${a.emoji} **${a.name}** antikası bulundu! (\`/antika envanter\` ile gör)`;
  }

  if (picked.type === 'relic_old') {
    const r = picked.data;
    if (!hasRelic(gid, uid, r.key)) {
      buyRelic(gid, uid, r.key);
      const ejderMsg = r.group === 'ejder' && hasAllEjderParts(gid, uid) ? ' 🐉 Ejder Seti tamamlandı!' : '';
      return `✨ **Şans Eseri!** ${r.emoji} **${r.name}** reliği bulundu!${ejderMsg}`;
    }
    // Zaten sahipse araç ver
    const tool = pickWeighted(toolPool);
    addPlayerTool(gid, uid, tool.key);
    return `✨ **Şans Eseri!** ${tool.emoji} **${tool.name}** düştü! (\`/pazar envanter\` ile gör)`;
  }

  if (picked.type === 'relic_new') {
    const piece = picked.data;
    if (!hasRelic(gid, uid, piece.key)) buyRelic(gid, uid, piece.key);
    return `✨ **Şans Eseri!** ${piece.setEmoji} **${piece.name}** relic parçası bulundu! (\`/envanter\` → Relic)`;
  }

  if (picked.type === 'craft_mat') {
    const mat = picked.data;
    addCraftMat(gid, uid, mat.key, 1);
    return `✨ **Şans Eseri!** ${mat.emoji} **${mat.name}** × 1 craft malzemesi düştü! (\`/envanter\` → Craft)`;
  }

  // tool (default)
  const tool = picked.data;
  addPlayerTool(gid, uid, tool.key);
  return `✨ **Şans Eseri!** ${tool.emoji} **${tool.name}** düştü! (\`/pazar envanter\` ile gör)`;
}

// Oyuncu Pazarı DB yardımcıları
function createMarketListing(gid, sellerId, itemType, itemKey, price) {
  const listedAt = new Date().toISOString();
  const res = db.prepare('INSERT INTO player_market(guildId,sellerId,itemType,itemKey,price,listedAt)VALUES(?,?,?,?,?,?)').run(gid, sellerId, itemType, itemKey, price, listedAt);
  return res.lastInsertRowid;
}
function getMarketListings(gid)         { return db.prepare('SELECT * FROM player_market WHERE guildId=? ORDER BY id DESC').all(gid); }
function getMarketListing(id)           { return db.prepare('SELECT * FROM player_market WHERE id=?').get(id); }
function deleteMarketListing(id)        { db.prepare('DELETE FROM player_market WHERE id=?').run(id); }

// Hem ham hem gelişmiş craft malzemelerinde arama yapar (pazar/craft ortak kullanır)
function findAnyCraftMaterial(key) {
  return CRAFT_MATERIALS.find(m => m.key === key) || ADVANCED_CRAFT_MATERIALS.find(m => m.key === key);
}

// Pazar ilanının görüntülenecek adını çözer — silah/zırh/pet/malzeme JSON
// payload olarak itemKey içinde saklanır (enhancement/level gibi durumu
// korumak için); diğerleri (kazma/balta/ejder/antika/relic) düz anahtar.
function describeMarketItem(l) {
  try {
    if (l.itemType === 'silah') {
      const p = JSON.parse(l.itemKey);
      return `${getWeaponName(p.weaponKey)} (+${p.enhancement})`;
    }
    if (l.itemType === 'zirh') {
      const p = JSON.parse(l.itemKey);
      return `${getArmorName(p.slot, p.armorKey.split('_')[1] || '')} (+${p.enhancement})`;
    }
    if (l.itemType === 'pet') {
      const p = JSON.parse(l.itemKey);
      const def = MMORPG_PETS.find(x => x.key === p.petKey);
      return `${def?.emoji || '🐾'} **${def?.name || p.petKey}** Lv.${p.level}`;
    }
    if (l.itemType === 'malzeme') {
      const p = JSON.parse(l.itemKey);
      const def = findAnyCraftMaterial(p.matKey);
      return `${def?.emoji || '🔩'} **${def?.name || p.matKey}** × ${p.quantity}`;
    }
  } catch { /* eski/bozuk payload — anahtarı olduğu gibi göster */ }

  if (l.itemType === 'relic') {
    const def = RELICS.find(x => x.key === l.itemKey) || ALL_NEW_RELIC_PIECES.find(x => x.key === l.itemKey);
    return def ? `${def.emoji} ${def.name}` : l.itemKey;
  }
  const def = ALL_TOOLS.find(x => x.key === l.itemKey)
    || RELICS.find(x => x.key === l.itemKey)
    || ANTIQUES.find(x => x.key === l.itemKey);
  return def ? `${def.emoji} ${def.name}` : l.itemKey;
}
// İlan alım/iptal iadesinde eşyayı alıcının/satıcının envanterine geri koyar
function grantMarketItem(gid, uid, listing) {
  if (listing.itemType === 'kazma' || listing.itemType === 'balta') {
    addPlayerTool(gid, uid, listing.itemKey);
  } else if (listing.itemType === 'ejder') {
    buyRelic(gid, uid, listing.itemKey);
  } else if (listing.itemType === 'antika') {
    addAntique(gid, uid, listing.itemKey);
  } else if (listing.itemType === 'relic') {
    buyRelic(gid, uid, listing.itemKey);
  } else if (listing.itemType === 'malzeme') {
    const p = JSON.parse(listing.itemKey);
    addCraftMat(gid, uid, p.matKey, p.quantity);
  } else if (listing.itemType === 'silah') {
    const p = JSON.parse(listing.itemKey);
    db.prepare('INSERT INTO mmo_weapons(guildId,userId,weaponKey,enhancement)VALUES(?,?,?,?)').run(gid, uid, p.weaponKey, p.enhancement);
  } else if (listing.itemType === 'zirh') {
    const p = JSON.parse(listing.itemKey);
    db.prepare('INSERT INTO mmo_armors(guildId,userId,armorKey,slot,enhancement)VALUES(?,?,?,?,?)').run(gid, uid, p.armorKey, p.slot, p.enhancement);
  } else if (listing.itemType === 'pet') {
    const p = JSON.parse(listing.itemKey);
    db.prepare('INSERT OR IGNORE INTO mmo_pets(guildId,userId,petKey,level,hatchedAt)VALUES(?,?,?,?,?)').run(gid, uid, p.petKey, p.level, `${Date.now()}_${Math.floor(Math.random()*1000)}`);
  }
}

// ──────────────────────────────────────────────────────────────
//  RELİK YARDIMCILARI
// ──────────────────────────────────────────────────────────────
function getRelics(gid, uid)          { return db.prepare('SELECT relicKey FROM relics WHERE guildId=? AND userId=?').all(gid, uid).map(r => r.relicKey); }
function hasRelic(gid, uid, key)      { return !!db.prepare('SELECT 1 FROM relics WHERE guildId=? AND userId=? AND relicKey=?').get(gid, uid, key); }

// messageCreate her mesajda hasAllEjderParts()'ı (XP ve Coin hesapları için ayrı
// ayrı) çağırıyor. Bunu ham SQL'e her seferinde gitmek yerine, kısa ömürlü
// (3 sn) bir bellek içi cache ile besliyoruz — trafik yoğun sunucularda relik
// kontrolü başına 3 sorguyu 1'e, mesaj başına toplam sorgu sayısını da
// büyük ölçüde azaltır. Relik satın alma/yükseltme az sıklıkta olduğundan
// 3 sn'lik olası gecikme (satın al → hemen mesaj at) kabul edilebilir; yine de
// buyRelic/upgradeEjderSet çağrılarında cache anında temizleniyor.
const _ownedRelicsCache = new Map(); // key: `${gid}:${uid}` -> { keys, expires }
const OWNED_RELICS_CACHE_TTL = 3000;
function getRelicsCached(gid, uid) {
  const key = `${gid}:${uid}`;
  const now = Date.now();
  const hit = _ownedRelicsCache.get(key);
  if (hit && hit.expires > now) return hit.keys;
  const keys = getRelics(gid, uid);
  _ownedRelicsCache.set(key, { keys, expires: now + OWNED_RELICS_CACHE_TTL });
  return keys;
}
function invalidateRelicsCache(gid, uid) { _ownedRelicsCache.delete(`${gid}:${uid}`); }

function buyRelic(gid, uid, key)      { db.prepare('INSERT OR IGNORE INTO relics(guildId,userId,relicKey)VALUES(?,?,?)').run(gid, uid, key); invalidateRelicsCache(gid, uid); }
function hasAllEjderParts(gid, uid)   { const owned = getRelicsCached(gid, uid); return EJDER_SET_KEYS.every(k => owned.includes(k)); }

// Relik yükseltme (Lv1-5, her biri RELIC_UPGRADE_COST coin, +RELIC_BONUS_PER_LEVEL% bonus/lv)
function getRelicLevel(gid, uid, key) {
  if (!hasRelic(gid, uid, key)) return 0;
  const r = db.prepare('SELECT level FROM relic_upgrades WHERE guildId=? AND userId=? AND relicKey=?').get(gid, uid, key);
  return r ? r.level : 1;
}
function upgradeRelic(gid, uid, key) {
  db.prepare('INSERT OR IGNORE INTO relic_upgrades(guildId,userId,relicKey,level)VALUES(?,?,?,1)').run(gid, uid, key);
  db.prepare('UPDATE relic_upgrades SET level=level+1 WHERE guildId=? AND userId=? AND relicKey=?').run(gid, uid, key);
}

// Ejder Seti seviyesi — set tamamlanmadan (3 parça) 0 döner, yani yükseltilemez.
// Tamamlandığında ilk sorguda otomatik olarak Lv.1 kabul edilir (satır DB'de yoksa).
function getEjderLevel(gid, uid) {
  if (!hasAllEjderParts(gid, uid)) return 0;
  const r = db.prepare('SELECT level FROM relic_upgrades WHERE guildId=? AND userId=? AND relicKey=?').get(gid, uid, 'ejderset');
  return r ? r.level : 1;
}
function upgradeEjderSet(gid, uid) {
  db.prepare('INSERT OR IGNORE INTO relic_upgrades(guildId,userId,relicKey,level)VALUES(?,?,?,1)').run(gid, uid, 'ejderset');
  db.prepare('UPDATE relic_upgrades SET level=level+1 WHERE guildId=? AND userId=? AND relicKey=?').run(gid, uid, 'ejderset');
}
function getEjderCoinBonus(gid, uid) {
  const lv = getEjderLevel(gid, uid); // 0 dönerse set tamamlanmamış demektir
  if (lv === 0) return 0;
  return EJDER_BASE_COIN_BONUS + (lv - 1) * EJDER_BONUS_PER_LEVEL; // Lv1=30% … Lv5=58%
}
function getEjderXpBonus(gid, uid) {
  const lv = getEjderLevel(gid, uid); // 0 dönerse set tamamlanmamış demektir
  if (lv === 0) return 0;
  return EJDER_BASE_XP_BONUS + (lv - 1) * EJDER_BONUS_PER_LEVEL; // Lv1=20% … Lv5=48%
}

function getRelicXpBonus(gid, uid) {
  let bonus = 0;
  if (hasRelic(gid, uid, 'bilgelik')) {
    const lv = getRelicLevel(gid, uid, 'bilgelik');
    bonus += 15 + (lv - 1) * RELIC_BONUS_PER_LEVEL; // Lv1=15% … Lv5=35%
  }
  bonus += getEjderXpBonus(gid, uid); // Ejder seti Lv1=%20 … Lv5=%48
  bonus += getRelicSetXpBonus(gid, uid); // Yeni MMORPG relic setleri
  return bonus;
}
function getRelicCoinBonus(gid, uid) {
  let bonus = 0;
  if (hasRelic(gid, uid, 'tuccar')) {
    const lv = getRelicLevel(gid, uid, 'tuccar');
    bonus += 10 + (lv - 1) * RELIC_BONUS_PER_LEVEL; // Lv1=10% … Lv5=30%
  }
  bonus += getEjderCoinBonus(gid, uid); // Ejder seti Lv1=%30 … Lv5=%58
  return bonus;
}
function getRelicMineBonus(gid, uid) {
  if (!hasRelic(gid, uid, 'madenci')) return 0;
  const lv = getRelicLevel(gid, uid, 'madenci');
  return 20 + (lv - 1) * RELIC_BONUS_PER_LEVEL; // Lv1=20% … Lv5=40%
}
function getRelicFishBonus(gid, uid) {
  if (!hasRelic(gid, uid, 'tuccar')) return 0;
  const lv = getRelicLevel(gid, uid, 'tuccar');
  return 10 + (lv - 1) * RELIC_BONUS_PER_LEVEL; // Lv1=10% … Lv5=30%
}
function getRelicDenizFishMultiplier(gid, uid) {
  if (!hasRelic(gid, uid, 'deniz')) return 1.0;
  const lv = getRelicLevel(gid, uid, 'deniz');
  return 1.3 + (lv - 1) * 0.2; // Lv1=1.3x … Lv5=2.1x nadir balık ağırlığı
}

// ──────────────────────────────────────────────────────────────
//  HAYVAN MAMASI YARDIMCILARI
// ──────────────────────────────────────────────────────────────
function getPetFedDate(gid, uid, petKey)         { const r = db.prepare('SELECT lastFedAt FROM pet_food WHERE guildId=? AND userId=? AND petKey=?').get(gid, uid, petKey); return r ? r.lastFedAt : null; }
function setPetFedDate(gid, uid, petKey, date)   { db.prepare('INSERT OR REPLACE INTO pet_food(guildId,userId,petKey,lastFedAt)VALUES(?,?,?,?)').run(gid, uid, petKey, date); }

function isPetAlive(gid, uid, petKey) {
  const fedDate = getPetFedDate(gid, uid, petKey);
  if (!fedDate) return true; // Hiç mama kaydı yoksa ölmüş sayılmaz (yeni sistem)
  const today    = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-');
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-');
  // Bugün veya dün beslendiyse canlı
  return fedDate >= yesterday;
}

function killPet(gid, uid, petKey) {
  db.prepare('DELETE FROM pets WHERE guildId=? AND userId=? AND petKey=?').run(gid, uid, petKey);
  db.prepare('DELETE FROM pet_food WHERE guildId=? AND userId=? AND petKey=?').run(gid, uid, petKey);
  db.prepare('DELETE FROM active_pet WHERE guildId=? AND userId=?').run(gid, uid);
}

// Starvation check: Pet açsa öldür, canlı petleri döndür
function checkAndKillHungryPets(gid, uid) {
  const rows = db.prepare('SELECT petKey FROM pets WHERE guildId=? AND userId=?').all(gid, uid);
  const killed = [];
  for (const r of rows) {
    const fedDate = getPetFedDate(gid, uid, r.petKey);
    if (fedDate !== null && !isPetAlive(gid, uid, r.petKey)) {
      killPet(gid, uid, r.petKey);
      const def = PETS.find(p => p.key === r.petKey);
      if (def) killed.push(def);
    }
  }
  return killed;
}

// ──────────────────────────────────────────────────────────────
//  ÇAPRAZ BOOST HESAPLAMA
// ──────────────────────────────────────────────────────────────
// XP çarpanı — YALNIZCA normal seviye sistemi, madencilik XP'sini etkilemez
function getXpMultiplier(gid, uid, consume = true) {
  let m = 1.0;
  if (hasBoost(gid, uid)) {
    m *= 1.5; // Kalıcı XP Boost artık 1.5x
  } else if (hasTempBoost(gid, uid)) {
    m *= 2.0;
    if (consume) consumeTempBoost(gid, uid);
  }
  m += (getAntiqueXpBonus(gid, uid) + getPetXpBonus(gid, uid) + getRelicXpBonus(gid, uid)) / 100;
  return m;
}

// Pet/Antika/Relik XP bonusu — madencilik ve odunculuk XP'sine de uygulanır.
// (Kalıcı/geçici XP Boost item'ları burada YOK; onlar yalnızca sohbet seviye
// sistemini etkilemeye devam ediyor. Bu sadece "sahip olunan" pasif bonuslar.)
function getPassiveXpBonusPct(gid, uid) {
  return (getAntiqueXpBonus(gid, uid) + getPetXpBonus(gid, uid) + getRelicXpBonus(gid, uid)) / 100;
}

// Mülk coin bonusu: Ev Lv başına +%2, Araba Lv başına +%2
function getPropertyCoinBonus(gid, uid) {
  const p = getProperties(gid, uid);
  return p.houseLevel * 2 + p.carLevel * 2;
}

// Coin bonus % (chat coin, madencilik satışı vb.)
function getTotalCoinBonusPct(gid, uid) { return getAntiqueCoinBonus(gid, uid) + getPetCoinBonus(gid, uid) + getPropertyCoinBonus(gid, uid) + (hasCoinBoost(gid, uid) ? 50 : 0) + getRelicCoinBonus(gid, uid) + getRelicSetCoinBonus(gid, uid); }

// Günlük ödül bonus % (yalnızca %1 antika + baykuş pet)
function getTotalDailyBonusPct(gid, uid) { return getAntiqueDailyBonus(gid, uid) + getPetDailyBonus(gid, uid) + getRelicSetDailyBonus(gid, uid); }

// ── Tarih / Saat yardımcıları ─────────────────────────────────
function todayTR()    { return new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-'); }
function nowTR()      { return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }); }
function sleep(ms)    { return new Promise(resolve => setTimeout(resolve, ms)); }
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

function pickFish(boosted, denizMult = 1.0) {
  let pool = FISH_TYPES.map(f => ({ ...f }));
  if (boosted)         pool = pool.map(f => ({ ...f, weight: f.value >= 14  ? f.weight * 3         : f.weight }));
  if (denizMult > 1.0) pool = pool.map(f => ({ ...f, weight: f.value >= 100 ? f.weight * denizMult : f.weight }));
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

  return { type: 'catch', fish: pickFish(boosted, getRelicDenizFishMultiplier(gid, uid)) };
}

// Blackjack / At Yarışı ortak ödül hesaplayıcı — 2x kazanç (bet kadar kâr)
// Coin boost / relik / pet / antika / mülk bonusları artık kazanılan tutara da uygulanıyor.
function resolveWinAmount(bet, gid, uid) {
  const base = Math.random() < 0.001 ? bet * 4 : bet * 2;
  if (!gid || !uid) return base; // gid/uid verilmediyse eski davranış (bonussuz)
  const bonusPct = getTotalCoinBonusPct(gid, uid);
  return Math.round(base * (1 + bonusPct / 100));
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
// (voiceDailySec ve voiceDailyClaimed kaldırıldı — tier sistemi yerine çıkışta dakika başına 2 coin ödeniyor)
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
  { key: 'bread', name: 'Ekmek', emoji: '🍞', price: 50,  uses: 10, desc: '10 kullanım hakkı verir' },
  { key: 'soup',  name: 'Çorba', emoji: '🍲', price: 100, uses: 20, desc: '20 kullanım hakkı verir' },
  { key: 'meat',  name: 'Et',    emoji: '🥩', price: 300, uses: 40, desc: '40 kullanım hakkı verir' },
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
function getMiningCapacity(level)   { return level >= 40 ? 8 : level >= 30 ? 7 : level >= 20 ? 5 : level >= 10 ? 3 : 2; }
function getMiningXpNeeded(level)   { return level * 9; } // %200 zorlaştırıldı (eskiden level*3)
function getEnergyXpNeeded(level)   { return level * 10; }

const MINING_MAX_LEVEL = 100;
const MINE_TRIP_COST   = 3; // gezi başına işçi başına ödenen coin (odunculukla aynı ücret)

function getMiningRank(level) {
  if (level >= 100) return { name: 'Godslayer',  emoji: '👑', color: 0x000000 };
  if (level >= 50) return { name: 'Challenger', emoji: '🔥', color: 0xFF0000 };
  if (level >= 45) return { name: 'Legendary',  emoji: '⭐', color: 0xFF6B00 };
  if (level >= 40) return { name: 'Grandmaster',emoji: '🏆', color: 0x9B59B6 };
  if (level >= 35) return { name: 'Diamond',    emoji: '💎', color: 0x00BFFF };
  if (level >= 30) return { name: 'Emerald',    emoji: '💚', color: 0x2ECC71 };
  if (level >= 25) return { name: 'Platinum',   emoji: '🔮', color: 0x1ABC9C };
  if (level >= 20) return { name: 'Master',     emoji: '👑', color: 0xE74C3C };
  if (level >= 15) return { name: 'Gold',       emoji: '🥇', color: 0xF1C40F };
  if (level >= 10) return { name: 'Iron',       emoji: '⚙️', color: 0x95A5A6 };
  if (level >= 5)  return { name: 'Bronze',     emoji: '🥉', color: 0xCD7F32 };
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
      '💸 Her gezi için işçi başına **3 coin** ücret ödenir.\n' +
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
    .setFooter({ text: 'Başlangıç: 2 işçi | Rütbeler: Bronze(Lv5) • Iron(Lv10) • Gold(Lv15) • Master(Lv20) • Platinum(Lv25) • Emerald(Lv30) • Diamond(Lv35) • Grandmaster(Lv40) • Legendary(Lv45) • Challenger(Lv50) • Godslayer(Lv100)' });

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

    // Gezi ücreti kontrolü (odunculukla aynı mantık: işçi başına sabit ücret)
    const tripCost = sendCount * MINE_TRIP_COST;
    const bal = getBalance(gid, uid).balance;
    if (bal < tripCost) {
      return interaction.reply({
        ephemeral: true,
        content: `💸 Gezi ücreti ödenemedi!\n**${sendCount}** işçi × **${MINE_TRIP_COST} coin** = **${tripCost} coin** gerekli. Bakiye: **${bal} coin**`,
      });
    }
    addBalance(gid, uid, -tripCost);

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

    // Madencilik XP (maks seviye: 100 — Godslayer)
    let leveledUp = false;
    if (data.miningLevel < MINING_MAX_LEVEL) {
      data.miningXp += Math.round(effectiveSend * (1 + getPassiveXpBonusPct(gid, uid)));
      while (data.miningXp >= getMiningXpNeeded(data.miningLevel) && data.miningLevel < MINING_MAX_LEVEL) {
        data.miningXp -= getMiningXpNeeded(data.miningLevel);
        data.miningLevel++;
        leveledUp = true;
      }
      // Maks seviyeye ulaşıldıysa XP'yi sıfırla
      if (data.miningLevel >= MINING_MAX_LEVEL) {
        data.miningXp = 0;
      }
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
        { name: '🏅 Rütbe / Seviye',       value: `${rank.emoji} **${rank.name}** Lv.${data.miningLevel}${data.miningLevel >= MINING_MAX_LEVEL ? ' 🔥 MAX' : ''}`, inline: true },
        { name: '📈 Madencilik XP',        value: data.miningLevel >= MINING_MAX_LEVEL ? '**MAX SEVİYE** 🔥' : `${data.miningXp} / ${getMiningXpNeeded(data.miningLevel)}`, inline: true },
        { name: '🍽️ İşçi Durumu',        value: foodStr,                                                 inline: true },
        { name: '💸 Ödenen Ücret',       value: `**-${tripCost} coin**`,                                inline: true },
      );

    if (leveledUp && data.miningLevel < MINING_MAX_LEVEL) embed.addFields({ name: '🎉 SEVİYE ATLADI!', value: `Madencilik Lv.**${data.miningLevel}** oldun! ${getMiningRank(data.miningLevel).emoji} **${getMiningRank(data.miningLevel).name}**`, inline: false });
    if (leveledUp && data.miningLevel >= MINING_MAX_LEVEL) embed.addFields({ name: '🏆 MAKSİMUM SEVİYE!', value: `👑 **Godslayer** oldun! Lv.100 — Madenciliğin zirvesine ulaştın! Artık XP kazanımı durdu.`, inline: false });
    if (justRanOut)   embed.addFields({ name: '🍽️ Yiyecek Bitti!',   value: 'Tüm yiyecek kullanımları tükendi! Marketten yenisini al.',       inline: false });
    if (isHungry)     embed.addFields({ name: '😫 İşçiler Aç!',       value: 'Yiyecek yok — verimlilik %50 düştü! Marketten yemek al.',        inline: false });

    // ── 1/20 şans eseri drop (gönderme anında) ──────────────
    if (Math.random() < 1 / 20) {
      const dropMsg = giveRareDrop(gid, uid, MINING_TOOLS);
      embed.addFields({ name: '🎉 Nadir Düşme!', value: dropMsg });
    }

    // ── Sabit sayıda craft malzeme düşmesi (her gönderimde) ──
    // ESKİ SİSTEM: her malzeme kendi başına bağımsız bir ihtimalle "düşer miydi"
    // diye ayrı ayrı zar atılıyordu (0-14 arası rastgele sayıda malzeme).
    // YENİ SİSTEM (kullanıcı isteği): her madene gönderişte SABİT 4 adet craft
    // malzemesi düşer (Şanslı Kazma Reliği ile 2x → 8 adet). HANGİ malzemenin
    // düşeceği, aşağıdaki `weight` değerine göre ağırlıklı rastgele seçilir —
    // ağırlıklar eski `chance` değerlerinden türetildi, yani yaygın (tier-1)
    // cevherler hâlâ en sık, nadir (tier-4) cevherler hâlâ en nadir çıkıyor;
    // sadece "her seferinde kaç tane düşer" artık şansa değil sabit sayıya bağlı.
    {
      const _matDropTable = [
        { minLevel: 1,  key: 'demir_cevheri',     weight: 144, emoji: '⚙️',  name: 'Demir' },
        { minLevel: 1,  key: 'bakir_cevheri',     weight: 144, emoji: '🟤', name: 'Bakır' },
        { minLevel: 5,  key: 'altin_cevheri',     weight: 288, emoji: '🟡', name: 'Altın' },
        { minLevel: 5,  key: 'obsidyen',           weight: 115, emoji: '🪨', name: 'Obsidyen' },
        { minLevel: 10, key: 'elmas_cevheri',      weight: 101, emoji: '💎', name: 'Elmas' },
        { minLevel: 10, key: 'saf_kristal',        weight: 101, emoji: '🔮', name: 'Saf Kristal' },
        { minLevel: 10, key: 'lav_tasi',           weight: 101, emoji: '🌋', name: 'Lav Taşı' },
        { minLevel: 15, key: 'ruh_tozu',           weight: 86,  emoji: '👻', name: 'Ruh Tozu' },
        { minLevel: 20, key: 'ejder_pulu',         weight: 86,  emoji: '🐉', name: 'Ejder Pulu' },
        { minLevel: 20, key: 'ay_tasi',            weight: 86,  emoji: '🌙', name: 'Ay Taşı' },
        { minLevel: 25, key: 'karanlik_oz',        weight: 72,  emoji: '🌑', name: 'Karanlık Öz' },
        { minLevel: 25, key: 'gunes_parcasi',      weight: 72,  emoji: '☀️', name: 'Güneş Parçası' },
        { minLevel: 30, key: 'yildirim_kristali',  weight: 72,  emoji: '⚡', name: 'Yıldırım Kristali' },
        { minLevel: 30, key: 'buz_cekirdegi',      weight: 72,  emoji: '❄️', name: 'Buz Çekirdeği' },
      ];
      const MINE_CRAFT_DROP_COUNT = 4; // gönderim başına sabit düşen malzeme adedi

      // Şanslı Kazma Reliği (tek parça, satın alındığı an oto aktif) artık
      // düşen malzeme SAYISINI 2 katına çıkarıyor (4 → 8), tek tek şansları değil.
      const _luckyMineRelic = hasRelic(gid, uid, 'sansli_kazma');
      const dropCount = MINE_CRAFT_DROP_COUNT * (_luckyMineRelic ? 2 : 1);

      const _eligible = _matDropTable.filter(md => data.miningLevel >= md.minLevel);
      const _totalWeight = _eligible.reduce((s, m) => s + m.weight, 0);

      const _dropCounts = {};
      for (let i = 0; i < dropCount && _eligible.length; i++) {
        let r = Math.random() * _totalWeight;
        let picked = _eligible[_eligible.length - 1];
        for (const md of _eligible) {
          if (r < md.weight) { picked = md; break; }
          r -= md.weight;
        }
        _dropCounts[picked.key] = (_dropCounts[picked.key] || 0) + 1;
      }

      const _matDrops = [];
      for (const [key, qty] of Object.entries(_dropCounts)) {
        addCraftMat(gid, uid, key, qty);
        const def = _matDropTable.find(m => m.key === key);
        _matDrops.push(`${def.emoji} **${def.name}** × ${qty}`);
      }
      if (_matDrops.length) {
        embed.addFields({ name: `⛏️ Craft Malzeme Düştü! (${dropCount} adet${_luckyMineRelic ? ' — 2x Şanslı Kazma' : ''})`, value: _matDrops.join('\n'), inline: false });
      }
    }

    // ── Madencilik Lv.15: Rol ver + madencilik kanalına duyuru ─
    if (leveledUp && data.miningLevel >= 15) {
      const WOOD_UNLOCK_ROLE = '1526518698054123602';
      try {
        const member = interaction.member || await interaction.guild.members.fetch(uid).catch(() => null);
        if (member && !member.roles.cache.has(WOOD_UNLOCK_ROLE)) {
          await member.roles.add(WOOD_UNLOCK_ROLE).catch(() => {});
          // DM ile bildirim
          await member.send({
            content: `🪓 **Tebrikler!** Madencilikte **Lv.15**'e ulaştın! <#${WOODCUTTING_CHANNEL_ID}> kanalı sana açıldı. 🎉`,
          }).catch(() => {});
        }
      } catch (e) { /* rol verilemezse sessizce geç */ }
    }

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
    // Enflasyon kesintisi kaldırıldı — satış değeri artık tam veriliyor. Madenci Reliği +%20 + En iyi kazma bonusu
    const mineCoinsRaw  = totalValue;
    const mineToolBonus = getBestMiningToolBonus(gid, uid);
    const mineSetBonus  = getRelicSetMineBonus(gid, uid); // Gölge Seti — Madencilik satışı
    const mineBonus     = getTotalCoinBonusPct(gid, uid) + getRelicMineBonus(gid, uid) + mineToolBonus + mineSetBonus;
    const mineEarned    = Math.round(mineCoinsRaw * (1 + mineBonus / 100));
    addBalance(gid, uid, mineEarned);

    const bestKazma = getBestMiningToolDef(gid, uid);
    const toolStr   = bestKazma ? ` • ${bestKazma.emoji} ${bestKazma.name} (+%${bestKazma.bonus})` : '';

    const embed = new EmbedBuilder()
      .setTitle('💰 Madenler Satıldı!')
      .setColor(0x2ECC71)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: '💰 Kazanılan', value: `**+${mineEarned} coin**${mineBonus > 0 ? ` (+%${mineBonus}${toolStr})` : ''}`, inline: true },
        { name: '💳 Yeni Bakiye', value: `**${getBalance(gid, uid).balance} coin**`, inline: true },
      );

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
      new ButtonBuilder().setCustomId('mine_buy_bread').setLabel('🍞 Ekmek 50c').setStyle(ButtonStyle.Success).setDisabled(bal < 50 || data.breadUses > 0),
      new ButtonBuilder().setCustomId('mine_buy_soup').setLabel('🍲 Çorba 100c').setStyle(ButtonStyle.Success).setDisabled(bal < 100 || data.soupUses > 0),
      new ButtonBuilder().setCustomId('mine_buy_meat').setLabel('🥩 Et 300c').setStyle(ButtonStyle.Success).setDisabled(bal < 300 || data.meatUses > 0),
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

    // Aynı yemek hakkı bitmeden tekrar alınamaz
    const currentUses = food.key === 'bread' ? data.breadUses : food.key === 'soup' ? data.soupUses : data.meatUses;
    if (currentUses > 0)
      return interaction.reply({ ephemeral: true, content: `❌ **${food.emoji} ${food.name}** hakkın henüz bitmedi! (**${currentUses}** kullanım kaldı). Önce mevcut hakkını kullan.` });

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
            '• Her gezide işçi başına **3 coin** ücret ödenir',
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
          name: '🏅 Rütbeler (Her 5 seviyede yeni rütbe)',
          value: [
            '⛏️ Beginner(Lv1) → 🥉 Bronze(Lv5) → ⚙️ Iron(Lv10) → 🥇 Gold(Lv15)',
            '👑 Master(Lv20) → 🔮 Platinum(Lv25) → 💚 Emerald(Lv30)',
            '💎 Diamond(Lv35) → 🏆 Grandmaster(Lv40) → ⭐ Legendary(Lv45)',
            '🔥 Challenger(Lv50) → 👑 **Godslayer (Lv.100 — MAKSİMUM)**',
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
        { name: '🏅 Rütbe',               value: `${rank.emoji} **${rank.name}** Lv.${data.miningLevel}${data.miningLevel >= MINING_MAX_LEVEL ? ' 🔥 MAX' : ''}`, inline: true },
        { name: '📈 Madencilik XP',        value: data.miningLevel >= MINING_MAX_LEVEL ? '**MAX SEVİYE** 🔥 — XP kazanımı durdu' : `${data.miningXp} / ${getMiningXpNeeded(data.miningLevel)}`, inline: true },
        { name: '👷 İşçi Sayısı',         value: `**${data.miners}** işçi`,                              inline: true },
        { name: '⚡ Enerji',               value: `**${data.energy}** / ${maxEnergy}`,                   inline: true },
        { name: '⚡ Enerji Seviyesi',      value: `Lv.**${data.energyLevel}** (${data.energyXp}/${getEnergyXpNeeded(data.energyLevel)} XP)`, inline: true },
        { name: '🔋 Enerji Kapasitesi',   value: `**${capTotalPurchases}/15** alım (+${capTotalPurchases * 5} max enerji)`, inline: true },
        { name: '🏭 Gezi Kapasitesi',     value: `Gezi başına **${capacity}** maden`,                   inline: true },
        { name: '🍽️ İşçi Durumu',       value: hungryStr,                                              inline: false },
        { name: '📦 Toplam Maden',        value: `**${data.totalOresMined}** adet`,                     inline: true },
        { name: '💰 Sonraki İşçi',        value: `**${tier.price}** coin (Lv.${tier.minLevel})`,        inline: true },
      )
      .setFooter({ text: 'Rütbeler: Bronze(Lv5) • Iron(Lv10) • Gold(Lv15) • Master(Lv20) • Platinum(Lv25) • Emerald(Lv30) • Diamond(Lv35) • Grandmaster(Lv40) • Legendary(Lv45) • 🔥Challenger(Lv50) • 👑Godslayer(Lv100)' });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }
}

// ──────────────────────────────────────────────────────────────
//  ODUNCULUK OYUNU SABİTLERİ & YARDIMCILARI
// ──────────────────────────────────────────────────────────────
const WOODCUTTING_CHANNEL_ID = '1526334843552796683';
const WOOD_EMPTY_CHANCE = 0.10; // her işçi için %10 boş dönme şansı
const WOOD_TRIP_COST    = 3;    // gezi başına işçi başına ödenen coin

const WOODS = [
  { key: 'pine',   name: 'Çam',         emoji: '🌲', value: 8,   weight: 30 },
  { key: 'oak',    name: 'Meşe',        emoji: '🌳', value: 15,  weight: 25 },
  { key: 'birch',  name: 'Huş',         emoji: '🪵', value: 25,  weight: 18 },
  { key: 'maple',  name: 'Akçaağaç',    emoji: '🍁', value: 40,  weight: 12 },
  { key: 'walnut', name: 'Ceviz',       emoji: '🌰', value: 65,  weight: 8  },
  { key: 'cherry', name: 'Kiraz',       emoji: '🌸', value: 100, weight: 4  },
  { key: 'ebony',  name: 'Abanoz',      emoji: '🖤', value: 180, weight: 2  },
  { key: 'dragon', name: 'Ejder Ağacı', emoji: '🐉', value: 350, weight: 1  },
];

const WOOD_WORKER_TIERS = [
  { price: 500,  minLevel: 1,  maxPurchases: 1 },
  { price: 2000, minLevel: 10, maxPurchases: 5 },
  { price: 4000, minLevel: 20, maxPurchases: 5 },
];

const WOOD_ENERGY_CAP_TIERS = [
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
  { price: 2000, maxPurchases: 10 },
];

const WOOD_COOLDOWNS = new Map();
function woodCooldownCheck(gid, uid) {
  const key = `${gid}:${uid}`;
  const last = WOOD_COOLDOWNS.get(key) || 0;
  const remaining = 10000 - (Date.now() - last);
  if (remaining > 0) return Math.ceil(remaining / 1000);
  WOOD_COOLDOWNS.set(key, Date.now());
  return 0;
}

function getWoodData(gid, uid) {
  let r = db.prepare('SELECT * FROM woodcutting_data WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) {
    db.prepare(
      `INSERT OR IGNORE INTO woodcutting_data(guildId,userId,lumberjacks,woodLevel,woodXp,energyLevel,energyXp,energy,lastEnergyRegen,workerTier,purchasesInTier,totalLogsCut,breadUses,soupUses,meatUses,energyCapTier,energyCapPurchasesInTier)
       VALUES(?,?,2,1,0,1,0,20,?,0,0,0,0,0,0,0,0)`
    ).run(gid, uid, Date.now());
    r = db.prepare('SELECT * FROM woodcutting_data WHERE guildId=? AND userId=?').get(gid, uid);
  }
  r.breadUses                = r.breadUses                ?? 0;
  r.soupUses                 = r.soupUses                 ?? 0;
  r.meatUses                 = r.meatUses                 ?? 0;
  r.energyCapTier            = r.energyCapTier            ?? 0;
  r.energyCapPurchasesInTier = r.energyCapPurchasesInTier ?? 0;
  return r;
}

function saveWoodData(gid, uid, data) {
  db.prepare(
    `UPDATE woodcutting_data SET lumberjacks=?,woodLevel=?,woodXp=?,energyLevel=?,energyXp=?,energy=?,lastEnergyRegen=?,workerTier=?,purchasesInTier=?,totalLogsCut=?,breadUses=?,soupUses=?,meatUses=?,energyCapTier=?,energyCapPurchasesInTier=?
     WHERE guildId=? AND userId=?`
  ).run(
    data.lumberjacks, data.woodLevel, data.woodXp,
    data.energyLevel, data.energyXp,
    data.energy, data.lastEnergyRegen,
    data.workerTier, data.purchasesInTier, data.totalLogsCut,
    data.breadUses, data.soupUses, data.meatUses,
    data.energyCapTier, data.energyCapPurchasesInTier,
    gid, uid
  );
}

function getWoodMaxEnergy(data) {
  const capBonus = (data.energyCapTier * 10 * 5) + (data.energyCapPurchasesInTier * 5);
  return 19 + (data.energyLevel ?? 1) + capBonus;
}

function getWoodXpNeeded(level)    { return level * 3; }
function getWoodEnergyXpNeeded(lv) { return lv * 10; }

function getWoodRank(level) {
  if (level >= 20) return { name: 'Usta',     emoji: '👑', color: 0xE74C3C };
  if (level >= 15) return { name: 'Kıdemli',  emoji: '🪓', color: 0xF1C40F };
  if (level >= 10) return { name: 'Deneyimli',emoji: '⚙️', color: 0x95A5A6 };
  if (level >= 5)  return { name: 'Çırak',    emoji: '🌿', color: 0x27AE60 };
  return { name: 'Acemi', emoji: '🌱', color: 0x3498DB };
}

function regenWoodEnergy(data) {
  const now = Date.now();
  const elapsed = now - (data.lastEnergyRegen || now);
  const regenCount = Math.floor(elapsed / (2 * 60 * 1000));
  if (regenCount > 0) {
    const maxE = getWoodMaxEnergy(data);
    data.energy = Math.min(maxE, data.energy + regenCount);
    data.lastEnergyRegen = (data.lastEnergyRegen || now) + regenCount * 2 * 60 * 1000;
  }
  return data;
}

function pickWood() {
  const total = WOODS.reduce((a, w) => a + w.weight, 0);
  let r = Math.random() * total;
  for (const w of WOODS) { if (r < w.weight) return w; r -= w.weight; }
  return WOODS[0];
}

function getWoodInventory(gid, uid) {
  return db.prepare('SELECT * FROM woodcutting_inventory WHERE guildId=? AND userId=?').all(gid, uid);
}
function addWoodLog(gid, uid, woodKey, amount) {
  db.prepare('INSERT OR IGNORE INTO woodcutting_inventory(guildId,userId,wood,amount)VALUES(?,?,?,0)').run(gid, uid, woodKey);
  db.prepare('UPDATE woodcutting_inventory SET amount=amount+? WHERE guildId=? AND userId=? AND wood=?').run(amount, gid, uid, woodKey);
}
function clearWoodInventory(gid, uid) {
  db.prepare('DELETE FROM woodcutting_inventory WHERE guildId=? AND userId=?').run(gid, uid);
}
function getWoodLeaderboard(gid, limit = 10) {
  return db.prepare(
    'SELECT userId,woodLevel,totalLogsCut FROM woodcutting_data WHERE guildId=? ORDER BY woodLevel DESC, totalLogsCut DESC LIMIT ?'
  ).all(gid, limit);
}

function buildWoodPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🪓 Odunculuk Oyunu')
    .setColor(0x27AE60)
    .setDescription(
      '**Ormana oduncu gönder, odun kes, envanterini sat!**\n\n' +
      '🔒 Tüm oyun verilerin yalnızca sana görünür.\n' +
      '⏱️ Her eylem için **10 saniye** bekleme süresi var.\n' +
      '⚡ Enerji her **2 dakikada bir** 1 adet yenilenir.\n' +
      '💸 Her gezi için işçi başına **3 coin** ücret ödenir.\n' +
      '🎲 Her oduncunun **%10 ihtimalle** eli boş dönme şansı var!\n' +
      '🍽️ Oduncuların aç kalırsa verim düşer!'
    )
    .addFields(
      { name: '🪓 Ormana Gönder', value: 'Oduncularını ormana yolla, odun kes',    inline: true },
      { name: '⚡ Enerji',         value: 'Enerji durumunu kontrol et',              inline: true },
      { name: '🎒 Envanter',       value: 'Kestiğin odunları gör',                  inline: true },
      { name: '💰 Sat',            value: 'Tüm envanteri coin\'e çevir',            inline: true },
      { name: '🛒 Market',         value: 'Oduncu, enerji ve yemek satın al',       inline: true },
      { name: '📊 Profil',         value: 'Odunculuk istatistiklerini gör',         inline: true },
    )
    .setFooter({ text: 'Başlangıç: 2 oduncu | Rütbeler: Çırak(Lv5) • Deneyimli(Lv10) • Kıdemli(Lv15) • Usta(Lv20)' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wood_chop').setLabel('🪓 Ormana Gönder').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wood_energy').setLabel('⚡ Enerji').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wood_inventory').setLabel('🎒 Envanter').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wood_sell').setLabel('💰 Sat').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('wood_market').setLabel('🛒 Market').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wood_profile').setLabel('📊 Profil').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wood_help').setLabel('📖 Nasıl Oynanır?').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2, row3] };
}

async function handleWoodButton(interaction) {
  const gid = interaction.guild?.id;
  const uid = interaction.user.id;
  if (!gid) return interaction.reply({ ephemeral: true, content: '⛔ Bu bir sunucu içinde kullanılabilir.' });

  const cd = woodCooldownCheck(gid, uid);
  if (cd > 0) return interaction.reply({ ephemeral: true, content: `⏳ **${cd}** saniye beklemelisin!` });

  if (!hasBankAccount(gid, uid))
    return interaction.reply({ ephemeral: true, content: '🏦 Önce `/banka olustur` ile hesap açman gerekiyor!' });

  const id = interaction.customId;

  // ── 🪓 ORMANA GÖNDER ───────────────────────────────────────
  if (id === 'wood_chop') {
    let data = getWoodData(gid, uid);
    data = regenWoodEnergy(data);

    const energyCost = data.lumberjacks;
    if (data.energy < energyCost) {
      saveWoodData(gid, uid, data);
      const maxE = getWoodMaxEnergy(data);
      const secToNext = Math.ceil((2 * 60 * 1000 - (Date.now() - data.lastEnergyRegen) % (2 * 60 * 1000)) / 1000);
      return interaction.reply({
        ephemeral: true,
        content: `⚡ Yeterli enerji yok!\nGerekli: **${energyCost}**, Mevcut: **${data.energy}/${maxE}**\n⏱️ Sonraki yenilenme: **${secToNext}s** | 🛒 Marketten de alabilirsin.`,
      });
    }

    // Gezi ücreti kontrolü
    const tripCost = data.lumberjacks * WOOD_TRIP_COST;
    const bal = getBalance(gid, uid).balance;
    if (bal < tripCost) {
      return interaction.reply({
        ephemeral: true,
        content: `💸 Gezi ücreti ödenemedi!\n**${data.lumberjacks}** oduncu × **${WOOD_TRIP_COST} coin** = **${tripCost} coin** gerekli. Bakiye: **${bal} coin**`,
      });
    }
    addBalance(gid, uid, -tripCost);

    data.energy -= energyCost;

    // Açlık kontrolü
    const totalFoodUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    const isHungry = totalFoodUses <= 0;

    // Her oduncu için ayrı %10 boş dönme şansı
    const results = [];
    const emptyWorkers = [];
    for (let i = 0; i < data.lumberjacks; i++) {
      if (Math.random() < WOOD_EMPTY_CHANCE) {
        emptyWorkers.push(i + 1);
      } else {
        const w = pickWood();
        results.push(w);
      }
    }

    // Açlık durumunda efektif sonuçlar yarıya düşer
    const effectiveResults = isHungry ? results.slice(0, Math.max(1, Math.floor(results.length / 2))) : results;

    for (const w of effectiveResults) addWoodLog(gid, uid, w.key, 1);
    data.totalLogsCut += effectiveResults.length;

    // Odunculuk XP
    data.woodXp += Math.round(effectiveResults.length * (1 + getPassiveXpBonusPct(gid, uid)));
    let leveledUp = false;
    while (data.woodXp >= getWoodXpNeeded(data.woodLevel)) {
      data.woodXp -= getWoodXpNeeded(data.woodLevel);
      data.woodLevel++;
      leveledUp = true;
    }

    // Yiyecek tüket
    if (!isHungry) {
      if (data.breadUses > 0)      data.breadUses--;
      else if (data.soupUses > 0)  data.soupUses--;
      else if (data.meatUses > 0)  data.meatUses--;
    }
    const newTotalFoodUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    const justRanOut = !isHungry && newTotalFoodUses <= 0;

    saveWoodData(gid, uid, data);

    const rank = getWoodRank(data.woodLevel);
    const maxEnergy = getWoodMaxEnergy(data);
    const woodLines = effectiveResults.length
      ? effectiveResults.map(w => `${w.emoji} ${w.name}`).join('\n')
      : '❌ Hiçbir oduncu odun getiremedi!';
    const emptyStr = emptyWorkers.length ? `\n🎲 Boş dönen oduncu: **${emptyWorkers.length}** kişi` : '';
    const foodStr = isHungry ? '😫 Aç (0 kullanım)' : `🍽️ Tok (${newTotalFoodUses} kullanım kaldı)`;

    const embed = new EmbedBuilder()
      .setTitle('🪓 Odunculuk Sonucu')
      .setColor(rank.color)
      .addFields(
        { name: '🌲 Kesilen Odunlar',     value: woodLines,                                                   inline: true },
        { name: '👷 Oduncu / Boş Dönen', value: `**${data.lumberjacks}** oduncu${emptyStr}`,                  inline: true },
        { name: '⚡ Kalan Enerji',         value: `**${data.energy}** / ${maxEnergy}`,                        inline: true },
        { name: '🏅 Rütbe / Seviye',       value: `${rank.emoji} **${rank.name}** Lv.${data.woodLevel}`,      inline: true },
        { name: '📈 Odunculuk XP',         value: `${data.woodXp} / ${getWoodXpNeeded(data.woodLevel)}`,      inline: true },
        { name: '🍽️ Oduncu Durumu',      value: foodStr,                                                     inline: true },
        { name: '💸 Ödenen Ücret',        value: `**-${tripCost} coin**`,                                     inline: true },
      );

    if (leveledUp)   embed.addFields({ name: '🎉 SEVİYE ATLADI!',   value: `Odunculuk Lv.**${data.woodLevel}** oldun!`,                    inline: false });
    if (justRanOut)  embed.addFields({ name: '🍽️ Yiyecek Bitti!',  value: 'Tüm yiyecek kullanımları tükendi! Marketten yenisini al.',      inline: false });
    if (isHungry)    embed.addFields({ name: '😫 Oduncular Aç!',    value: 'Yiyecek yok — verimlilik %50 düştü! Marketten yemek al.',       inline: false });

    // ── 1/20 şans eseri drop (gönderme anında) ──────────────
    if (Math.random() < 1 / 20) {
      const dropMsg = giveRareDrop(gid, uid, WOOD_TOOLS);
      embed.addFields({ name: '🎉 Nadir Düşme!', value: dropMsg });
    }

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── ⚡ ENERJİ ───────────────────────────────────────────────
  if (id === 'wood_energy') {
    let data = getWoodData(gid, uid);
    data = regenWoodEnergy(data);
    saveWoodData(gid, uid, data);

    const maxEnergy = getWoodMaxEnergy(data);
    const msToNext  = 2 * 60 * 1000 - (Date.now() - data.lastEnergyRegen) % (2 * 60 * 1000);
    const secToNext = Math.ceil(msToNext / 1000);

    const embed = new EmbedBuilder()
      .setTitle('⚡ Enerji Durumu — Odunculuk')
      .setColor(0xF39C12)
      .addFields(
        { name: '⚡ Mevcut Enerji',     value: `**${data.energy}** / ${maxEnergy}`,                              inline: true },
        { name: '⏱️ Sonraki Yenilenme', value: `**${secToNext}** saniye`,                                       inline: true },
        { name: '⚡ Enerji Seviyesi',   value: `Lv.**${data.energyLevel}** (Max: ${maxEnergy})`,                 inline: true },
        { name: '📈 Enerji XP',         value: `${data.energyXp} / ${getWoodEnergyXpNeeded(data.energyLevel)}`, inline: true },
      )
      .setFooter({ text: '2 dk = +1 enerji otomatik | Market: 2 coin/enerji (tam doldurur) | 🔋 Kapasite: 2000 coin = +5 max enerji' });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 🎒 ENVANTER ─────────────────────────────────────────────
  if (id === 'wood_inventory') {
    const inv = getWoodInventory(gid, uid).filter(r => r.amount > 0);
    if (!inv.length) return interaction.reply({ ephemeral: true, content: '🎒 Envanterin boş! Ormana oduncu gönder.' });

    let totalValue = 0;
    const lines = inv.map(r => {
      const w = WOODS.find(x => x.key === r.wood);
      if (!w) return null;
      const val = w.value * r.amount;
      totalValue += val;
      return `${w.emoji} **${w.name}** × ${r.amount} — ${val} coin`;
    }).filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🎒 Odunculuk Envanteri')
      .setColor(0x27AE60)
      .setDescription(lines.join('\n'))
      .addFields({ name: '💰 Toplam Değer', value: `**${totalValue} coin**`, inline: true })
      .setFooter({ text: 'Satmak için "Sat" düğmesine bas' });

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 💰 SAT ──────────────────────────────────────────────────
  if (id === 'wood_sell') {
    const inv = getWoodInventory(gid, uid).filter(r => r.amount > 0);
    if (!inv.length) return interaction.reply({ ephemeral: true, content: '🎒 Satacak odun yok! Önce ormana gönder.' });

    let totalValue = 0;
    const lines = [];
    for (const r of inv) {
      const w = WOODS.find(x => x.key === r.wood);
      if (!w) continue;
      const earned = w.value * r.amount;
      totalValue += earned;
      lines.push(`${w.emoji} ${w.name} × ${r.amount} = ${earned} coin`);
    }
    clearWoodInventory(gid, uid);
    // Enflasyon kesintisi kaldırıldı — satış değeri artık tam veriliyor. En iyi balta bonusu
    const woodCoinsRaw  = totalValue;
    const woodToolBonus = getBestWoodToolBonus(gid, uid);
    const woodSetBonus  = getRelicSetWoodBonus(gid, uid); // Güneş Seti — Odunculuk satışı
    const woodBonus     = getTotalCoinBonusPct(gid, uid) + woodToolBonus + woodSetBonus;
    const woodEarned    = Math.round(woodCoinsRaw * (1 + woodBonus / 100));
    addBalance(gid, uid, woodEarned);

    const bestBalta = getBestWoodToolDef(gid, uid);
    const toolStr   = bestBalta ? ` • ${bestBalta.emoji} ${bestBalta.name} (+%${bestBalta.bonus})` : '';

    const embed = new EmbedBuilder()
      .setTitle('💰 Odunlar Satıldı!')
      .setColor(0x2ECC71)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: '💰 Kazanılan',   value: `**+${woodEarned} coin**${woodBonus > 0 ? ` (+%${woodBonus}${toolStr})` : ''}`, inline: true },
        { name: '💳 Yeni Bakiye', value: `**${getBalance(gid, uid).balance} coin**`,                                      inline: true },
      );

    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 🛒 MARKET ───────────────────────────────────────────────
  if (id === 'wood_market') {
    let data = getWoodData(gid, uid);
    data = regenWoodEnergy(data);
    const bal         = getBalance(gid, uid).balance;
    const tierIdx     = Math.min(data.workerTier, WOOD_WORKER_TIERS.length - 1);
    const tier        = WOOD_WORKER_TIERS[tierIdx];
    const nextTier    = WOOD_WORKER_TIERS[tierIdx + 1] || null;
    const allWorkersBought = data.workerTier >= WOOD_WORKER_TIERS.length;
    const canBuyWorker = !allWorkersBought && data.woodLevel >= tier.minLevel;
    const maxEnergy   = getWoodMaxEnergy(data);
    const remaining   = allWorkersBought ? 0 : tier.maxPurchases - data.purchasesInTier;

    const capTierIdx   = Math.min(data.energyCapTier, WOOD_ENERGY_CAP_TIERS.length - 1);
    const capTier      = WOOD_ENERGY_CAP_TIERS[capTierIdx];
    const allCapBought = data.energyCapTier >= WOOD_ENERGY_CAP_TIERS.length;
    const capRemaining = allCapBought ? 0 : capTier.maxPurchases - data.energyCapPurchasesInTier;
    const totalFoodUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    const missing      = maxEnergy - data.energy;

    const workerLines = allWorkersBought
      ? ['**👷 Oduncu Satın Al**', '  ✅ Maksimum oduncu sayısına ulaştın! (**13 oduncu**)']
      : [
          '**👷 Oduncu Satın Al**',
          `  Fiyat: **${tier.price} coin** | Mevcut: **${data.lumberjacks}** oduncu`,
          canBuyWorker ? `  ✅ Seviye yeterli (Lv.${data.woodLevel})` : `  ❌ Gereken seviye: Lv.${tier.minLevel}`,
          `  Bu tier'dan kalan: **${remaining}** alım`,
          nextTier ? `  Sonraki tier: **${nextTier.price}** coin (Lv.${nextTier.minLevel} gerekli)` : '  📌 Bu son tier',
        ];

    const capLines = allCapBought
      ? ['**🔋 Enerji Kapasitesi** — ✅ Maksimum kapasiteye ulaştın! (+250 enerji)']
      : [
          `**🔋 Enerji Kapasitesi** — 2000 coin / +5 max enerji`,
          `  Mevcut max: **${maxEnergy}** | Bu tier'dan kalan: **${capRemaining}** alım`,
        ];

    const infoLines = [
      ...workerLines,
      '',
      `**⚡ Enerji Doldur** — 2 coin/enerji (tam doldurur)`,
      `  Mevcut: ${data.energy}/${maxEnergy} | Eksik: ${missing} enerji = ${missing * 2} coin`,
      '',
      ...capLines,
      '',
      '**🍞 Ekmek** — 50 coin (+10 kullanım hakkı)',
      '**🍲 Çorba** — 100 coin (+20 kullanım hakkı)',
      '**🥩 Et** — 300 coin (+40 kullanım hakkı)',
      `  🍽️ Mevcut yiyecek kullanımı: **${totalFoodUses}**`,
      '',
      `💰 Bakiye: **${bal} coin**`,
    ].join('\n');

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wood_buy_worker').setLabel('👷 Oduncu Al').setStyle(ButtonStyle.Primary).setDisabled(!canBuyWorker || bal < tier.price),
      new ButtonBuilder().setCustomId('wood_buy_energy').setLabel('⚡ Enerji Doldur').setStyle(ButtonStyle.Secondary).setDisabled(data.energy >= maxEnergy || bal < missing * 2),
      new ButtonBuilder().setCustomId('wood_buy_energy_cap').setLabel('🔋 Kapasite +5').setStyle(ButtonStyle.Secondary).setDisabled(allCapBought || bal < 2000),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wood_buy_bread').setLabel('🍞 Ekmek 50c').setStyle(ButtonStyle.Success).setDisabled(bal < 50 || data.breadUses > 0),
      new ButtonBuilder().setCustomId('wood_buy_soup').setLabel('🍲 Çorba 100c').setStyle(ButtonStyle.Success).setDisabled(bal < 100 || data.soupUses > 0),
      new ButtonBuilder().setCustomId('wood_buy_meat').setLabel('🥩 Et 300c').setStyle(ButtonStyle.Success).setDisabled(bal < 300 || data.meatUses > 0),
    );

    return interaction.reply({ ephemeral: true, content: infoLines, components: [row1, row2] });
  }

  // ── 👷 ODUNCU SATIN AL ────────────────────────────────────
  if (id === 'wood_buy_worker') {
    let data = getWoodData(gid, uid);
    data = regenWoodEnergy(data);

    if (data.workerTier >= WOOD_WORKER_TIERS.length)
      return interaction.reply({ ephemeral: true, content: '✅ Zaten maksimum oduncu sayısına ulaştın! (**13 oduncu**)' });

    const tierIdx = Math.min(data.workerTier, WOOD_WORKER_TIERS.length - 1);
    const tier    = WOOD_WORKER_TIERS[tierIdx];
    const bal     = getBalance(gid, uid).balance;

    if (data.woodLevel < tier.minLevel)
      return interaction.reply({ ephemeral: true, content: `❌ Oduncu almak için Odunculuk Lv.**${tier.minLevel}** gerekiyor! (Şu an: Lv.${data.woodLevel})` });
    if (bal < tier.price)
      return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! Gerekli: **${tier.price}**, Bakiye: **${bal}**` });

    addBalance(gid, uid, -tier.price);
    data.lumberjacks++;
    data.purchasesInTier++;

    if (data.purchasesInTier >= tier.maxPurchases) {
      data.workerTier++;
      data.purchasesInTier = 0;
    }

    saveWoodData(gid, uid, data);
    const newBal = getBalance(gid, uid).balance;
    const allDone = data.workerTier >= WOOD_WORKER_TIERS.length;
    const nextInfo = allDone
      ? '✅ Maksimum oduncu sayısına ulaştın! (13/13)'
      : (() => {
          const nt = WOOD_WORKER_TIERS[data.workerTier];
          return `📌 Sonraki oduncu: **${nt.price}** coin (Lv.${nt.minLevel} gerekli)`;
        })();

    return interaction.reply({
      ephemeral: true,
      content: `✅ Yeni oduncu alındı! Toplam: **${data.lumberjacks}**\n💰 Kalan: **${newBal}** coin\n${nextInfo}`,
    });
  }

  // ── ⚡ ENERJİ SATIN AL (tam doldurur) ────────────────────
  if (id === 'wood_buy_energy') {
    let data = getWoodData(gid, uid);
    data = regenWoodEnergy(data);
    const maxEnergy = getWoodMaxEnergy(data);
    const bal       = getBalance(gid, uid).balance;
    const missing   = maxEnergy - data.energy;
    const cost      = missing * 2;

    if (data.energy >= maxEnergy) return interaction.reply({ ephemeral: true, content: `⚡ Enerji zaten dolu! (${data.energy}/${maxEnergy})` });
    if (bal < cost)               return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! Enerjini doldurmak için **${cost} coin** gerekli (${missing} enerji eksik). Bakiye: **${bal}**` });

    addBalance(gid, uid, -cost);
    data.energy = maxEnergy;

    data.energyXp += missing;
    let energyLvlUp = false;
    while (data.energyXp >= getWoodEnergyXpNeeded(data.energyLevel)) {
      data.energyXp -= getWoodEnergyXpNeeded(data.energyLevel);
      data.energyLevel++;
      energyLvlUp = true;
    }

    saveWoodData(gid, uid, data);
    const newMaxE = getWoodMaxEnergy(data);
    let msg = `✅ Enerji tam dolduruldu! **${data.energy}/${newMaxE}** ⚡\n💰 Harcanan: **${cost} coin** | Kalan: **${getBalance(gid, uid).balance} coin**`;
    if (energyLvlUp) msg += `\n🎉 **Enerji Lv.${data.energyLevel}!** Maksimum enerji **${newMaxE}** oldu!`;
    return interaction.reply({ ephemeral: true, content: msg });
  }

  // ── 🔋 ENERJİ KAPASİTESİ SATIN AL ───────────────────────
  if (id === 'wood_buy_energy_cap') {
    let data = getWoodData(gid, uid);
    data = regenWoodEnergy(data);
    const bal = getBalance(gid, uid).balance;

    if (data.energyCapTier >= WOOD_ENERGY_CAP_TIERS.length)
      return interaction.reply({ ephemeral: true, content: '✅ Zaten maksimum enerji kapasitesine ulaştın!' });

    if (bal < 2000)
      return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! Enerji kapasitesi için **2000 coin** gerekli. Bakiye: **${bal}**` });

    addBalance(gid, uid, -2000);
    data.energyCapPurchasesInTier++;
    if (data.energyCapPurchasesInTier >= WOOD_ENERGY_CAP_TIERS[data.energyCapTier].maxPurchases) {
      data.energyCapTier++;
      data.energyCapPurchasesInTier = 0;
    }

    saveWoodData(gid, uid, data);
    const newMaxE = getWoodMaxEnergy(data);
    const allDone = data.energyCapTier >= WOOD_ENERGY_CAP_TIERS.length;
    return interaction.reply({
      ephemeral: true,
      content: `✅ Enerji kapasitesi yükseltildi! Yeni max enerji: **${newMaxE}**\n💰 Kalan: **${getBalance(gid, uid).balance}** coin${allDone ? '\n🎉 Maksimum kapasiteye ulaştın!' : ''}`,
    });
  }

  // ── 🍽️ YEMEK SATIN AL ────────────────────────────────────
  if (id === 'wood_buy_bread' || id === 'wood_buy_soup' || id === 'wood_buy_meat') {
    const foodMap  = { wood_buy_bread: 'bread', wood_buy_soup: 'soup', wood_buy_meat: 'meat' };
    const food     = MINING_FOODS.find(f => f.key === foodMap[id]);
    const bal      = getBalance(gid, uid).balance;

    if (bal < food.price)
      return interaction.reply({ ephemeral: true, content: `❌ Yetersiz coin! **${food.emoji} ${food.name}** için **${food.price} coin** gerekli. Bakiye: **${bal}**` });

    let data = getWoodData(gid, uid);
    const currentUses = food.key === 'bread' ? data.breadUses : food.key === 'soup' ? data.soupUses : data.meatUses;
    if (currentUses > 0)
      return interaction.reply({ ephemeral: true, content: `❌ **${food.emoji} ${food.name}** hakkın henüz bitmedi! (**${currentUses}** kullanım kaldı).` });

    addBalance(gid, uid, -food.price);
    if (food.key === 'bread') data.breadUses += food.uses;
    else if (food.key === 'soup') data.soupUses += food.uses;
    else if (food.key === 'meat') data.meatUses += food.uses;

    const totalUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    saveWoodData(gid, uid, data);
    return interaction.reply({
      ephemeral: true,
      content: `✅ **${food.emoji} ${food.name}** satın alındı! +**${food.uses}** kullanım hakkı.\n🍽️ Toplam: **${totalUses}** kullanım\n💰 Kalan: **${getBalance(gid, uid).balance}** coin`,
    });
  }

  // ── 📖 NASIL OYNANIR? ────────────────────────────────────
  if (id === 'wood_help') {
    const embed = new EmbedBuilder()
      .setTitle('📖 Odunculuk — Nasıl Oynanır?')
      .setColor(0x27AE60)
      .addFields(
        {
          name: '🪓 Ormana Gönder',
          value: [
            'Oduncularını ormana yollar, odun kesersin.',
            '• Her gezi **işçi başına 1 enerji** harcar',
            '• Her gezide işçi başına **3 coin** ücret ödenir',
            '• Her oduncunun **%10 ihtimalle** eli boş dönme şansı var',
            '• Aç oduncuların verimi **%50 düşer**',
          ].join('\n'),
        },
        {
          name: '⚡ Enerji',
          value: [
            '• Başlangıç: **20 enerji** | Her 2 dakikada **+1** otomatik yenilenir',
            '• Enerji XP kazanarak Enerji Level atla → max enerji **+1** artar',
            '• Marketten **2 coin/enerji** ile enerjini tamamen doldurabilirsin',
            '• 🔋 **Enerji Kapasitesi**: 2000 coin = +5 max enerji (max 50 alım)',
          ].join('\n'),
        },
        {
          name: '👷 Oduncu Sistemi',
          value: [
            '• **Başlangıç:** 2 oduncu (bedava)',
            '• **1. alım:** 500 coin (Lv.1 gerekli) → 3 oduncu',
            '• **2-6. alım:** 2000 coin her biri (Lv.10 gerekli) → 8 oduncu',
            '• **7-11. alım:** 4000 coin her biri (Lv.20 gerekli) → **max 13 oduncu**',
          ].join('\n'),
        },
        {
          name: '🍽️ Yemek Sistemi',
          value: [
            'Yiyecek kullanımı bitince oduncular acıkır → verim yarıya düşer.',
            '• 🍞 **Ekmek** — 50 coin → **+10 kullanım hakkı**',
            '• 🍲 **Çorba** — 100 coin → **+20 kullanım hakkı**',
            '• 🥩 **Et** — 300 coin → **+40 kullanım hakkı**',
          ].join('\n'),
        },
        {
          name: '🌲 Odun Değerleri',
          value: [
            '`Çam` **8** 🪙 | `Meşe` **15** 🪙 | `Huş` **25** 🪙 | `Akçaağaç` **40** 🪙',
            '`Ceviz` **65** 🪙 | `Kiraz` **100** 🪙 | `Abanoz` **180** 🪙 | `Ejder Ağacı` **350** 🪙',
          ].join('\n'),
        },
        {
          name: '🏅 Rütbeler',
          value: '🌱 Acemi (Lv.1) → 🌿 Çırak (Lv.5) → ⚙️ Deneyimli (Lv.10)\n🪓 Kıdemli (Lv.15) → 👑 Usta (Lv.20)',
        },
      )
      .setFooter({ text: '/odunculuk siralama — Sunucu sıralamasını gör' });
    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }

  // ── 📊 PROFİL ────────────────────────────────────────────
  if (id === 'wood_profile') {
    let data = getWoodData(gid, uid);
    data = regenWoodEnergy(data);
    saveWoodData(gid, uid, data);

    const rank      = getWoodRank(data.woodLevel);
    const maxEnergy = getWoodMaxEnergy(data);
    const totalFoodUses = (data.breadUses || 0) + (data.soupUses || 0) + (data.meatUses || 0);
    const isHungry  = totalFoodUses <= 0;
    const hungryStr = isHungry
      ? '😫 Aç — marketten yemek al!'
      : `🍽️ Tok (**${data.breadUses}** 🍞 + **${data.soupUses}** 🍲 + **${data.meatUses}** 🥩 = **${totalFoodUses}** kullanım)`;
    const capTotalPurchases = data.energyCapTier * 10 + (data.energyCapPurchasesInTier || 0);
    const tierIdx   = Math.min(data.workerTier, WOOD_WORKER_TIERS.length - 1);
    const tier      = WOOD_WORKER_TIERS[tierIdx];

    const embed = new EmbedBuilder()
      .setTitle(`🪓 ${interaction.user.username} — Odunculuk Profili`)
      .setColor(rank.color)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: '🏅 Rütbe',               value: `${rank.emoji} **${rank.name}** Lv.${data.woodLevel}`,                         inline: true },
        { name: '📈 Odunculuk XP',         value: `${data.woodXp} / ${getWoodXpNeeded(data.woodLevel)}`,                         inline: true },
        { name: '👷 Oduncu Sayısı',        value: `**${data.lumberjacks}** oduncu`,                                              inline: true },
        { name: '⚡ Enerji',               value: `**${data.energy}** / ${maxEnergy}`,                                           inline: true },
        { name: '⚡ Enerji Seviyesi',      value: `Lv.**${data.energyLevel}** (${data.energyXp}/${getWoodEnergyXpNeeded(data.energyLevel)} XP)`, inline: true },
        { name: '🔋 Enerji Kapasitesi',   value: `**${capTotalPurchases}/50** alım (+${capTotalPurchases * 5} max enerji)`,      inline: true },
        { name: '🍽️ Oduncu Durumu',      value: hungryStr,                                                                      inline: false },
        { name: '📦 Toplam Odun',          value: `**${data.totalLogsCut}** adet`,                                               inline: true },
        { name: '💰 Sonraki Oduncu',       value: data.workerTier < WOOD_WORKER_TIERS.length ? `**${tier.price}** coin (Lv.${tier.minLevel})` : '✅ Maks', inline: true },
      )
      .setFooter({ text: 'Rütbeler: Çırak(Lv5) • Deneyimli(Lv10) • Kıdemli(Lv15) • Usta(Lv20)' });

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

  // /xp — artık sadece owner ver komutu; /hakkimda ve /siralama ayrı komutlardır
  new SlashCommandBuilder()
    .setName('xp')
    .setDescription('XP komutları (yönetici)')
    .addSubcommand(s => s.setName('ver').setDescription('[OWNER] Kullanıcıya XP ver').addUserOption(o => o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1))),

  // /ses
  new SlashCommandBuilder()
    .setName('ses')
    .setDescription('Ses süresi komutları')
    .addSubcommand(s => s.setName('sifirla').setDescription('[OWNER] Ses verilerini sıfırla'))
    .addSubcommand(s => s.setName('kapat').setDescription('[OWNER] Ses takip sistemini durdur'))
    .addSubcommand(s => s.setName('ac').setDescription('[OWNER] Ses takip sistemini başlat / mevcut kanalları tara'))
    .addSubcommand(s => s.setName('yeniden-baslat').setDescription('[OWNER] Ses sistemini yeniden başlat (offline → online, mevcut üyeleri senkronize eder)')),

  // /sohbet — günlük mesaj görevi kaldırıldı, artık pasif "her 2 mesaj = 8 coin" sistemi var
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
    .addSubcommand(s => s.setName('yuzuk-al').setDescription('Evlilik yüzüğü satın al (1500 coin)'))
    .addSubcommand(s => s.setName('yuzugum').setDescription('Yüzük durumunu gör'))
    .addSubcommand(s => s.setName('bosan').setDescription('Eşinden boşan (500 coin ücret + 800 coin nafaka = 1300 coin)'))
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

  // /market — tek komut, butonlarla gezinme
  new SlashCommandBuilder()
    .setName('market')
    .setDescription('🏪 Market — alışveriş için butonları kullan'),

  // /market-yonet (admin)
  new SlashCommandBuilder()
    .setName('market-yonet')
    .setDescription('Market rol yönetimi (yönetici)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('ekle').setDescription('Markete rol ekle').addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true)).addIntegerOption(o => o.setName('fiyat').setDescription('Coin fiyatı').setRequired(true).setMinValue(1)).addBooleanOption(o => o.setName('premium').setDescription('Premium?')))
    .addSubcommand(s => s.setName('cikar').setDescription('Marketten VEYA renk listesinden rol çıkar').addRoleOption(o => o.setName('rol').setDescription('Rol (hâlâ sunucuda mevcutsa)')).addStringOption(o => o.setName('rol_id').setDescription('Rol ID (rol sunucudan silindiyse bunu kullan — /market-yonet liste ile ID öğren)')))
    .addSubcommand(s => s.setName('liste').setDescription('Market rol listesi')),

  // /hakkimda — profil komutu (eski /xp seviye yerine)
  new SlashCommandBuilder()
    .setName('hakkimda')
    .setDescription('Profil bilgilerini gör (seviye, antika, pet, mülk, kraliyet)')
    .addUserOption(o => o.setName('hedef').setDescription('Kullanıcı (boş=kendin)')),

  // /siralama — seviye sıralaması (eski /xp siralama yerine)
  new SlashCommandBuilder()
    .setName('siralama')
    .setDescription('Seviye sıralamasını gör (kraliyet unvan sahipleri dahil)'),

  // /mulk — mülk sistemi (Ev & Araba)
  new SlashCommandBuilder()
    .setName('mulk')
    .setDescription('Mülk (Ev🏠 / Araba🚗) komutları')
    .addSubcommand(s => s.setName('bilgi').setDescription('Mülk bilgilerini gör').addUserOption(o => o.setName('hedef').setDescription('Kullanıcı (boş=kendin)')))
    .addSubcommand(s => s.setName('ev-al').setDescription('Ev satın al (5000 coin)'))
    .addSubcommand(s => s.setName('araba-al').setDescription('Araba satın al (5000 coin)')),

  // /mulk-siralama
  new SlashCommandBuilder()
    .setName('mulk-siralama')
    .setDescription('Mülk sıralamasını gör'),

  // /pazar — oyuncu pazarı
  new SlashCommandBuilder()
    .setName('pazar')
    .setDescription('Oyuncu pazarı — araç, ekipman, pet, relic ve malzeme al/sat')
    .addSubcommand(s => s.setName('listele').setDescription('Aktif ilanları gör'))
    .addSubcommand(s => s.setName('envanter').setDescription('Araç envanterini gör'))
    .addSubcommand(s => s.setName('sat').setDescription('İlan aç')
      .addStringOption(o => o.setName('tur').setDescription('Eşya türü').setRequired(true)
        .addChoices(
          { name: '⛏️ Kazma (madencilik aracı)', value: 'kazma' },
          { name: '🪓 Balta (odunculuk aracı)',  value: 'balta'  },
          { name: '🐉 Ejder Seti Reliği',         value: 'ejder'  },
          { name: '🏺 Antika',                    value: 'antika' },
          { name: '🔩 Craft/Gelişmiş Malzeme',    value: 'malzeme' },
          { name: '📿 Relic (Tekli/Set Parçası)', value: 'relic' },
          { name: '⚔️ Silah (Envanter ID)',       value: 'silah' },
          { name: '🛡️ Zırh (Envanter ID)',        value: 'zirh' },
          { name: '🐾 MMORPG Pet',                value: 'pet' },
        ))
      .addStringOption(o => o.setName('anahtar').setDescription('Eşya anahtarı / ID / (pet için petkey|hatchedat)').setRequired(true))
      .addIntegerOption(o => o.setName('fiyat').setDescription('Satış fiyatı (coin, ilanın TAMAMI için)').setRequired(true).setMinValue(1))
      .addIntegerOption(o => o.setName('miktar').setDescription('Miktar (yalnızca craft/gelişmiş malzeme için, varsayılan 1)').setMinValue(1)))
    .addSubcommand(s => s.setName('al').setDescription('İlandan satın al')
      .addIntegerOption(o => o.setName('id').setDescription('İlan ID numarası').setRequired(true)))
    .addSubcommand(s => s.setName('iptal').setDescription('Kendi ilanını iptal et')
      .addIntegerOption(o => o.setName('id').setDescription('İlan ID numarası').setRequired(true))),

  // /pet — hayvan dostları sistemi
  new SlashCommandBuilder()
    .setName('pet')
    .setDescription('Pet (hayvan) komutları')
    .addSubcommand(s => s.setName('bilgi').setDescription('Petlerini gör').addUserOption(o => o.setName('hedef').setDescription('Kullanıcı (boş=kendin)')))
    .addSubcommand(s => s.setName('al').setDescription('Pet satın al')
      .addStringOption(o => o.setName('pet').setDescription('Pet').setRequired(true)
        .addChoices(
          { name: '🐱 Kedi (4500 coin, +%10 XP)', value: 'kedi' },
          { name: '🐶 Köpek (4500 coin, +%10 Coin)', value: 'kopek' },
          { name: '🦉 Baykuş (6300 coin, +%10 Günlük)', value: 'baykus' },
        ))),

  // /antika — antika koleksiyon sistemi
  new SlashCommandBuilder()
    .setName('antika')
    .setDescription('Antika koleksiyon komutları')
    .addSubcommand(s => s.setName('envanter').setDescription('Antika envanterini gör'))
    .addSubcommand(s => s.setName('aktif-et').setDescription('Aktif antika ayarla')
      .addStringOption(o => o.setName('anahtar').setDescription('Antika anahtarı (envanterinden seç)').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('kaldir').setDescription('Aktif antikayı kaldır')),

  // /gelistir — tek panel'den her şeyi yükselt
  new SlashCommandBuilder()
    .setName('gelistir')
    .setDescription('Ev, Araba, Pet veya Antika yükselt — hepsini tek panelden'),

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
    .addSubcommand(s => s.setName('sanskutusu').setDescription('Şans kutusu aç (80 coin, günlük 5 hak)')),

  // /çal — kısa komut (eskiden /oyunlar cal)
  new SlashCommandBuilder()
    .setName('çal')
    .setDescription('Birinin coinini çalmaya çalış')
    .addUserOption(o => o.setName('hedef').setDescription('Hedef kullanıcı').setRequired(true)),

  // /xpboost (kalıcı)
  new SlashCommandBuilder()
    .setName('xpboost')
    .setDescription('Kalıcı 1.5x XPBoost satın al (4000 coin)'),

  // /renk — isim rengi rolleri (al artık /market → 🎨 Renk Al butonu ile)
  new SlashCommandBuilder()
    .setName('renk')
    .setDescription('İsim rengi rolleri')
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

  // /blackjack — blackjack (21)
  new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Blackjack (21) oyna — botla (günlük max 8 kez)')
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

  // /odunculuk
  new SlashCommandBuilder()
    .setName('odunculuk')
    .setDescription('Odunculuk oyunu komutları')
    .addSubcommand(s => s.setName('panel').setDescription('[OWNER] Odunculuk panelini kanala gönder'))
    .addSubcommand(s => s.setName('siralama').setDescription('Odunculuk sıralamasını gör')),

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
// Ses sistemi: dakika başına 2 coin (çıkışta ödenir)

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
        // Dakika başına 2 coin öde
        const minutes = Math.floor(diffSec / 60);
        if (minutes > 0 && hasBankAccount(gid, uid)) {
          const coinEarned = minutes * 2;
          addBalance(gid, uid, coinEarned);
          sendLog(gid, 'coin', new EmbedBuilder()
            .setTitle('💰 Coin — Ses Kanalı')
            .setColor(0xF1C40F)
            .addFields(
              { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
              { name: 'Ödül', value: `+${coinEarned} coin`, inline: true },
              { name: 'Süre', value: `${minutes} dk`, inline: true },
            )
            .setTimestamp()
          );
        }
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

// (checkVoiceReward kaldırıldı — ses ödülü artık voiceStateUpdate çıkışında dakika başına 2 coin olarak ödeniyor)

// (30 saniyelik ses kontrol interval kaldırıldı — ödül artık çıkışta dakika başına 2 coin olarak ödeniyor)

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
    const xpMult  = getXpMultiplier(gid, uid, true);
    const xpBase  = 2;
    const xpGained = Math.max(1, Math.round(xpBase * xpMult));
    const result = addXp(gid, uid, xpGained);

    // XP Log — yalnızca log kanalı ayarlıysa embed inşa et (aksi halde her
    // mesajda boşa bir EmbedBuilder + ekstra getLevel() sorgusu çalışırdı)
    if (getSetting(gid, 'log_xp_channel')) {
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
    }

    if (result.leveled) {
      const lvlCh = getSetting(gid, 'level_channel');
      const ch = lvlCh ? message.guild.channels.cache.get(lvlCh) : message.channel;
      const coinMsg = result.coinReward ? ` +**${result.coinReward} coin** seviye ödülü! 💰` : '';
      if (ch) ch.send(`🎉 <@${uid}> seviye atladı! Yeni seviye: **${result.newLevel}** 🏆${coinMsg}`).catch(() => {});

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

  // ── SOHBET MESAJ SAYACI + PASİF COIN (her 2 mesaj = 8 coin) ─
  // Coin ödülü banka hesabı ister — hesabı yoksa mesaj sayılır ama coin verilmez.
  const sohbetCh = getSetting(gid, 'sohbet_channel');
  if (sohbetCh && cid === sohbetCh && hasBankAccount(gid, uid)) {
    addMsgCount(gid, cid, uid, todayTR());
    const total = incChatCoinCounter(gid, uid);
    if (total % 2 === 0) {
      const coinBonusPct = getTotalCoinBonusPct(gid, uid);
      const reward = Math.max(1, Math.round(8 * (1 + coinBonusPct / 100)));
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

    // ── AUTOCOMPLETE ─────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const { commandName } = interaction;
      const focused = interaction.options.getFocused(true); // { name, value }
      const typed   = (focused.value || '').toLowerCase().trim();
      const gid2    = interaction.guildId;
      const uid2    = interaction.user.id;

      let choices = [];

      if (commandName === 'craft' && focused.name === 'item') {
        const kategori = interaction.options.getString('kategori');

        if (kategori === 'silah') {
          choices = WEAPON_TYPES.flatMap(t => WEAPON_TIERS.map(r => ({
            key:   `${t.key}_${r.key}`,
            label: `${t.emoji} ${t.name} — ${r.emoji}[${r.grade}] ${r.name}`,
          })));
        } else if (kategori === 'zirh') {
          choices = ARMOR_SLOTS.flatMap(s => ARMOR_TIERS.map(t => ({
            key:   `${s.key}_${t.key}`,
            label: `${s.emoji} ${s.name} — ${t.emoji}[${t.grade}] ${t.name}`,
          })));
        } else if (kategori === 'yumurta') {
          choices = Object.keys(CRAFT_EGG_RECIPES).map(key => {
            const def = PET_EGG_TYPES.find(e => e.key === key);
            return { key, label: def ? `${def.emoji} ${def.name}` : key };
          });
        } else if (kategori === 'sandik') {
          choices = Object.keys(CRAFT_SANDIK_RECIPES).map(key => {
            const def = MMORPG_CHESTS.find(c => c.key === key);
            return { key, label: def ? `${def.emoji} ${def.name}` : key };
          });
        } else if (kategori === 'malzeme') {
          choices = ADVANCED_CRAFT_MATERIALS.map(m => ({ key: m.key, label: `${m.emoji} ${m.name}` }));
        } else if (kategori === 'set') {
          choices = Object.entries(RELIC_SETS).map(([key, def]) => ({
            key, label: `${def.emoji} ${def.name} [${def.tier}]${def.classKey ? ' 🔒' : ''}`,
          }));
        }

        choices = choices
          .filter(c => !typed || c.key.toLowerCase().includes(typed) || c.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map(c => ({ name: c.label.slice(0, 100), value: c.key }));
      }

      else if (commandName === 'relic-set' && focused.name === 'set') {
        choices = Object.entries(RELIC_SETS)
          .map(([key, def]) => ({ key, label: `${def.emoji} ${def.name} [${def.tier}]` }))
          .filter(c => !typed || c.key.toLowerCase().includes(typed) || c.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map(c => ({ name: c.label.slice(0, 100), value: c.key }));
      }

      else if (commandName === 'rpg-pet' && focused.name === 'pet') {
        const pets = getMmoPets(gid2, uid2);
        const active = getMmoActivePets(gid2, uid2);
        const rarityStars = ['⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
        choices = pets.map(p => {
          const def = MMORPG_PETS.find(x => x.key === p.petKey);
          const isActive = active.find(a => a.petKey === p.petKey && a.petHatchedAt === p.hatchedAt);
          const stat = RPG_STAT_NAMES[def?.bonusType];
          const label = `${def?.emoji || '🐾'} ${def?.name || p.petKey} Lv.${p.level} ${rarityStars[def?.rarity || 0]} ${stat?.emoji || ''}${isActive ? ` [Slot ${isActive.slot}]` : ''}`;
          return { key: `${p.petKey}|${p.hatchedAt}`, label };
        })
          .filter(c => !typed || c.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map(c => ({ name: c.label.slice(0, 100), value: c.key }));
      }

      else if (commandName === 'antika' && focused.name === 'anahtar') {
        const inv = getAntiqueInventory(gid2, uid2);
        choices = inv
          .map(r => {
            const def = ANTIQUES.find(a => a.key === r.antiqueKey);
            return def ? { key: def.key, label: `${def.emoji} ${def.name} ×${r.count}` } : null;
          })
          .filter(Boolean)
          .filter(c => !typed || c.key.toLowerCase().includes(typed) || c.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map(c => ({ name: c.label.slice(0, 100), value: c.key }));
      }

      else if (commandName === 'parcala' && focused.name === 'anahtar') {
        const owned = getCraftMats(gid2, uid2);
        choices = ADVANCED_CRAFT_MATERIALS
          .map(m => {
            const qty = owned.find(o => o.matKey === m.key)?.quantity || 0;
            return qty > 0 ? { key: m.key, label: `${m.emoji} ${m.name} ×${qty}` } : null;
          })
          .filter(Boolean)
          .filter(c => !typed || c.key.toLowerCase().includes(typed) || c.label.toLowerCase().includes(typed))
          .slice(0, 25)
          .map(c => ({ name: c.label.slice(0, 100), value: c.key }));
      }

      return interaction.respond(choices);
    }

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

    // ── ODUNCULUK BUTONLARI ───────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('wood_')) {
      return handleWoodButton(interaction);
    }

    // ── MMORPG Butonları ───────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('mmo_')) {
      return handleMMOButton(interaction);
    }
    if (interaction.isAnySelectMenu() && interaction.customId.startsWith('mmo_')) {
      return handleMMOSelect(interaction);
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

    // ── MMORPG Komutları ───────────────────────────────────────
    // Sınıf seçmeden (/sinif) oyunun geri kalanı oynanamaz.
    if (MMO_CMDS.has(cmd) && cmd !== 'sinif' && gid && !getPlayerClass(gid, uid)) {
      return interaction.reply({
        ephemeral: true,
        content: '🧭 Önce bir savaş yolu (sınıf) seçmen gerekiyor! `/sinif` ile Şövalye ⚔️, Nişancı 🏹 veya Büyücü 🪄 seç.',
      });
    }
    if (MMO_CMDS.has(cmd)) return handleMMOCommand(interaction, cmd, sub, gid, uid);

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
              '`/hakkimda` — Profil (seviye, antika, pet, mülk, kraliyet)',
              '`/siralama` — Seviye sıralaması (kraliyet dahil)',
            ].join('\n'),
          },
          {
            name: '🎙️ Ses Takibi',
            value: [
              '`/ses` — Ses kanalında her dakika **2 coin** kazanırsın (otomatik)',
            ].join('\n'),
          },
          {
            name: '💬 Sohbet',
            value: [
              '`/sohbet siralama` — Bugünkü mesaj liderleri',
              '`/sohbet durum` — Pasif coin kazanımı (her 2 mesaj = 8 coin)',
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
              '`/oyunlar sanskutusu` — Şans kutusu (80 coin)',
              '`/çal @hedef` — Coinini çal',
              '`/blackjack bahis:` — Blackjack (botla, 2x / ~%0.1 ihtimalle 4x)',
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
              '`/evlilik yuzuk-al` — Yüzük al (1500 coin)',
              '`/evlen @kişi` — Evlilik teklifi et',
              '`/esim` — Eşini gör',
              '`/evlilik bosan` — Boşan (1300 coin)',
              '`/evlilik liste` — Tüm evlilikler',
              '`/evlilik ciftyazitura` — Evlilere özel oyun',
            ].join('\n'),
          },
          {
            name: '🏪 Market',
            value: [
              '`/market` — **Tüm alışveriş buradan** (butonlarla gezin)',
              '  🎭 Roller · 🎁 Eşyalar · 🏺 Antikalar · 👑 Kraliyet · 🐾 Pet · 📿 Relikler · 🍖 Mama',
              '⚠️ **Ejder Seti** (🐉 Pençe/Diş/Göz) marketten satılmaz — sadece oyuncu pazarı veya şans eseri drop',
            ].join('\n'),
          },
          {
            name: '🏪 Oyuncu Pazarı',
            value: [
              '`/pazar listele` — Aktif ilanları gör',
              '`/pazar envanter` — Araç envanterine bak (kazma/balta)',
              '`/pazar sat tur:<tür> anahtar:<key> fiyat:<coin>` — İlan aç',
              '`/pazar al id:<numara>` — İlandan satın al',
              '`/pazar iptal id:<numara>` — Kendi ilanını geri çek',
              '📌 **Satılabilir:** ⛏️ Kazmalar · 🪓 Baltalar · 🐉 Ejder Seti Relikleri · 🏺 Antikalar',
              '💡 Kazmalar/baltalar madencilik & odunculukta **1/20** şansla düşer',
            ].join('\n'),
          },
          {
            name: '⛏️ Araçlar & Şans Eseri',
            value: [
              '**Madencilik Kazmalar** (satış bonusu):',
              '  ⛏️ Demir +%5 · 🪙 Altın +%10 · 💎 Elmas +%15 · ✨ Büyülü +%20',
              '**Odunculuk Baltaları** (satış bonusu):',
              '  🪓 Demir +%5 · 🪙 Altın +%10 · 💎 Elmas +%15 · ✨ Büyülü +%20',
              '🎲 Her satışta **1/20** ihtimalle antika, relik, araç veya craft malzeme düşebilir!',
            ].join('\n'),
          },
          {
            name: '🔧 Diğer',
            value: [
              '`/xpboost` — Kalıcı 1.5x XP Boost (4000 coin)',
              '`/pet bilgi` — Pet bilgisi & yem durumu',
              '`/antika envanter/aktif-et/kaldir` — Antika sistemi',
              '`/mulk ev-al/araba-al` — Mülk satın al',
              '`/gelistir` — Ev, Araba, Pet, Antika yükselt',
              '`/mulk-siralama` — Mülk sıralaması',
              '`/market` → 🎨 Renk Al butonu — İsim rengi rolü satın al',
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
              '**Rütbeler (Maks: Lv100):** ⛏️Beginner → 🥉Bronze(5) → ⚙️Iron(10) → 🥇Gold(15) → 👑Master(20) → 🔮Platinum(25) → 💚Emerald(30) → 💎Diamond(35) → 🏆Grandmaster(40) → ⭐Legendary(45) → 🔥Challenger(50) → 👑Godslayer(100)',
            ].join('\n'),
          }
        )
        .setFooter({ text: 'XP mesaj yazarak otomatik kazanılır • Her 2 mesajda 8 coin otomatik verilir' });
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
        const dailyBonusPct = getTotalDailyBonusPct(gid, uid);
        const reward = Math.floor(base * (1 + dailyBonusPct / 100));
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

        return interaction.reply(`✅ Günlük **+${reward} coin** aldın! ${dailyBonusPct > 0 ? `(+%${dailyBonusPct} bonus 🔥)` : ''}\n💰 Bakiye: **${getBalance(gid, uid).balance}**`);
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
          .setTitle('💰 Coin Sıralaması (Toplam)')
          .setColor(0xF1C40F)
          .setDescription(top.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.balance + r.bank}** coin`).join('\n'));
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
        const needed = Math.round((lvl.level + 1) * 100 * 0.8925);
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
            const minutes = Math.floor(diffSec / 60);
            if (minutes > 0 && hasBankAccount(gid, memberId)) addBalance(gid, memberId, minutes * 2);
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
            const minutes = Math.floor(diffSec / 60);
            if (minutes > 0 && hasBankAccount(gid, memberId)) addBalance(gid, memberId, minutes * 2);
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
        return interaction.reply({ ephemeral: true, content: `💬 Sohbet kanalında (**<#${sohbetCh}>**) attığın her **2 mesajda 8 coin** otomatik olarak hesabına ekleniyor. Herhangi bir komuta gerek yok, sadece sohbet et!` });
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
      // ─── Yardımcı: Market embed + buton satırları ─────────
      function buildMarketHome() {
        const e = new EmbedBuilder()
          .setTitle('🏪 DeathWish Market')
          .setColor(0xE67E22)
          .setDescription('Bir bölüm seç:')
          .addFields(
            { name: '🎁 Özel Eşyalar',   value: 'Kalkan, XP Boost, Coin Boost ve daha fazlası.',        inline: true },
            { name: '🏺 Antikalar',       value: 'Her gün 2 yeni antika gelir.',                         inline: true },
            { name: '👑 Kraliyet',        value: 'Her satışta fiyat artan kraliyet eşyaları.',           inline: true },
            { name: '🐾 Pet Satın Al',   value: 'Kedi, Köpek, Baykuş.',                                  inline: true },
            { name: '📿 Relikler',       value: 'Kalıcı güç bonusları kazandıran kutsal eserler.',       inline: true },
            { name: '🍖 Hayvan Maması',  value: '⚠️ Petlerini besle! 1 gün beslenmezse ölür!',          inline: true },
            { name: '🎨 Renk Al',        value: 'İsim rengi rolü satın al.',                            inline: true },
          )
          .setFooter({ text: '/market-yonet ile rol ekle/çıkar (admin)' });
        const r1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mkt_esyalar_${uid}`).setLabel('🎁 Eşyalar').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`mkt_antikalar_${uid}`).setLabel('🏺 Antikalar').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`mkt_kraliyet_${uid}`).setLabel('👑 Kraliyet').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`mkt_renkal_${uid}`).setLabel('🎨 Renk Al').setStyle(ButtonStyle.Primary),
        );
        const r2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mkt_pet_${uid}`).setLabel('🐾 Pet Al').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`mkt_relikler_${uid}`).setLabel('📿 Relikler').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`mkt_mama_${uid}`).setLabel('🍖 Hayvan Maması').setStyle(ButtonStyle.Danger),
        );
        return { embeds: [e], components: [r1, r2] };
      }

      const homePayload = buildMarketHome();
      const msg = await interaction.reply({ ...homePayload, fetchReply: true });

      const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === uid && i.customId.startsWith('mkt_'),
        time: 120_000,
      });

      collector.on('collect', async i => {
        const parts   = i.customId.split('_');
        const section = parts[1]; // e.g. roller, esyalar, antikalar, kraliyet, pet, petbuy, relikler, relical, mama, mamaver, esya, antika, kral, back

        // ── GERİ ─────────────────────────────────────────────
        if (section === 'back') {
          return i.update(buildMarketHome());
        }

        // ── RENK AL (herkes kullanabilir) ────────────────────
        // NOT: Discord StringSelectMenu'de en fazla 25 seçenek olabilir.
        // Renk sayısı 25'i geçince fazlası seçilemez hale geliyordu ve
        // placeholder'daki "ara" ifadesi de gerçek bir arama yapmıyordu
        // (Discord'un yerleşik filtrelemesi yalnızca o an EKLENMİŞ 25
        // seçenek arasında çalışır). Aşağıdaki yardımcı, sayfalama (◀ ▶)
        // ve gerçek bir modal tabanlı arama ekleyerek 25'ten fazla renk
        // rolü olsa bile TÜMÜNÜN seçilebilir olmasını sağlar.
        function buildColorPage(member, offset = 0) {
          const colorRoles  = getColorRoles(gid);
          const guildRoles2 = interaction.guild.roles.cache;
          const page = colorRoles.slice(offset, offset + 25);
          const colorOptions = page.map(r => {
            const roleObj = guildRoles2.get(r.roleId);
            const label   = roleObj ? roleObj.name : r.roleId;
            const owned2  = member.roles.cache.has(r.roleId);
            const desc    = `${r.price} coin${owned2 ? ' — Zaten sahipsin' : ''}`;
            return { label: label.slice(0, 100), description: desc.slice(0, 100), value: r.roleId };
          });
          const colorSelect = new StringSelectMenuBuilder()
            .setCustomId(`renkpick_${uid}`)
            .setPlaceholder(colorRoles.length > 25 ? `🎨 Listeden seç (${offset + 1}-${offset + page.length}/${colorRoles.length})` : '🎨 Listeden seç...')
            .addOptions(colorOptions);
          const rows = [new ActionRowBuilder().addComponents(colorSelect)];

          const navBtns = [];
          if (colorRoles.length > 25) {
            navBtns.push(new ButtonBuilder().setCustomId(`mkt_renkpage_${Math.max(0, offset - 25)}_${uid}`).setLabel('◀ Önceki 25').setStyle(ButtonStyle.Secondary).setDisabled(offset === 0));
            navBtns.push(new ButtonBuilder().setCustomId(`mkt_renksearch_${uid}`).setLabel('🔍 Ara').setStyle(ButtonStyle.Primary));
            navBtns.push(new ButtonBuilder().setCustomId(`mkt_renkpage_${offset + 25}_${uid}`).setLabel('Sonraki 25 ▶').setStyle(ButtonStyle.Secondary).setDisabled(offset + 25 >= colorRoles.length));
          } else {
            navBtns.push(new ButtonBuilder().setCustomId(`mkt_renksearch_${uid}`).setLabel('🔍 Ara').setStyle(ButtonStyle.Primary));
          }
          rows.push(new ActionRowBuilder().addComponents(...navBtns));
          rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger)));

          const colorEmbed = new EmbedBuilder()
            .setTitle('🎨 Renk Rolü Seç')
            .setColor(0xEB459E)
            .setDescription(colorRoles.map(r => `<@&${r.roleId}> — **${r.price} coin**`).join('\n'))
            .setFooter({ text: colorRoles.length > 25
              ? `Sadece 1 renk rolüne sahip olabilirsin • ${colorRoles.length} renk var — sayfalar arasında gezin ya da 🔍 Ara'ya bas`
              : 'Bir renk rolü seç — sadece 1 renk rolüne sahip olabilirsin' });
          return { embeds: [colorEmbed], components: rows.slice(0, 5) };
        }

        if (section === 'renkal') {
          const colorRoles = getColorRoles(gid);
          if (!colorRoles.length) {
            return i.reply({ ephemeral: true, content: '⛔ Henüz renk rolü eklenmemiş. `/renkrolekle` komutuyla ekleyebilirsin.' });
          }
          return i.update(buildColorPage(i.member, 0));
        }

        // ── RENK SAYFALAMA (◀ Önceki 25 / Sonraki 25 ▶) ──────
        if (section === 'renkpage') {
          const offset = parseInt(parts[2], 10) || 0;
          return i.update(buildColorPage(i.member, offset));
        }

        // ── RENK ARA (gerçek arama — modal ile) ──────────────
        if (section === 'renksearch') {
          const modal = new ModalBuilder().setCustomId(`renksearchmodal_${uid}`).setTitle('🎨 Renk Ara');
          const input = new TextInputBuilder()
            .setCustomId('renksearchinput')
            .setLabel('Renk adı (tam veya kısmi yazabilirsin)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('örn: Mavi, Kırmızı Siyah...')
            .setRequired(true)
            .setMaxLength(50);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await i.showModal(modal);

          let modalSubmit;
          try {
            modalSubmit = await i.awaitModalSubmit({ time: 60_000, filter: m => m.user.id === uid && m.customId === `renksearchmodal_${uid}` });
          } catch {
            return; // kullanıcı modal'ı kapattı / zaman aşımı — sessiz geç
          }

          const query = modalSubmit.fields.getTextInputValue('renksearchinput').trim().toLowerCase();
          const colorRoles  = getColorRoles(gid);
          const guildRoles2 = interaction.guild.roles.cache;
          const matched = colorRoles.filter(r => {
            const roleObj = guildRoles2.get(r.roleId);
            const name = (roleObj ? roleObj.name : r.roleId).toLowerCase();
            return name.includes(query);
          });

          if (!matched.length) {
            return modalSubmit.reply({ ephemeral: true, content: `⛔ **"${query}"** ile eşleşen bir renk rolü bulunamadı.` });
          }

          const page = matched.slice(0, 25);
          const colorOptions = page.map(r => {
            const roleObj = guildRoles2.get(r.roleId);
            const label   = roleObj ? roleObj.name : r.roleId;
            const owned2  = modalSubmit.member.roles.cache.has(r.roleId);
            const desc    = `${r.price} coin${owned2 ? ' — Zaten sahipsin' : ''}`;
            return { label: label.slice(0, 100), description: desc.slice(0, 100), value: r.roleId };
          });
          const colorSelect = new StringSelectMenuBuilder()
            .setCustomId(`renkpick_${uid}`)
            .setPlaceholder(`🎨 "${query}" sonuçları (${page.length}/${matched.length})`)
            .addOptions(colorOptions);
          const resultRows = [
            new ActionRowBuilder().addComponents(colorSelect),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`mkt_renkal_${uid}`).setLabel('🔄 Tüm Listeye Dön').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger),
            ),
          ];
          const resultEmbed = new EmbedBuilder()
            .setTitle('🎨 Renk Arama Sonuçları')
            .setColor(0xEB459E)
            .setDescription(matched.map(r => `<@&${r.roleId}> — **${r.price} coin**`).join('\n'))
            .setFooter({ text: matched.length > 25 ? `${matched.length} eşleşme bulundu, ilk 25'i gösteriliyor — aramanı daraltmayı dene` : 'Bir renk rolü seç' });
          return modalSubmit.update({ embeds: [resultEmbed], components: resultRows });
        }

        // ── ÖZEL EŞYALAR ─────────────────────────────────────
        if (section === 'esyalar') {
          const e = new EmbedBuilder().setTitle('🎁 Özel Eşyalar').setColor(0xE67E22)
            .addFields(
              { name: '🛡️ Kalkan',         value: '**900 coin** — 4 saat hırsızlık koruması',   inline: true },
              { name: '⚡ Geçici XP (2x)', value: '**2000 coin** — 50 kullanım',                 inline: true },
              { name: '💰 Coin Boost',     value: '**20000 coin** — Kalıcı 1.5x coin',            inline: true },
              { name: '⚡ Kalıcı XP',      value: '**4000 coin** — Kalıcı 1.5x XP',             inline: true },
            );
          const r = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mkt_esya_kalkan_${uid}`).setLabel('🛡️ Kalkan (900c)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`mkt_esya_gecici_${uid}`).setLabel('⚡ Geçici XP (2000c)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`mkt_esya_coinboost_${uid}`).setLabel('💰 Coin Boost (20000c)').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`mkt_esya_xpboost_${uid}`).setLabel('⚡ XP Boost (4000c)').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger),
          );
          return i.update({ embeds: [e], components: [r] });
        }

        if (section === 'esya') {
          const esya = parts[2];
          if (esya === 'kalkan') {
            if (hasShield(gid, uid)) return i.reply({ ephemeral: true, content: '🛡️ Zaten aktif bir kalkanın var.' });
            const bal = getBalance(gid, uid);
            if (bal.balance < 900) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **900**, Bakiye: **${bal.balance}**` });
            addBalance(gid, uid, -900); setShield(gid, uid, 4 * 60 * 60 * 1000);
            sendLog(gid, 'market', new EmbedBuilder().setTitle('🛡️ Kalkan').setColor(0xE67E22).addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
            return i.reply({ ephemeral: true, content: `🛡️ **Hırsızlık Kalkanı** aktif! 4 saat korunuyorsun. Bakiye: **${getBalance(gid, uid).balance}**` });
          }
          if (esya === 'gecici') {
            if (hasBoost(gid, uid)) return i.reply({ ephemeral: true, content: '⛔ Kalıcı XP Boost sahibisin, geçici kullanılamaz.' });
            const bal = getBalance(gid, uid);
            if (bal.balance < 2000) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **2000**, Bakiye: **${bal.balance}**` });
            addBalance(gid, uid, -2000); addTempBoostUses(gid, uid, 50);
            sendLog(gid, 'market', new EmbedBuilder().setTitle('⚡ Geçici XP Boost').setColor(0xE67E22).addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
            return i.reply({ ephemeral: true, content: `⚡ **Geçici XP Boost (2x)** alındı! Kalan: **${getTempBoostUses(gid, uid)}** | Bakiye: **${getBalance(gid, uid).balance}**` });
          }
          if (esya === 'coinboost') {
            if (hasCoinBoost(gid, uid)) return i.reply({ ephemeral: true, content: '💰 Zaten Kalıcı Coin Boost sahibisin!' });
            const bal = getBalance(gid, uid);
            if (bal.balance < 20000) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **20000**, Bakiye: **${bal.balance}**` });
            addBalance(gid, uid, -20000); setCoinBoost(gid, uid);
            sendLog(gid, 'market', new EmbedBuilder().setTitle('💰 Coin Boost').setColor(0xF1C40F).addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
            return i.reply({ ephemeral: true, content: `💰 **Kalıcı Coin Boost (1.5x)** alındı! Bakiye: **${getBalance(gid, uid).balance}**` });
          }
          if (esya === 'xpboost') {
            if (hasBoost(gid, uid)) return i.reply({ ephemeral: true, content: '⚡ Zaten Kalıcı XP Boost sahibisin!' });
            const bal = getBalance(gid, uid);
            if (bal.balance < 4000) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **4000**, Bakiye: **${bal.balance}**` });
            addBalance(gid, uid, -4000); setBoost(gid, uid);
            sendLog(gid, 'market', new EmbedBuilder().setTitle('⚡ Kalıcı XP Boost').setColor(0x57F287).addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
            return i.reply({ ephemeral: true, content: `⚡ **Kalıcı XP Boost (1.5x)** alındı! Bakiye: **${getBalance(gid, uid).balance}**` });
          }
        }

        // ── ANTİKALAR ────────────────────────────────────────
        if (section === 'antikalar') {
          const rarityLabel = { normal: '🟢 Normal', uncommon: '🟡 Nadir', rare: '🔴 Çok Nadir' };
          const daily = getDailyAntiqueMarket(gid);
          const lines = daily.map(a => `${a.emoji} **${a.name}** — ${rarityLabel[a.rarity]} • **${a.price} coin**\n  ↳ +%${a.xpBonus} XP | +%${a.coinBonus} Coin${a.dailyBonus ? ` | +%${a.dailyBonus} Günlük` : ''}`);
          const antBtns = daily.map(a =>
            new ButtonBuilder().setCustomId(`mkt_antika_${a.key}_${uid}`).setLabel(`${a.emoji} ${a.name} (${a.price}c)`).setStyle(ButtonStyle.Success)
          );
          const row = new ActionRowBuilder().addComponents(...antBtns, new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger));
          const e = new EmbedBuilder().setTitle('🏺 Günlük Antika Marketi').setColor(0xE67E22)
            .setDescription(lines.join('\n\n')).setFooter({ text: 'Her gece yarısı yeni antikalar gelir' });
          return i.update({ embeds: [e], components: [row] });
        }

        if (section === 'antika') {
          const antiqueKey = parts[2];
          const daily      = getDailyAntiqueMarket(gid);
          const available  = daily.find(a => a.key === antiqueKey);
          if (!available) return i.reply({ ephemeral: true, content: '⛔ Bu antika bugünkü markette yok!' });
          const bal = getBalance(gid, uid);
          if (bal.balance < available.price) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${available.price}**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -available.price); addAntique(gid, uid, antiqueKey);
          sendLog(gid, 'market', new EmbedBuilder().setTitle('🏺 Antika').setColor(0xE67E22).addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }, { name: 'Antika', value: `${available.emoji} ${available.name}`, inline: true }).setTimestamp());
          return i.reply({ ephemeral: true, content: `✅ ${available.emoji} **${available.name}** alındı! Aktif: \`/antika aktif-et anahtar:${antiqueKey}\` | Bakiye: **${getBalance(gid, uid).balance}**` });
        }

        // ── KRALİYET ─────────────────────────────────────────
        if (section === 'kraliyet') {
          const lines = ROYAL_ITEMS.map(ri => {
            const r = getRoyalItem(gid, ri.key);
            return `${ri.emoji} **${ri.name}**\n  Sahibi: ${r.ownerId ? `<@${r.ownerId}>` : '❌ Sahipsiz'} • **${r.price} coin**`;
          });
          const kBtns = ROYAL_ITEMS.map(ri => {
            const r = getRoyalItem(gid, ri.key);
            return new ButtonBuilder().setCustomId(`mkt_kral_${ri.key}_${uid}`).setLabel(`${ri.emoji} ${ri.name} (${r.price}c)`).setStyle(ButtonStyle.Primary).setDisabled(r.ownerId === uid);
          });
          const row1 = new ActionRowBuilder().addComponents(...kBtns.slice(0, 4));
          const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger));
          const e = new EmbedBuilder().setTitle('👑 Kraliyet Marketi').setColor(0xFFD700)
            .setDescription(lines.join('\n\n')).setFooter({ text: 'Her satışta fiyat 1000 coin artar' });
          return i.update({ embeds: [e], components: [row1, row2] });
        }

        if (section === 'kral') {
          const itemKey = parts[2];
          const ri      = ROYAL_ITEMS.find(x => x.key === itemKey);
          if (!ri) return i.reply({ ephemeral: true, content: '⛔ Geçersiz eşya.' });
          const current = getRoyalItem(gid, itemKey);
          if (current.ownerId === uid) return i.reply({ ephemeral: true, content: `${ri.emoji} Bu eşya zaten sende!` });
          const bal = getBalance(gid, uid);
          if (bal.balance < current.price) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${current.price}**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -current.price);
          const { prevOwner, price } = buyRoyalItem(gid, itemKey, uid);
          const refund = prevOwner ? Math.floor(price / 2) : 0;
          if (prevOwner) addBalance(gid, prevOwner, refund);
          sendLog(gid, 'market', new EmbedBuilder().setTitle('👑 Kraliyet El Değişimi').setColor(0xFFD700).addFields({ name: 'Yeni Sahip', value: `<@${uid}>`, inline: true }, { name: 'Eşya', value: `${ri.emoji} ${ri.name}`, inline: true }, { name: 'Ödenen', value: `${price} coin`, inline: true }, { name: 'Eski Sahibine İade', value: prevOwner ? `${refund} coin (%50)` : '—', inline: true }).setTimestamp());
          return i.reply({ ephemeral: true, content: `✅ ${ri.emoji} **${ri.name}** alındı!${prevOwner ? ` (eski sahibine **${refund}c** iade — ödenenin yarısı)` : ''} | Bakiye: **${getBalance(gid, uid).balance}**` });
        }

        // ── PET AL ───────────────────────────────────────────
        if (section === 'pet') {
          const petLines = PETS.map(p => {
            const bonus = `+%${p.bonusBase} ${p.bonusType === 'xp' ? 'XP' : p.bonusType === 'coin' ? 'Coin' : 'Günlük'}`;
            return `${p.emoji} **${p.name}** — **${p.price} coin** | ${bonus}${hasPet(gid, uid, p.key) ? ' ✅' : ''}`;
          });
          const petBtns = PETS.map(p =>
            new ButtonBuilder().setCustomId(`mkt_petbuy_${p.key}_${uid}`).setLabel(`${p.emoji} ${p.name} (${p.price}c)`).setStyle(hasPet(gid, uid, p.key) ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(hasPet(gid, uid, p.key))
          );
          const row = new ActionRowBuilder().addComponents(...petBtns, new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger));
          const e = new EmbedBuilder().setTitle('🐾 Pet Satın Al').setColor(0xEB459E)
            .setDescription(petLines.join('\n'))
            .setFooter({ text: '⚠️ Petler her gün beslenmeli! /market → Hayvan Maması' });
          return i.update({ embeds: [e], components: [row] });
        }

        if (section === 'petbuy') {
          const petKey = parts[2];
          const def    = PETS.find(p => p.key === petKey);
          if (!def) return i.reply({ ephemeral: true, content: '⛔ Geçersiz pet.' });
          if (hasPet(gid, uid, petKey)) return i.reply({ ephemeral: true, content: `${def.emoji} Zaten bu pete sahipsin!` });
          const bal = getBalance(gid, uid);
          if (bal.balance < def.price) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${def.price}**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -def.price); buyPet(gid, uid, petKey);
          sendLog(gid, 'market', new EmbedBuilder().setTitle(`🐾 Pet Alındı: ${def.name}`).setColor(0xEB459E).addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
          return i.reply({ ephemeral: true, content: `✅ ${def.emoji} **${def.name}** alındı! +%${def.bonusBase} ${def.bonusType === 'xp' ? 'XP' : def.bonusType === 'coin' ? 'Coin' : 'Günlük'}\n⚠️ Her gün beslemeyi unutma! Bakiye: **${getBalance(gid, uid).balance}**` });
        }

        // ── RELİKLER ─────────────────────────────────────────
        if (section === 'relikler') {
          const ownedKeys = getRelics(gid, uid);
          const ejderCnt  = EJDER_SET_KEYS.filter(k => ownedKeys.includes(k)).length;
          const lines = RELICS.map(r => {
            const owned   = ownedKeys.includes(r.key);
            const isEjder = r.group === 'ejder';
            if (owned && !isEjder) {
              const lv  = getRelicLevel(gid, uid, r.key);
              const bar = '⭐'.repeat(lv) + '☆'.repeat(RELIC_MAX_LEVEL - lv);
              const tag = lv >= RELIC_MAX_LEVEL ? `✅ **Lv.${lv} (MAKSİMUM)**` : `✅ **Lv.${lv}** ${bar} — Yükselt: **${RELIC_UPGRADE_COST} coin**`;
              return `${r.emoji} **${r.name}** — ${tag}\n  ↳ ${r.description}`;
            }
            const tag = owned ? '✅ **SAHİPSİN**' : isEjder ? '🐉 Oyuncu Pazarı / Şans Eseri' : `**${r.price} coin**`;
            return `${r.emoji} **${r.name}** — ${tag}\n  ↳ ${r.description}`;
          });
          // Ejder Seti — set tamamlanmadan yükseltilemez, tamamlanınca Lv.1'den başlar
          const ejderLv = ejderCnt === 3 ? getEjderLevel(gid, uid) : 0;
          let ejderStatus;
          if (ejderCnt < 3) {
            ejderStatus = `🐉 Oyuncu Pazarı / Şans Eseri ile parçaları topla`;
          } else {
            const ejderBar   = '⭐'.repeat(ejderLv) + '☆'.repeat(EJDER_MAX_LEVEL - ejderLv);
            const coinBonus  = getEjderCoinBonus(gid, uid);
            const xpBonus    = getEjderXpBonus(gid, uid);
            ejderStatus = ejderLv >= EJDER_MAX_LEVEL
              ? `✅ **Lv.${ejderLv} (MAKSİMUM)** ${ejderBar} — **+%${coinBonus} Coin** / **+%${xpBonus} XP**`
              : `✅ **Lv.${ejderLv}** ${ejderBar} — **+%${coinBonus} Coin** / **+%${xpBonus} XP** — Yükselt: **${EJDER_UPGRADE_COST} coin**`;
          }
          lines.push(`\n🐉 **Ejder Seti** (${ejderCnt}/3): ${ejderStatus}\n  ↳ Madencilik/odunculukta **1/20** şansla düşer ya da \`/pazar listele\`'den satın alınabilir. Set tamamlanmadan yükseltilemez.`);
          // Satın alma butonları (henüz sahip olunamayanlar)
          const avail   = RELICS.filter(r => r.group === 'single' && !ownedKeys.includes(r.key));
          const buyBtns = avail.map(r => new ButtonBuilder().setCustomId(`mkt_relical_${r.key}_${uid}`).setLabel(`${r.emoji} ${r.name.split(' ')[0]} (${r.price}c)`).setStyle(ButtonStyle.Primary));
          // Yükseltme butonları (sahip olunan, max olmayan single relikler)
          const upgRelics = RELICS.filter(r => r.group === 'single' && ownedKeys.includes(r.key) && getRelicLevel(gid, uid, r.key) < RELIC_MAX_LEVEL);
          const upgBtns   = upgRelics.map(r => {
            const lv = getRelicLevel(gid, uid, r.key);
            return new ButtonBuilder().setCustomId(`mkt_relicupg_${r.key}_${uid}`).setLabel(`⬆️ ${r.emoji} Lv.${lv}→${lv+1} (${RELIC_UPGRADE_COST}c)`).setStyle(ButtonStyle.Success);
          });
          // Ejder Seti yükseltme butonu (yalnızca set tamamlandıysa ve max değilse)
          if (ejderCnt === 3 && ejderLv < EJDER_MAX_LEVEL) {
            upgBtns.push(new ButtonBuilder().setCustomId(`mkt_relicupg_ejderset_${uid}`).setLabel(`⬆️ 🐉 Ejder Seti Lv.${ejderLv}→${ejderLv+1} (${EJDER_UPGRADE_COST}c)`).setStyle(ButtonStyle.Success));
          }
          const rows = [];
          if (buyBtns.length) rows.push(new ActionRowBuilder().addComponents(...buyBtns.slice(0, 5)));
          if (upgBtns.length) rows.push(new ActionRowBuilder().addComponents(...upgBtns.slice(0, 5)));
          rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger)));
          const e = new EmbedBuilder().setTitle('📿 Relikler').setColor(0x9B59B6)
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: `Tekli relik: +%${RELIC_BONUS_PER_LEVEL}/lv (${RELIC_UPGRADE_COST}c) • Ejder Seti: +%${EJDER_BONUS_PER_LEVEL}/lv (${EJDER_UPGRADE_COST}c) • Max Lv.${RELIC_MAX_LEVEL}` });
          return i.update({ embeds: [e], components: rows.slice(0, 5) });
        }

        if (section === 'relicupg') {
          const relicKey = parts[2];

          // Ejder Seti — ayrı yükseltme mantığı: set tamamlanmadan yükseltilemez
          if (relicKey === 'ejderset') {
            if (!hasAllEjderParts(gid, uid)) return i.reply({ ephemeral: true, content: '🐉 Ejder Setini yükseltebilmek için önce **3 parçanın da** (Pençe, Diş, Göz) sahibi olmalısın!' });
            const lv = getEjderLevel(gid, uid);
            if (lv >= EJDER_MAX_LEVEL) return i.reply({ ephemeral: true, content: `🐉 **Ejder Seti** zaten maksimum seviyede (Lv.${EJDER_MAX_LEVEL})!` });
            const bal = getBalance(gid, uid);
            if (bal.balance < EJDER_UPGRADE_COST) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${EJDER_UPGRADE_COST}**, Bakiye: **${bal.balance}**` });
            addBalance(gid, uid, -EJDER_UPGRADE_COST);
            upgradeEjderSet(gid, uid);
            const newLv = lv + 1;
            sendLog(gid, 'market', new EmbedBuilder().setTitle('🐉 Ejder Seti Yükseltme').setColor(0x9B59B6)
              .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }, { name: 'Yeni Lv.', value: `${newLv}`, inline: true }).setTimestamp());
            return i.reply({ ephemeral: true, content: `✨ 🐉 **Ejder Seti** → **Lv.${newLv}** yükseltildi! (+%${EJDER_BONUS_PER_LEVEL} Coin & XP bonus)\n💰 Kalan: **${getBalance(gid, uid).balance} coin**\n📊 Yeni toplam: **+%${getEjderCoinBonus(gid, uid)} Coin** / **+%${getEjderXpBonus(gid, uid)} XP**` });
          }

          const rDef     = RELICS.find(r => r.key === relicKey);
          if (!rDef || rDef.group === 'ejder') return i.reply({ ephemeral: true, content: '⛔ Geçersiz relik.' });
          if (!hasRelic(gid, uid, relicKey)) return i.reply({ ephemeral: true, content: `${rDef.emoji} Bu relike sahip değilsin!` });
          const lv = getRelicLevel(gid, uid, relicKey);
          if (lv >= RELIC_MAX_LEVEL) return i.reply({ ephemeral: true, content: `${rDef.emoji} **${rDef.name}** zaten maksimum seviyede (Lv.${RELIC_MAX_LEVEL})!` });
          const bal = getBalance(gid, uid);
          if (bal.balance < RELIC_UPGRADE_COST) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${RELIC_UPGRADE_COST}**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -RELIC_UPGRADE_COST);
          upgradeRelic(gid, uid, relicKey);
          const newLv    = lv + 1;
          const newBonus = 15 + (newLv - 1) * RELIC_BONUS_PER_LEVEL; // genel gösterim için
          sendLog(gid, 'market', new EmbedBuilder().setTitle(`📿 Relik Yükseltme: ${rDef.name}`).setColor(0x9B59B6)
            .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }, { name: 'Yeni Lv.', value: `${newLv}`, inline: true }).setTimestamp());
          return i.reply({ ephemeral: true, content: `✨ ${rDef.emoji} **${rDef.name}** → **Lv.${newLv}** yükseltildi! (+%${RELIC_BONUS_PER_LEVEL} bonus)\n💰 Kalan: **${getBalance(gid, uid).balance} coin**` });
        }

        if (section === 'relical') {
          const relicKey = parts[2];
          const rDef     = RELICS.find(r => r.key === relicKey);
          if (!rDef) return i.reply({ ephemeral: true, content: '⛔ Geçersiz relik.' });
          if (rDef.group === 'ejder') return i.reply({ ephemeral: true, content: '🐉 Ejder Seti parçaları marketten satılmaz! `/pazar listele` ile oyuncu pazarından al veya madencilik/odunculukta şans eseri düşmesini bekle.' });
          if (hasRelic(gid, uid, relicKey)) return i.reply({ ephemeral: true, content: `${rDef.emoji} Bu relike zaten sahipsin!` });
          const bal = getBalance(gid, uid);
          if (bal.balance < rDef.price) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${rDef.price}**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -rDef.price); buyRelic(gid, uid, relicKey);
          sendLog(gid, 'market', new EmbedBuilder().setTitle(`📿 Relik: ${rDef.name}`).setColor(0x9B59B6).addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
          return i.reply({ ephemeral: true, content: `✅ ${rDef.emoji} **${rDef.name}** alındı!\n↳ ${rDef.description}\nBakiye: **${getBalance(gid, uid).balance}**` });
        }

        // ── HAYVAN MAMASI ─────────────────────────────────────
        if (section === 'mama') {
          const petRows = getPetRows(gid, uid);
          if (!petRows.length) return i.reply({ ephemeral: true, content: '🐾 Hiç petin yok! Önce Pet Al bölümünden bir pet satın al.' });
          const today = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-');
          const lines = PET_FOODS.map(f => {
            const hasPetBool = petRows.some(r => r.petKey === f.petKey);
            if (!hasPetBool) return `${f.emoji} **${f.name}** — Bu pet sende yok`;
            const fedDate = getPetFedDate(gid, uid, f.petKey);
            const alive   = isPetAlive(gid, uid, f.petKey);
            return `${f.emoji} **${f.name}** — **${f.price} coin** ${fedDate === today ? '✅ Bugün beslendi' : alive ? '⚠️ Beslenmedi!' : '❌ Ölme tehlikesi!'}`;
          });
          const foodBtns = PET_FOODS.map(f => {
            const hasPetBool = petRows.some(r => r.petKey === f.petKey);
            const fedDate    = getPetFedDate(gid, uid, f.petKey);
            return new ButtonBuilder().setCustomId(`mkt_mamaver_${f.petKey}_${uid}`).setLabel(`${f.emoji} ${f.name} (${f.price}c)`).setStyle(ButtonStyle.Success).setDisabled(!hasPetBool || fedDate === today);
          });
          const row = new ActionRowBuilder().addComponents(...foodBtns, new ButtonBuilder().setCustomId(`mkt_back_${uid}`).setLabel('← Geri').setStyle(ButtonStyle.Danger));
          const e = new EmbedBuilder().setTitle('🍖 Hayvan Maması').setColor(0xEB459E)
            .setDescription(lines.join('\n'))
            .setFooter({ text: '⚠️ 1 gün beslenmezse pet ölür ve yeniden satın alınması gerekir!' });
          return i.update({ embeds: [e], components: [row] });
        }

        if (section === 'mamaver') {
          const petKey = parts[2];
          const def    = PETS.find(p => p.key === petKey);
          if (!def || !hasPet(gid, uid, petKey)) return i.reply({ ephemeral: true, content: '⛔ Bu pet sende yok.' });
          const today   = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-');
          const fedDate = getPetFedDate(gid, uid, petKey);
          if (fedDate === today) return i.reply({ ephemeral: true, content: `${def.emoji} **${def.name}** bugün zaten beslendi!` });
          const foodDef = PET_FOODS.find(f => f.petKey === petKey);
          const bal     = getBalance(gid, uid);
          if (bal.balance < foodDef.price) return i.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${foodDef.price}**, Bakiye: **${bal.balance}**` });
          addBalance(gid, uid, -foodDef.price);
          setPetFedDate(gid, uid, petKey, today);
          return i.reply({ ephemeral: true, content: `${def.emoji} **${def.name}** beslendi! **-${foodDef.price} coin** | Bakiye: **${getBalance(gid, uid).balance}**` });
        }
      });

      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
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
        const role   = interaction.options.getRole('rol');
        const rawId  = interaction.options.getString('rol_id');
        const roleId = role ? role.id : (rawId ? rawId.trim() : null);
        if (!roleId) return interaction.reply({ ephemeral: true, content: '⛔ `rol` veya `rol_id` seçeneklerinden birini gir. Rol sunucudan silinmişse `/market-yonet liste` ile ID\'sini görüp `rol_id` ile gir.' });
        // NOT: "🎨 Renk Al" bölümünde gösterilen roller market_roles'ta değil,
        // AYRI bir tabloda (color_roles — /renkrolekle ile eklenir) tutuluyor.
        // Eskiden bu komut yalnızca market_roles'tan siliyordu, bu yüzden bir
        // renk rolünü çıkarmaya çalışınca hiçbir şey olmuyormuş gibi
        // görünüyordu (rol hâlâ /market'ta "🎨 Renk Al" listesinde duruyordu).
        // Artık ikisini de kontrol edip, hangisinde kayıtlıysa oradan siliyor.
        const inMarket = getMarketRoles(gid).some(r => r.roleId === roleId);
        const inColor  = getColorRoles(gid).some(r => r.roleId === roleId);
        removeMarketRole(gid, roleId);
        removeColorRole(gid, roleId);
        if (!inMarket && !inColor) return interaction.reply({ ephemeral: true, content: `⚠️ <@&${roleId}> ne markette ne de renk rolleri listesinde kayıtlıydı.` });
        const where = [inMarket ? '🛒 Market' : null, inColor ? '🎨 Renk Al' : null].filter(Boolean).join(' + ');
        return interaction.reply(`✅ <@&${roleId}> **${where}** listesinden çıkarıldı.`);
      }
      if (sub === 'liste') {
        const roles      = getMarketRoles(gid);
        const colorRoles = getColorRoles(gid);
        if (!roles.length && !colorRoles.length) return interaction.reply('🛒 Market ve renk listesi boş.');
        const embed = new EmbedBuilder()
          .setTitle('🛒 Market Rolleri')
          .setColor(0xE67E22);
        if (roles.length) {
          embed.addFields({ name: '🛒 Market (Eşyalar)', value: roles.map((r, i) => `**${i + 1}.** <@&${r.roleId}> \`(${r.roleId})\` — **${r.price} coin**${r.isPremium ? ' 👑' : ''}`).join('\n'), inline: false });
        }
        if (colorRoles.length) {
          embed.addFields({ name: '🎨 Renk Al', value: colorRoles.map((r, i) => `**${i + 1}.** <@&${r.roleId}> \`(${r.roleId})\` — **${r.price} coin**`).join('\n'), inline: false });
        }
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
        // Aynı anda yalnızca 1 kişi soyulabilir (aynı saldırgan başka hırsızlık işlemi yapamasın)
        const alreadyThieving = [...activeSteals].some(k => k.startsWith(`${uid}:`));
        if (alreadyThieving) return interaction.reply({ ephemeral: true, content: '⛔ Zaten aktif bir hırsızlık işlemin var! Önce o bitsin.' });
        const key = `${uid}:${victim.id}`;
        const stealAmount = getTheftStealAmount(gid, uid);
        if (getBalance(gid, victim.id).balance < stealAmount) return interaction.reply({ ephemeral: true, content: 'Hedefin coin\'i yetersiz.' });
        activeSteals.add(key);
        const cancelId = `cancel_steal_${Date.now()}_${uid}`;
        // Gölge Seti — Hırsızlık başarı bonusu: hedefin iptal etmek için ayrılan süre kısalır
        const stealSetBonusPct = getRelicSetStealBonus(gid, uid);
        const stealWindowMs    = Math.max(10000, Math.round(30000 * (1 - stealSetBonusPct / 100)));
        const stealWindowSec   = Math.round(stealWindowMs / 1000);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(cancelId).setLabel(`İptal Et (${stealWindowSec}s)`).setStyle(ButtonStyle.Danger).setEmoji('⛔')
        );
        await interaction.reply({
          content: `${victim}, **${interaction.user.username}** senden **${stealAmount} coin** çalmaya çalışıyor! ${stealWindowSec} saniye içinde butona basmazsan para gider 😈`,
          components: [row],
        });
        const m2 = await interaction.fetchReply();
        let prevented = false;
        const coll = m2.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: stealWindowMs,
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
          if (getBalance(gid, victim.id).balance < stealAmount) return m2.edit({ content: '⚠️ Hedef zaten fakirleşmiş.', components: [] });
          transfer(gid, victim.id, uid, stealAmount);
          const theftResult = addTheftXp(gid, uid);
          const levelUpMsg = theftResult.leveled ? ` 📈 Hırsızlık seviyen **${theftResult.newLevel}** oldu!` : '';
          await m2.edit({ content: `💰 **${interaction.user.username}**, **${victim.username}**'den **${stealAmount} coin** çaldı! (+${THEFT_XP_PER_WIN} hırsızlık XP)${levelUpMsg}`, components: [] });
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
      // Aynı anda yalnızca 1 kişi soyulabilir
      const alreadyThieving2 = [...activeSteals].some(k => k.startsWith(`${uid}:`));
      if (alreadyThieving2) return interaction.reply({ ephemeral: true, content: '⛔ Zaten aktif bir hırsızlık işlemin var! Önce o bitsin.' });
      const key = `${uid}:${victim.id}`;
      const stealAmount = getTheftStealAmount(gid, uid);
      if (getBalance(gid, victim.id).balance < stealAmount) return interaction.reply({ ephemeral: true, content: 'Hedefin coin\'i yetersiz.' });
      activeSteals.add(key);
      const cancelId = `cancel_steal_${Date.now()}_${uid}`;
      // Gölge Seti — Hırsızlık başarı bonusu: hedefin iptal etmek için ayrılan süre kısalır
      const stealSetBonusPct = getRelicSetStealBonus(gid, uid);
      const stealWindowMs    = Math.max(10000, Math.round(30000 * (1 - stealSetBonusPct / 100)));
      const stealWindowSec   = Math.round(stealWindowMs / 1000);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(cancelId).setLabel(`İptal Et (${stealWindowSec}s)`).setStyle(ButtonStyle.Danger).setEmoji('⛔')
      );
      await interaction.reply({
        content: `${victim}, **${interaction.user.username}** senden **${stealAmount} coin** çalmaya çalışıyor! ${stealWindowSec} saniye içinde butona basmazsan para gider 😈`,
        files: [STEAL_START_GIF],
        components: [row],
      });
      const m2 = await interaction.fetchReply();
      let prevented = false;
      const coll = m2.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: stealWindowMs,
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
        if (getBalance(gid, victim.id).balance < stealAmount) return m2.edit({ content: '⚠️ Hedef zaten fakirleşmiş.', components: [] });
        transfer(gid, victim.id, uid, stealAmount);
        const theftResult = addTheftXp(gid, uid);
        const levelUpMsg = theftResult.leveled ? ` 📈 Hırsızlık seviyen **${theftResult.newLevel}** oldu!` : '';
        await m2.edit({ content: `💰 **${interaction.user.username}**, **${victim.username}**'den **${stealAmount} coin** çaldı! (+${THEFT_XP_PER_WIN} hırsızlık XP)${levelUpMsg}`, files: [STEAL_SUCCESS_GIF], components: [] });
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
      if (hasBoost(gid, uid)) return interaction.reply({ ephemeral: true, content: '⚡ Zaten kalıcı **XPBoost (1.5x)** sahibisin babuş!' });
      if (hasTempBoost(gid, uid)) return interaction.reply({ ephemeral: true, content: '⛔ Aktif geçici XP Boost\'un var! Kalıcı boost almak için önce geçici boost kullanımı bitmeli.' });
      const bal = getBalance(gid, uid);
      if (bal.balance < 4000) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **4000**, Bakiye: **${bal.balance}**` });
      addBalance(gid, uid, -4000);
      setBoost(gid, uid);
      return interaction.reply('✅ **Kalıcı XPBoost (1.5x)** satın alındı! 🔥 Her mesajda 1.5x XP kazanırsın!');
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
      // Tüccar Reliği +%10 balık satış bonusu + Güneş Seti balıkçılık bonusu (daha önce hiçbir yerde uygulanmıyordu)
      const fishRelicBonus = getRelicFishBonus(gid, uid);
      const fishSetBonus   = getRelicSetFishBonus(gid, uid);
      const fishBonusTotal = fishRelicBonus + fishSetBonus;
      const totalEarned = Math.round(total * (1 + fishBonusTotal / 100));
      addBalance(gid, uid, totalEarned);
      const bonusNote = [
        fishRelicBonus > 0 ? `+%${fishRelicBonus} Tüccar Reliği` : null,
        fishSetBonus   > 0 ? `+%${fishSetBonus} Güneş Seti`      : null,
      ].filter(Boolean).join(' • ');
      const embed = new EmbedBuilder()
        .setTitle('🐟 Balık Marketi — Tüm Balıklar Satıldı!')
        .setColor(0x1ABC9C)
        .setDescription(lines.join('\n'))
        .addFields(
          { name: '💰 Toplam Kazanç', value: `**+${totalEarned} coin**${bonusNote ? ` *(${bonusNote})*` : ''}`, inline: true },
          { name: '💳 Yeni Bakiye', value: `**${getBalance(gid, uid).balance} coin**`, inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ─────────────────────────────────────────────────────────
    //  /blackjack
    // ─────────────────────────────────────────────────────────
    if (cmd === 'blackjack') {
      const bet = interaction.options.getInteger('bahis');
      const bkey = `${gid}:${uid}`;
      if (activeBlackjack.has(bkey)) return interaction.reply({ ephemeral: true, content: '⛔ Zaten aktif bir blackjack elin var.' });

      const bjDay   = todayTR();
      const bjPlays = getDailyCount(gid, uid, bjDay, 'blackjack');
      if (bjPlays >= BLACKJACK_MAX_DAILY) {
        return interaction.reply({ ephemeral: true, content: `🃏 Günlük ${BLACKJACK_MAX_DAILY} blackjack hakkın doldu! Yarın tekrar gel.` });
      }

      const bal = getBalance(gid, uid);
      if (bal.balance < bet) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Bakiye: **${bal.balance}**` });

      let betCharged = false;
      try {
        incDailyCount(gid, uid, bjDay, 'blackjack');
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
            .setFooter({ text: `Bahis: ${bet} coin • Hak: ${bjPlays + 1}/${BLACKJACK_MAX_DAILY}` });
          if (desc) e.setDescription(desc);
          return e;
        };

        if (handValue(player) === 21) {
          activeBlackjack.delete(bkey);
          const win = resolveWinAmount(bet, gid, uid);
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
                const win = resolveWinAmount(bet, gid, uid);
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
            sendErrorLog(gid, '/blackjack (collect)', err);
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
        sendErrorLog(gid, '/blackjack', err);
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
              const win = resolveWinAmount(p.bet, gid, p.uid);
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
          .setFooter({ text: 'Rütbeler: Bronze(5) • Iron(10) • Gold(15) • Master(20) • Platinum(25) • Emerald(30) • Diamond(35) • Grandmaster(40) • Legendary(45) • 🔥Challenger(50) • 👑Godslayer(100)' });
        return interaction.reply({ ephemeral: true, embeds: [embed] });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /odunculuk
    // ─────────────────────────────────────────────────────────
    if (cmd === 'odunculuk') {
      if (sub === 'panel') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const woodCh = await client.channels.fetch(WOODCUTTING_CHANNEL_ID).catch(() => null);
        if (!woodCh?.isTextBased()) return interaction.reply({ ephemeral: true, content: `⛔ Odunculuk kanalı bulunamadı (<#${WOODCUTTING_CHANNEL_ID}>).` });
        await woodCh.send(buildWoodPanel());
        return interaction.reply({ ephemeral: true, content: `✅ Odunculuk paneli <#${WOODCUTTING_CHANNEL_ID}> kanalına gönderildi!` });
      }

      if (sub === 'siralama') {
        const rows = getWoodLeaderboard(gid);
        if (!rows.length) return interaction.reply({ ephemeral: true, content: '🪓 Henüz kimse odunculuk yapmamış!' });
        const lines = rows.map((r, i) => {
          const rank = getWoodRank(r.woodLevel);
          return `**${i + 1}.** <@${r.userId}> — ${rank.emoji} **${rank.name}** Lv.${r.woodLevel} (${r.totalLogsCut} odun)`;
        });
        const embed = new EmbedBuilder()
          .setTitle('🪓 Odunculuk Sıralaması')
          .setColor(0x27AE60)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Rütbeler: Çırak(Lv5) • Deneyimli(Lv10) • Kıdemli(Lv15) • Usta(Lv20)' });
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
    //  /hakkimda — profil (eski /xp seviye yerine)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'hakkimda') {
      const target = interaction.options.getUser('hedef') || interaction.user;
      const tid = target.id;
      const lvl = getLevel(gid, tid);
      const needed = lvl.level >= NORMAL_MAX_LEVEL ? 0 : Math.round((lvl.level + 1) * 100 * 0.7809375);
      const xpStr = lvl.level >= NORMAL_MAX_LEVEL ? 'MAX SEVİYE 🔥' : `${lvl.xp} / ${needed} XP`;

      let boostInfo = '❌ Yok';
      if (hasBoost(gid, tid)) boostInfo = '✅ Kalıcı 1.5x XP';
      else if (hasTempBoost(gid, tid)) boostInfo = `✅ Geçici 2x XP (${getTempBoostUses(gid, tid)} kalan)`;
      const coinBoostInfo = hasCoinBoost(gid, tid) ? '✅ Kalıcı 1.5x Coin' : '❌ Yok';

      // Aktif antika
      const activeAntique = getActiveAntique(gid, tid);
      const antiqueStr = activeAntique
        ? `${activeAntique.emoji} **${activeAntique.name}** (+%${activeAntique.xpBonus} XP, +%${activeAntique.coinBonus} Coin${activeAntique.dailyBonus ? `, +%${activeAntique.dailyBonus} Günlük` : ''})`
        : '❌ Aktif antika yok';

      // Antika envanteri özeti
      const antiqueInv = getAntiqueInventory(gid, tid);
      const antiqueInvStr = antiqueInv.length
        ? antiqueInv.map(r => { const a = ANTIQUES.find(x => x.key === r.antiqueKey); return a ? `${a.emoji} ${a.name} ×${r.count}` : null; }).filter(Boolean).join(', ')
        : '❌ Yok';

      // Petler (hepsi her zaman aktif)
      const petRows = getPetRows(gid, tid);
      const petStr = petRows.length
        ? petRows.map(r => { const p = PETS.find(x => x.key === r.petKey); return p ? `${p.emoji} **${p.name}** Lv.${r.level} (+%${getPetBonusByLevel(p, r.level)} ${p.bonusType === 'xp' ? 'XP' : p.bonusType === 'coin' ? 'Coin' : 'Günlük'}) ✅` : null; }).filter(Boolean).join('\n')
        : '❌ Pet yok';

      // Kuşanılmış Relic Setleri (MMORPG) — aynı anda max RELIC_SET_MAX_EQUIPPED set
      const relicSetInfo   = getRelicSetBonuses(gid, tid);
      const equippedSetStr = Object.entries(relicSetInfo)
        .filter(([, info]) => info.equipped)
        .map(([key, info]) => {
          const def = RELIC_SETS[key];
          const tierDesc = info.bonus === 'full' ? def.bonusFull.desc : info.bonus === '4piece' ? def.bonus4.desc : info.bonus === '2piece' ? def.bonus2.desc : 'Bonus yok (2 parça gerekli)';
          return `${def.emoji} **${def.name}** (${info.count}/${info.total}) — ${tierDesc}`;
        }).join('\n') || `❌ Kuşanılmış set yok *(/relic-set ile kuşan, max ${RELIC_SET_MAX_EQUIPPED})*`;

      // MMORPG Petleri — aktif kuşanılmış slotlar
      const mmoActivePets = getMmoActivePets(gid, tid);
      const mmoPetStr = mmoActivePets.length
        ? mmoActivePets.map(ap => {
            const def = MMORPG_PETS.find(p => p.key === ap.petKey);
            const lv  = db.prepare('SELECT level FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?').get(gid, tid, ap.petKey, ap.petHatchedAt);
            const stat = RPG_STAT_NAMES[def?.bonusType];
            const bonus = (def?.bonusBase || 0) + ((lv?.level || 1) - 1) * MMO_PET_BONUS_PER_LV;
            return `**[${ap.slot}]** ${def?.emoji || '?'} **${def?.name || ap.petKey}** Lv.${lv?.level || 1} (${stat?.emoji || ''}+%${bonus} ${stat?.name || ''})`;
          }).join('\n')
        : `❌ Kuşanılmış MMORPG pet yok *(/rpg-pet kuşan)*`;

      // Mülkler
      const props = getProperties(gid, tid);
      const houseStr = props.houseLevel > 0 ? `Lv.${props.houseLevel} (+%${props.houseLevel * 2} Coin Boost)` : '❌ Yok';
      const carStr   = props.carLevel   > 0 ? `Lv.${props.carLevel} (+%${props.carLevel * 2} Coin Boost)`   : '❌ Yok';

      // Kraliyet unvanları
      const royalItems = getUserRoyalItems(gid, tid);
      const royalStr = royalItems.length ? royalItems.map(r => `${r.emoji} ${r.name}`).join(', ') : '❌ Yok';

      const embed = new EmbedBuilder()
        .setTitle(`👤 ${target.username} — Profil`)
        .setColor(0x5865F2)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '🏆 Seviye',            value: `**${lvl.level}** / ${NORMAL_MAX_LEVEL}`, inline: true },
          { name: '⚡ XP',                value: xpStr,                                    inline: true },
          { name: '🔥 XP Boost',          value: boostInfo,                                inline: true },
          { name: '💰 Coin Boost',        value: coinBoostInfo,                            inline: true },
          { name: '🏺 Aktif Antika',      value: antiqueStr,                               inline: false },
          { name: '📦 Antika Koleksiyonu', value: antiqueInvStr,                           inline: false },
          { name: '🐾 Petler (Hepsi Aktif)', value: petStr,                                  inline: false },
          { name: `💎 Kuşanılmış Relic Setleri (${Object.values(relicSetInfo).filter(i => i.equipped).length}/${RELIC_SET_MAX_EQUIPPED})`, value: equippedSetStr, inline: false },
          { name: `🐉 MMORPG Petleri (${mmoActivePets.length}/${MMO_PET_MAX_ACTIVE})`, value: mmoPetStr, inline: false },
          { name: '🏠 Ev',                value: houseStr,                                 inline: true },
          { name: '🚗 Araba',             value: carStr,                                   inline: true },
          { name: '👑 Kraliyet Unvanları', value: royalStr,                                inline: false },
        );
      return interaction.reply({ embeds: [embed] });
    }

    // ─────────────────────────────────────────────────────────
    //  /siralama — seviye sıralaması (eski /xp siralama yerine)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'siralama') {
      const top = topLevels(gid, 10);
      if (!top.length) return interaction.reply('🏁 Henüz seviye verisi yok.');

      const royalLines = ROYAL_ITEMS.map(ri => {
        const r = getRoyalItem(gid, ri.key);
        return r.ownerId ? `${ri.emoji} **${ri.name}**: <@${r.ownerId}>` : null;
      }).filter(Boolean);

      const embed = new EmbedBuilder()
        .setTitle('📊 Seviye Sıralaması')
        .setColor(0x57F287)
        .setDescription(top.map((r, i) => `**${i + 1}.** <@${r.userId}> — Seviye **${r.level}**`).join('\n'));

      if (royalLines.length) embed.addFields({ name: '👑 Kraliyet Unvan Sahipleri', value: royalLines.join('\n'), inline: false });
      return interaction.reply({ embeds: [embed] });
    }

    // ─────────────────────────────────────────────────────────
    //  /mulk — mülk sistemi (Ev & Araba)
    // ─────────────────────────────────────────────────────────
    if (cmd === 'mulk') {
      if (sub === 'bilgi') {
        const target = interaction.options.getUser('hedef') || interaction.user;
        const props = getProperties(gid, target.id);
        const embed = new EmbedBuilder()
          .setTitle(`🏠 ${target.username} — Mülkler`)
          .setColor(0xE67E22)
          .addFields(
            { name: '🏠 Ev',   value: props.houseLevel > 0 ? `Lv.**${props.houseLevel}** / ${PROPERTY_MAX_LEVEL} (+%${props.houseLevel * 2} Coin Boost)` : '❌ Yok', inline: true },
            { name: '🚗 Araba', value: props.carLevel   > 0 ? `Lv.**${props.carLevel}** / ${PROPERTY_MAX_LEVEL} (+%${props.carLevel * 2} Coin Boost)` : '❌ Yok', inline: true },
          );
        return interaction.reply({ embeds: [embed] });
      }
      if (sub === 'ev-al') {
        const props = getProperties(gid, uid);
        if (props.houseLevel > 0) return interaction.reply({ ephemeral: true, content: '🏠 Zaten bir evin var!' });
        const bal = getBalance(gid, uid);
        if (bal.balance < PROPERTY_COST) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${PROPERTY_COST}**, Bakiye: **${bal.balance}**` });
        addBalance(gid, uid, -PROPERTY_COST);
        saveProperties(gid, uid, 1, props.carLevel);
        return interaction.reply(`✅ 🏠 **Ev** satın alındı! Lv.**1** (+%2 Coin Boost) | Bakiye: **${getBalance(gid, uid).balance} coin**`);
      }
      if (sub === 'araba-al') {
        const props = getProperties(gid, uid);
        if (props.carLevel > 0) return interaction.reply({ ephemeral: true, content: '🚗 Zaten bir araban var!' });
        const bal = getBalance(gid, uid);
        if (bal.balance < PROPERTY_COST) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${PROPERTY_COST}**, Bakiye: **${bal.balance}**` });
        addBalance(gid, uid, -PROPERTY_COST);
        saveProperties(gid, uid, props.houseLevel, 1);
        return interaction.reply(`✅ 🚗 **Araba** satın alındı! Lv.**1** (+%2 Coin Boost) | Bakiye: **${getBalance(gid, uid).balance} coin**`);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /mulk-siralama
    // ─────────────────────────────────────────────────────────
    if (cmd === 'mulk-siralama') {
      const top = getPropertyLeaderboard(gid);
      if (!top.length) return interaction.reply('🏠 Henüz mülk verisi yok.');
      const embed = new EmbedBuilder()
        .setTitle('🏠 Mülk Sıralaması')
        .setColor(0xE67E22)
        .setDescription(top.map((r, i) => `**${i + 1}.** <@${r.userId}> — 🏠 Ev Lv.${r.houseLevel} | 🚗 Araba Lv.${r.carLevel}`).join('\n'));
      return interaction.reply({ embeds: [embed] });
    }

    // ─────────────────────────────────────────────────────────
    //  /pet — hayvan dostları
    // ─────────────────────────────────────────────────────────
    if (cmd === 'pet') {
      // Her pet komutunda açlık kontrolü yap — açlıktan ölen petleri sil
      const killedByHunger = checkAndKillHungryPets(gid, uid);
      if (killedByHunger.length) {
        const killedNames = killedByHunger.map(p => `${p.emoji} **${p.name}**`).join(', ');
        await interaction.followUp({ ephemeral: true, content: `💀 Beslenmediği için ${killedNames} açlıktan öldü! Yeniden satın almak için: \`/market\` → Pet Al.` }).catch(() => {});
      }

      if (sub === 'bilgi') {
        const target  = interaction.options.getUser('hedef') || interaction.user;
        const tuid    = target.id;
        // Hedef için de açlık kontrolü (kendi profili görülürken)
        if (tuid === uid) checkAndKillHungryPets(gid, tuid);
        const rows    = getPetRows(gid, tuid);
        const today   = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-');
        if (!rows.length) return interaction.reply({ ephemeral: true, content: `🐾 **${target.username}**'in hiç peti yok. \`/market\` → Pet Al` });
        const petLines = rows.map(r => {
          const def = PETS.find(p => p.key === r.petKey);
          if (!def) return null;
          const bonus   = getPetBonusByLevel(def, r.level);
          const fedDate = getPetFedDate(gid, tuid, def.key);
          const alive   = isPetAlive(gid, tuid, def.key);
          const feedStr = fedDate === today ? '✅ Bugün beslendi' : alive ? '⚠️ Bugün beslenmedi!' : '❌ Açlık tehlikesi!';
          return `${def.emoji} **${def.name}** Lv.${r.level} — +%${bonus} ${def.bonusType === 'xp' ? 'XP' : def.bonusType === 'coin' ? 'Coin' : 'Günlük'} | ${feedStr}`;
        }).filter(Boolean);
        const embed = new EmbedBuilder()
          .setTitle(`🐾 ${target.username} — Petler`)
          .setColor(0xEB459E)
          .setDescription(petLines.join('\n'))
          .setFooter({ text: '⚠️ Her gün /market → Hayvan Maması ile besle! 1 gün atlarsan ölür.' });
        return interaction.reply({ embeds: [embed] });
      }
      if (sub === 'al') {
        const petKey = interaction.options.getString('pet');
        const def = PETS.find(p => p.key === petKey);
        if (!def) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz pet.' });
        if (hasPet(gid, uid, petKey)) return interaction.reply({ ephemeral: true, content: `${def.emoji} Zaten bu pete sahipsin!` });
        const bal = getBalance(gid, uid);
        if (bal.balance < def.price) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${def.price}**, Bakiye: **${bal.balance}**` });
        addBalance(gid, uid, -def.price);
        buyPet(gid, uid, petKey);
        const bonus = getPetBonusByLevel(def, 1);
        return interaction.reply(`✅ ${def.emoji} **${def.name}** satın alındı!\n+%${bonus} ${def.bonusType === 'xp' ? 'XP' : def.bonusType === 'coin' ? 'Coin' : 'Günlük'} bonus aktif.\n⚠️ Her gün beslemeyi unutma! (\`/market\` → Hayvan Maması) | Bakiye: **${getBalance(gid, uid).balance} coin**`);
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /antika — antika koleksiyon sistemi
    // ─────────────────────────────────────────────────────────
    if (cmd === 'antika') {
      if (sub === 'envanter') {
        const inv = getAntiqueInventory(gid, uid);
        const active = getActiveAntique(gid, uid);
        if (!inv.length) return interaction.reply({ ephemeral: true, content: '📦 Antika envanterin boş. Günlük antika marketi: `/market antikalar`' });
        const rarityLabel = { normal: '🟢', uncommon: '🟡', rare: '🔴' };
        const lines = inv.map(r => {
          const a = ANTIQUES.find(x => x.key === r.antiqueKey);
          if (!a) return null;
          const isActive = active && active.key === r.antiqueKey;
          const upg = getAntiqueUpgradeLevel(gid, uid, a.key);
          const maxUpg = a.rarity === 'uncommon' ? 1 : a.rarity === 'rare' ? 2 : 0;
          const upgStr = maxUpg > 0 ? ` ${'⭐'.repeat(upg)}${'☆'.repeat(maxUpg - upg)}` : '';
          const xp   = a.xpBonus    + upg * 5;
          const coin = a.coinBonus  + upg * 5;
          const daily= a.dailyBonus + upg * 5;
          return `${rarityLabel[a.rarity]} ${a.emoji} **${a.name}** \`${a.key}\`${upgStr} ×${r.count} ${isActive ? '⭐ **AKTİF**' : ''}\n  ↳ +%${xp} XP | +%${coin} Coin${daily ? ` | +%${daily} Günlük` : ''}${maxUpg > 0 && upg < maxUpg ? `\n  ↳ 🔧 Yükseltilebilir (${upg}/${maxUpg}) — \`/antika yukselt\`` : ''}`;
        }).filter(Boolean);
        const embed = new EmbedBuilder()
          .setTitle('🏺 Antika Koleksiyonu')
          .setColor(0xE67E22)
          .setDescription(lines.join('\n\n'))
          .setFooter({ text: 'Aktif etmek için: /antika aktif-et anahtar:<key>' });
        return interaction.reply({ ephemeral: true, embeds: [embed] });
      }
      if (sub === 'aktif-et') {
        const key = interaction.options.getString('anahtar');
        const inv = getAntiqueInventory(gid, uid);
        const hasIt = inv.some(r => r.antiqueKey === key);
        if (!hasIt) return interaction.reply({ ephemeral: true, content: '⛔ Bu antikaya sahip değilsin! `/antika envanter` ile kontrol et.' });
        const a = ANTIQUES.find(x => x.key === key);
        if (!a) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz antika anahtarı.' });
        setActiveAntique(gid, uid, key);
        return interaction.reply(`✅ ${a.emoji} **${a.name}** aktif antika olarak ayarlandı!\n+%${a.xpBonus} XP | +%${a.coinBonus} Coin${a.dailyBonus ? ` | +%${a.dailyBonus} Günlük` : ''}`);
      }
      if (sub === 'kaldir') {
        const active = getActiveAntique(gid, uid);
        if (!active) return interaction.reply({ ephemeral: true, content: '❌ Zaten aktif antikan yok.' });
        clearActiveAntique(gid, uid);
        return interaction.reply('✅ Aktif antika kaldırıldı.');
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /pazar — oyuncu pazarı
    // ─────────────────────────────────────────────────────────
    if (cmd === 'pazar') {
      if (interaction.channelId !== GAME_CHANNEL_ID)
        return interaction.reply({ ephemeral: true, content: `⛔ Bu komutu yalnızca <#${GAME_CHANNEL_ID}> kanalında kullanabilirsin.` });

      // ── ENVANTER ─────────────────────────────────────────
      if (sub === 'envanter') {
        const tools = getPlayerTools(gid, uid);
        if (!tools.length) return interaction.reply({ ephemeral: true, content: '🎒 Araç envanteriniz boş.\nMadencilik/odunculukta **1/20** şansla araç, relic parçası veya craft malzeme düşebilir!' });
        const lines = tools.map(t => {
          const def = ALL_TOOLS.find(x => x.key === t.toolKey);
          if (!def) return null;
          return `${def.emoji} **${def.name}** ×${t.quantity} — Satış bonusu +%${def.bonus}`;
        }).filter(Boolean);
        const embed = new EmbedBuilder()
          .setTitle('🎒 Araç Envanteri')
          .setColor(0x8B4513)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'En yüksek bonuslu araç otomatik aktif olur • /pazar sat ile ilan aç' });
        return interaction.reply({ ephemeral: true, embeds: [embed] });
      }

      // ── LİSTELE ──────────────────────────────────────────
      if (sub === 'listele') {
        const listings = getMarketListings(gid);
        if (!listings.length) return interaction.reply({ ephemeral: true, content: '🏪 Oyuncu pazarında aktif ilan yok.\n`/pazar sat` ile ilan açabilirsin!' });
        const lines = listings.slice(0, 20).map(l => {
          const name = describeMarketItem(l);
          return `**[#${l.id}]** ${name} — **${l.price} coin** | Satıcı: <@${l.sellerId}>`;
        });
        const embed = new EmbedBuilder()
          .setTitle('🏪 Oyuncu Pazarı')
          .setColor(0xE67E22)
          .setDescription(lines.join('\n'))
          .setFooter({ text: '/pazar al id:<numara> ile satın al • /pazar sat ile ilan aç' });
        return interaction.reply({ embeds: [embed] });
      }

      // ── SAT ──────────────────────────────────────────────
      if (sub === 'sat') {
        const tur    = interaction.options.getString('tur');
        const key    = interaction.options.getString('anahtar').toLowerCase().trim();
        const price  = interaction.options.getInteger('fiyat');

        if (tur === 'kazma') {
          const def = MINING_TOOLS.find(x => x.key === key);
          if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz kazma anahtarı!\nGeçerli: ${MINING_TOOLS.map(x => `\`${x.key}\``).join(', ')}` });
          const row = getPlayerTool(gid, uid, key);
          if (!row || row.quantity < 1) return interaction.reply({ ephemeral: true, content: `⛔ Envanterinde **${def.name}** yok! \`/pazar envanter\` ile kontrol et.` });
          removePlayerTool(gid, uid, key, 1);
          const id = createMarketListing(gid, uid, 'kazma', key, price);
          return interaction.reply(`✅ ${def.emoji} **${def.name}** **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'balta') {
          const def = WOOD_TOOLS.find(x => x.key === key);
          if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz balta anahtarı!\nGeçerli: ${WOOD_TOOLS.map(x => `\`${x.key}\``).join(', ')}` });
          const row = getPlayerTool(gid, uid, key);
          if (!row || row.quantity < 1) return interaction.reply({ ephemeral: true, content: `⛔ Envanterinde **${def.name}** yok! \`/pazar envanter\` ile kontrol et.` });
          removePlayerTool(gid, uid, key, 1);
          const id = createMarketListing(gid, uid, 'balta', key, price);
          return interaction.reply(`✅ ${def.emoji} **${def.name}** **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'ejder') {
          const def = RELICS.find(x => x.key === key && x.group === 'ejder');
          if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz Ejder Seti anahtarı!\nGeçerli: ${EJDER_SET_KEYS.map(k => `\`${k}\``).join(', ')}` });
          if (!hasRelic(gid, uid, key)) return interaction.reply({ ephemeral: true, content: `⛔ Bu relike sahip değilsin!` });
          // Reliği envanterden sil
          db.prepare('DELETE FROM relics WHERE guildId=? AND userId=? AND relicKey=?').run(gid, uid, key);
          invalidateRelicsCache(gid, uid);
          const id = createMarketListing(gid, uid, 'ejder', key, price);
          return interaction.reply(`✅ ${def.emoji} **${def.name}** **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'antika') {
          const def = ANTIQUES.find(x => x.key === key);
          if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz antika anahtarı! \`/antika envanter\` ile anahtarları gör.` });
          const inv = getAntiqueInventory(gid, uid);
          const row = inv.find(r => r.antiqueKey === key);
          if (!row || row.count < 1) return interaction.reply({ ephemeral: true, content: `⛔ Envanterinde **${def.name}** yok!` });
          // Antikayi envanterden düşür
          db.prepare('UPDATE antique_inventory SET count=count-1 WHERE guildId=? AND userId=? AND antiqueKey=?').run(gid, uid, key);
          db.prepare('DELETE FROM antique_inventory WHERE guildId=? AND userId=? AND antiqueKey=? AND count<=0').run(gid, uid, key);
          const id = createMarketListing(gid, uid, 'antika', key, price);
          return interaction.reply(`✅ ${def.emoji} **${def.name}** **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'malzeme') {
          const def = findAnyCraftMaterial(key);
          if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz malzeme anahtarı! (craft/gelişmiş malzeme anahtarlarını \`/envanter\` craft sekmesinden gör)` });
          const qty = interaction.options.getInteger('miktar') || 1;
          const owned = getCraftMats(gid, uid).find(m => m.matKey === key)?.quantity || 0;
          if (owned < qty) return interaction.reply({ ephemeral: true, content: `⛔ Envanterinde yeterli **${def.name}** yok! Mevcut: ${owned}, İstenen: ${qty}` });
          consumeCraftMat(gid, uid, key, qty);
          const payload = JSON.stringify({ matKey: key, quantity: qty });
          const id = createMarketListing(gid, uid, 'malzeme', payload, price);
          return interaction.reply(`✅ ${def.emoji} **${def.name}** × ${qty} **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'relic') {
          const single = RELICS.find(x => x.key === key && x.group !== 'ejder');
          const piece  = ALL_NEW_RELIC_PIECES.find(p => p.key === key);
          const def = single || piece;
          if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz relic anahtarı! (Ejder Seti için \`tur:ejder\` kullan)` });
          if (!hasRelic(gid, uid, key)) return interaction.reply({ ephemeral: true, content: `⛔ Bu relike sahip değilsin!` });
          db.prepare('DELETE FROM relics WHERE guildId=? AND userId=? AND relicKey=?').run(gid, uid, key);
          invalidateRelicsCache(gid, uid);
          const id = createMarketListing(gid, uid, 'relic', key, price);
          return interaction.reply(`✅ ${def.emoji} **${def.name}** **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'silah') {
          const itemId = parseInt(key, 10);
          if (!itemId) return interaction.reply({ ephemeral: true, content: `⛔ Geçerli bir silah **ID** gir (\`/envanter\` ile öğren).` });
          const row = db.prepare('SELECT * FROM mmo_weapons WHERE id=? AND guildId=? AND userId=?').get(itemId, gid, uid);
          if (!row) return interaction.reply({ ephemeral: true, content: `⛔ #${itemId} sana ait bir silah değil.` });
          db.prepare('DELETE FROM mmo_weapons WHERE id=?').run(itemId);
          const payload = JSON.stringify({ weaponKey: row.weaponKey, enhancement: row.enhancement });
          const id = createMarketListing(gid, uid, 'silah', payload, price);
          return interaction.reply(`✅ ${getWeaponName(row.weaponKey)} (+${row.enhancement}) **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'zirh') {
          const itemId = parseInt(key, 10);
          if (!itemId) return interaction.reply({ ephemeral: true, content: `⛔ Geçerli bir zırh **ID** gir (\`/envanter\` ile öğren).` });
          const row = db.prepare('SELECT * FROM mmo_armors WHERE id=? AND guildId=? AND userId=?').get(itemId, gid, uid);
          if (!row) return interaction.reply({ ephemeral: true, content: `⛔ #${itemId} sana ait bir zırh değil.` });
          db.prepare('DELETE FROM mmo_armors WHERE id=?').run(itemId);
          const payload = JSON.stringify({ armorKey: row.armorKey, slot: row.slot, enhancement: row.enhancement });
          const id = createMarketListing(gid, uid, 'zirh', payload, price);
          return interaction.reply(`✅ ${getArmorName(row.slot, row.armorKey.split('_')[1] || '')} (+${row.enhancement}) **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }

        if (tur === 'pet') {
          const [petKey, hatchedAt] = interaction.options.getString('anahtar').trim().split('|');
          if (!petKey || !hatchedAt) return interaction.reply({ ephemeral: true, content: `⛔ Format: \`petkey|hatchedat\` (\`/rpg-pet liste\`'den kopyala).` });
          const row = db.prepare('SELECT * FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?').get(gid, uid, petKey, hatchedAt);
          if (!row) return interaction.reply({ ephemeral: true, content: `⛔ Bu pet sende yok.` });
          db.prepare('DELETE FROM mmo_active_pets WHERE guildId=? AND userId=? AND petKey=? AND petHatchedAt=?').run(gid, uid, petKey, hatchedAt);
          db.prepare('DELETE FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?').run(gid, uid, petKey, hatchedAt);
          const payload = JSON.stringify({ petKey: row.petKey, level: row.level });
          const id = createMarketListing(gid, uid, 'pet', payload, price);
          const def = MMORPG_PETS.find(p => p.key === petKey);
          return interaction.reply(`✅ ${def?.emoji || '🐾'} **${def?.name || petKey}** Lv.${row.level} **${price} coin**'e ilanı açıldı! İlan #${id}`);
        }
      }

      // ── AL ───────────────────────────────────────────────
      if (sub === 'al') {
        const listingId = interaction.options.getInteger('id');
        const listing   = getMarketListing(listingId);
        if (!listing || listing.guildId !== gid)
          return interaction.reply({ ephemeral: true, content: `⛔ #${listingId} numaralı ilan bulunamadı.` });
        if (listing.sellerId === uid)
          return interaction.reply({ ephemeral: true, content: '⛔ Kendi ilanından satın alamazsın.' });

        const bal = getBalance(gid, uid);
        if (bal.balance < listing.price)
          return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${listing.price}**, Bakiye: **${bal.balance}**` });

        const name = describeMarketItem(listing);

        // Para transferi
        addBalance(gid, uid, -listing.price);
        addBalance(gid, listing.sellerId, listing.price);
        deleteMarketListing(listingId);

        // Eşyayı alıcıya ver
        grantMarketItem(gid, uid, listing);

        if (listing.itemType === 'ejder') {
          const ejderMsg = hasAllEjderParts(gid, uid) ? `\n🐉 **Ejder Seti tamamlandı!** +%${getEjderCoinBonus(gid, uid)} Coin ve +%${getEjderXpBonus(gid, uid)} XP aktif! (\`/market\` → Relikler'den yükseltebilirsin)` : '';
          sendLog(gid, 'market', new EmbedBuilder().setTitle('🏪 Oyuncu Pazarı — Alım').setColor(0xE67E22)
            .addFields({ name: 'Alıcı', value: `<@${uid}>`, inline: true }, { name: 'Satıcı', value: `<@${listing.sellerId}>`, inline: true }, { name: 'Eşya', value: name, inline: true }, { name: 'Fiyat', value: `${listing.price} coin`, inline: true }).setTimestamp());
          return interaction.reply(`✅ ${name} satın alındı! **-${listing.price} coin** | Bakiye: **${getBalance(gid, uid).balance}**${ejderMsg}`);
        }

        sendLog(gid, 'market', new EmbedBuilder().setTitle('🏪 Oyuncu Pazarı — Alım').setColor(0xE67E22)
          .addFields({ name: 'Alıcı', value: `<@${uid}>`, inline: true }, { name: 'Satıcı', value: `<@${listing.sellerId}>`, inline: true }, { name: 'Eşya', value: name, inline: true }, { name: 'Fiyat', value: `${listing.price} coin`, inline: true }).setTimestamp());
        return interaction.reply(`✅ ${name} satın alındı! **-${listing.price} coin** | Bakiye: **${getBalance(gid, uid).balance}**`);
      }

      // ── İPTAL ────────────────────────────────────────────
      if (sub === 'iptal') {
        const listingId = interaction.options.getInteger('id');
        const listing   = getMarketListing(listingId);
        if (!listing || listing.guildId !== gid)
          return interaction.reply({ ephemeral: true, content: `⛔ #${listingId} numaralı ilan bulunamadı.` });
        if (listing.sellerId !== uid)
          return interaction.reply({ ephemeral: true, content: '⛔ Bu ilan sana ait değil.' });

        deleteMarketListing(listingId);
        // Eşyayı iade et
        grantMarketItem(gid, uid, listing);

        const name = describeMarketItem(listing);
        return interaction.reply({ ephemeral: true, content: `↩️ İlan #${listingId} iptal edildi. ${name} envanterine iade edildi.` });
      }
    }

    // ─────────────────────────────────────────────────────────
    //  /gelistir — tek panelden her şeyi yükselt
    // ─────────────────────────────────────────────────────────
    if (cmd === 'gelistir') {
      const props      = getProperties(gid, uid);
      const bal        = getBalance(gid, uid).balance;
      const petRows    = getPetRows(gid, uid);
      const activeAnt  = getActiveAntique(gid, uid);
      const bonusLabel = t => t === 'xp' ? 'XP' : t === 'coin' ? 'Coin' : 'Günlük';

      const options = [];
      const lines   = [];

      // 🏠 Ev
      if (props.houseLevel === 0) {
        lines.push('🏠 **Ev** — Önce satın al: `/mulk ev-al`');
      } else if (props.houseLevel >= PROPERTY_MAX_LEVEL) {
        lines.push(`🏠 **Ev** Lv.${PROPERTY_MAX_LEVEL}/${PROPERTY_MAX_LEVEL} — 🔒 Maksimum`);
      } else {
        const ok = bal >= PROPERTY_COST;
        options.push({ label: `🏠 Ev — Lv.${props.houseLevel} → Lv.${props.houseLevel + 1}`, description: `5000 coin${ok ? ' ✅' : ' ❌ Yetersiz'}`, value: 'ev' });
        lines.push(`🏠 **Ev** Lv.${props.houseLevel}/${PROPERTY_MAX_LEVEL} — **5000 coin** ${ok ? '✅' : '❌ Yetersiz'}`);
      }

      // 🚗 Araba
      if (props.carLevel === 0) {
        lines.push('🚗 **Araba** — Önce satın al: `/mulk araba-al`');
      } else if (props.carLevel >= PROPERTY_MAX_LEVEL) {
        lines.push(`🚗 **Araba** Lv.${PROPERTY_MAX_LEVEL}/${PROPERTY_MAX_LEVEL} — 🔒 Maksimum`);
      } else {
        const ok = bal >= PROPERTY_COST;
        options.push({ label: `🚗 Araba — Lv.${props.carLevel} → Lv.${props.carLevel + 1}`, description: `5000 coin${ok ? ' ✅' : ' ❌ Yetersiz'}`, value: 'araba' });
        lines.push(`🚗 **Araba** Lv.${props.carLevel}/${PROPERTY_MAX_LEVEL} — **5000 coin** ${ok ? '✅' : '❌ Yetersiz'}`);
      }

      // 🐾 Petler
      for (const row of petRows) {
        const def = PETS.find(p => p.key === row.petKey);
        if (!def) continue;
        const lv = row.level;
        if (lv >= PET_MAX_LEVEL) {
          lines.push(`${def.emoji} **${def.name}** Lv.${PET_MAX_LEVEL}/${PET_MAX_LEVEL} — 🔒 Maksimum`);
        } else {
          const cost = PET_UPGRADE_COSTS[lv];
          const nextBonus = getPetBonusByLevel(def, lv + 1);
          const ok = bal >= cost;
          options.push({ label: `${def.emoji} ${def.name} — Lv.${lv} → Lv.${lv + 1}`, description: `${cost} coin | +%${nextBonus} ${bonusLabel(def.bonusType)}${ok ? ' ✅' : ' ❌ Yetersiz'}`, value: `pet_${def.key}` });
          lines.push(`${def.emoji} **${def.name}** Lv.${lv}/${PET_MAX_LEVEL} — **${cost} coin** → +%${nextBonus} ${bonusLabel(def.bonusType)} ${ok ? '✅' : '❌ Yetersiz'}`);
        }
      }

      // 📿 Relikler (single group, sahip olunan, max olmayan)
      const ownedSingleRelics = RELICS.filter(r => r.group === 'single' && hasRelic(gid, uid, r.key));
      for (const r of ownedSingleRelics) {
        const lv = getRelicLevel(gid, uid, r.key);
        if (lv >= RELIC_MAX_LEVEL) {
          lines.push(`${r.emoji} **${r.name}** Lv.${RELIC_MAX_LEVEL}/${RELIC_MAX_LEVEL} — 🔒 Maksimum`);
        } else {
          const ok = bal >= RELIC_UPGRADE_COST;
          const bar = '⭐'.repeat(lv) + '☆'.repeat(RELIC_MAX_LEVEL - lv);
          options.push({ label: `${r.emoji} ${r.name} — Lv.${lv} → Lv.${lv + 1}`, description: `${RELIC_UPGRADE_COST} coin | +%${RELIC_BONUS_PER_LEVEL} bonus${ok ? ' ✅' : ' ❌ Yetersiz'}`, value: `relic_${r.key}` });
          lines.push(`${r.emoji} **${r.name}** ${bar} (${lv}/${RELIC_MAX_LEVEL}) — **${RELIC_UPGRADE_COST} coin** ${ok ? '✅' : '❌ Yetersiz'}`);
        }
      }

      // 🐉 Ejder Seti (yalnızca 3 parça tamamlandıysa yükseltilebilir)
      const ejderCntPanel = EJDER_SET_KEYS.filter(k => hasRelic(gid, uid, k)).length;
      if (ejderCntPanel === 3) {
        const ejLv = getEjderLevel(gid, uid);
        if (ejLv >= EJDER_MAX_LEVEL) {
          lines.push(`🐉 **Ejder Seti** Lv.${EJDER_MAX_LEVEL}/${EJDER_MAX_LEVEL} — 🔒 Maksimum`);
        } else {
          const ok  = bal >= EJDER_UPGRADE_COST;
          const bar = '⭐'.repeat(ejLv) + '☆'.repeat(EJDER_MAX_LEVEL - ejLv);
          options.push({ label: `🐉 Ejder Seti — Lv.${ejLv} → Lv.${ejLv + 1}`, description: `${EJDER_UPGRADE_COST} coin | +%${EJDER_BONUS_PER_LEVEL} Coin & XP${ok ? ' ✅' : ' ❌ Yetersiz'}`, value: 'ejderset' });
          lines.push(`🐉 **Ejder Seti** ${bar} (${ejLv}/${EJDER_MAX_LEVEL}) — **${EJDER_UPGRADE_COST} coin** ${ok ? '✅' : '❌ Yetersiz'}`);
        }
      }

      // 🏺 Aktif Antika
      if (activeAnt) {
        const maxUpg = activeAnt.rarity === 'uncommon' ? 1 : activeAnt.rarity === 'rare' ? 2 : 0;
        if (maxUpg === 0) {
          lines.push(`${activeAnt.emoji} **${activeAnt.name}** — Normal antikalar yükseltilemez`);
        } else {
          const curUpg = getAntiqueUpgradeLevel(gid, uid, activeAnt.key);
          if (curUpg >= maxUpg) {
            lines.push(`${activeAnt.emoji} **${activeAnt.name}** ${'⭐'.repeat(curUpg)} — 🔒 Maksimum yükseltme`);
          } else {
            const cost  = activeAnt.rarity === 'uncommon' ? 2000 : 3000;
            const stars = '⭐'.repeat(curUpg) + '☆'.repeat(maxUpg - curUpg);
            const ok    = bal >= cost;
            options.push({ label: `${activeAnt.emoji} ${activeAnt.name} ${stars}`, description: `${cost} coin | Lv.${curUpg}→Lv.${curUpg + 1}${ok ? ' ✅' : ' ❌ Yetersiz'}`, value: 'antika' });
            lines.push(`${activeAnt.emoji} **${activeAnt.name}** ${stars} (${curUpg}/${maxUpg}) — **${cost} coin** ${ok ? '✅' : '❌ Yetersiz'}`);
          }
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('⬆️ Yükseltme Paneli')
        .setColor(0x9B59B6)
        .setDescription(lines.length ? lines.join('\n') : '📦 Yükseltilebilecek hiçbir şeyin yok.')
        .setFooter({ text: `💰 Bakiye: ${bal} coin` });

      if (!options.length) return interaction.reply({ ephemeral: true, embeds: [embed] });

      const menu = new StringSelectMenuBuilder()
        .setCustomId('yukselt_sec')
        .setPlaceholder('Ne yükseltmek istiyorsun?')
        .addOptions(options);

      const msg = await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], fetchReply: true });

      const collector = msg.createMessageComponentCollector({ filter: i => i.user.id === uid, time: 30_000 });
      collector.on('collect', async i => {
        collector.stop();
        const choice  = i.values[0];
        const nowBal  = getBalance(gid, uid).balance;

        if (choice === 'ev') {
          const p = getProperties(gid, uid);
          if (p.houseLevel >= PROPERTY_MAX_LEVEL) return i.update({ content: '🏠 Ev zaten maksimum!', embeds: [], components: [] });
          if (nowBal < PROPERTY_COST) return i.update({ content: `⛔ Yetersiz coin! Gerekli: **${PROPERTY_COST}**, Bakiye: **${nowBal}**`, embeds: [], components: [] });
          addBalance(gid, uid, -PROPERTY_COST);
          saveProperties(gid, uid, p.houseLevel + 1, p.carLevel);
          return i.update({ content: `✅ 🏠 **Ev Lv.${p.houseLevel + 1}** oldu! 💰 Kalan: **${getBalance(gid, uid).balance} coin**`, embeds: [], components: [] });
        }

        if (choice === 'araba') {
          const p = getProperties(gid, uid);
          if (p.carLevel >= PROPERTY_MAX_LEVEL) return i.update({ content: '🚗 Araba zaten maksimum!', embeds: [], components: [] });
          if (nowBal < PROPERTY_COST) return i.update({ content: `⛔ Yetersiz coin! Gerekli: **${PROPERTY_COST}**, Bakiye: **${nowBal}**`, embeds: [], components: [] });
          addBalance(gid, uid, -PROPERTY_COST);
          saveProperties(gid, uid, p.houseLevel, p.carLevel + 1);
          return i.update({ content: `✅ 🚗 **Araba Lv.${p.carLevel + 1}** oldu! 💰 Kalan: **${getBalance(gid, uid).balance} coin**`, embeds: [], components: [] });
        }

        if (choice.startsWith('pet_')) {
          const petKey = choice.slice(4);
          const def    = PETS.find(p => p.key === petKey);
          const lv     = getPetLevel(gid, uid, petKey);
          const cost   = PET_UPGRADE_COSTS[lv];
          if (nowBal < cost) return i.update({ content: `⛔ Yetersiz coin! Gerekli: **${cost}**, Bakiye: **${nowBal}**`, embeds: [], components: [] });
          addBalance(gid, uid, -cost);
          upgradePet(gid, uid, petKey);
          const newLv  = lv + 1;
          const bonus  = getPetBonusByLevel(def, newLv);
          return i.update({ content: `✅ ${def.emoji} **${def.name} Lv.${newLv}** oldu! +%${bonus} ${bonusLabel(def.bonusType)} 💰 Kalan: **${getBalance(gid, uid).balance} coin**`, embeds: [], components: [] });
        }

        if (choice === 'antika') {
          const active = getActiveAntique(gid, uid);
          if (!active) return i.update({ content: '❌ Aktif antikan yok.', embeds: [], components: [] });
          const maxUpg = active.rarity === 'uncommon' ? 1 : active.rarity === 'rare' ? 2 : 0;
          const curUpg = getAntiqueUpgradeLevel(gid, uid, active.key);
          const cost   = active.rarity === 'uncommon' ? 2000 : 3000;
          if (nowBal < cost) return i.update({ content: `⛔ Yetersiz coin! Gerekli: **${cost}**, Bakiye: **${nowBal}**`, embeds: [], components: [] });
          addBalance(gid, uid, -cost);
          const newUpg  = curUpg + 1;
          setAntiqueUpgradeLevel(gid, uid, active.key, newUpg);
          const starsNew = '⭐'.repeat(newUpg) + '☆'.repeat(maxUpg - newUpg);
          const newXp    = active.xpBonus    + newUpg * 5;
          const newCoin  = active.coinBonus  + newUpg * 5;
          const newDaily = active.dailyBonus + newUpg * 5;
          return i.update({ content: `✨ ${active.emoji} **${active.name}** ${starsNew} yükseltildi!\n+%${newXp} XP | +%${newCoin} Coin${newDaily ? ` | +%${newDaily} Günlük` : ''}\n💰 Kalan: **${getBalance(gid, uid).balance} coin**`, embeds: [], components: [] });
        }

        if (choice === 'ejderset') {
          if (!hasAllEjderParts(gid, uid)) return i.update({ content: '🐉 Ejder Setini yükseltebilmek için önce **3 parçanın da** sahibi olmalısın!', embeds: [], components: [] });
          const lv = getEjderLevel(gid, uid);
          if (lv >= EJDER_MAX_LEVEL) return i.update({ content: `🐉 **Ejder Seti** zaten maksimum (Lv.${EJDER_MAX_LEVEL})!`, embeds: [], components: [] });
          if (nowBal < EJDER_UPGRADE_COST) return i.update({ content: `⛔ Yetersiz coin! Gerekli: **${EJDER_UPGRADE_COST}**, Bakiye: **${nowBal}**`, embeds: [], components: [] });
          addBalance(gid, uid, -EJDER_UPGRADE_COST);
          upgradeEjderSet(gid, uid);
          const newLv = lv + 1;
          const bar   = '⭐'.repeat(newLv) + '☆'.repeat(EJDER_MAX_LEVEL - newLv);
          return i.update({ content: `✨ 🐉 **Ejder Seti** ${bar} **Lv.${newLv}** oldu! **+%${getEjderCoinBonus(gid, uid)} Coin** / **+%${getEjderXpBonus(gid, uid)} XP**\n💰 Kalan: **${getBalance(gid, uid).balance} coin**`, embeds: [], components: [] });
        }

        if (choice.startsWith('relic_')) {
          const relicKey = choice.slice(6);
          const rDef     = RELICS.find(r => r.key === relicKey);
          if (!rDef) return i.update({ content: '⛔ Geçersiz relik.', embeds: [], components: [] });
          const lv = getRelicLevel(gid, uid, relicKey);
          if (lv >= RELIC_MAX_LEVEL) return i.update({ content: `${rDef.emoji} **${rDef.name}** zaten maksimum (Lv.${RELIC_MAX_LEVEL})!`, embeds: [], components: [] });
          if (nowBal < RELIC_UPGRADE_COST) return i.update({ content: `⛔ Yetersiz coin! Gerekli: **${RELIC_UPGRADE_COST}**, Bakiye: **${nowBal}**`, embeds: [], components: [] });
          addBalance(gid, uid, -RELIC_UPGRADE_COST);
          upgradeRelic(gid, uid, relicKey);
          const newLv = lv + 1;
          const bar   = '⭐'.repeat(newLv) + '☆'.repeat(RELIC_MAX_LEVEL - newLv);
          return i.update({ content: `✨ ${rDef.emoji} **${rDef.name}** ${bar} **Lv.${newLv}** oldu! (+%${RELIC_BONUS_PER_LEVEL} bonus)\n💰 Kalan: **${getBalance(gid, uid).balance} coin**`, embeds: [], components: [] });
        }
      });

      collector.on('end', (_, reason) => {
        if (reason === 'time') msg.edit({ components: [] }).catch(() => {});
      });
      return;
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
      { name: '💰 Ekonomi', value: `Başlangıç Coin: **${s.start_coin || '0'}**\nGünlük Ödül: **${s.daily_reward || '640'}**` },
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

// ═══════════════════════════════════════════════════════════════════════════
//  MMORPG MODÜLÜ — DeathWish Bot  (v1.0) — entegre edildi
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG VERİTABANI ŞEMASI
// ─────────────────────────────────────────────────────────────────────────
function ensureMMORPGSchema() {
  db.exec(`
    -- RPG seviye & XP (mesaj sisteminden tamamen bağımsız)
    CREATE TABLE IF NOT EXISTS rpg_data (
      guildId TEXT, userId TEXT,
      rpgLevel INTEGER DEFAULT 1,
      rpgXp    INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId)
    );

    -- 7 adet stat (her biri max seviye 50)
    CREATE TABLE IF NOT EXISTS rpg_stats (
      guildId    TEXT, userId TEXT,
      hp         INTEGER DEFAULT 1,
      attack     INTEGER DEFAULT 1,
      defense    INTEGER DEFAULT 1,
      critical   INTEGER DEFAULT 1,
      speed      INTEGER DEFAULT 1,
      mana       INTEGER DEFAULT 1,
      magic      INTEGER DEFAULT 1,
      PRIMARY KEY(guildId, userId)
    );

    -- MMORPG Pet envanteri (yumurtadan çıkan yeni petler)
    CREATE TABLE IF NOT EXISTS mmo_pets (
      guildId TEXT, userId TEXT,
      petKey  TEXT,
      level   INTEGER DEFAULT 1,
      hatchedAt TEXT,
      PRIMARY KEY(guildId, userId, petKey, hatchedAt)
    );

    -- Aktif MMORPG pet slotları (max 6)
    CREATE TABLE IF NOT EXISTS mmo_active_pets (
      guildId TEXT, userId TEXT,
      slot    INTEGER,
      petKey  TEXT,
      petHatchedAt TEXT,
      PRIMARY KEY(guildId, userId, slot)
    );

    -- Pet yumurtası envanteri
    CREATE TABLE IF NOT EXISTS mmo_eggs (
      guildId  TEXT, userId TEXT,
      eggType  TEXT,
      quantity INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, eggType)
    );

    -- Pet Parçası envanteri (aynı pet tekrar çıkınca buraya düşer)
    CREATE TABLE IF NOT EXISTS mmo_pet_shards (
      guildId  TEXT, userId TEXT,
      petKey   TEXT,
      quantity INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, petKey)
    );

    -- Sandık envanteri
    CREATE TABLE IF NOT EXISTS mmo_chests (
      guildId   TEXT, userId TEXT,
      chestType TEXT,
      quantity  INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, chestType)
    );

    -- Craft malzemeleri (madencilik cevherlerinden AYRI)
    CREATE TABLE IF NOT EXISTS mmo_craft_mats (
      guildId  TEXT, userId TEXT,
      matKey   TEXT,
      quantity INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, matKey)
    );

    -- Silah envanteri
    CREATE TABLE IF NOT EXISTS mmo_weapons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId     TEXT, userId TEXT,
      weaponKey   TEXT,
      enhancement INTEGER DEFAULT 0
    );

    -- Zırh envanteri
    CREATE TABLE IF NOT EXISTS mmo_armors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId     TEXT, userId TEXT,
      armorKey    TEXT,
      slot        TEXT,
      enhancement INTEGER DEFAULT 0
    );

    -- Ekipman slotları (kuşanılan)
    CREATE TABLE IF NOT EXISTS mmo_equipped (
      guildId    TEXT, userId TEXT,
      slot       TEXT,
      itemId     INTEGER,
      itemTable  TEXT,
      PRIMARY KEY(guildId, userId, slot)
    );

    -- Sınıf/yol sistemi: sovalye / nisanci / buyucu
    CREATE TABLE IF NOT EXISTS rpg_class (
      guildId TEXT, userId TEXT, class TEXT,
      PRIMARY KEY(guildId, userId)
    );

    -- Slot makinesi günlük oynama sayısı
    CREATE TABLE IF NOT EXISTS mmo_slot_daily (
      guildId TEXT, userId TEXT,
      date    TEXT,
      plays   INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, date)
    );

    -- Zindan cooldown
    CREATE TABLE IF NOT EXISTS mmo_dungeon_cd (
      guildId    TEXT, userId TEXT,
      dungeonKey TEXT,
      lastEnter  INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId, dungeonKey)
    );

    -- Düello (/fight) cooldown — meydan okuyan için
    CREATE TABLE IF NOT EXISTS mmo_fight_cd (
      guildId   TEXT, userId TEXT,
      lastFight INTEGER DEFAULT 0,
      PRIMARY KEY(guildId, userId)
    );
  `);

  // Yeni relic set parçaları için mevcut relics tablosu kullanılır (zaten var)
  console.log('✅ MMORPG şeması hazır.');
}

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — RPG Stat
// ─────────────────────────────────────────────────────────────────────────
const RPG_STAT_KEYS  = ['hp', 'attack', 'defense', 'critical', 'speed', 'mana', 'magic'];
const RPG_STAT_NAMES = {
  hp:       { name: 'Can',        emoji: '❤️' },
  attack:   { name: 'Güç',        emoji: '⚔️' },
  defense:  { name: 'Savunma',    emoji: '🛡️' },
  critical: { name: 'Kritik',     emoji: '🎯' },
  speed:    { name: 'Hız',        emoji: '💨' },
  mana:     { name: 'Mana',       emoji: '🔮' },
  magic:    { name: 'Büyücülük',  emoji: '✨' },
};

// ── Sınıf/yol sistemi ────────────────────────────────────────────────────
// Her sınıf yalnızca kendi statlarıyla eşleşen silah/zırh/pet kullanabilir.
// Eşleştirme WEAPON_TYPES.stat, ARMOR_SLOTS.stat ve MMORPG_PETS.bonusType
// alanlarıyla birebir uyumlu — hepsi RPG_STAT_NAMES anahtarlarını kullanıyor.
const RPG_CLASSES = [
  { key: 'sovalye', name: 'Şövalye', emoji: '⚔️', stats: ['attack', 'defense', 'hp'] },
  { key: 'nisanci', name: 'Nişancı', emoji: '🏹', stats: ['critical', 'speed'] },
  { key: 'buyucu',  name: 'Büyücü',  emoji: '🪄', stats: ['magic', 'mana'] },
];
// Sınıfların dövüş profilleri — /fight ve /zindan'daki round-bazlı simülasyonda kullanılır.
// speedMult: zırhın ağırlığına bağlı hareket hızı çarpanı (ağır zırh = yavaş ama dayanıklı)
// physResist/magicResist: gelen hasarın kaç katı azaltılacağı (0..1 arası oran)
// closeGapPerRound: menzil dezavantajını her round ne kadar kapattığı (mesafe kapatma)
const CLASS_COMBAT_PROFILE = {
  sovalye: { speedMult: 0.55, physResist: 0.35, magicResist: 0.05, closeGapPerRound: 0.35 }, // ağır zırh, çok yavaş ama fiziksele dayanıklı, mesafeyi hızla kapatır
  nisanci: { speedMult: 1.55, physResist: 0.08, magicResist: 0.12, closeGapPerRound: 0.05 }, // hafif zırh, çok hızlı, uzaktan avantajlı ama az dayanıklı
  buyucu:  { speedMult: 0.95, physResist: 0.08, magicResist: 0.42, closeGapPerRound: 0.15 }, // orta hız, büyüye karşı çok dirençli
};
function getPlayerClass(gid, uid) {
  const r = db.prepare('SELECT class FROM rpg_class WHERE guildId=? AND userId=?').get(gid, uid);
  return r ? r.class : null;
}
function setPlayerClass(gid, uid, cls) {
  db.prepare('INSERT OR REPLACE INTO rpg_class(guildId,userId,class)VALUES(?,?,?)').run(gid, uid, cls);
}
function clearPlayerClass(gid, uid) {
  db.prepare('DELETE FROM rpg_class WHERE guildId=? AND userId=?').run(gid, uid);
}
// Sınıf seçilmemişse (eski oyuncular / henüz seçmemişler) kısıtlama uygulanmaz.
function classAllowsStat(cls, statKey) {
  if (!cls) return true;
  const def = RPG_CLASSES.find(c => c.key === cls);
  return def ? def.stats.includes(statKey) : true;
}
const RPG_MAX_LEVEL      = 50;
const RPG_MAX_STAT_LEVEL = 50;
// Stat yükseltme maliyeti (current_level+1'e göre)
function getStatCost(nextLevel) {
  if (nextLevel <= 10)  return 1000;
  if (nextLevel <= 20)  return 2000;
  if (nextLevel <= 30)  return 3000;
  if (nextLevel <= 40)  return 4000;
  return 5000;
}
// RPG level XP eşiği
function getRpgXpNeeded(level) { return level * 100; }

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Pet Yumurtaları
// ─────────────────────────────────────────────────────────────────────────
const PET_EGG_TYPES = [
  { key: 'siradan', name: 'Sıradan Yumurta',  emoji: '🥚', price: 450,  color: 0x95A5A6 },
  { key: 'nadir',   name: 'Nadir Yumurta',    emoji: '🥈', price: 1350, color: 0x3498DB },
  { key: 'altin',   name: 'Altın Yumurta',    emoji: '🥇', price: 2700, color: 0xF1C40F },
  { key: 'kristal', name: 'Kristal Yumurta',  emoji: '💎', price: 4500, color: 0x1ABC9C },
  { key: 'kraliyet',name: 'Kraliyet Yumurtası',emoji: '👑', price: 8100, color: 0x9B59B6 },
];

// 27 MMORPG Pet — nadirlik: 0=yaygın … 4=efsanevi
const MMORPG_PETS = [
  { key: 'akrep',      name: 'Akrep',            emoji: '🦂', rarity: 0, bonusType: 'attack',   bonusBase: 3,  eggPools: ['siradan','nadir'] },
  { key: 'lav_kert',   name: 'Lav Kertenkelesi', emoji: '🦎', rarity: 1, bonusType: 'defense',  bonusBase: 4,  eggPools: ['siradan','nadir','altin'] },
  { key: 'krist_kap',  name: 'Kristal Kaplumbağa',emoji: '🐢', rarity: 1, bonusType: 'defense',  bonusBase: 5,  eggPools: ['nadir','altin'] },
  { key: 'vamp_yar',   name: 'Vampir Yarasa',     emoji: '🦇', rarity: 1, bonusType: 'critical', bonusBase: 4,  eggPools: ['nadir','altin'] },
  { key: 'ruh_tilki',  name: 'Ruh Tilkisi',       emoji: '🦊', rarity: 2, bonusType: 'speed',    bonusBase: 6,  eggPools: ['nadir','altin','kristal'] },
  { key: 'anka',       name: 'Anka Kuşu',         emoji: '🦅', rarity: 2, bonusType: 'magic',    bonusBase: 7,  eggPools: ['altin','kristal'] },
  { key: 'hayalet',    name: 'Hayalet',            emoji: '👻', rarity: 2, bonusType: 'mana',     bonusBase: 7,  eggPools: ['altin','kristal'] },
  { key: 'iblis',      name: 'İblis',              emoji: '😈', rarity: 3, bonusType: 'attack',   bonusBase: 10, eggPools: ['kristal','kraliyet'] },
  { key: 'melek',      name: 'Melek',              emoji: '👼', rarity: 3, bonusType: 'hp',       bonusBase: 10, eggPools: ['kristal','kraliyet'] },
  { key: 'aslan',      name: 'Aslan',              emoji: '🦁', rarity: 2, bonusType: 'attack',   bonusBase: 8,  eggPools: ['altin','kristal'] },
  { key: 'dinozor',    name: 'Dinozor',            emoji: '🦖', rarity: 2, bonusType: 'hp',       bonusBase: 8,  eggPools: ['altin','kristal'] },
  { key: 'unicorn',    name: 'Unicorn',            emoji: '🦄', rarity: 3, bonusType: 'magic',    bonusBase: 12, eggPools: ['kristal','kraliyet'] },
  { key: 'golge_kurt', name: 'Gölge Kurt',         emoji: '🐺', rarity: 3, bonusType: 'critical', bonusBase: 12, eggPools: ['kristal','kraliyet'] },
  { key: 'mini_ejder', name: 'Mini Ejder',         emoji: '🐉', rarity: 4, bonusType: 'attack',   bonusBase: 20, eggPools: ['kraliyet'] },
  { key: 'seytan',     name: 'Şeytan',             emoji: '👿', rarity: 3, bonusType: 'attack',   bonusBase: 11, eggPools: ['kristal','kraliyet'] },
  { key: 'kaos_ejder', name: 'Kaos Ejderi',        emoji: '🔥', rarity: 4, bonusType: 'magic',    bonusBase: 22, eggPools: ['kraliyet'] },
  { key: 'goblin_lord',name: 'Goblin Lordu',       emoji: '👺', rarity: 1, bonusType: 'attack',   bonusBase: 4,  eggPools: ['siradan','nadir'] },
  { key: 'iskelet_lord',name: 'İskelet Lordu',     emoji: '💀', rarity: 2, bonusType: 'mana',     bonusBase: 6,  eggPools: ['nadir','altin'] },
  { key: 'buz_perisi', name: 'Buz Perisi',         emoji: '🧚', rarity: 2, bonusType: 'magic',    bonusBase: 7,  eggPools: ['nadir','altin'] },
  { key: 'simsek_kus', name: 'Şimşek Kuşu',       emoji: '⚡', rarity: 3, bonusType: 'critical', bonusBase: 11, eggPools: ['kristal','kraliyet'] },
  { key: 'deniz_canh', name: 'Deniz Canavarı',     emoji: '🐙', rarity: 2, bonusType: 'defense',  bonusBase: 7,  eggPools: ['nadir','altin'] },

  // ── 6 yeni pet — mevcut nadirlik/bonus/egg pool mantığı korunarak eklendi ──
  { key: 'buzul_ayi',    name: 'Buzul Ayısı',      emoji: '🐻‍❄️', rarity: 1, bonusType: 'defense',  bonusBase: 5,  eggPools: ['nadir','altin'] },
  { key: 'zehir_orumcek',name: 'Zehir Örümceği',   emoji: '🕷️', rarity: 1, bonusType: 'critical', bonusBase: 4,  eggPools: ['siradan','nadir'] },
  { key: 'firtina_sahin',name: 'Fırtına Şahini',   emoji: '🐦‍⬛', rarity: 2, bonusType: 'speed',    bonusBase: 7,  eggPools: ['altin','kristal'] },
  { key: 'mercan_yilan', name: 'Mercan Yılanı',    emoji: '🐍', rarity: 2, bonusType: 'attack',   bonusBase: 8,  eggPools: ['altin','kristal'] },
  { key: 'zumrut_kaplan',name: 'Zümrüt Kaplan',    emoji: '🐅', rarity: 3, bonusType: 'attack',   bonusBase: 11, eggPools: ['kristal','kraliyet'] },
  { key: 'gokyuzu_ejder',name: 'Gökyüzü Ejderi',   emoji: '🐲', rarity: 4, bonusType: 'magic',    bonusBase: 21, eggPools: ['kraliyet'] },
];
const MMO_PET_MAX_LEVEL    = 10;
const MMO_PET_BONUS_PER_LV = 5; // her seviyede +5%
const MMO_PET_MAX_ACTIVE   = 6;

// Pet Parçası sistemi — Lv1-5 arası sadece Coin, Lv6'dan itibaren Coin + Parça
// Anahtar = mevcut seviye (yükseltmenin BAŞLADIĞI seviye), değer = gereken parça sayısı
const PET_SHARD_COSTS = { 5: 1, 6: 2, 7: 4, 8: 6, 9: 10 }; // Lv5→6, Lv6→7, Lv7→8, Lv8→9, Lv9→10
function getPetShardCostForLevel(level) { return PET_SHARD_COSTS[level] || 0; }

// Egg açma ağırlıkları — her egg type için hangi petler çıkabilir
function pickMmoPetFromEgg(eggType) {
  const eligible = MMORPG_PETS.filter(p => p.eggPools.includes(eggType));
  // Nadirlik ağırlıkları (düşük rarity = daha yaygın)
  const weights = { 0: 40, 1: 30, 2: 20, 3: 8, 4: 2 };
  let pool = eligible.map(p => ({ ...p, weight: weights[p.rarity] || 1 }));
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of pool) { if (r < p.weight) return p; r -= p.weight; }
  return pool[0];
}

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Sandık
// ─────────────────────────────────────────────────────────────────────────
const MMORPG_CHESTS = [
  { key: 'ahsap',    name: 'Ahşap Sandık',   emoji: '📦', price: 500,  color: 0x8B4513 },
  { key: 'demir',    name: 'Demir Sandık',   emoji: '⚙️',  price: 1000, color: 0x7F8C8D },
  { key: 'altin',    name: 'Altın Sandık',   emoji: '🥇', price: 1500, color: 0xF1C40F },
  { key: 'elmas',    name: 'Elmas Sandık',   emoji: '💎', price: 2000, color: 0x1ABC9C },
  { key: 'kraliyet', name: 'Kraliyet Sandığı',emoji: '👑', price: 3000, color: 0x9B59B6 },
];

// Yumurta craft reçeteleri (top-level: hem handleCraftCommand hem autocomplete kullanır)
const CRAFT_EGG_RECIPES = {
  siradan:  { demir_cevheri: 6, bakir_cevheri: 3 },
  nadir:    { altin_cevheri: 5, obsidyen: 1 },
  altin:    { saf_kristal: 2, altin_cevheri: 6, elmas_cevheri: 1 },
  kristal:  { saf_kristal: 4, ejder_pulu: 2, elmas_cevheri: 2 },
  kraliyet: { ejder_pulu: 6, ay_tasi: 3, gunes_parcasi: 3, karanlik_oz: 2 },
};
// Sandık craft reçeteleri (top-level: hem handleCraftCommand hem autocomplete kullanır)
const CRAFT_SANDIK_RECIPES = {
  ahsap:    { demir_cevheri: 5 },
  demir:    { demir_cevheri: 9, obsidyen: 2 },
  altin:    { altin_cevheri: 6, saf_kristal: 2 },
  elmas:    { elmas_cevheri: 4, saf_kristal: 4, ejder_pulu: 1 },
  kraliyet: { ejder_pulu: 4, ay_tasi: 3, karanlik_oz: 3 },
};

// Sandıktan çıkabilecek ödüller — tier'a göre ağırlıklar farklı
function openChest(gid, uid, chestType) {
  // Sandık tier değeri
  const tierMap = { ahsap: 1, demir: 2, altin: 3, elmas: 4, kraliyet: 5 };
  const tier = tierMap[chestType] || 1;

  // Olası çıktılar ve ağırlıkları (tier arttıkça iyiler daha ağır)
  const outcomes = [
    { type: 'coin',        label: 'Coin',            weight: Math.max(5, 45 - tier * 6) },
    { type: 'craft_mat',   label: 'Craft Malzemesi', weight: 30 },
    { type: 'egg',         label: 'Pet Yumurtası',   weight: 5 + tier * 3 },
    { type: 'chest',       label: 'Sandık',          weight: 3 + tier },
    { type: 'relic_piece', label: 'Relic Parçası',   weight: 2 + tier * 2 },
    { type: 'antique',     label: 'Antika',          weight: tier === 5 ? 5 : Math.max(0, tier - 1) },
    { type: 'craft_recipe',label: 'Taslak',          weight: tier * 2 },
  ];

  const total = outcomes.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  let picked = outcomes[0];
  for (const o of outcomes) { if (r < o.weight) { picked = o; break; } r -= o.weight; }

  const result = { type: picked.type, label: picked.label };

  if (picked.type === 'coin') {
    const coinRanges = { ahsap: [50,200], demir: [150,500], altin: [400,1000], elmas: [800,2000], kraliyet: [1500,4000] };
    const [min, max] = coinRanges[chestType] || [50, 200];
    result.amount = Math.floor(Math.random() * (max - min + 1)) + min;
    addBalance(gid, uid, result.amount);

  } else if (picked.type === 'craft_mat') {
    // Tier'a göre hangi malzeme düşebilir
    const matTiers = {
      1: ['demir_cevheri','bakir_cevheri'],
      2: ['demir_cevheri','altin_cevheri','obsidyen'],
      3: ['altin_cevheri','elmas_cevheri','obsidyen','saf_kristal'],
      4: ['elmas_cevheri','saf_kristal','ejder_pulu','lav_tasi'],
      5: ['ejder_pulu','ruh_tozu','karanlik_oz','ay_tasi','gunes_parcasi','yildirim_kristali','buz_cekirdegi'],
    };
    const pool = matTiers[tier] || matTiers[1];
    result.matKey = pool[Math.floor(Math.random() * pool.length)];
    result.quantity = Math.floor(Math.random() * 3) + 1;
    addCraftMat(gid, uid, result.matKey, result.quantity);

  } else if (picked.type === 'egg') {
    const eggByTier = { 1: 'siradan', 2: 'siradan', 3: 'nadir', 4: 'altin', 5: 'kristal' };
    // Kraliyet sandığından %5 kraliyet yumurtası
    if (tier === 5 && Math.random() < 0.05) result.eggType = 'kraliyet';
    else result.eggType = eggByTier[tier] || 'siradan';
    addEgg(gid, uid, result.eggType, 1);

  } else if (picked.type === 'chest') {
    const nextTiers = { ahsap: 'ahsap', demir: 'ahsap', altin: 'demir', elmas: 'altin', kraliyet: 'elmas' };
    result.chestType = nextTiers[chestType] || 'ahsap';
    addChest(gid, uid, result.chestType, 1);

  } else if (picked.type === 'relic_piece') {
    // Yeni relic set parçalarından biri
    const allNewPieces = Object.values(RELIC_SETS).flatMap(s => s.pieces.map(p => p.key));
    result.relicKey = allNewPieces[Math.floor(Math.random() * allNewPieces.length)];
    if (!hasRelic(gid, uid, result.relicKey)) buyRelic(gid, uid, result.relicKey);

  } else if (picked.type === 'antique') {
    // Kraliyet sandığında %5 nadir antika, diğerlerinde normal
    const antiquePool = chestType === 'kraliyet'
      ? ANTIQUES.filter(a => a.rarity === 'rare')
      : ANTIQUES.filter(a => a.rarity === 'normal');
    const a = antiquePool[Math.floor(Math.random() * antiquePool.length)] || ANTIQUES[0];
    result.antique = a;
    addAntique(gid, uid, a.key);

  } else {
    // craft_recipe — şimdilik coin ver
    result.type = 'coin';
    result.amount = tier * 100;
    addBalance(gid, uid, result.amount);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Craft Malzemeleri
// ─────────────────────────────────────────────────────────────────────────
const CRAFT_MATERIALS = [
  { key: 'demir_cevheri',    name: 'Demir',             emoji: '⚙️',  tier: 1, sellValue: 20 },
  { key: 'bakir_cevheri',    name: 'Bakır',             emoji: '🟤', tier: 1, sellValue: 20 },
  { key: 'altin_cevheri',    name: 'Altın',             emoji: '🟡', tier: 2, sellValue: 25 },
  { key: 'elmas_cevheri',    name: 'Elmas',             emoji: '💎', tier: 3, sellValue: 35 },
  { key: 'obsidyen',         name: 'Obsidyen',          emoji: '🪨', tier: 2, sellValue: 25 },
  { key: 'saf_kristal',      name: 'Saf Kristal',       emoji: '🔮', tier: 3, sellValue: 30 },
  { key: 'ejder_pulu',       name: 'Ejder Pulu',        emoji: '🐉', tier: 4, sellValue: 45 },
  { key: 'lav_tasi',         name: 'Lav Taşı',          emoji: '🌋', tier: 3, sellValue: 30 },
  { key: 'ruh_tozu',         name: 'Ruh Tozu',          emoji: '👻', tier: 3, sellValue: 30 },
  { key: 'karanlik_oz',      name: 'Karanlık Öz',       emoji: '🌑', tier: 4, sellValue: 40 },
  { key: 'ay_tasi',          name: 'Ay Taşı',           emoji: '🌙', tier: 4, sellValue: 40 },
  { key: 'gunes_parcasi',    name: 'Güneş Parçası',     emoji: '☀️', tier: 4, sellValue: 40 },
  { key: 'yildirim_kristali',name: 'Yıldırım Kristali', emoji: '⚡', tier: 4, sellValue: 45 },
  { key: 'buz_cekirdegi',    name: 'Buz Çekirdeği',     emoji: '❄️', tier: 4, sellValue: 50 },
];

// ─────────────────────────────────────────────────────────────────────────
//  GELİŞMİŞ CRAFT MALZEMELERİ (madenden DÜŞMEZ — yalnızca /craft ile üretilir)
// ─────────────────────────────────────────────────────────────────────────
// Bu 4 malzeme hiçbir maden/zindan/sandık drop tablosunda yer almaz; tek elde
// etme yolu `/craft kategori:malzeme` ile yukarıdaki tier-4 cevherlerden
// üretmektir. Her biri, tek bir S tier (Ejder) kılıç üretmek için gereken
// toplam malzeme miktarına (180 adet) eşit zorlukta craftlanır — yani "kolay
// bulunan" bir şey değil, başlı başına ağır bir üretim hedefi.
// Kullanım alanları: SSS tier silah/zırh/relic set üretiminde (2-3 adet) VE
// +5'ten sonraki her ekipman geliştirmesinde (bkz. ADVANCED_ENHANCEMENT_MAT_COST).
const ADVANCED_CRAFT_MATERIALS = [
  // NOT: Bu 4 malzemenin tüm reçete miktarları kullanıcı isteğiyle +%15 daha
  // kolaylaştırıldı (craftlamak çok zordu) — aşağıdaki sayılar bu ekstra
  // %15 indirimi zaten içeriyor.
  { key: 'kaos_ozu',        name: 'Kaos Özü',        emoji: '🌀', tier: 5, sellValue: 90, advanced: true,
    craft: { ejder_pulu: 30, karanlik_oz: 43, obsidyen: 24, saf_kristal: 24 } },
  { key: 'zaman_kumu',      name: 'Zaman Kumu',      emoji: '⏳', tier: 5, sellValue: 90, advanced: true,
    craft: { ay_tasi: 43, gunes_parcasi: 43, elmas_cevheri: 24, saf_kristal: 24 } },
  { key: 'yildiz_tozu',     name: 'Yıldız Tozu',     emoji: '🌠', tier: 5, sellValue: 90, advanced: true,
    craft: { yildirim_kristali: 43, buz_cekirdegi: 43, ejder_pulu: 24, altin_cevheri: 34 } },
  { key: 'kozmik_kristal',  name: 'Kozmik Kristal',  emoji: '💠', tier: 5, sellValue: 90, advanced: true,
    craft: { elmas_cevheri: 30, saf_kristal: 30, ruh_tozu: 34, lav_tasi: 34 } },
];
const ADVANCED_MAT_KEYS = ADVANCED_CRAFT_MATERIALS.map(m => m.key);

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Silahlar
// ─────────────────────────────────────────────────────────────────────────
const WEAPON_TYPES = [
  { key: 'kilic',    name: 'Kılıç',       emoji: '🗡️', stat: 'attack'   },
  { key: 'yay',      name: 'Yay',         emoji: '🏹', stat: 'critical' },
  { key: 'asa',      name: 'Asa',         emoji: '🪄', stat: 'magic'    },
  { key: 'hancer',   name: 'Çift Hançer', emoji: '🗡️', stat: 'speed'    },
  { key: 'tirpan',   name: 'Tırpan',      emoji: '🪃', stat: 'attack'   },
];
// Silah tipi taban saldırı hızı — /fight'ta menzil/inisiyatif hesabında kullanılır.
// Yay uzaktan başlar (en hızlı), kılıç/tırpan mesafe kapatması gereken ağır silahlar (en yavaş).
const WEAPON_SPEED_BASE = {
  yay:    2.0,
  hancer: 1.6,
  asa:    1.3,
  kilic:  1.0,
  tirpan: 0.8,
};
// Tier harfleri: E (en düşük) < C < B < A < S < SSS (Godslayer, en nadir/en güçlü)
const GEAR_GRADE_MULTIPLIER = { E: 1.0, C: 1.3, B: 1.7, A: 2.3, S: 3.2, SSS: 3.2 };
// Tier arttıkça silahın vuruş hızı da artar (daha iyi işçilik = daha çevik silah)
const TIER_SPEED_MULT = { deri: 1.0, demir: 1.1, altin: 1.2, kristal: 1.35, ejder: 1.5, godslayer: 1.65 };
// Her +1 geliştirme seviyesi taban gücü/savunmayı %10 artırır (+10 → +%100)
const GEAR_ENHANCEMENT_BONUS_PER_LV = 0.10;
const WEAPON_TIERS = [
  { key: 'deri',    name: 'Deri',    grade: 'E', emoji: '🥉', power: 5,  price: 1500,
    craft: { demir_cevheri: 5 },              canBuy: true  },
  { key: 'demir',   name: 'Demir',   grade: 'C', emoji: '⚙️',  power: 12, price: 3500,
    craft: { demir_cevheri: 10, bakir_cevheri: 5 }, canBuy: true  },
  // B tier — 3 kat zorlaştırıldı
  { key: 'altin',   name: 'Altın',   grade: 'B', emoji: '🥇', power: 22, price: 0,
    craft: { altin_cevheri: 24, demir_cevheri: 15, obsidyen: 6 }, canBuy: false },
  // A tier — 4 kat zorlaştırıldı
  { key: 'kristal', name: 'Kristal', grade: 'A', emoji: '💎', power: 35, price: 0,
    craft: { saf_kristal: 28, altin_cevheri: 32, elmas_cevheri: 14 }, canBuy: false },
  // S tier — 6 kat zorlaştırıldı
  { key: 'ejder',   name: 'Ejder',   grade: 'S', emoji: '🐉', power: 55, price: 0,
    craft: { ejder_pulu: 42, elmas_cevheri: 42, obsidyen: 21, saf_kristal: 21 }, canBuy: false },
  // SSS tier — GODSLAYER: S tier'den %50 daha güçlü, S tier'in (zorlaştırılmış) maliyetinden 10 kat daha zor
  // Ayrıca 3 adet gelişmiş (yalnızca craftlanan) malzeme gerektirir — bkz. ADVANCED_CRAFT_MATERIALS.
  { key: 'godslayer', name: 'Godslayer', grade: 'SSS', emoji: '👑', power: 83, price: 0,
    craft: { ejder_pulu: 420, elmas_cevheri: 420, obsidyen: 210, saf_kristal: 210, kaos_ozu: 2, zaman_kumu: 1 }, canBuy: false },
];

// weaponKey formatı: `{type}_{tier}` örn: `kilic_altin`
function parseWeaponKey(key) {
  const [typeKey, tierKey] = key.split('_');
  const type = WEAPON_TYPES.find(t => t.key === typeKey);
  const tier = WEAPON_TIERS.find(t => t.key === tierKey);
  return { type, tier };
}
function getWeaponName(key) {
  const { type, tier } = parseWeaponKey(key);
  if (!type || !tier) return key;
  return `[${tier.grade}] ${tier.emoji} ${tier.name} ${type.emoji} ${type.name}`;
}
function getWeaponPower(key) {
  const { tier } = parseWeaponKey(key);
  return tier ? tier.power : 0;
}
// Dövüş gücü: taban güç × tier'ın nadirlik çarpanı (E/C/B/A/S) × geliştirme bonusu (+0..+10 → +%0..+%100)
function getWeaponBattlePower(weaponKey, enhancement = 0) {
  const { tier } = parseWeaponKey(weaponKey);
  if (!tier) return 0;
  const mult = GEAR_GRADE_MULTIPLIER[tier.grade] || 1;
  return Math.round(tier.power * mult * (1 + enhancement * GEAR_ENHANCEMENT_BONUS_PER_LV));
}

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Zırh
// ─────────────────────────────────────────────────────────────────────────
// Zırh slot tier'i — /fight'ta ekstra bir güç çarpanı katıyor (bkz. ARMOR_SLOT_TIER_MULT).
// Büyücü'nün eskiden tek zırh slotu (kolye) vardı; dengelemek için hem yeni slotlar
// eklendi hem de kolye'ye en yüksek tier (SSS) verildi.
const ARMOR_SLOT_TIER_MULT = { B: 1.10, A: 1.25, S: 1.45, SSS: 1.75, cope: 1.0 };
const ARMOR_SLOTS = [
  // ── Orijinal 7 slot — B/A/S/SSS olarak tierlendirildi (3B/3A/3S/3SSS kotasının parçası) ──
  { key: 'miğfer',    name: 'Miğfer',    emoji: '⛑️',  stat: 'defense', tier: 'B'   },
  { key: 'gogusulk',  name: 'Göğüslük',  emoji: '🛡️', stat: 'hp',      tier: 'B'   },
  { key: 'eldiven',   name: 'Eldiven',   emoji: '🧤', stat: 'attack',  tier: 'B'   },
  { key: 'pantolon',  name: 'Pantolon',  emoji: '👖', stat: 'speed',   tier: 'A'   },
  { key: 'bot',       name: 'Bot',       emoji: '👢', stat: 'speed',   tier: 'A'   },
  { key: 'yuzuk',     name: 'Yüzük',     emoji: '💍', stat: 'critical',tier: 'S'   },
  { key: 'kolye',     name: 'Kolye',     emoji: '📿', stat: 'mana',    tier: 'SSS' }, // Büyücü'nün TEK slotu — kotayı dengelemek için SSS verildi
  // ── 10 yeni slot — sınıf slot sayılarını dengelemek için eklendi (sovalye+3, nisanci+3, buyucu+4) ──
  { key: 'pelerin',   name: 'Pelerin',    emoji: '🧥', stat: 'defense', tier: 'cope' }, // sovalye
  { key: 'kalkan',    name: 'Kalkan',     emoji: '🛡️', stat: 'attack',  tier: 'cope' }, // sovalye
  { key: 'kemer',     name: 'Kemer',      emoji: '🥋', stat: 'hp',      tier: 'cope' }, // sovalye
  { key: 'sadak',     name: 'Sadak',      emoji: '🏹', stat: 'speed',   tier: 'cope' }, // nişancı
  { key: 'pence',     name: 'Pençelik',   emoji: '🧤', stat: 'critical',tier: 'cope' }, // nişancı
  { key: 'gozluk',    name: 'Nişan Gözlüğü', emoji: '🥽', stat: 'speed', tier: 'cope' }, // nişancı
  { key: 'asakini',   name: 'Asa Kını',   emoji: '🪄', stat: 'magic',   tier: 'cope' }, // büyücü
  { key: 'buyucubaget', name: 'Büyücü Çubuğu', emoji: '✨', stat: 'magic', tier: 'cope' }, // büyücü
  { key: 'muskalik',  name: 'Muskalık',   emoji: '🧿', stat: 'mana',    tier: 'cope' }, // büyücü
  { key: 'buyukitap', name: 'Büyü Kitabı', emoji: '📖', stat: 'mana', tier: 'cope' }, // büyücü
];
const ARMOR_TIERS = [
  { key: 'deri',    name: 'Deri',    grade: 'E', emoji: '🥉', defense: 3,  price: 1200,
    craft: { demir_cevheri: 3 },                canBuy: true  },
  { key: 'demir',   name: 'Demir',   grade: 'C', emoji: '⚙️',  defense: 7,  price: 2800,
    craft: { demir_cevheri: 8 },                canBuy: true  },
  // B tier — 3 kat zorlaştırıldı
  { key: 'altin',   name: 'Altın',   grade: 'B', emoji: '🥇', defense: 13, price: 0,
    craft: { altin_cevheri: 18, demir_cevheri: 12 }, canBuy: false },
  // A tier — 4 kat zorlaştırıldı
  { key: 'kristal', name: 'Kristal', grade: 'A', emoji: '💎', defense: 22, price: 0,
    craft: { saf_kristal: 22, altin_cevheri: 20 }, canBuy: false },
  // S tier — 6 kat zorlaştırıldı
  { key: 'ejder',   name: 'Ejder',   grade: 'S', emoji: '🐉', defense: 35, price: 0,
    craft: { ejder_pulu: 34, elmas_cevheri: 34, saf_kristal: 17 }, canBuy: false },
  // SSS tier — GODSLAYER: S tier'den %50 daha güçlü, S tier'in (zorlaştırılmış) maliyetinden 10 kat daha zor
  // Ayrıca 3 adet gelişmiş (yalnızca craftlanan) malzeme gerektirir — bkz. ADVANCED_CRAFT_MATERIALS.
  { key: 'godslayer', name: 'Godslayer', grade: 'SSS', emoji: '👑', defense: 53, price: 0,
    craft: { ejder_pulu: 336, elmas_cevheri: 336, saf_kristal: 168, kozmik_kristal: 2, yildiz_tozu: 1 }, canBuy: false },
];

// armorKey formatı: `{slot}_{tier}` örn: `miğfer_altin`
function getArmorName(slotKey, tierKey) {
  const slot = ARMOR_SLOTS.find(s => s.key === slotKey);
  const tier = ARMOR_TIERS.find(t => t.key === tierKey);
  if (!slot || !tier) return `${slotKey}_${tierKey}`;
  return `[${tier.grade}] ${tier.emoji} ${tier.name} ${slot.emoji} ${slot.name}`;
}
// Dövüş gücü: taban savunma × tier'ın nadirlik çarpanı (E/C/B/A/S) × geliştirme bonusu
function getArmorBattlePower(tierKey, enhancement = 0, slotKey = null) {
  const tier = ARMOR_TIERS.find(t => t.key === tierKey);
  if (!tier) return 0;
  const mult = GEAR_GRADE_MULTIPLIER[tier.grade] || 1;
  const slot = slotKey ? ARMOR_SLOTS.find(s => s.key === slotKey) : null;
  const slotMult = slot ? (ARMOR_SLOT_TIER_MULT[slot.tier] || 1) : 1;
  return Math.round(tier.defense * mult * slotMult * (1 + enhancement * GEAR_ENHANCEMENT_BONUS_PER_LV));
}

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Ekipman Basma (+0 … +10)
// ─────────────────────────────────────────────────────────────────────────
const ENHANCEMENT_SUCCESS_RATES = [100, 95, 90, 85, 75, 65, 50, 35, 25, 15];
// Eşya kırılmaz — coin ve craft malzemesi gider
const ENHANCEMENT_COIN_COST = [500, 800, 1200, 1800, 2500, 3500, 5000, 7000, 10000, 15000];
// Başarısızlıkta kaybedilen craft malzemesi (tier bazlı)
const ENHANCEMENT_MAT_COST = { demir_cevheri: 3, altin_cevheri: 2, saf_kristal: 1 };

// +5'ten SONRAKİ her geliştirme (yani +5→+6, +6→+7, ... +9→+10) ayrıca
// yukarıdaki ADVANCED_CRAFT_MATERIALS'tan da malzeme ister (madenden düşmez,
// yalnızca /craft kategori:malzeme ile üretilir). Anahtar = mevcut seviye
// (yükseltmenin BAŞLADIĞI seviye, enh), değer = gereken adet (1-3 arası,
// seviye arttıkça zorlaşır). Kullanılan malzeme türü seviyeye göre döner.
const ADVANCED_ENHANCEMENT_MAT_COST = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 3 };
function getAdvancedEnhanceRequirement(enh) {
  if (enh < 5) return null;
  const qty = ADVANCED_ENHANCEMENT_MAT_COST[enh] || 3;
  const matKey = ADVANCED_MAT_KEYS[enh % ADVANCED_MAT_KEYS.length];
  return { [matKey]: qty };
}

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Yeni Relic Setleri
// ─────────────────────────────────────────────────────────────────────────
// Aynı anda en fazla bu kadar Relic Set'in bonusu aktif olabilir — parça
// sahipliğinin kendisini etkilemez, sadece hangi setlerin bonusunun
// hesaba katılacağını sınırlar. Kuşanma: /relic-set ekranındaki
// "Kuşan"/"Çıkar" butonları (mmo_equipset_ / mmo_unequipset_).
const RELIC_SET_MAX_EQUIPPED = 2;
// Parça fiyatı — artık tüm tier'lerde eşit (satın alma yerine craftlamayı özendirmek için).
// Tüm tier'ler artık aynı fiyatta: 6 parça × 20.000 = set başına 120.000 coin.
// Amaç: satın almayı caydırıp herkesi craftlamaya (bkz. getRelicSetCraftRecipe) yönlendirmek.
const RELIC_TIER_PRICE = { B: 20000, A: 20000, S: 20000, SSS: 20000 };
// Tam set craft reçetesi — kılıç (WEAPON_TIERS) craft reçetesinden örnek alınır,
// aynı tier'in kılıcına göre %60 DAHA ZOR (×1.6) olacak şekilde ölçeklenir.
// SSS tier setler ayrıca 2-3 adet gelişmiş (yalnızca craftlanan) malzeme ister.
const RELIC_SET_TIER_TO_WEAPON_TIER = { B: 'altin', A: 'kristal', S: 'ejder', SSS: 'godslayer' };
const RELIC_SET_CRAFT_HARDER_MULT = 1.6;
function getRelicSetCraftRecipe(tierGrade) {
  const wKey  = RELIC_SET_TIER_TO_WEAPON_TIER[tierGrade];
  const wTier = WEAPON_TIERS.find(t => t.key === wKey);
  if (!wTier) return {};
  const recipe = {};
  for (const [mat, qty] of Object.entries(wTier.craft)) {
    // Kılıcın kendi gelişmiş malzeme gereksinimi varsa (godslayer) onu da
    // aynı ×1.6 oranıyla ölçekle; yoksa aşağıda ayrıca ekleniyor.
    recipe[mat] = Math.ceil(qty * RELIC_SET_CRAFT_HARDER_MULT);
  }
  if (tierGrade === 'SSS') {
    // 2-3 adet gelişmiş malzeme şartı (godslayer kılıcınkinden bağımsız, sete özel)
    recipe.kaos_ozu       = (recipe.kaos_ozu || 0) + 1;
    recipe.kozmik_kristal = (recipe.kozmik_kristal || 0) + 1;
    recipe.yildiz_tozu    = (recipe.yildiz_tozu || 0) + 1;
  }
  return recipe;
}
// 6 parçalı bir seti tek satırda üretir — Lav/Buz/Fırtına/Gölge/Güneş ile
// aynı isimlendirme kalıbını (Tacı/Kolyesi/Yüzüğü/Kristali/Mührü/Çekirdeği) kullanır.
function mkRelicPieces(prefix, theme, emoji, price) {
  return [
    { key: `${prefix}_tac`,      name: `${theme} Tacı`,      price, emoji },
    { key: `${prefix}_kolye`,    name: `${theme} Kolyesi`,   price, emoji },
    { key: `${prefix}_yuzuk`,    name: `${theme} Yüzüğü`,    price, emoji },
    { key: `${prefix}_kristal`,  name: `${theme} Kristali`,  price, emoji },
    { key: `${prefix}_muhur`,    name: `${theme} Mührü`,     price, emoji },
    { key: `${prefix}_cekirdek`, name: `${theme} Çekirdeği`, price, emoji },
  ];
}
const RELIC_SETS = {
  lav: {
    name: 'Lav Seti', emoji: '🌋', color: 0xFF4500, tier: 'A',
    pieces: [
      { key: 'lav_tac',      name: 'Lav Tacı',      price: 20000, emoji: '🌋' },
      { key: 'lav_kolye',    name: 'Lav Kolyesi',   price: 20000, emoji: '🌋' },
      { key: 'lav_yuzuk',    name: 'Lav Yüzüğü',   price: 20000, emoji: '🌋' },
      { key: 'lav_kristal',  name: 'Lav Kristali',  price: 20000, emoji: '🌋' },
      { key: 'lav_muhur',    name: 'Lav Mührü',     price: 20000, emoji: '🌋' },
      { key: 'lav_cekirdek', name: 'Lav Çekirdeği', price: 20000, emoji: '🌋' },
    ],
    bonus2: { desc: '+%10 Coin kazanımı',                       coinPct: 10 },
    bonus4: { desc: '+%20 Coin & +%8 XP kazanımı',              coinPct: 20, xpPct: 8 },
    bonusFull: { desc: '+%35 Coin & +%15 XP & Zindan coin +%25', coinPct: 35, xpPct: 15, dungeonCoinPct: 25 },
  },
  buz: {
    name: 'Buz Seti', emoji: '❄️', color: 0x00BFFF, tier: 'S',
    pieces: [
      { key: 'buz_tac',      name: 'Buz Tacı',      price: 20000, emoji: '❄️' },
      { key: 'buz_kolye',    name: 'Buz Kolyesi',   price: 20000, emoji: '❄️' },
      { key: 'buz_yuzuk',    name: 'Buz Yüzüğü',   price: 20000, emoji: '❄️' },
      { key: 'buz_kristal',  name: 'Buz Kristali',  price: 20000, emoji: '❄️' },
      { key: 'buz_muhur',    name: 'Buz Mührü',     price: 20000, emoji: '❄️' },
      { key: 'buz_cekirdek', name: 'Buz Çekirdeği', price: 20000, emoji: '❄️' },
    ],
    bonus2: { desc: '+%13 XP kazanımı',                         xpPct: 13 },
    bonus4: { desc: '+%26 XP & +%10 Coin kazanımı',             xpPct: 26, coinPct: 10 },
    bonusFull: { desc: '+%46 XP & +%20 Coin & Zindan XP +%32',  xpPct: 46, coinPct: 20, dungeonXpPct: 32 },
  },
  firtina: {
    name: 'Fırtına Seti', emoji: '⚡', color: 0xF1C40F, tier: 'S',
    pieces: [
      { key: 'firtina_tac',      name: 'Fırtına Tacı',      price: 20000, emoji: '⚡' },
      { key: 'firtina_kolye',    name: 'Fırtına Kolyesi',   price: 20000, emoji: '⚡' },
      { key: 'firtina_yuzuk',    name: 'Fırtına Yüzüğü',   price: 20000, emoji: '⚡' },
      { key: 'firtina_kristal',  name: 'Fırtına Kristali',  price: 20000, emoji: '⚡' },
      { key: 'firtina_muhur',    name: 'Fırtına Mührü',     price: 20000, emoji: '⚡' },
      { key: 'firtina_cekirdek', name: 'Fırtına Çekirdeği', price: 20000, emoji: '⚡' },
    ],
    bonus2: { desc: '+%13 Kritik şansı (zindan/boss)',            critPct: 13 },
    bonus4: { desc: '+%26 Kritik & +%13 Günlük bonus',            critPct: 26, dailyPct: 13 },
    bonusFull: { desc: '+%46 Kritik & +%26 Günlük & Slot +%20',   critPct: 46, dailyPct: 26, slotPct: 20 },
  },
  golge: {
    name: 'Gölge Seti', emoji: '🌑', color: 0x2C3E50, tier: 'SSS',
    pieces: [
      { key: 'golge_tac',      name: 'Gölge Tacı',      price: 20000, emoji: '🌑' },
      { key: 'golge_kolye',    name: 'Gölge Kolyesi',   price: 20000, emoji: '🌑' },
      { key: 'golge_yuzuk',    name: 'Gölge Yüzüğü',   price: 20000, emoji: '🌑' },
      { key: 'golge_kristal',  name: 'Gölge Kristali',  price: 20000, emoji: '🌑' },
      { key: 'golge_muhur',    name: 'Gölge Mührü',     price: 20000, emoji: '🌑' },
      { key: 'golge_cekirdek', name: 'Gölge Çekirdeği', price: 20000, emoji: '🌑' },
    ],
    bonus2: { desc: '+%16 Hırsızlık başarı şansı',               stealPct: 16 },
    bonus4: { desc: '+%32 Hırsızlık & +%16 Madencilik satışı',   stealPct: 32, minePct: 16 },
    bonusFull: { desc: '+%56 Hırsızlık & +%32 Madencilik & Boss drop +%32', stealPct: 56, minePct: 32, bossPct: 32 },
  },
  gunes: {
    name: 'Güneş Seti', emoji: '☀️', color: 0xFFD700, tier: 'SSS',
    pieces: [
      { key: 'gunes_tac',      name: 'Güneş Tacı',      price: 20000, emoji: '☀️' },
      { key: 'gunes_kolye',    name: 'Güneş Kolyesi',   price: 20000, emoji: '☀️' },
      { key: 'gunes_yuzuk',    name: 'Güneş Yüzüğü',   price: 20000, emoji: '☀️' },
      { key: 'gunes_kristal',  name: 'Güneş Kristali',  price: 20000, emoji: '☀️' },
      { key: 'gunes_muhur',    name: 'Güneş Mührü',     price: 20000, emoji: '☀️' },
      { key: 'gunes_cekirdek', name: 'Güneş Çekirdeği', price: 20000, emoji: '☀️' },
    ],
    bonus2: { desc: '+%16 Balıkçılık değeri',                     fishPct: 16 },
    bonus4: { desc: '+%32 Balıkçılık & +%16 Odunculuk satışı',    fishPct: 32, woodPct: 16 },
    bonusFull: { desc: '+%56 Balık & +%32 Odunculuk & Pet XP +%40', fishPct: 56, woodPct: 32, petXpPct: 40 },
  },

  // ── 10 ek relic seti — düzgün isimlendirildi ve gerçek tier'lere (B/A/S/SSS)
  // dağıtıldı. Fiyat ve bonus büyüklüğü, silah/zırh tier sistemindeki (WEAPON_TIERS/
  // GEAR_GRADE_MULTIPLIER) mantıkla aynı doğrultuda tier arttıkça büyüyor:
  //   B  → bonus2:%7  | bonus4:%14 (+%6)  | bonusFull:%25 (+%10 +%10) | fiyat 120.000 (set)
  //   A  → bonus2:%10 | bonus4:%20 (+%8)  | bonusFull:%35 (+%15 +%15) | fiyat 120.000 (set)
  //   S  → bonus2:%13 | bonus4:%26 (+%11) | bonusFull:%46 (+%21 +%21) | fiyat 120.000 (set)
  //   SSS→ bonus2:%16 | bonus4:%32 (+%14) | bonusFull:%56 (+%27 +%27) | fiyat 120.000 (set)
  // Dağılım: B=Toprak,Ay,Demir(3) • A=Rüzgar,Su,Yıldız(3) • S=Zehir,Kan(2) • SSS=Elmas,Altın(2)
  toprak: {
    name: 'Toprak Seti', emoji: '🪨', color: 0x8B5A2B, tier: 'B',
    pieces: mkRelicPieces('toprak', 'Toprak', '🪨', RELIC_TIER_PRICE.B),
    bonus2: { desc: '+%7 Madencilik satışı', minePct: 7 },
    bonus4: { desc: '+%14 Madencilik satışı & +%6 Coin', minePct: 14, coinPct: 6 },
    bonusFull: { desc: '+%25 Madencilik satışı & +%10 Coin & Boss drop +%10', minePct: 25, coinPct: 10, bossPct: 10 },
  },
  ay: {
    name: 'Ay Seti', emoji: '🌙', color: 0x5D6D7E, tier: 'B',
    pieces: mkRelicPieces('ay', 'Ay', '🌙', RELIC_TIER_PRICE.B),
    bonus2: { desc: '+%7 Slot kazancı', slotPct: 7 },
    bonus4: { desc: '+%14 Slot & +%6 Coin', slotPct: 14, coinPct: 6 },
    bonusFull: { desc: '+%25 Slot & +%10 Coin & Madencilik +%10', slotPct: 25, coinPct: 10, minePct: 10 },
  },
  demirset: {
    name: 'Demir Seti', emoji: '⚙️', color: 0x7F8C8D, tier: 'B',
    pieces: mkRelicPieces('dmrset', 'Demir', '⚙️', RELIC_TIER_PRICE.B),
    bonus2: { desc: '+%7 Pet XP', petXpPct: 7 },
    bonus4: { desc: '+%14 Pet XP & +%6 XP', petXpPct: 14, xpPct: 6 },
    bonusFull: { desc: '+%25 Pet XP & +%10 XP & Odunculuk +%10', petXpPct: 25, xpPct: 10, woodPct: 10 },
  },
  ruzgar: {
    name: 'Rüzgar Seti', emoji: '🌪️', color: 0x87CEEB, tier: 'A',
    pieces: mkRelicPieces('ruzgar', 'Rüzgar', '🌪️', RELIC_TIER_PRICE.A),
    bonus2: { desc: '+%10 Odunculuk satışı', woodPct: 10 },
    bonus4: { desc: '+%20 Odunculuk & +%8 XP', woodPct: 20, xpPct: 8 },
    bonusFull: { desc: '+%35 Odunculuk & +%15 XP & Pet XP +%15', woodPct: 35, xpPct: 15, petXpPct: 15 },
  },
  su: {
    name: 'Su Seti', emoji: '🌊', color: 0x1E90FF, tier: 'A',
    pieces: mkRelicPieces('su', 'Su', '🌊', RELIC_TIER_PRICE.A),
    bonus2: { desc: '+%10 Balıkçılık değeri', fishPct: 10 },
    bonus4: { desc: '+%20 Balıkçılık & +%8 XP', fishPct: 20, xpPct: 8 },
    bonusFull: { desc: '+%35 Balıkçılık & +%15 XP & Zindan coin +%15', fishPct: 35, xpPct: 15, dungeonCoinPct: 15 },
  },
  yildiz: {
    name: 'Yıldız Seti', emoji: '⭐', color: 0xF39C12, tier: 'A',
    pieces: mkRelicPieces('yildiz', 'Yıldız', '⭐', RELIC_TIER_PRICE.A),
    bonus2: { desc: '+%10 Günlük bonus', dailyPct: 10 },
    bonus4: { desc: '+%20 Günlük & +%8 XP', dailyPct: 20, xpPct: 8 },
    bonusFull: { desc: '+%35 Günlük & +%15 XP & Zindan XP +%15', dailyPct: 35, xpPct: 15, dungeonXpPct: 15 },
  },
  zehir: {
    name: 'Zehir Seti', emoji: '☠️', color: 0x2ECC71, tier: 'S',
    pieces: mkRelicPieces('zehir', 'Zehir', '☠️', RELIC_TIER_PRICE.S),
    bonus2: { desc: '+%13 Hırsızlık başarı şansı', stealPct: 13 },
    bonus4: { desc: '+%26 Hırsızlık & +%11 Kritik', stealPct: 26, critPct: 11 },
    bonusFull: { desc: '+%46 Hırsızlık & +%21 Kritik & Slot +%21', stealPct: 46, critPct: 21, slotPct: 21 },
  },
  kan: {
    name: 'Kan Seti', emoji: '🩸', color: 0xC0392B, tier: 'S',
    pieces: mkRelicPieces('kan', 'Kan', '🩸', RELIC_TIER_PRICE.S),
    bonus2: { desc: '+%13 Kritik şansı', critPct: 13 },
    bonus4: { desc: '+%26 Kritik & +%11 Günlük bonus', critPct: 26, dailyPct: 11 },
    bonusFull: { desc: '+%46 Kritik & +%21 Günlük & Boss drop +%21', critPct: 46, dailyPct: 21, bossPct: 21 },
  },
  elmas: {
    name: 'Elmas Seti', emoji: '💎', color: 0x9B59B6, tier: 'SSS',
    pieces: mkRelicPieces('elmas', 'Elmas', '💎', RELIC_TIER_PRICE.SSS),
    bonus2: { desc: '+%16 XP kazanımı', xpPct: 16 },
    bonus4: { desc: '+%32 XP & +%14 Coin', xpPct: 32, coinPct: 14 },
    bonusFull: { desc: '+%56 XP & +%27 Coin & Pet XP +%27', xpPct: 56, coinPct: 27, petXpPct: 27 },
  },
  altinset: {
    name: 'Altın Seti', emoji: '🥇', color: 0xFFC300, tier: 'SSS',
    pieces: mkRelicPieces('altnset', 'Altın', '🥇', RELIC_TIER_PRICE.SSS),
    bonus2: { desc: '+%16 Coin kazanımı', coinPct: 16 },
    bonus4: { desc: '+%32 Coin & +%14 Zindan coin', coinPct: 32, dungeonCoinPct: 14 },
    bonusFull: { desc: '+%56 Coin & +%27 Zindan coin & Madencilik +%27', coinPct: 56, dungeonCoinPct: 27, minePct: 27 },
  },

  // ── Büyücü'ye özel 4 yeni relic seti — yalnızca /sinif ile "Büyücü" seçen
  // oyuncular kuşanabilir (classKey kontrolü equipRelicSet() içinde yapılır).
  // Parça sahipliği herkese açık (madenden/zindandan da düşebilir), ama bonusun
  // aktif olması için oyuncunun sınıfı büyücü olmalı. Aynı B/A/S/SSS ölçeği kullanılır.
  muska: {
    name: 'Muska Seti', emoji: '🧿', color: 0x1ABC9C, tier: 'B', classKey: 'buyucu',
    pieces: mkRelicPieces('muska', 'Muska', '🧿', RELIC_TIER_PRICE.B),
    bonus2: { desc: '+%7 Günlük bonus', dailyPct: 7 },
    bonus4: { desc: '+%14 Günlük & +%6 XP', dailyPct: 14, xpPct: 6 },
    bonusFull: { desc: '+%25 Günlük & +%10 XP & Pet XP +%10 & Büyü direnci +%8', dailyPct: 25, xpPct: 10, petXpPct: 10, magicResistPct: 8 },
  },
  buyu: {
    name: 'Büyü Seti', emoji: '🪄', color: 0x6C3483, tier: 'A', classKey: 'buyucu',
    pieces: mkRelicPieces('buyu', 'Büyü', '🪄', RELIC_TIER_PRICE.A),
    bonus2: { desc: '+%10 XP kazanımı', xpPct: 10 },
    bonus4: { desc: '+%20 XP & +%8 Kritik', xpPct: 20, critPct: 8 },
    bonusFull: { desc: '+%35 XP & +%15 Kritik & Zindan XP +%15 & Büyü direnci +%12', xpPct: 35, critPct: 15, dungeonXpPct: 15, magicResistPct: 12 },
  },
  sihir: {
    name: 'Sihir Seti', emoji: '✨', color: 0x8E44AD, tier: 'S', classKey: 'buyucu',
    pieces: mkRelicPieces('sihir', 'Sihir', '✨', RELIC_TIER_PRICE.S),
    bonus2: { desc: '+%13 Kritik şansı (büyü)', critPct: 13 },
    bonus4: { desc: '+%26 Kritik & +%11 XP', critPct: 26, xpPct: 11 },
    bonusFull: { desc: '+%46 Kritik & +%21 XP & Zindan coin +%21 & Büyü direnci +%17', critPct: 46, xpPct: 21, dungeonCoinPct: 21, magicResistPct: 17 },
  },
  kadim: {
    name: 'Kadim Seti', emoji: '📜', color: 0x4A235A, tier: 'SSS', classKey: 'buyucu',
    pieces: mkRelicPieces('kadim', 'Kadim', '📜', RELIC_TIER_PRICE.SSS),
    bonus2: { desc: '+%16 Zindan XP', dungeonXpPct: 16 },
    bonus4: { desc: '+%32 Zindan XP & +%14 XP', dungeonXpPct: 32, xpPct: 14 },
    bonusFull: { desc: '+%56 Zindan XP & +%27 XP & Boss drop +%27 & Büyü direnci +%22', dungeonXpPct: 56, xpPct: 27, bossPct: 27, magicResistPct: 22 },
  },

  // ── Şövalye'ye özel 4 yeni relic seti — Büyücü'nün Muska/Büyü/Sihir/Kadim
  // setleriyle aynı mantık: parça sahipliği herkese açık, bonusun aktif olması
  // için oyuncunun sınıfı Şövalye olmalı. Aynı B/A/S/SSS ölçeği kullanılır.
  sovalye_zirh: {
    name: 'Zırh Seti', emoji: '🛡️', color: 0x566573, tier: 'B', classKey: 'sovalye',
    pieces: mkRelicPieces('svzirh', 'Zırh', '🛡️', RELIC_TIER_PRICE.B),
    bonus2: { desc: '+%7 Zindan coin kazanımı', dungeonCoinPct: 7 },
    bonus4: { desc: '+%14 Zindan coin & +%6 Coin', dungeonCoinPct: 14, coinPct: 6 },
    bonusFull: { desc: '+%25 Zindan coin & +%10 Coin & Boss drop +%10 & Fiziksel direnç +%8', dungeonCoinPct: 25, coinPct: 10, bossPct: 10, physResistPct: 8 },
  },
  sovalye_savas: {
    name: 'Savaş Seti', emoji: '⚔️', color: 0x943126, tier: 'A', classKey: 'sovalye',
    pieces: mkRelicPieces('svsavas', 'Savaş', '⚔️', RELIC_TIER_PRICE.A),
    bonus2: { desc: '+%10 Boss drop şansı', bossPct: 10 },
    bonus4: { desc: '+%20 Boss drop & +%8 XP', bossPct: 20, xpPct: 8 },
    bonusFull: { desc: '+%35 Boss drop & +%15 XP & Zindan XP +%15 & Fiziksel direnç +%12', bossPct: 35, xpPct: 15, dungeonXpPct: 15, physResistPct: 12 },
  },
  sovalye_kale: {
    name: 'Kale Seti', emoji: '🏰', color: 0x717D7E, tier: 'S', classKey: 'sovalye',
    pieces: mkRelicPieces('svkale', 'Kale', '🏰', RELIC_TIER_PRICE.S),
    bonus2: { desc: '+%13 Kritik şansı', critPct: 13 },
    bonus4: { desc: '+%26 Kritik & +%11 Günlük bonus', critPct: 26, dailyPct: 11 },
    bonusFull: { desc: '+%46 Kritik & +%21 Günlük & Zindan coin +%21 & Fiziksel direnç +%17', critPct: 46, dailyPct: 21, dungeonCoinPct: 21, physResistPct: 17 },
  },
  sovalye_kahraman: {
    name: 'Kahraman Seti', emoji: '🦁', color: 0xB7950B, tier: 'SSS', classKey: 'sovalye',
    pieces: mkRelicPieces('svkahr', 'Kahraman', '🦁', RELIC_TIER_PRICE.SSS),
    bonus2: { desc: '+%16 Boss drop şansı', bossPct: 16 },
    bonus4: { desc: '+%32 Boss drop & +%14 Coin', bossPct: 32, coinPct: 14 },
    bonusFull: { desc: '+%56 Boss drop & +%27 Coin & Zindan coin +%27 & Fiziksel direnç +%22', bossPct: 56, coinPct: 27, dungeonCoinPct: 27, physResistPct: 22 },
  },

  // ── Nişancı'ya özel 4 yeni relic seti — aynı mantık, Nişancı'nın kritik/hız
  // temasına uygun bonuslarla. Aynı B/A/S/SSS ölçeği kullanılır.
  nisanci_ok: {
    name: 'Ok Seti', emoji: '🏹', color: 0x784212, tier: 'B', classKey: 'nisanci',
    pieces: mkRelicPieces('nsok', 'Ok', '🏹', RELIC_TIER_PRICE.B),
    bonus2: { desc: '+%7 Kritik şansı', critPct: 7 },
    bonus4: { desc: '+%14 Kritik & +%6 Coin', critPct: 14, coinPct: 6 },
    bonusFull: { desc: '+%25 Kritik & +%10 Coin & Slot +%10 & Hareket hızı +%8', critPct: 25, coinPct: 10, slotPct: 10, speedPct: 8 },
  },
  nisanci_nisan: {
    name: 'Nişan Seti', emoji: '🎯', color: 0xCB4335, tier: 'A', classKey: 'nisanci',
    pieces: mkRelicPieces('nsnisan', 'Nişan', '🎯', RELIC_TIER_PRICE.A),
    bonus2: { desc: '+%10 Slot kazancı', slotPct: 10 },
    bonus4: { desc: '+%20 Slot & +%8 XP', slotPct: 20, xpPct: 8 },
    bonusFull: { desc: '+%35 Slot & +%15 XP & Kritik +%15 & Hareket hızı +%12', slotPct: 35, xpPct: 15, critPct: 15, speedPct: 12 },
  },
  nisanci_sahin: {
    name: 'Şahin Seti', emoji: '🦅', color: 0x6E2C00, tier: 'S', classKey: 'nisanci',
    pieces: mkRelicPieces('nssahin', 'Şahin', '🦅', RELIC_TIER_PRICE.S),
    bonus2: { desc: '+%13 Hırsızlık başarı şansı', stealPct: 13 },
    bonus4: { desc: '+%26 Hırsızlık & +%11 Kritik', stealPct: 26, critPct: 11 },
    bonusFull: { desc: '+%46 Hırsızlık & +%21 Kritik & Zindan XP +%21 & Hareket hızı +%17', stealPct: 46, critPct: 21, dungeonXpPct: 21, speedPct: 17 },
  },
  nisanci_avci: {
    name: 'Avcı Seti', emoji: '🐆', color: 0x1B4F72, tier: 'SSS', classKey: 'nisanci',
    pieces: mkRelicPieces('nsavci', 'Avcı', '🐆', RELIC_TIER_PRICE.SSS),
    bonus2: { desc: '+%16 Kritik şansı', critPct: 16 },
    bonus4: { desc: '+%32 Kritik & +%14 Slot', critPct: 32, slotPct: 14 },
    bonusFull: { desc: '+%56 Kritik & +%27 Slot & Zindan XP +%27 & Hareket hızı +%22', critPct: 56, slotPct: 27, dungeonXpPct: 27, speedPct: 22 },
  },
};

// Tüm yeni relic parçalarını düz listeye çevir
const ALL_NEW_RELIC_PIECES = Object.values(RELIC_SETS).flatMap(s => s.pieces);

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Zindanlar
// ─────────────────────────────────────────────────────────────────────────
const DUNGEONS = [
  {
    key: 'goblin',      name: 'Goblin Mağarası',    emoji: '👺',
    minLevel: 1,  xpReward: [30,60],   coinReward: [80,200],
    color: 0x2ECC71, cd: 120000, requiredPower: 10,
    desc: 'Goblinlerin ininden coin ve malzeme topla.',
    matPool: ['demir_cevheri','bakir_cevheri'],
  },
  {
    key: 'iskelet',     name: 'İskelet Mezarlığı',  emoji: '💀',
    minLevel: 3,  xpReward: [50,90],   coinReward: [150,350],
    color: 0x95A5A6, cd: 120000, requiredPower: 20,
    desc: 'Ölümsüzlerin arasında gizli hazineler var.',
    matPool: ['demir_cevheri','obsidyen'],
  },
  {
    key: 'orumcek',     name: 'Örümcek Yuvası',     emoji: '🕷️',
    minLevel: 5,  xpReward: [80,130],  coinReward: [250,500],
    color: 0x8E44AD, cd: 120000, requiredPower: 30,
    desc: 'Dev örümcekler değerli iplik ve malzeme bırakır.',
    matPool: ['demir_cevheri','altin_cevheri','ruh_tozu'],
  },
  {
    key: 'hayalet',     name: 'Hayalet Şatosu',     emoji: '👻',
    minLevel: 8,  xpReward: [110,180], coinReward: [400,750],
    color: 0x6C3483, cd: 120000, requiredPower: 45,
    desc: 'Şatonun hayaletleri Ruh Tozu bırakır.',
    matPool: ['ruh_tozu','obsidyen','saf_kristal'],
  },
  {
    key: 'lav',         name: 'Lav Tapınağı',       emoji: '🌋',
    minLevel: 12, xpReward: [160,250], coinReward: [600,1100],
    color: 0xFF4500, cd: 120000, requiredPower: 65,
    desc: 'Cehennem ateşi içinde Lav Taşları bulunur.',
    matPool: ['lav_tasi','obsidyen','ejder_pulu'],
  },
  {
    key: 'buz',         name: 'Buz Sarayı',         emoji: '❄️',
    minLevel: 16, xpReward: [210,320], coinReward: [850,1500],
    color: 0x00BFFF, cd: 120000, requiredPower: 85,
    desc: 'Sonsuz soğukta Buz Çekirdekleri gizlidir.',
    matPool: ['buz_cekirdegi','saf_kristal','yildirim_kristali'],
  },
  {
    key: 'orman',       name: 'Orman Mabedi',       emoji: '🌲',
    minLevel: 20, xpReward: [280,420], coinReward: [1200,2000],
    color: 0x27AE60, cd: 120000, requiredPower: 105,
    desc: 'Antik ormanın ruhu değerli taşlar saklar.',
    matPool: ['ay_tasi','gunes_parcasi','saf_kristal'],
  },
  {
    key: 'karanlik',    name: 'Karanlık Orman',     emoji: '🌑',
    minLevel: 25, xpReward: [370,560], coinReward: [1700,2800],
    color: 0x2C3E50, cd: 120000, requiredPower: 130,
    desc: 'Karanlık öz bu ormanda kendiliğinden oluşur.',
    matPool: ['karanlik_oz','ruh_tozu','ejder_pulu'],
  },
  {
    key: 'ejder',       name: 'Ejder Zirvesi',      emoji: '🐉',
    minLevel: 35, xpReward: [550,800], coinReward: [2500,4000],
    color: 0xFF6B00, cd: 120000, requiredPower: 180,
    desc: 'Ejderin yatağında Ejder Pulu ve nadirlikler var.',
    matPool: ['ejder_pulu','elmas_cevheri','karanlik_oz','ay_tasi'],
  },
  {
    key: 'cehennem',    name: 'Cehennem Kapısı',    emoji: '🔥',
    minLevel: 45, xpReward: [750,1100],coinReward: [4000,7000],
    color: 0xC0392B, cd: 120000, requiredPower: 230,
    desc: 'Cehennemin kapısında en değerli malzemeler bulunur.',
    matPool: ['ejder_pulu','karanlik_oz','ay_tasi','gunes_parcasi','yildirim_kristali','buz_cekirdegi'],
  },
];

// ─────────────────────────────────────────────────────────────────────────
//  ZINDAN ZORLUĞU — RPG statları başarı şansını belirler
// ─────────────────────────────────────────────────────────────────────────
// "Güç" = 7 RPG statının (hp+attack+defense+critical+speed+mana+magic) toplamı.
// Yeni bir karakter min 7 güce sahiptir (her stat Lv.1), max 350 güce
// ulaşabilir (her stat Lv.50). dungeon.requiredPower o zindanı "rahat"
// geçebilmek için hedeflenen güç seviyesidir — tam o gücün altında/üstünde
// olmak başarı şansını kaydırır, ama hiçbir zaman %100 garanti ya da
// %0 imkansız değildir (DUNGEON_SUCCESS_MIN/MAX ile sınırlanır).

// ─────────────────────────────────────────────────────────────────────────
//  ZINDAN DÜŞMANLARI — Her zindan için görsel düşman listesi
// ─────────────────────────────────────────────────────────────────────────
const DUNGEON_ENEMIES = {
  goblin:    [
    { name: 'Goblin Savaşçısı', emoji: '👺', hp: 80  },
    { name: 'Goblin Şamanı',    emoji: '🧙', hp: 60  },
    { name: 'Goblin Avcısı',    emoji: '🏹', hp: 55  },
  ],
  iskelet:   [
    { name: 'İskelet Muhafızı', emoji: '💀', hp: 100 },
    { name: 'Lich',             emoji: '🦴', hp: 90  },
    { name: 'Kemik Golem',      emoji: '⚰️', hp: 120 },
  ],
  orumcek:   [
    { name: 'Dev Örümcek',      emoji: '🕷️', hp: 110 },
    { name: 'Zehir Ağ Canavarı',emoji: '🕸️', hp: 85  },
    { name: 'Örümcek Kraliçesi',emoji: '🦗', hp: 150 },
  ],
  hayalet:   [
    { name: 'Hayalet',          emoji: '👻', hp: 95  },
    { name: 'Ruh Avcısı',       emoji: '💫', hp: 75  },
    { name: 'Şato Efendisi',    emoji: '🫥', hp: 200 },
  ],
  lav:       [
    { name: 'Ateş İfriti',      emoji: '🔥', hp: 130 },
    { name: 'Lav Golemi',       emoji: '🌋', hp: 180 },
    { name: 'Cehennem Köpeği',  emoji: '🐕', hp: 100 },
  ],
  buz:       [
    { name: 'Buz Devi',         emoji: '❄️', hp: 160 },
    { name: 'Frost Elemental',  emoji: '🌨️', hp: 140 },
    { name: 'Buz Ejderi',       emoji: '🐲', hp: 220 },
  ],
  orman:     [
    { name: 'Orman Ruhu',       emoji: '🌲', hp: 140 },
    { name: 'Ent',              emoji: '🪵', hp: 200 },
    { name: 'Yaban Canavarı',   emoji: '🐗', hp: 120 },
  ],
  karanlik:  [
    { name: 'Gölge Avcısı',     emoji: '🌑', hp: 150 },
    { name: 'Karanlık Emici',   emoji: '🦇', hp: 130 },
    { name: 'Karanlık Lord',    emoji: '😈', hp: 250 },
  ],
  ejder:     [
    { name: 'Ejder Yavrusu',    emoji: '🐉', hp: 180 },
    { name: 'Wyvern',           emoji: '🦎', hp: 160 },
    { name: 'Antik Ejder',      emoji: '🔥', hp: 350 },
  ],
  cehennem:  [
    { name: 'İblis Muhafızı',   emoji: '😈', hp: 250 },
    { name: 'Cehennem Lordu',   emoji: '👹', hp: 300 },
    { name: 'Şeytan Prensi',    emoji: '🔱', hp: 500 },
  ],
};

const DUNGEON_SUCCESS_BASE  = 70;  // requiredPower'a TAM eşit güçte başarı şansı
const DUNGEON_SUCCESS_SLOPE = 2;   // güç farkı başına ± şans puanı
const DUNGEON_SUCCESS_MIN   = 15;  // hazırlıksız gitsen bile en az bu kadar şansın var
const DUNGEON_SUCCESS_MAX   = 95;  // aşırı hazırlıklı olsan bile küçük bir risk hep kalır
// Başarısızlıkta coin/drop YOK, sadece küçük bir "tecrübe" XP'si verilir
const DUNGEON_FAIL_XP_PCT = 0.25;


// ─────────────────────────────────────────────────────────────────────────
//  PET SAVAŞ GÜCÜ — Aktif MMORPG petleri dövüş/zindan gücüne katkı sağlar
// ─────────────────────────────────────────────────────────────────────────
function getMmoPetBattlePower(gid, uid) {
  const active = getMmoActivePets(gid, uid);
  if (!active.length) return { power: 0, pets: [] };
  const cls = getPlayerClass(gid, uid);
  let power = 0;
  const pets = [];
  for (const ap of active) {
    const def = MMORPG_PETS.find(p => p.key === ap.petKey);
    if (!def) continue;
    if (cls && !classAllowsStat(cls, def.bonusType)) continue; // sınıfa uygun olmayan pet güce katılmaz
    const lv = db.prepare('SELECT level FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?')
      .get(gid, uid, ap.petKey, ap.petHatchedAt);
    const level = lv ? lv.level : 1;
    const bonus = (def.bonusBase || 0) + (level - 1) * MMO_PET_BONUS_PER_LV;
    const rarityMult = [1, 1.5, 2, 3, 5][def.rarity] || 1;
    const petPower = Math.round((def.rarity + 1) * level * rarityMult + bonus * 0.3);
    power += petPower;
    pets.push({ ...def, level, bonus, petPower });
  }
  return { power, pets };
}

function getRpgPowerScore(gid, uid) {
  const s = getRpgStats(gid, uid);
  return RPG_STAT_KEYS.reduce((sum, k) => sum + (s[k] || 1), 0);
}
function getDungeonSuccessChance(gid, uid, dungeon) {
  const statPower = getRpgPowerScore(gid, uid);
  // Aktif petler zindan başarı şansına katkı sağlar (max +30 puan)
  const { power: petPowerVal } = getMmoPetBattlePower(gid, uid);
  const effectivePetBonus = Math.min(petPowerVal * 0.4, 30);
  const power = statPower + effectivePetBonus;
  const raw   = DUNGEON_SUCCESS_BASE + (power - dungeon.requiredPower) * DUNGEON_SUCCESS_SLOPE;
  return Math.max(DUNGEON_SUCCESS_MIN, Math.min(DUNGEON_SUCCESS_MAX, Math.round(raw)));
}

// ─────────────────────────────────────────────────────────────────────────
//  /fight — OYUNCULAR ARASI DÜELLO
//  Dövüş gücü = RPG Seviyesi + Stat Gücü + Relic Seviyesi + Silah Gücü + Zırh Gücü
//  Silah/zırh gücü, o eşyanın TIER'ına (E/C/B/A/S → GEAR_GRADE_MULTIPLIER) ve
//  +geliştirme seviyesine göre hesaplanır. Manuel "kuşanma" yok — her zaman
//  sahip olunan EN İYİ silah + her zırh slotundaki EN İYİ parça kullanılır.
// ─────────────────────────────────────────────────────────────────────────
const FIGHT_COOLDOWN_MS  = 15 * 60 * 1000; // meydan okuyan için 15 dk
const FIGHT_STEAL_PCT    = 0.05;           // kaybedenin bakiyesinin %5'i (Gölge Seti stealPct ile artar)
const FIGHT_STEAL_CAP    = 2000;           // tek seferde en fazla bu kadar coin çalınabilir
const FIGHT_WIN_XP       = [40, 80];
const FIGHT_LOSE_XP      = [10, 20];       // kaybeden de küçük bir tecrübe XP'si alır
const FIGHT_MIN_CHANCE   = 15;             // en güçsüz oyuncu bile en az %15 şansla kazanabilir
const FIGHT_MAX_CHANCE   = 85;             // en güçlü oyuncu bile %100 garanti kazanamaz

// Relic seviyesi: kuşanılmış set parçaları + tekli relikler + Ejder Seti seviyesi
function getRelicBattlePower(gid, uid) {
  const singleCount = RELICS.filter(r => r.group === 'single' && hasRelic(gid, uid, r.key)).length;
  const setInfo = getRelicSetBonuses(gid, uid);
  const equippedSetPieces = Object.values(setInfo).filter(i => i.equipped).reduce((sum, i) => sum + i.count, 0);
  const ejderLevel = hasAllEjderParts(gid, uid) ? getEjderLevel(gid, uid) : 0;
  return singleCount * 10 + equippedSetPieces * 5 + ejderLevel * 15;
}

// Sahip olunan en iyi silah + her zırh slotundaki en iyi parça (otomatik seçilir)
// Sınıf seçilmişse, sınıfa uygun olmayan silah/zırh dövüş gücüne hiç katılmaz.
function getBestGearPower(gid, uid) {
  const cls = getPlayerClass(gid, uid);
  const weapons = getWeapons(gid, uid);
  let bestWeapon = null;
  for (const w of weapons) {
    const { type } = parseWeaponKey(w.weaponKey);
    if (cls && type && !classAllowsStat(cls, type.stat)) continue;
    const p = getWeaponBattlePower(w.weaponKey, w.enhancement);
    if (!bestWeapon || p > bestWeapon.power) bestWeapon = { ...w, power: p };
  }
  const weaponPower = bestWeapon ? bestWeapon.power : 0;

  const armors = getArmors(gid, uid);
  const bestBySlot = {};
  for (const a of armors) {
    const slotDef = ARMOR_SLOTS.find(s => s.key === a.slot);
    if (cls && slotDef && !classAllowsStat(cls, slotDef.stat)) continue;
    const tierKey = a.armorKey.split('_')[1] || a.armorKey;
    const p = getArmorBattlePower(tierKey, a.enhancement, a.slot);
    if (!bestBySlot[a.slot] || p > bestBySlot[a.slot].power) bestBySlot[a.slot] = { ...a, power: p };
  }
  const armorPower = Object.values(bestBySlot).reduce((sum, a) => sum + a.power, 0);

  return { weaponPower, armorPower, bestWeapon, bestArmors: Object.values(bestBySlot) };
}

// Zırhın kuşandığı slotun statüne göre savaşa küçük bir katkı sağlar:
// hız statlı slotlar (Pantolon/Bot/Sadak/Nişan Gözlüğü) → hareket hızı
// büyü/mana statlı slotlar (Kolye/Asa Kını/Büyücü Çubuğu/Muskalık/Büyü Kitabı) → büyü direnci
// savunma/can statlı slotlar (Miğfer/Göğüslük/Pelerin/Kemer) → fiziksel direnç
// Tier ve geliştirme seviyesi arttıkça katkı da büyür (üst sınır: %25).
function getArmorCombatBonus(gid, uid) {
  const { bestArmors } = getBestGearPower(gid, uid);
  let speedBonus = 0, physResistBonus = 0, magicResistBonus = 0;
  for (const a of bestArmors) {
    const slotDef = ARMOR_SLOTS.find(s => s.key === a.slot);
    const tierKey = a.armorKey.split('_')[1] || a.armorKey;
    const tierDef = ARMOR_TIERS.find(t => t.key === tierKey);
    if (!slotDef || !tierDef) continue;
    const gradeMult = GEAR_GRADE_MULTIPLIER[tierDef.grade] || 1;
    const enhMult   = 1 + (a.enhancement || 0) * GEAR_ENHANCEMENT_BONUS_PER_LV;
    const base = 0.015 * gradeMult * enhMult;
    if (slotDef.stat === 'speed')                                  speedBonus       += base;
    else if (slotDef.stat === 'magic' || slotDef.stat === 'mana')  magicResistBonus += base;
    else if (slotDef.stat === 'defense' || slotDef.stat === 'hp')  physResistBonus  += base;
  }
  return {
    speedBonus:       Math.min(0.25, speedBonus),
    physResistBonus:  Math.min(0.25, physResistBonus),
    magicResistBonus: Math.min(0.25, magicResistBonus),
  };
}

// Toplam dövüş gücü — /fight ve gösterim için kullanılır (petler dahil!)
function getBattlePower(gid, uid) {
  const rpg        = getRpgData(gid, uid);
  const levelPower = rpg.rpgLevel * 3;
  const statPower  = getRpgPowerScore(gid, uid);
  const relicPower = getRelicBattlePower(gid, uid);
  const gear       = getBestGearPower(gid, uid);
  // Aktif MMORPG petleri artık dövüş gücüne katkı sağlıyor!
  const { power: petPower, pets: activePetList } = getMmoPetBattlePower(gid, uid);
  const total = levelPower + statPower + relicPower + gear.weaponPower + gear.armorPower + petPower;
  return { total, levelPower, statPower, relicPower, weaponPower: gear.weaponPower, armorPower: gear.armorPower, petPower, activePetList, gear };
}


// ─────────────────────────────────────────────────────────────────────────
//  GÖRSEL SAVAŞ YARDIMCILARI — OwO tarzı dövüş ve zindan ekranı
// ─────────────────────────────────────────────────────────────────────────
function buildHpBar(current, max, length = 10) {
  const filled = Math.max(0, Math.min(length, Math.round((current / max) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function buildFightResultPetVisual(gid, uid, username, isWinner) {
  const { pets } = getMmoPetBattlePower(gid, uid);
  if (!pets.length) {
    return isWinner ? `🏆 **${username}**\n*(pet yok)*` : `💀 **${username}**\n*(pet yok)*`;
  }
  const lines = pets.slice(0, 3).map((p, i) => {
    const maxHp = 100 + p.level * 20;
    let remainHp;
    if (isWinner) {
      remainHp = i === 0 ? Math.round(maxHp * 0.45) : Math.round(maxHp * (0.3 + Math.random() * 0.3));
    } else {
      remainHp = i === 0 ? 0 : Math.round(maxHp * Math.random() * 0.15);
    }
    remainHp = Math.max(0, Math.min(maxHp, remainHp));
    const bar = buildHpBar(remainHp, maxHp);
    return `${p.emoji} **${p.name}** Lv.${p.level}\n\`${bar}\` ${remainHp}/${maxHp}`;
  });
  const crown = isWinner ? '🏆 ' : '💀 ';
  return `${crown}**${username}**\n${lines.join('\n')}`;
}

function buildDungeonResultVisual(gid, uid, dungeon, success) {
  const { pets } = getMmoPetBattlePower(gid, uid);
  const enemies  = (DUNGEON_ENEMIES[dungeon.key] || []).slice(0, 2);

  let petLines;
  if (pets.length) {
    petLines = pets.slice(0, 3).map(p => {
      const maxHp = 100 + p.level * 20;
      const remainHp = success
        ? Math.round(maxHp * (0.2 + Math.random() * 0.5))
        : Math.round(maxHp * Math.random() * 0.1);
      const bar = buildHpBar(Math.max(0, remainHp), maxHp);
      return `${p.emoji} **${p.name}** Lv.${p.level}\n\`${bar}\` ${Math.max(0,remainHp)}/${maxHp}`;
    }).join('\n');
  } else {
    petLines = '*(Kuşanılmış pet yok — /rpg-pet ile kuşan!)*';
  }

  let enemyLines;
  if (enemies.length) {
    enemyLines = enemies.map(e => {
      const remainHp = success ? 0 : Math.round(e.hp * (0.5 + Math.random() * 0.5));
      const bar = buildHpBar(Math.max(0, remainHp), e.hp);
      return `${e.emoji} **${e.name}**\n\`${bar}\` ${Math.max(0,remainHp)}/${e.hp}`;
    }).join('\n');
  } else {
    enemyLines = `${dungeon.emoji} *(Bilinmeyen düşman)*`;
  }

  return { petLines, enemyLines };
}

function getFightCd(gid, uid) {
  const row = db.prepare('SELECT lastFight FROM mmo_fight_cd WHERE guildId=? AND userId=?').get(gid, uid);
  return row ? row.lastFight : 0;
}
function setFightCd(gid, uid) {
  db.prepare(`
    INSERT INTO mmo_fight_cd(guildId,userId,lastFight) VALUES(?,?,?)
    ON CONFLICT(guildId,userId) DO UPDATE SET lastFight=excluded.lastFight
  `).run(gid, uid, Date.now());
}

// Düelloyu çözer: kim kazanır, kimden ne kadar coin/XP el değiştirir.
// Artık düz bir % zar atışı değil — hız/mesafe/direnç temelli 5 round'luk bir simülasyon (bkz. simulateCombat).
function resolveFight(gid, challengerId, opponentId) {
  const challengerPower = getBattlePower(gid, challengerId);
  const opponentPower   = getBattlePower(gid, opponentId);

  const A = buildCombatant(gid, challengerId);
  const B = buildCombatant(gid, opponentId);
  const sim = simulateCombat(A, B);
  const challengerWins = sim.aWon;

  // Gösterim amaçlı "kazanma şansı" — güç oranından türetilir, artık zar atmıyor ama panelde bilgi verir
  const totalPower = challengerPower.total + opponentPower.total || 1;
  const share = challengerPower.total / totalPower;
  const challengerChance = Math.max(FIGHT_MIN_CHANCE, Math.min(FIGHT_MAX_CHANCE, Math.round(15 + share * 70)));

  const winnerId = challengerWins ? challengerId : opponentId;
  const loserId  = challengerWins ? opponentId   : challengerId;

  // Gölge Seti — hırsızlık başarı bonusu, düellodaki coin çalma oranını da güçlendirir
  const stealSetBonus    = getRelicSetStealBonus(gid, winnerId);
  const effectiveStealPct = FIGHT_STEAL_PCT * (1 + stealSetBonus / 100);
  const loserBal = getBalance(gid, loserId);
  const stolen   = Math.min(FIGHT_STEAL_CAP, Math.floor(loserBal.balance * effectiveStealPct));
  if (stolen > 0) {
    addBalance(gid, loserId, -stolen);
    addBalance(gid, winnerId, stolen);
  }

  const winXp  = Math.floor(Math.random() * (FIGHT_WIN_XP[1]  - FIGHT_WIN_XP[0]  + 1)) + FIGHT_WIN_XP[0];
  const loseXp = Math.floor(Math.random() * (FIGHT_LOSE_XP[1] - FIGHT_LOSE_XP[0] + 1)) + FIGHT_LOSE_XP[0];
  addRpgXp(gid, winnerId, winXp);
  addRpgXp(gid, loserId, loseXp);

  return {
    winnerId, loserId, stolen, winXp, loseXp,
    challengerId, opponentId, challengerPower, opponentPower, challengerChance, challengerWins,
    combatLog: sim.log, hpA: sim.hpA, hpB: sim.hpB, maxHpA: A.maxHp, maxHpB: B.maxHp,
  };
}
function buildCombatant(gid, uid) {
  const bp    = getBattlePower(gid, uid);
  const cls   = getPlayerClass(gid, uid);
  const stats = getRpgStats(gid, uid);
  const rpg   = getRpgData(gid, uid);
  const gear  = getBestGearPower(gid, uid);

  let weaponSpeed = 1.0;
  if (gear.bestWeapon) {
    const { type, tier } = parseWeaponKey(gear.bestWeapon.weaponKey);
    if (type && tier) weaponSpeed = (WEAPON_SPEED_BASE[type.key] || 1.0) * (TIER_SPEED_MULT[tier.key] || 1.0);
  }

  const profile = CLASS_COMBAT_PROFILE[cls] || { speedMult: 1, physResist: 0.1, magicResist: 0.1, closeGapPerRound: 0.15 };

  // Aktif petlerin destek bonusu: hız/direnç türüne uygun petler ufak bir ek katkı sağlar
  let speedSupport = 0, physSupport = 0, magicSupport = 0;
  const { pets: activePets } = getMmoPetBattlePower(gid, uid);
  for (const p of activePets) {
    if (p.bonusType === 'speed')                       speedSupport += 0.1;
    else if (p.bonusType === 'magic' || p.bonusType === 'mana') magicSupport += 0.03;
    else if (p.bonusType === 'defense' || p.bonusType === 'hp') physSupport += 0.03;
  }
  speedSupport = Math.min(0.3, speedSupport);
  magicSupport = Math.min(0.15, magicSupport);
  physSupport  = Math.min(0.15, physSupport);

  // Zırh (slot statüne göre) ve tam kuşanılmış class-locked relic setleri
  // (Şövalye/Nişancı/Büyücü) hız/fiziksel direnç/büyü direnci katkısı sağlar.
  const armorCombat = getArmorCombatBonus(gid, uid);
  const relicCombat = getRelicSetCombatBonus(gid, uid);

  return {
    uid, cls,
    battlePower: bp,
    power: bp.total,
    totalSpeed: (weaponSpeed * profile.speedMult + speedSupport + armorCombat.speedBonus) * (1 + relicCombat.speedPct / 100),
    physResist: Math.min(0.75, profile.physResist + physSupport + armorCombat.physResistBonus + relicCombat.physResistPct / 100),
    magicResist: Math.min(0.75, profile.magicResist + magicSupport + armorCombat.magicResistBonus + relicCombat.magicResistPct / 100),
    closeGapPerRound: profile.closeGapPerRound,
    dmgType: cls === 'buyucu' ? 'magic' : 'physical',
    hp: 100 + rpg.rpgLevel * 4 + (stats.hp || 1) * 6,
    maxHp: 100 + rpg.rpgLevel * 4 + (stats.hp || 1) * 6,
  };
}

// Round bazlı, mantığa dayalı düello simülasyonu (5 round ≈ 10 saniyelik düello).
// Kazananı şans zarı değil; hız/inisiyatif, mesafe kapatma ve direnç filtreli hasar belirler.
// Ufak (±%10) rastgelelik sadece varyasyon için var, ana belirleyici değil.
function simulateCombat(A, B) {
  const ROUNDS = 5;
  let hpA = A.hp, hpB = B.hp;
  let gapA = 0, gapB = 0; // mesafeyi ne kadar kapattığı (0..1) — sadece yavaş taraf için işler
  const log = [];

  // NOT: Eskiden hasar sadece "inisiyatif payı" (shareA — salt hıza dayalı,
  // silahsız biri bile temel hız 1.0 ile kılıçlı biriyle eşit çıkabiliyordu)
  // ile çarpılıyordu; güç farkı (ör. 31 güç vs 10 güç) hasar dağılımına neredeyse
  // hiç yansımıyordu ve zayıf taraf 5 tur sonunda hâlâ yüksek can ile kalıyordu.
  // Artık her turda GÜÇ ORANINA dayalı bir "üstünlük çarpanı" da uygulanıyor:
  // güçlü taraf daha fazla, zayıf taraf daha az hasar veriyor — böylece belirgin
  // bir silah/ekipman/seviye farkı olduğunda düello gerçekten kararlı bitiyor.
  const powerShareA = A.power / ((A.power + B.power) || 1);
  // 0.5 (eşit güç) → çarpan 1.0x/1.0x ; 1.0 (tek taraflı güç) → çarpan ~1.6x/~0.4x
  const dominanceA = 0.4 + 1.2 * powerShareA;
  const dominanceB = 0.4 + 1.2 * (1 - powerShareA);

  for (let r = 1; r <= ROUNDS; r++) {
    if (hpA <= 0 || hpB <= 0) break;

    if (A.totalSpeed < B.totalSpeed) gapA = Math.min(1, gapA + A.closeGapPerRound);
    if (B.totalSpeed < A.totalSpeed) gapB = Math.min(1, gapB + B.closeGapPerRound);

    const effSpeedA = A.totalSpeed + Math.max(0, B.totalSpeed - A.totalSpeed) * gapA;
    const effSpeedB = B.totalSpeed + Math.max(0, A.totalSpeed - B.totalSpeed) * gapB;
    const speedSum  = effSpeedA + effSpeedB || 1;
    const shareA    = effSpeedA / speedSum; // bu round kim daha çok inisiyatif alıyor

    const noise = () => 0.9 + Math.random() * 0.2; // ±%10 varyasyon
    const dmgToB = Math.round((A.power * shareA       * dominanceA * (1 - (A.dmgType === 'magic' ? B.magicResist : B.physResist)) * noise()) / ROUNDS);
    const dmgToA = Math.round((B.power * (1 - shareA) * dominanceB * (1 - (B.dmgType === 'magic' ? A.magicResist : A.physResist)) * noise()) / ROUNDS);

    hpB -= dmgToB;
    hpA -= dmgToA;
    log.push(`**Tur ${r}:** ${Math.round(shareA*100)}% / ${Math.round((1-shareA)*100)}% inisiyatif → -${dmgToB} / -${dmgToA} can`);
  }

  const aWon = hpA === hpB ? (A.power >= B.power) : hpA > hpB;
  return { aWon, hpA: Math.max(0, hpA), hpB: Math.max(0, hpB), log };
}

// ─────────────────────────────────────────────────────────────────────────
//  MMORPG SABİTLERİ — Slot Makinesi
// ─────────────────────────────────────────────────────────────────────────
const SLOT_SYMBOLS_DEF = [
  { key: 'cherry',  emoji: '🍒', tier: 1 },
  { key: 'lemon',   emoji: '🍋', tier: 2 },
  { key: 'bell',    emoji: '🔔', tier: 3 },
  { key: 'star',    emoji: '⭐', tier: 4 },
  { key: 'diamond', emoji: '💎', tier: 5 },
];
const SLOT_MAX_DAILY = 10;
const BLACKJACK_MAX_DAILY = 8;

// ~50% RTP slot sonucu üret
// Returns: { reels, multiplier, label }
function spinSlot() {
  // Önce outcome belirle
  const r = Math.random() * 1000;
  let mult, tier;

  // Dağılım: ~%50 loss, gerisi win — EV ≈ 0.48x
  if      (r < 675) { mult = 0; tier = 0; }   // %67.5 kaybet
  else if (r < 835) { mult = 1; tier = 1; }   // %16.0 cherry pair (1x)
  else if (r < 925) { mult = 1.5; tier = 2; } // %9.0  lemon pair (1.5x)
  else if (r < 975) { mult = 2; tier = 3; }   // %5.0  bell 3x (2x)
  else if (r < 995) { mult = 3; tier = 4; }   // %2.0  star 3x (3x)
  else if (r < 998) { mult = 4; tier = 5; }   // %0.3  star jackpot (4x)
  else              { mult = 5; tier = 6; }   // %0.2  diamond jackpot (5x)

  // Görsel semboller üret (outcome'a uygun)
  let reels;
  if (mult === 0) {
    // Kazan yok — 3 farklı sembol
    const shuffled = [...SLOT_SYMBOLS_DEF].sort(() => Math.random() - 0.5);
    reels = [shuffled[0], shuffled[1], shuffled[2]].map(s => s.emoji);
    // Son olarak aynı çıkmadığından emin ol
    while (reels[0] === reels[1] && reels[1] === reels[2]) {
      reels[2] = SLOT_SYMBOLS_DEF[Math.floor(Math.random() * SLOT_SYMBOLS_DEF.length)].emoji;
    }
  } else if (mult === 1) {
    // Cherry pair (2 kiraz + 1 farklı)
    const other = SLOT_SYMBOLS_DEF.filter(s => s.key !== 'cherry');
    reels = ['🍒', '🍒', other[Math.floor(Math.random() * other.length)].emoji];
    reels.sort(() => Math.random() - 0.5);
  } else if (mult === 1.5) {
    // Lemon pair
    const other = SLOT_SYMBOLS_DEF.filter(s => s.key !== 'lemon');
    reels = ['🍋', '🍋', other[Math.floor(Math.random() * other.length)].emoji];
    reels.sort(() => Math.random() - 0.5);
  } else if (mult === 2) { reels = ['🔔', '🔔', '🔔']; }
  else if (mult === 3)   { reels = ['⭐', '⭐', '⭐']; }
  else if (mult === 4)   { reels = ['⭐', '⭐', '⭐']; } // yüksek star
  else                   { reels = ['💎', '💎', '💎']; }

  const labels = {
    0: '❌ Kazanamadın!',
    1: '🍒 İkili! Bahis iade',
    1.5:'🍋 İkili! +%50 kazanç',
    2: '🔔 Üçlü! 2x Kazanç',
    3: '⭐ Üçlü Yıldız! 3x',
    4: '⭐ JACKPOT! 4x',
    5: '💎 MEGA JACKPOT! 5x',
  };

  return { reels, multiplier: mult, label: labels[mult] || '...' };
}

// ─────────────────────────────────────────────────────────────────────────
//  VERİTABANI YARDIMCILARI — RPG
// ─────────────────────────────────────────────────────────────────────────
function getRpgData(gid, uid) {
  let r = db.prepare('SELECT * FROM rpg_data WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) {
    db.prepare('INSERT OR IGNORE INTO rpg_data(guildId,userId,rpgLevel,rpgXp)VALUES(?,?,1,0)').run(gid, uid);
    r = { guildId: gid, userId: uid, rpgLevel: 1, rpgXp: 0 };
  }
  return r;
}
function addRpgXp(gid, uid, amount) {
  const d = getRpgData(gid, uid);
  if (d.rpgLevel >= RPG_MAX_LEVEL) return { leveled: false, newLevel: d.rpgLevel };
  db.prepare('UPDATE rpg_data SET rpgXp=rpgXp+? WHERE guildId=? AND userId=?').run(amount, gid, uid);
  let cur = db.prepare('SELECT rpgLevel,rpgXp FROM rpg_data WHERE guildId=? AND userId=?').get(gid, uid);
  let leveled = false;
  while (cur.rpgXp >= getRpgXpNeeded(cur.rpgLevel) && cur.rpgLevel < RPG_MAX_LEVEL) {
    const xpUsed = getRpgXpNeeded(cur.rpgLevel);
    db.prepare('UPDATE rpg_data SET rpgLevel=rpgLevel+1,rpgXp=rpgXp-? WHERE guildId=? AND userId=?').run(xpUsed, gid, uid);
    cur = db.prepare('SELECT rpgLevel,rpgXp FROM rpg_data WHERE guildId=? AND userId=?').get(gid, uid);
    leveled = true;
  }
  return { leveled, newLevel: cur.rpgLevel };
}

function getRpgStats(gid, uid) {
  let r = db.prepare('SELECT * FROM rpg_stats WHERE guildId=? AND userId=?').get(gid, uid);
  if (!r) {
    db.prepare('INSERT OR IGNORE INTO rpg_stats(guildId,userId)VALUES(?,?)').run(gid, uid);
    r = { guildId: gid, userId: uid, hp:1, attack:1, defense:1, critical:1, speed:1, mana:1, magic:1 };
  }
  return r;
}
function upgradeRpgStat(gid, uid, stat) {
  const s = getRpgStats(gid, uid);
  const cur = s[stat] || 1;
  if (cur >= RPG_MAX_STAT_LEVEL) return { ok: false, reason: 'max' };
  const cost = getStatCost(cur + 1);
  const bal = getBalance(gid, uid);
  if (bal.balance < cost) return { ok: false, reason: 'coin', cost };
  addBalance(gid, uid, -cost);
  db.prepare(`UPDATE rpg_stats SET ${stat}=${stat}+1 WHERE guildId=? AND userId=?`).run(gid, uid);
  return { ok: true, newLevel: cur + 1, cost };
}
// Statlara harcanan toplam coini hesaplar (her stat için 2. seviyeden mevcut seviyeye kadar)
function calcStatRefundTotal(gid, uid) {
  const stats = getRpgStats(gid, uid);
  let total = 0;
  for (const key of Object.keys(RPG_STAT_NAMES)) {
    const lvl = stats[key] || 1;
    for (let l = 2; l <= lvl; l++) total += getStatCost(l);
  }
  return total;
}
function resetRpgStats(gid, uid) {
  db.prepare('UPDATE rpg_stats SET hp=1,attack=1,defense=1,critical=1,speed=1,mana=1,magic=1 WHERE guildId=? AND userId=?').run(gid, uid);
}

// ─────────────────────────────────────────────────────────────────────────
//  VERİTABANI YARDIMCILARI — MMORPG Petler & Yumurtalar
// ─────────────────────────────────────────────────────────────────────────
function addEgg(gid, uid, eggType, qty = 1) {
  db.prepare('INSERT OR IGNORE INTO mmo_eggs(guildId,userId,eggType,quantity)VALUES(?,?,?,0)').run(gid, uid, eggType);
  db.prepare('UPDATE mmo_eggs SET quantity=quantity+? WHERE guildId=? AND userId=? AND eggType=?').run(qty, gid, uid, eggType);
}
function getEggs(gid, uid) {
  return db.prepare('SELECT eggType,quantity FROM mmo_eggs WHERE guildId=? AND userId=? AND quantity>0').all(gid, uid);
}
function consumeEgg(gid, uid, eggType) {
  const r = db.prepare('SELECT quantity FROM mmo_eggs WHERE guildId=? AND userId=? AND eggType=?').get(gid, uid, eggType);
  if (!r || r.quantity < 1) return false;
  db.prepare('UPDATE mmo_eggs SET quantity=quantity-1 WHERE guildId=? AND userId=? AND eggType=?').run(gid, uid, eggType);
  return true;
}
// Pet Parçası envanteri yardımcıları
function addPetShard(gid, uid, petKey, qty = 1) {
  db.prepare('INSERT OR IGNORE INTO mmo_pet_shards(guildId,userId,petKey,quantity)VALUES(?,?,?,0)').run(gid, uid, petKey);
  db.prepare('UPDATE mmo_pet_shards SET quantity=quantity+? WHERE guildId=? AND userId=? AND petKey=?').run(qty, gid, uid, petKey);
}
function getPetShards(gid, uid) {
  return db.prepare('SELECT petKey,quantity FROM mmo_pet_shards WHERE guildId=? AND userId=? AND quantity>0').all(gid, uid);
}
function getPetShardCount(gid, uid, petKey) {
  const r = db.prepare('SELECT quantity FROM mmo_pet_shards WHERE guildId=? AND userId=? AND petKey=?').get(gid, uid, petKey);
  return r ? r.quantity : 0;
}
function consumePetShard(gid, uid, petKey, qty) {
  const cur = getPetShardCount(gid, uid, petKey);
  if (cur < qty) return false;
  db.prepare('UPDATE mmo_pet_shards SET quantity=quantity-? WHERE guildId=? AND userId=? AND petKey=?').run(qty, gid, uid, petKey);
  return true;
}

// Oyuncu zaten bu peti sahipleniyor mu? (herhangi bir hatchedAt ile)
function hasMmoPet(gid, uid, petKey) {
  return !!db.prepare('SELECT 1 FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=?').get(gid, uid, petKey);
}

function hatchEgg(gid, uid, eggType) {
  if (!consumeEgg(gid, uid, eggType)) return null;
  const pet = pickMmoPetFromEgg(eggType);

  // Oyuncuda zaten bu pet varsa: ikinci pet OLUŞTURMA, onun yerine
  // otomatik olarak o petin Pet Parçası x1'ini ver.
  if (hasMmoPet(gid, uid, pet.key)) {
    addPetShard(gid, uid, pet.key, 1);
    return { ...pet, duplicate: true, shardsGiven: 1, shardTotal: getPetShardCount(gid, uid, pet.key) };
  }

  const now = new Date().toISOString();
  db.prepare('INSERT INTO mmo_pets(guildId,userId,petKey,level,hatchedAt)VALUES(?,?,?,1,?)').run(gid, uid, pet.key, now);
  return { ...pet, duplicate: false, hatchedAt: now };
}
function getMmoPets(gid, uid) {
  return db.prepare('SELECT * FROM mmo_pets WHERE guildId=? AND userId=?').all(gid, uid);
}
function getMmoActivePets(gid, uid) {
  return db.prepare('SELECT * FROM mmo_active_pets WHERE guildId=? AND userId=?').all(gid, uid);
}
function equipMmoPet(gid, uid, petKey, hatchedAt, slot) {
  // Maks 6 slot kontrolü
  const active = getMmoActivePets(gid, uid);
  if (slot < 1 || slot > MMO_PET_MAX_ACTIVE) return false;
  db.prepare('INSERT OR REPLACE INTO mmo_active_pets(guildId,userId,slot,petKey,petHatchedAt)VALUES(?,?,?,?,?)').run(gid, uid, slot, petKey, hatchedAt);
  return true;
}
function unequipMmoPet(gid, uid, slot) {
  db.prepare('DELETE FROM mmo_active_pets WHERE guildId=? AND userId=? AND slot=?').run(gid, uid, slot);
}
function upgradeMmoPet(gid, uid, petKey, hatchedAt) {
  const r = db.prepare('SELECT level FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?').get(gid, uid, petKey, hatchedAt);
  if (!r || r.level >= MMO_PET_MAX_LEVEL) return { ok: false };
  const cost = 1000 + r.level * 500;

  // Lv6'dan itibaren (yani mevcut seviye 5+) Coin + Pet Parçası gerekir.
  const shardCost = getPetShardCostForLevel(r.level);
  if (shardCost > 0) {
    const haveShards = getPetShardCount(gid, uid, petKey);
    if (haveShards < shardCost) return { ok: false, reason: 'shard', shardCost, haveShards };
  }

  const bal = getBalance(gid, uid);
  if (bal.balance < cost) return { ok: false, reason: 'coin', cost, shardCost };

  addBalance(gid, uid, -cost);
  if (shardCost > 0) consumePetShard(gid, uid, petKey, shardCost);
  db.prepare('UPDATE mmo_pets SET level=level+1 WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?').run(gid, uid, petKey, hatchedAt);
  return { ok: true, newLevel: r.level + 1, cost, shardCost };
}

// ─────────────────────────────────────────────────────────────────────────
//  VERİTABANI YARDIMCILARI — Sandıklar
// ─────────────────────────────────────────────────────────────────────────
function addChest(gid, uid, chestType, qty = 1) {
  db.prepare('INSERT OR IGNORE INTO mmo_chests(guildId,userId,chestType,quantity)VALUES(?,?,?,0)').run(gid, uid, chestType);
  db.prepare('UPDATE mmo_chests SET quantity=quantity+? WHERE guildId=? AND userId=? AND chestType=?').run(qty, gid, uid, chestType);
}
function getChests(gid, uid) {
  return db.prepare('SELECT chestType,quantity FROM mmo_chests WHERE guildId=? AND userId=? AND quantity>0').all(gid, uid);
}
function consumeChest(gid, uid, chestType) {
  const r = db.prepare('SELECT quantity FROM mmo_chests WHERE guildId=? AND userId=? AND chestType=?').get(gid, uid, chestType);
  if (!r || r.quantity < 1) return false;
  db.prepare('UPDATE mmo_chests SET quantity=quantity-1 WHERE guildId=? AND userId=? AND chestType=?').run(gid, uid, chestType);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
//  VERİTABANI YARDIMCILARI — Craft Malzemeleri
// ─────────────────────────────────────────────────────────────────────────
function addCraftMat(gid, uid, matKey, qty = 1) {
  db.prepare('INSERT OR IGNORE INTO mmo_craft_mats(guildId,userId,matKey,quantity)VALUES(?,?,?,0)').run(gid, uid, matKey);
  db.prepare('UPDATE mmo_craft_mats SET quantity=quantity+? WHERE guildId=? AND userId=? AND matKey=?').run(qty, gid, uid, matKey);
}
function getCraftMats(gid, uid) {
  return db.prepare('SELECT matKey,quantity FROM mmo_craft_mats WHERE guildId=? AND userId=? AND quantity>0').all(gid, uid);
}
function consumeCraftMat(gid, uid, matKey, qty) {
  const r = db.prepare('SELECT quantity FROM mmo_craft_mats WHERE guildId=? AND userId=? AND matKey=?').get(gid, uid, matKey);
  if (!r || r.quantity < qty) return false;
  db.prepare('UPDATE mmo_craft_mats SET quantity=quantity-? WHERE guildId=? AND userId=? AND matKey=?').run(qty, gid, uid, matKey);
  return true;
}
function hasCraftMats(gid, uid, recipe) {
  for (const [mat, qty] of Object.entries(recipe)) {
    const r = db.prepare('SELECT quantity FROM mmo_craft_mats WHERE guildId=? AND userId=? AND matKey=?').get(gid, uid, mat);
    if (!r || r.quantity < qty) return false;
  }
  return true;
}
function spendCraftMats(gid, uid, recipe) {
  for (const [mat, qty] of Object.entries(recipe)) consumeCraftMat(gid, uid, mat, qty);
}

// ─────────────────────────────────────────────────────────────────────────
//  VERİTABANI YARDIMCILARI — Silah & Zırh
// ─────────────────────────────────────────────────────────────────────────
function addWeapon(gid, uid, weaponKey) {
  return db.prepare('INSERT INTO mmo_weapons(guildId,userId,weaponKey,enhancement)VALUES(?,?,?,0)').run(gid, uid, weaponKey).lastInsertRowid;
}
function addArmor(gid, uid, armorKey, slot) {
  return db.prepare('INSERT INTO mmo_armors(guildId,userId,armorKey,slot,enhancement)VALUES(?,?,?,?,0)').run(gid, uid, armorKey, slot).lastInsertRowid;
}
function getWeapons(gid, uid) {
  return db.prepare('SELECT * FROM mmo_weapons WHERE guildId=? AND userId=?').all(gid, uid);
}
function getArmors(gid, uid) {
  return db.prepare('SELECT * FROM mmo_armors WHERE guildId=? AND userId=?').all(gid, uid);
}
function enhanceItem(gid, uid, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND guildId=? AND userId=?`).get(id, gid, uid);
  if (!row) return { ok: false, reason: 'notfound' };
  if (row.enhancement >= 10) return { ok: false, reason: 'max' };
  const enh = row.enhancement;
  const coinCost = ENHANCEMENT_COIN_COST[enh];
  const bal = getBalance(gid, uid);
  if (bal.balance < coinCost) return { ok: false, reason: 'coin', cost: coinCost };

  // Craft malzeme gereksinimleri (fail veya success durumda)
  if (!hasCraftMats(gid, uid, ENHANCEMENT_MAT_COST)) {
    return { ok: false, reason: 'mats' };
  }

  // +5'ten sonra ayrıca gelişmiş (yalnızca craftlanan) malzeme de gerekir
  const advReq = getAdvancedEnhanceRequirement(enh);
  if (advReq && !hasCraftMats(gid, uid, advReq)) {
    return { ok: false, reason: 'advmats', advReq };
  }

  addBalance(gid, uid, -coinCost);
  spendCraftMats(gid, uid, ENHANCEMENT_MAT_COST);
  if (advReq) spendCraftMats(gid, uid, advReq);

  const successRate = ENHANCEMENT_SUCCESS_RATES[enh];
  const success = Math.random() * 100 < successRate;
  if (success) {
    db.prepare(`UPDATE ${table} SET enhancement=enhancement+1 WHERE id=?`).run(id);
    return { ok: true, success: true, newEnh: enh + 1, cost: coinCost, advReq };
  }
  // Başarısız — eşya kırılmaz, coin + mat gitti (zaten harcandı)
  return { ok: true, success: false, enh, cost: coinCost, advReq };
}

// ─────────────────────────────────────────────────────────────────────────
//  VERİTABANI YARDIMCILARI — Slot Makinesi
// ─────────────────────────────────────────────────────────────────────────
function getSlotPlays(gid, uid) {
  const date = todayTR();
  const r = db.prepare('SELECT plays FROM mmo_slot_daily WHERE guildId=? AND userId=? AND date=?').get(gid, uid, date);
  return r ? r.plays : 0;
}
function incSlotPlays(gid, uid) {
  const date = todayTR();
  db.prepare('INSERT OR IGNORE INTO mmo_slot_daily(guildId,userId,date,plays)VALUES(?,?,?,0)').run(gid, uid, date);
  db.prepare('UPDATE mmo_slot_daily SET plays=plays+1 WHERE guildId=? AND userId=? AND date=?').run(gid, uid, date);
}

// ─────────────────────────────────────────────────────────────────────────
//  VERİTABANI YARDIMCILARI — Zindan Cooldown
// ─────────────────────────────────────────────────────────────────────────
function getDungeonCd(gid, uid, dungeonKey) {
  const r = db.prepare('SELECT lastEnter FROM mmo_dungeon_cd WHERE guildId=? AND userId=? AND dungeonKey=?').get(gid, uid, dungeonKey);
  return r ? r.lastEnter : 0;
}
function setDungeonCd(gid, uid, dungeonKey) {
  db.prepare('INSERT OR REPLACE INTO mmo_dungeon_cd(guildId,userId,dungeonKey,lastEnter)VALUES(?,?,?,?)').run(gid, uid, dungeonKey, Date.now());
}

// ─────────────────────────────────────────────────────────────────────────
//  RELIC SET KUŞANMA (aynı anda max RELIC_SET_MAX_EQUIPPED set)
// ─────────────────────────────────────────────────────────────────────────
function getEquippedRelicSets(gid, uid) {
  return db.prepare('SELECT setKey FROM active_relic_sets WHERE guildId=? AND userId=?').all(gid, uid).map(r => r.setKey);
}
function equipRelicSet(gid, uid, setKey) {
  const def = RELIC_SETS[setKey];
  if (!def) return { ok: false, reason: 'invalid' };
  // Sınıfa özel setler (örn. Büyücü relic setleri) yalnızca o sınıfı seçmiş
  // oyuncular tarafından kuşanılabilir. Parça sahipliği herkese açıktır,
  // kısıtlama sadece bonusun aktifleşmesi (kuşanma) aşamasında uygulanır.
  if (def.classKey && getPlayerClass(gid, uid) !== def.classKey) {
    return { ok: false, reason: 'class', requiredClass: def.classKey };
  }
  const equipped = getEquippedRelicSets(gid, uid);
  if (equipped.includes(setKey)) return { ok: false, reason: 'already' };
  if (equipped.length >= RELIC_SET_MAX_EQUIPPED) return { ok: false, reason: 'full', max: RELIC_SET_MAX_EQUIPPED };
  db.prepare('INSERT OR IGNORE INTO active_relic_sets(guildId,userId,setKey)VALUES(?,?,?)').run(gid, uid, setKey);
  return { ok: true };
}
function unequipRelicSet(gid, uid, setKey) {
  db.prepare('DELETE FROM active_relic_sets WHERE guildId=? AND userId=? AND setKey=?').run(gid, uid, setKey);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
//  RELIC SET BONUS HESAPLAMA
// ─────────────────────────────────────────────────────────────────────────
function getRelicSetBonuses(gid, uid) {
  const ownedKeys    = getRelics(gid, uid);
  const equippedSets = getEquippedRelicSets(gid, uid);
  const result = {};
  for (const [setKey, setDef] of Object.entries(RELIC_SETS)) {
    const count      = setDef.pieces.filter(p => ownedKeys.includes(p.key)).length;
    const isEquipped = equippedSets.includes(setKey);
    result[setKey] = { count, total: setDef.pieces.length, equipped: isEquipped };
    // Parça sahipliği ilerlemesi her zaman gösterilir, ama bonus SADECE
    // kuşanılmış (max 2) setler için hesaba katılır.
    if (!isEquipped) { result[setKey].bonus = 'none'; continue; }
    if (count >= setDef.pieces.length) result[setKey].bonus = 'full';
    else if (count >= 4) result[setKey].bonus = '4piece';
    else if (count >= 2) result[setKey].bonus = '2piece';
    else result[setKey].bonus = 'none';
  }
  return result;
}

function getRelicSetCoinBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.coinPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.coinPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.coinPct || 0;
  }
  return total;
}
function getRelicSetXpBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.xpPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.xpPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.xpPct || 0;
  }
  return total;
}
function getRelicSetDailyBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.dailyPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.dailyPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.dailyPct || 0;
  }
  return total;
}
function getRelicSetFishBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.fishPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.fishPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.fishPct || 0;
  }
  return total;
}
// Şövalye/Nişancı/Büyücü'nün class-locked SSS/S/A/B setleri — tam set (6/6)
// kuşanıldığında /fight simülasyonuna hareket hızı, fiziksel direnç veya
// büyü direnci katkısı sağlar (bkz. buildCombatant()).
function getRelicSetCombatBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let speedPct = 0, physResistPct = 0, magicResistPct = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    if (info.bonus !== 'full') continue; // bu üç stat yalnızca TAM SET'te açılıyor
    const def = RELIC_SETS[setKey];
    speedPct       += def.bonusFull.speedPct || 0;
    physResistPct  += def.bonusFull.physResistPct || 0;
    magicResistPct += def.bonusFull.magicResistPct || 0;
  }
  return { speedPct, physResistPct, magicResistPct };
}
// Gölge Seti — Hırsızlık başarı bonusu (/çal ve /oyunlar cal içinde kullanılır)
function getRelicSetStealBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.stealPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.stealPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.stealPct || 0;
  }
  return total;
}
// Gölge Seti — Madencilik satış bonusu (mine_sell içinde kullanılır)
function getRelicSetMineBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.minePct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.minePct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.minePct || 0;
  }
  return total;
}
// Gölge Seti (full) — Zindan nadir drop (relic parçası / antika) şansı bonusu
function getRelicSetBossBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.bossPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.bossPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.bossPct || 0;
  }
  return total;
}
// Güneş Seti — Odunculuk satış bonusu (wood_sell içinde kullanılır)
function getRelicSetWoodBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.woodPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.woodPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.woodPct || 0;
  }
  return total;
}
// Güneş Seti (full) — Pet XP bonusunu güçlendirir (getPetXpBonus içinde kullanılır)
function getRelicSetPetXpBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.petXpPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.petXpPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.petXpPct || 0;
  }
  return total;
}
// Fırtına Seti — Zindan kritik şansı (enterDungeon içinde kullanılır)
function getRelicSetCritBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.critPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.critPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.critPct || 0;
  }
  return total;
}
// Fırtına Seti (full) — /slot ekstra kazanç bonusu (sabit %15 yerine RELIC_SETS'ten okunur)
function getRelicSetSlotBonus(gid, uid) {
  const bonuses = getRelicSetBonuses(gid, uid);
  let total = 0;
  for (const [setKey, info] of Object.entries(bonuses)) {
    const def = RELIC_SETS[setKey];
    if (info.bonus === 'full')    total += def.bonusFull.slotPct || 0;
    else if (info.bonus === '4piece') total += def.bonus4.slotPct || 0;
    else if (info.bonus === '2piece') total += def.bonus2.slotPct || 0;
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────
//  ZINDAN GİRİŞ MANTAĞI
// ─────────────────────────────────────────────────────────────────────────
function enterDungeon(gid, uid, dungeonKey) {
  const dungeon = DUNGEONS.find(d => d.key === dungeonKey);
  if (!dungeon) return { ok: false, reason: 'invalid' };

  const rpg = getRpgData(gid, uid);
  if (rpg.rpgLevel < dungeon.minLevel) {
    return { ok: false, reason: 'level', required: dungeon.minLevel, current: rpg.rpgLevel };
  }

  const lastEnter = getDungeonCd(gid, uid, dungeonKey);
  const remaining = dungeon.cd - (Date.now() - lastEnter);
  if (remaining > 0) return { ok: false, reason: 'cd', remaining };

  setDungeonCd(gid, uid, dungeonKey);

  // Zorluk / başarı şansı — RPG statlarının toplam gücüne göre belirlenir
  const playerPower   = getRpgPowerScore(gid, uid) + getSimplePetDungeonBonus(gid, uid);
  const successChance = getDungeonSuccessChance(gid, uid, dungeon);
  const isSuccess      = Math.random() * 100 < successChance;

  // Ödülleri hesapla
  const [xpMin, xpMax] = dungeon.xpReward;
  const [coinMin, coinMax] = dungeon.coinReward;
  const baseXp   = Math.floor(Math.random() * (xpMax - xpMin + 1)) + xpMin;
  const baseCoin = Math.floor(Math.random() * (coinMax - coinMin + 1)) + coinMin;

  // Relic set bonus uygula
  const setXpBonus   = getRelicSetXpBonus(gid, uid);
  const setCoinBonus = getRelicSetCoinBonus(gid, uid);

  // Zindan bonus (Lav full set = +%25 dungeon coin, Buz full set = +%25 dungeon XP)
  const relicBonuses = getRelicSetBonuses(gid, uid);
  let extraCoinPct = 0, extraXpPct = 0;
  if (relicBonuses.lav?.bonus === 'full') extraCoinPct += RELIC_SETS.lav.bonusFull.dungeonCoinPct || 0;
  if (relicBonuses.buz?.bonus === 'full') extraXpPct   += RELIC_SETS.buz.bonusFull.dungeonXpPct  || 0;

  if (!isSuccess) {
    // Başarısız — coin/drop yok, sadece küçük bir tecrübe XP'si (set XP bonusu yine geçerli, kritik yok)
    const failXp = Math.round(baseXp * DUNGEON_FAIL_XP_PCT * (1 + (setXpBonus + extraXpPct) / 100));
    const { leveled, newLevel } = addRpgXp(gid, uid, failXp);
    return {
      ok: true,
      success: false,
      dungeon,
      xp: failXp,
      coin: 0,
      leveled,
      newLevel,
      drops: [],
      rpgLevel: rpg.rpgLevel,
      isCrit: false,
      successChance,
      playerPower,
      requiredPower: dungeon.requiredPower,
    };
  }

  // Fırtına Seti — Zindan/boss kritik şansı: critPct ihtimalle ödüller %50 artar
  const critChancePct = getRelicSetCritBonus(gid, uid);
  const isCrit = critChancePct > 0 && Math.random() * 100 < critChancePct;
  const critMultiplier = isCrit ? 1.5 : 1;

  const finalXp   = Math.round(baseXp   * (1 + (setXpBonus   + extraXpPct)   / 100) * critMultiplier);
  const finalCoin = Math.round(baseCoin * (1 + (setCoinBonus  + extraCoinPct) / 100) * critMultiplier);

  addBalance(gid, uid, finalCoin);
  const { leveled, newLevel } = addRpgXp(gid, uid, finalXp);

  // Gölge Seti — Boss drop bonusu: nadir düşme (relic parçası / antika) şansını artırır
  const bossDropBonusPct = getRelicSetBossBonus(gid, uid);
  const bossDropMultiplier = 1 + bossDropBonusPct / 100;

  // Ekstra drop şansı
  const drops = [];

  // Craft malzeme drop (%60)
  if (Math.random() < 0.60) {
    const matKey = dungeon.matPool[Math.floor(Math.random() * dungeon.matPool.length)];
    const matQty = Math.floor(Math.random() * 3) + 1;
    addCraftMat(gid, uid, matKey, matQty);
    const matDef = CRAFT_MATERIALS.find(m => m.key === matKey);
    drops.push(`${matDef?.emoji || '🔩'} **${matDef?.name || matKey}** x${matQty}`);
  }

  // Pet yumurtası drop (%15)
  if (Math.random() < 0.15) {
    const eggTierByLevel = rpg.rpgLevel >= 35 ? 'altin' : rpg.rpgLevel >= 20 ? 'nadir' : 'siradan';
    addEgg(gid, uid, eggTierByLevel, 1);
    const eggDef = PET_EGG_TYPES.find(e => e.key === eggTierByLevel);
    drops.push(`${eggDef?.emoji || '🥚'} **${eggDef?.name || eggTierByLevel}** açıldı!`);
  }

  // Sandık drop (%10)
  if (Math.random() < 0.10) {
    const chestTier = rpg.rpgLevel >= 45 ? 'elmas' : rpg.rpgLevel >= 35 ? 'altin' : rpg.rpgLevel >= 20 ? 'demir' : 'ahsap';
    addChest(gid, uid, chestTier, 1);
    const chestDef = MMORPG_CHESTS.find(c => c.key === chestTier);
    drops.push(`${chestDef?.emoji || '📦'} **${chestDef?.name}** kazandın!`);
  }

  // Relic parçası drop (%5, Gölge Seti (full) bossPct ile artar)
  if (Math.random() < 0.05 * bossDropMultiplier) {
    const allPieces = Object.values(RELIC_SETS).flatMap(s => s.pieces.map(p => p.key));
    const picked = allPieces[Math.floor(Math.random() * allPieces.length)];
    if (!hasRelic(gid, uid, picked)) {
      buyRelic(gid, uid, picked);
      const pieceDef = ALL_NEW_RELIC_PIECES.find(p => p.key === picked);
      drops.push(`${pieceDef?.emoji || '💎'} **Relic:** ${pieceDef?.name || picked}`);
    }
  }

  // Antika drop (%5, Gölge Seti (full) bossPct ile artar)
  if (Math.random() < 0.05 * bossDropMultiplier) {
    const a = ANTIQUES[Math.floor(Math.random() * ANTIQUES.length)];
    addAntique(gid, uid, a.key);
    drops.push(`${a.emoji} **Antika:** ${a.name}`);
  }

  return {
    ok: true,
    success: true,
    dungeon,
    xp: finalXp,
    coin: finalCoin,
    leveled,
    newLevel,
    drops,
    rpgLevel: rpg.rpgLevel,
    isCrit,
    successChance,
    playerPower,
    requiredPower: dungeon.requiredPower,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  SLASH KOMUTLAR — MMORPG
// ─────────────────────────────────────────────────────────────────────────
const MMORPG_SLASH_COMMANDS = [
  // /rpg — RPG profil
  new SlashCommandBuilder()
    .setName('rpg')
    .setDescription('RPG profilini ve statlarını gör')
    .addUserOption(o => o.setName('hedef').setDescription('Kullanıcı (boş=kendin)')),

  // /stat — stat yükselt
  new SlashCommandBuilder()
    .setName('stat')
    .setDescription('RPG statlarını coin ile yükselt'),

  // /sinif — savaş yolu (sınıf) seç
  new SlashCommandBuilder()
    .setName('sinif')
    .setDescription('Savaş yolunu (sınıfını) seç — Şövalye, Nişancı veya Büyücü')
    .addStringOption(o => o.setName('sinif').setDescription('Seçmek istediğin sınıf').setRequired(true)
      .addChoices(
        { name: '⚔️ Şövalye (Kılıç/Tırpan • Güç-Savunma-Can)', value: 'sovalye' },
        { name: '🏹 Nişancı (Yay/Hançer • Kritik-Hız)',        value: 'nisanci' },
        { name: '🪄 Büyücü (Asa • Büyücülük-Mana)',            value: 'buyucu'  },
      )),

  // /statsifirla — statları sıfırla, coin iade et, sınıfı da temizle
  new SlashCommandBuilder()
    .setName('statsifirla')
    .setDescription('Tüm statlarını sıfırlar, harcadığın coini iade eder ve yeniden sınıf seçmeni sağlar'),

  // /zindan — zindan gir
  new SlashCommandBuilder()
    .setName('zindan')
    .setDescription('Zindana gir ve ödül kazan')
    .addStringOption(o => o
      .setName('zindan')
      .setDescription('Girmek istediğin zindan')
      .setRequired(true)
      .addChoices(
        ...DUNGEONS.map(d => ({ name: `${d.emoji} ${d.name} (Lv.${d.minLevel}+, Önerilen Güç: ${d.requiredPower})`, value: d.key }))
      )),

  // /fight — oyuncular arası düello
  new SlashCommandBuilder()
    .setName('fight')
    .setDescription('Başka bir oyuncuya düello teklif et')
    .addUserOption(o => o.setName('rakip').setDescription('Meydan okumak istediğin oyuncu').setRequired(true)),

  // /envanter — sekmeli envanter
  new SlashCommandBuilder()
    .setName('envanter')
    .setDescription('Tüm eşyalarını sekmeli olarak gör'),

  // /sandik ac — sandık aç
  new SlashCommandBuilder()
    .setName('sandik')
    .setDescription('Sandık yönetimi')
    .addSubcommand(s => s
      .setName('ac')
      .setDescription('Sandık aç')
      .addStringOption(o => o
        .setName('tur')
        .setDescription('Sandık türü')
        .setRequired(true)
        .addChoices(...MMORPG_CHESTS.map(c => ({ name: `${c.emoji} ${c.name}`, value: c.key }))))),

  // /yumurta ac — yumurta aç
  new SlashCommandBuilder()
    .setName('yumurta')
    .setDescription('Yumurta yönetimi')
    .addSubcommand(s => s
      .setName('ac')
      .setDescription('Pet yumurtası aç')
      .addStringOption(o => o
        .setName('tur')
        .setDescription('Yumurta türü')
        .setRequired(true)
        .addChoices(...PET_EGG_TYPES.map(e => ({ name: `${e.emoji} ${e.name}`, value: e.key }))))),

  // /craft — craft yap
  new SlashCommandBuilder()
    .setName('craft')
    .setDescription('Craft sistemi — silah, zırh ve diğer eşyaları üret')
    .addStringOption(o => o
      .setName('kategori')
      .setDescription('Craft kategorisi')
      .setRequired(true)
      .addChoices(
        { name: '⚔️ Silah', value: 'silah' },
        { name: '🛡️ Zırh',  value: 'zirh'  },
        { name: '🥚 Yumurta', value: 'yumurta' },
        { name: '📦 Sandık',  value: 'sandik'  },
        { name: '🌀 Gelişmiş Malzeme', value: 'malzeme' },
        { name: '💎 Relic Seti (Tam Set)', value: 'set' },
      ))
    .addStringOption(o => o.setName('item').setDescription('Üretilecek eşya').setRequired(true).setAutocomplete(true)),

  // /yukselt — ekipman güçlendirme
  new SlashCommandBuilder()
    .setName('yukselt')
    .setDescription('Silah veya zırh güçlendir (+0 → +10)')
    .addStringOption(o => o
      .setName('tur')
      .setDescription('Silah mı, zırh mı?')
      .setRequired(true)
      .addChoices({ name: '⚔️ Silah', value: 'silah' }, { name: '🛡️ Zırh', value: 'zirh' }))
    .addIntegerOption(o => o.setName('id').setDescription('Eşya ID (envanter\'den öğren)').setRequired(true).setMinValue(1)),

  // /slot — slot makinesi
  new SlashCommandBuilder()
    .setName('slot')
    .setDescription(`Slot makinesi oyna (günlük max ${SLOT_MAX_DAILY} kez)`)
    .addIntegerOption(o => o.setName('bahis').setDescription('Bahis miktarı (min 50, max 5000)').setRequired(true).setMinValue(50).setMaxValue(5000)),

  // /relic-set — yeni relic set görüntüle
  new SlashCommandBuilder()
    .setName('relic-set')
    .setDescription('Yeni Relic setlerini ve bonuslarını gör')
    .addStringOption(o => o
      .setName('set')
      .setDescription('Set (boş=hepsi)')
      .setAutocomplete(true)),

  // /rpg-pet — MMORPG pet yönetimi
  new SlashCommandBuilder()
    .setName('rpg-pet')
    .setDescription('MMORPG pet yönetimi')
    .addSubcommand(s => s.setName('liste').setDescription('Tüm petlerini gör'))
    .addSubcommand(s => s
      .setName('kusan')
      .setDescription('Pet slotuna kuşan')
      .addStringOption(o => o.setName('pet').setDescription('Kuşanılacak pet').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('slot').setDescription('Slot (1-6)').setRequired(true).setMinValue(1).setMaxValue(6)))
    .addSubcommand(s => s
      .setName('cikar')
      .setDescription('Pet slotundan çıkar')
      .addIntegerOption(o => o.setName('slot').setDescription('Slot (1-6)').setRequired(true).setMinValue(1).setMaxValue(6)))
    .addSubcommand(s => s
      .setName('yukselt')
      .setDescription('Pet seviye yükselt')
      .addStringOption(o => o.setName('pet').setDescription('Yükseltilecek pet').setRequired(true).setAutocomplete(true))),

  // /parcala — silah/zırh/gelişmiş malzemeyi geri harcanan malzemenin %70'i karşılığında bozar
  new SlashCommandBuilder()
    .setName('parcala')
    .setDescription('Craftlanmış eşyayı boz — harcanan malzemenin %70\'i geri iade edilir')
    .addSubcommand(s => s
      .setName('silah')
      .setDescription('Bir silahı boz (%70 malzeme iadesi)')
      .addIntegerOption(o => o.setName('id').setDescription('Silah ID (/envanter ile öğren)').setRequired(true)))
    .addSubcommand(s => s
      .setName('zirh')
      .setDescription('Bir zırhı boz (%70 malzeme iadesi)')
      .addIntegerOption(o => o.setName('id').setDescription('Zırh ID (/envanter ile öğren)').setRequired(true)))
    .addSubcommand(s => s
      .setName('gelismis-malzeme')
      .setDescription('Craftladığın gelişmiş bir malzemeyi boz (%70 iade)')
      .addStringOption(o => o.setName('anahtar').setDescription('Gelişmiş malzeme').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('miktar').setDescription('Bozulacak adet (varsayılan 1)').setMinValue(1))),
].map(c => c.toJSON());

// MMORPG komutlarını ana listeye ekle (tanım yukarıda yapıldıktan sonra push)
SLASH_COMMANDS.push(...MMORPG_SLASH_COMMANDS);

const MMO_CMDS = new Set([
  'rpg', 'stat', 'sinif', 'statsifirla', 'zindan', 'envanter', 'sandik', 'yumurta',
  'craft', 'yukselt', 'slot', 'relic-set', 'rpg-pet', 'fight', 'parcala',
]);

// ─────────────────────────────────────────────────────────────────────────
//  ANA MMORPG KOMUT HANDLER
// ─────────────────────────────────────────────────────────────────────────
async function handleMMOCommand(interaction, cmd, sub, gid, uid) {
  // Kanal kısıtlaması (owner'lar hariç)
  if (interaction.channelId !== GAME_CHANNEL_ID && !hasOwnerAccess(uid, interaction.member)) {
    return interaction.reply({ ephemeral: true, content: `⛔ Bu komutu yalnızca <#${GAME_CHANNEL_ID}> kanalında kullanabilirsin.` });
  }

  // ── /rpg ─────────────────────────────────────────────────────────────
  if (cmd === 'rpg') {
    const target = interaction.options.getUser('hedef') || interaction.user;
    const tgid   = gid;
    const tuid   = target.id;
    const rpg    = getRpgData(tgid, tuid);
    const stats  = getRpgStats(tgid, tuid);
    const sets   = getRelicSetBonuses(tgid, tuid);
    const activePets = getMmoActivePets(tgid, tuid);

    const xpBar = buildBar(rpg.rpgXp, getRpgXpNeeded(rpg.rpgLevel), 10);
    const power = getRpgPowerScore(tgid, tuid);
    const statLines = RPG_STAT_KEYS.map(k => {
      const info = RPG_STAT_NAMES[k];
      return `${info.emoji} **${info.name}:** Lv.${stats[k] || 1}`;
    }).join('\n') + `\n\n⚔️ **Toplam Güç:** ${power} / 350`;

    const setLines = Object.entries(sets).map(([key, info]) => {
      const def = RELIC_SETS[key];
      const bar = '🟩'.repeat(info.count) + '⬜'.repeat(info.total - info.count);
      return `${def.emoji} **${def.name}:** ${bar} (${info.count}/${info.total})${info.equipped ? ' 🟢' : ''}`;
    }).join('\n');

    const petLines = activePets.length
      ? activePets.map(ap => {
          const def = MMORPG_PETS.find(p => p.key === ap.petKey);
          const lv  = db.prepare('SELECT level FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?').get(tgid, tuid, ap.petKey, ap.petHatchedAt);
          return `**[${ap.slot}]** ${def?.emoji || '?'} ${def?.name || ap.petKey} Lv.${lv?.level || 1}`;
        }).join('\n')
      : '*Pet kuşanılmamış*';

    const bp = getBattlePower(tgid, tuid);
    const battlePowerLine = `**${bp.total}** ⚔️\nSeviye:${bp.levelPower} Stat:${bp.statPower} Relic:${bp.relicPower} Silah:${bp.weaponPower} Zırh:${bp.armorPower}`;
    const tCls = getPlayerClass(tgid, tuid);
    const classDef = tCls ? RPG_CLASSES.find(c => c.key === tCls) : null;
    const classLine = classDef ? `${classDef.emoji} **${classDef.name}**` : '❌ Seçilmedi *(`/sinif` ile seç)*';

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ ${target.username} — RPG Profili`)
      .setThumbnail(target.displayAvatarURL())
      .setColor(0x5865F2)
      .addFields(
        { name: '🧭 Sınıf', value: classLine, inline: false },
        { name: '🏆 RPG Seviyesi', value: `**Lv.${rpg.rpgLevel}** / ${RPG_MAX_LEVEL}\n${xpBar}\n${rpg.rpgXp} / ${getRpgXpNeeded(rpg.rpgLevel)} XP`, inline: false },
        { name: '📊 Statlar', value: statLines, inline: true },
        { name: '💎 Relic Setleri', value: setLines || '—', inline: true },
        { name: `🐉 Aktif Petler (${activePets.length}/${MMO_PET_MAX_ACTIVE})`, value: petLines, inline: false },
        { name: '🥊 Toplam Dövüş Gücü (/fight)', value: battlePowerLine, inline: false },
      )
      .setFooter({ text: '/stat ile stat yükselt (Gücünü artırır) • /rpg-pet ile pet kuşan • /zindan ile XP kazan' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /stat ─────────────────────────────────────────────────────────────
  if (cmd === 'stat') {
    return showStatPanel(interaction, gid, uid);
  }

  // ── /sinif ────────────────────────────────────────────────────────────
  if (cmd === 'sinif') {
    const secim = interaction.options.getString('sinif');
    const cur   = getPlayerClass(gid, uid);
    if (cur) {
      const curDef = RPG_CLASSES.find(c => c.key === cur);
      return interaction.reply({ ephemeral: true, content: `⛔ Zaten **${curDef.emoji} ${curDef.name}** yolunu seçtin! Değiştirmek için \`/statsifirla\` kullanmalısın (statların sıfırlanır, coin iade edilir, sınıf tekrar seçilebilir hale gelir).` });
    }
    setPlayerClass(gid, uid, secim);
    const def = RPG_CLASSES.find(c => c.key === secim);
    return interaction.reply({ content: `✅ **${def.emoji} ${def.name}** yolunu seçtin!\nArtık yalnızca bu sınıfa uygun silah/zırh craftlayabilir ve bu sınıfa uygun petler kuşanabilirsin.\n📊 Kilitli statlar: ${def.stats.map(s => `${RPG_STAT_NAMES[s].emoji} ${RPG_STAT_NAMES[s].name}`).join(', ')}` });
  }

  // ── /statsifirla ──────────────────────────────────────────────────────
  if (cmd === 'statsifirla') {
    const refund = calcStatRefundTotal(gid, uid);
    resetRpgStats(gid, uid);
    clearPlayerClass(gid, uid);
    if (refund > 0) addBalance(gid, uid, refund);
    return interaction.reply({ content: `♻️ **Statların sıfırlandı** ve sınıf seçimin kaldırıldı!\n💰 **+${refund} coin** iade edildi. Bakiye: **${getBalance(gid, uid).balance}**\n🧭 \`/sinif\` ile yeniden yol seç (Şövalye ⚔️ / Nişancı 🏹 / Büyücü 🪄).` });
  }

  // ── /zindan ───────────────────────────────────────────────────────────
  if (cmd === 'zindan') {
    const dungeonKey = interaction.options.getString('zindan');
    const result = enterDungeon(gid, uid, dungeonKey);

    if (!result.ok) {
      if (result.reason === 'invalid') return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz zindan.' });
      if (result.reason === 'level') {
        return interaction.reply({ ephemeral: true, content: `⛔ Bu zindan için minimum **RPG Lv.${result.required}** gerekiyor! (Şu an: Lv.${result.current})` });
      }
      if (result.reason === 'cd') {
        const min = Math.ceil(result.remaining / 60000);
        return interaction.reply({ ephemeral: true, content: `⏳ Bu zindana girmek için **${min} dakika** beklemelisin!` });
      }
    }

    const { dungeon, xp, coin, leveled, newLevel, drops, isCrit, success, successChance, playerPower, requiredPower } = result;
    const powerLine = `⚔️ Gücün: **${playerPower}** / Önerilen: **${requiredPower}** • 🎲 Başarı şansı: **%${successChance}**`;

    // Zindan hesaplanırken bot birkaç saniye "düşünsün"
    await interaction.reply(`${dungeon.emoji} **${dungeon.name}**'a giriliyor... Hesaplanıyor...`);
    await new Promise(res => setTimeout(res, 4000));

    // ── OwO tarzı görsel zindan savaş ekranı ───────────────────
    const { petLines, enemyLines } = buildDungeonResultVisual(gid, uid, dungeon, success);
    const dungeonEnemyList = (DUNGEON_ENEMIES[dungeon.key] || []).slice(0, 2);
    const enemyLabel = dungeonEnemyList.length
      ? `${dungeon.emoji} ${dungeon.name} Düşmanları`
      : `${dungeon.emoji} ${dungeon.name}`;
    const { power: petPowerVal, pets: dungPets } = getMmoPetBattlePower(gid, uid);
    const petPowerNote = petPowerVal > 0
      ? `🐾 Petlerin **+${petPowerVal}** güç ve **+${Math.min(Math.round(petPowerVal*0.4),30)}** başarı şansı katkısı sağladı!`
      : '💡 `/rpg-pet` ile pet kuşan → zindan başarı şansını artır!';

    const embed = new EmbedBuilder()
      .setTitle(success
        ? `${dungeon.emoji} ${dungeon.name} — ${isCrit ? '⚡ KRİTİK ZAFER!' : 'Tamamlandı!'}`
        : `${dungeon.emoji} ${dungeon.name} — ❌ YENİLDİN!`)
      .setColor(success ? dungeon.color : 0x992D22)
      .setDescription(
        (success
          ? (isCrit ? '⚡ **Fırtına Seti kritik vuruş yaptı!** Ödüller %50 arttı!' : 'Zindanı başarıyla geçtin!')
          : 'Zindan seni yendi — coin ve eşya kazanamadın, sadece küçük bir tecrübe aldın.') +
        `\n\n${petPowerNote}`
      )
      .addFields(
        {
          name: `👤 Senin Petlerin${dungPets.length ? ` (${dungPets.length} aktif)` : ''}`,
          value: petLines,
          inline: true,
        },
        {
          name: '\u200b',
          value: success ? '⚔️\n**vs**\n✅' : '⚔️\n**vs**\n❌',
          inline: true,
        },
        {
          name: enemyLabel,
          value: enemyLines,
          inline: true,
        },
        { name: '💰 Coin',   value: success ? `+**${coin}** coin` : '~~+coin~~ (başarısız)', inline: true },
        { name: '✨ RPG XP', value: `+**${xp}** XP`, inline: true },
        { name: '🕐 Tekrar', value: `${Math.round(dungeon.cd / 60000)} dakika sonra`, inline: true },
      );

    if (success && drops.length > 0) {
      embed.addFields({ name: '🎁 Ekstra Düşme!', value: drops.join('\n'), inline: false });
    }
    if (leveled) {
      embed.addFields({ name: '🎉 RPG SEVİYE ATLADINIZ!', value: `Yeni RPG Seviyeniz: **Lv.${newLevel}**`, inline: false });
    }
    embed.setFooter({ text: powerLine });

    return interaction.editReply({ content: null, embeds: [embed] });
  }

  // ── /fight ────────────────────────────────────────────────────────────
  if (cmd === 'fight') {
    const opponent = interaction.options.getUser('rakip');
    if (opponent.id === uid) return interaction.reply({ ephemeral: true, content: '⛔ Kendinle düello yapamazsın.' });
    if (opponent.bot)        return interaction.reply({ ephemeral: true, content: '⛔ Bir bot ile düello yapamazsın.' });

    const lastFight = getFightCd(gid, uid);
    const remaining = FIGHT_COOLDOWN_MS - (Date.now() - lastFight);
    if (remaining > 0) {
      const min = Math.ceil(remaining / 60000);
      return interaction.reply({ ephemeral: true, content: `⏳ Tekrar düello teklif etmek için **${min} dakika** beklemelisin.` });
    }

    const base      = `fight_${Date.now()}_${uid}`;
    const acceptId  = `${base}_accept`;
    const declineId = `${base}_decline`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(acceptId).setLabel('Kabul Et').setEmoji('⚔️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(declineId).setLabel('Reddet').setEmoji('🏳️').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: `⚔️ ${opponent}, **${interaction.user.username}** sana düello teklif ediyor! 60 saniye içinde kabul et ya da reddet.`,
      components: [row],
    });
    const msg = await interaction.fetchReply();
    const coll = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
    // NOT: Süre dolduğunda mesajın "kabul et/reddet" haliyle takılı kalmaması için
    // `collected.size === 0` kontrolüne güvenmiyoruz — rakip olmayan biri butona
    // basarsa bile bu koleksiyona ekleniyordu, bu yüzden zaman aşımı hiç
    // tetiklenmiyordu. Bunun yerine düellonun gerçekten çözülüp çözülmediğini
    // ayrı bir bayrakla (`resolvedFlag`) takip ediyoruz.
    let resolvedFlag = false;

    coll.on('collect', async i => {
      if (i.user.id !== opponent.id) {
        return i.reply({ ephemeral: true, content: '⛔ Bu düello teklifi sana ait değil.' });
      }
      resolvedFlag = true;
      coll.stop('resolved');

      if (i.customId === declineId) {
        return i.update({ content: `🏳️ **${opponent.username}** düelloyu reddetti.`, components: [] });
      }

      setFightCd(gid, uid);

      // Düello ~10 saniye sürsün — sonucu hemen değil, biraz "hesaplandıktan" sonra göster
      await i.update({ content: `⚔️ **${interaction.user.username}** vs **${opponent.username}** — düello başladı! Hesaplanıyor...`, embeds: [], components: [] });
      const result = resolveFight(gid, uid, opponent.id);
      await new Promise(res => setTimeout(res, 10000));

      const winnerUser  = result.winnerId === uid ? interaction.user : opponent;
      const cp = result.challengerPower;
      const op = result.opponentPower;

      // ── OwO tarzı görsel savaş ekranı ──────────────────────────
      const challWon    = result.winnerId === uid;
      const challVisual = buildFightResultPetVisual(gid, uid, interaction.user.username, challWon);
      const oppVisual   = buildFightResultPetVisual(gid, opponent.id, opponent.username, !challWon);

      const totalPow = (cp.total + op.total) || 1;
      const challBar = Math.round((cp.total / totalPow) * 10);
      const oppBar   = 10 - challBar;
      const powerBar = '🟦'.repeat(challBar) + '🟥'.repeat(oppBar);
      const cpPetNote = (cp.petPower || 0) > 0 ? ` 🐾+${cp.petPower}` : '';
      const opPetNote = (op.petPower || 0) > 0 ? ` 🐾+${op.petPower}` : '';

      const embed = new EmbedBuilder()
        .setTitle(`⚔️ ${interaction.user.username} vs ${opponent.username}`)
        .setColor(challWon ? 0x3498DB : 0xE74C3C)
        .setDescription(
          `🏆 **${winnerUser.username}** kazandı!\n` +
          `**%${result.challengerChance}** ← 🎲 Kazanma Şansı\n` +
          `${powerBar}\n` +
          `⚔️ Güç: **${cp.total}${cpPetNote}** vs **${op.total}${opPetNote}**`
        )
        .addFields(
          {
            name: `${challWon ? '🏆' : '💀'} ${interaction.user.username} — ⚔️ ${cp.total}`,
            value: challVisual,
            inline: true,
          },
          {
            name: '⚔️',
            value: 'vs',
            inline: true,
          },
          {
            name: `${!challWon ? '🏆' : '💀'} ${opponent.username} — ⚔️ ${op.total}`,
            value: oppVisual,
            inline: true,
          },
          {
            name: '📊 Güç Dökümü',
            value: [
              `**${interaction.user.username}:** Lv:${cp.levelPower} Stat:${cp.statPower} Relic:${cp.relicPower} Silah:${cp.weaponPower} Zırh:${cp.armorPower}${cpPetNote}`,
              `**${opponent.username}:** Lv:${op.levelPower} Stat:${op.statPower} Relic:${op.relicPower} Silah:${op.weaponPower} Zırh:${op.armorPower}${opPetNote}`,
            ].join('\n'),
            inline: false,
          },
          {
            name: '💰 Ödül',
            value: result.stolen > 0
              ? `${winnerUser.username} rakibinden **${result.stolen} coin** kazandı!`
              : 'Kaybedenin cebi boştu, coin el değiştirmedi.',
            inline: true,
          },
          {
            name: '✨ XP',
            value: `Kazanan +${result.winXp} XP • Kaybeden +${result.loseXp} XP`,
            inline: true,
          },
          {
            name: '📜 Düello Akışı (round bazlı)',
            value: (result.combatLog && result.combatLog.length ? result.combatLog.join('\n') : '—') +
              `\n❤️ Kalan can: **${interaction.user.username}** ${result.hpA}/${result.maxHpA} — **${opponent.username}** ${result.hpB}/${result.maxHpB}`,
            inline: false,
          },
        )
        .setFooter({ text: 'Petlerini /rpg-pet ile kuşan → Dövüş gücünü artır! 🐾' });

      return i.editReply({ content: null, embeds: [embed], components: [] });
    });

    coll.on('end', (collected, reason) => {
      if (!resolvedFlag) {
        interaction.editReply({ content: '⌛ Düello teklifi zaman aşımına uğradı.', components: [] }).catch(() => {});
      }
    });

    return;
  }

  // ── /envanter ─────────────────────────────────────────────────────────
  if (cmd === 'envanter') {
    return showInventory(interaction, gid, uid, 'genel');
  }

  // ── /sandik ac ────────────────────────────────────────────────────────
  if (cmd === 'sandik' && sub === 'ac') {
    const chestType = interaction.options.getString('tur');
    if (!consumeChest(gid, uid, chestType)) {
      const chestDef = MMORPG_CHESTS.find(c => c.key === chestType);
      return interaction.reply({ ephemeral: true, content: `⛔ Envanterende **${chestDef?.name || chestType}** yok!` });
    }
    const result = openChest(gid, uid, chestType);
    const chestDef = MMORPG_CHESTS.find(c => c.key === chestType);

    const embed = new EmbedBuilder()
      .setTitle(`${chestDef?.emoji} ${chestDef?.name} Açıldı!`)
      .setColor(chestDef?.color || 0xF1C40F)
      .setDescription(buildChestResultDesc(result));

    return interaction.reply({ embeds: [embed] });
  }

  // ── /yumurta ac ───────────────────────────────────────────────────────
  if (cmd === 'yumurta' && sub === 'ac') {
    const eggType = interaction.options.getString('tur');
    const eggDef  = PET_EGG_TYPES.find(e => e.key === eggType);

    const eggs = getEggs(gid, uid);
    const has = eggs.find(e => e.eggType === eggType && e.quantity > 0);
    if (!has) {
      return interaction.reply({ ephemeral: true, content: `⛔ Envanterende **${eggDef?.name || eggType}** yok!` });
    }

    const hatched = hatchEgg(gid, uid, eggType);
    if (!hatched) return interaction.reply({ ephemeral: true, content: '⛔ Bir hata oluştu.' });

    const rarityStars = ['⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];

    // Aynı pet zaten sahipse: ikinci pet oluşturulmadı, Pet Parçası verildi
    if (hatched.duplicate) {
      const embed = new EmbedBuilder()
        .setTitle(`${eggDef?.emoji || '🥚'} Yumurta Açıldı!`)
        .setColor(eggDef?.color || 0xF1C40F)
        .setDescription(`${hatched.emoji} **${hatched.name}** zaten sende vardı! Onun yerine **${hatched.emoji} ${hatched.name} Parçası x${hatched.shardsGiven}** kazandın.\nToplam parça: **${hatched.shardTotal}**\n\nParçalar Lv.6+ pet yükseltmelerinde kullanılır (\`/rpg-pet yukselt\`).`)
        .setFooter({ text: 'Aynı pet tekrar çıkarsa ikinci kopya oluşmaz, otomatik parçaya dönüşür.' });
      return interaction.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setTitle(`${eggDef?.emoji || '🥚'} Yumurta Açıldı!`)
      .setColor(eggDef?.color || 0xF1C40F)
      .addFields(
        { name: '🐾 Pet',      value: `${hatched.emoji} **${hatched.name}**`, inline: true },
        { name: '⭐ Nadirlik', value: rarityStars[hatched.rarity] || '⭐',    inline: true },
        { name: '🎁 Bonus',    value: `${RPG_STAT_NAMES[hatched.bonusType]?.emoji} +${hatched.bonusBase}% ${RPG_STAT_NAMES[hatched.bonusType]?.name}`, inline: true },
      )
      .setDescription(`**${hatched.name}** yumurtadan çıktı! \`/rpg-pet kuşan\` ile slotuna takabilirsin.`)
      .setFooter({ text: `ID: ${hatched.hatchedAt}` });

    return interaction.reply({ embeds: [embed] });
  }

  // ── /craft ────────────────────────────────────────────────────────────
  if (cmd === 'craft') {
    return handleCraftCommand(interaction, gid, uid);
  }

  // ── /yukselt (ekipman) ────────────────────────────────────────────────
  if (cmd === 'yukselt') {
    const tur   = interaction.options.getString('tur');
    const itemId = interaction.options.getInteger('id');
    const table = tur === 'silah' ? 'mmo_weapons' : 'mmo_armors';

    const result = enhanceItem(gid, uid, table, itemId);
    if (!result.ok) {
      if (result.reason === 'notfound') return interaction.reply({ ephemeral: true, content: '⛔ Eşya bulunamadı veya sana ait değil.' });
      if (result.reason === 'max')      return interaction.reply({ ephemeral: true, content: '⛔ Bu eşya zaten +10 (maksimum)!' });
      if (result.reason === 'coin')     return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${result.cost}** coin.` });
      if (result.reason === 'mats')     return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz craft malzemesi!\nGerekli: ${Object.entries(ENHANCEMENT_MAT_COST).map(([k,v]) => `${CRAFT_MATERIALS.find(m=>m.key===k)?.emoji||''} ${CRAFT_MATERIALS.find(m=>m.key===k)?.name||k} x${v}`).join(', ')}` });
      if (result.reason === 'advmats')  return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz gelişmiş malzeme! **+5 sonrası** geliştirmeler için ayrıca gerekli:\n${Object.entries(result.advReq).map(([k,v]) => { const d = ADVANCED_CRAFT_MATERIALS.find(m=>m.key===k); return `${d?.emoji||''} ${d?.name||k} x${v}`; }).join(', ')}\n💡 \`/craft kategori:malzeme\` ile üretebilirsin.` });
    }

    const advStr = result.advReq
      ? ` + ${Object.entries(result.advReq).map(([k,v]) => { const d = ADVANCED_CRAFT_MATERIALS.find(m=>m.key===k); return `${d?.emoji||''} ${d?.name||k} x${v}`; }).join(', ')}`
      : '';

    if (result.success) {
      return interaction.reply({ content: `✨ **Başarılı!** Eşyan **+${result.newEnh}** oldu! (-${result.cost} coin${advStr})` });
    } else {
      const mats = Object.entries(ENHANCEMENT_MAT_COST)
        .map(([k,v]) => { const d = CRAFT_MATERIALS.find(m=>m.key===k); return `${d?.emoji||''} ${d?.name||k} x${v}`; })
        .join(', ');
      return interaction.reply({ content: `💥 **Başarısız!** Eşya **+${result.enh}** kalmaya devam ediyor. (-${result.cost} coin, ${mats}${advStr} malzeme harcandı.)` });
    }
  }

  // ── /parcala ──────────────────────────────────────────────────────────
  // Craftlanmış silah/zırh/gelişmiş malzemeyi bozar, temel craft reçetesindeki
  // malzemelerin %70'ini (küsurat aşağı yuvarlanır) geri iade eder. Not:
  // eşya +geliştirme (yukselt) için harcanan EK malzemeler iade edilmez —
  // sadece o eşyanın taban tier reçetesi baz alınır.
  const PARCALA_REFUND_PCT = 0.70;
  function refundRecipe(recipe) {
    const refunded = {};
    for (const [matKey, qty] of Object.entries(recipe || {})) {
      const back = Math.floor(qty * PARCALA_REFUND_PCT);
      if (back > 0) {
        addCraftMat(gid, uid, matKey, back);
        refunded[matKey] = back;
      }
    }
    return refunded;
  }
  function formatRefund(refunded) {
    const entries = Object.entries(refunded);
    if (!entries.length) return '*(iade edilecek malzeme yok — bu tier hiç malzeme gerektirmiyor)*';
    return entries.map(([k, v]) => {
      const d = findAnyCraftMaterial(k);
      return `${d?.emoji || '🔩'} **${d?.name || k}** × ${v}`;
    }).join('\n');
  }

  if (cmd === 'parcala') {
    if (sub === 'silah') {
      const itemId = interaction.options.getInteger('id');
      const row = db.prepare('SELECT * FROM mmo_weapons WHERE id=? AND guildId=? AND userId=?').get(itemId, gid, uid);
      if (!row) return interaction.reply({ ephemeral: true, content: `⛔ #${itemId} sana ait bir silah değil.` });
      const { tier } = parseWeaponKey(row.weaponKey);
      if (!tier) return interaction.reply({ ephemeral: true, content: '⛔ Bu silahın reçetesi bulunamadı.' });
      const refunded = refundRecipe(tier.craft);
      db.prepare('DELETE FROM mmo_weapons WHERE id=?').run(itemId);
      return interaction.reply({
        content: `🔨 **${getWeaponName(row.weaponKey)}** (+${row.enhancement}) bozuldu!\n📦 **%70 İade:**\n${formatRefund(refunded)}${row.enhancement > 0 ? '\n⚠️ Geliştirme (+' + row.enhancement + ') için harcanan ek malzemeler iade edilmedi.' : ''}`,
      });
    }

    if (sub === 'zirh') {
      const itemId = interaction.options.getInteger('id');
      const row = db.prepare('SELECT * FROM mmo_armors WHERE id=? AND guildId=? AND userId=?').get(itemId, gid, uid);
      if (!row) return interaction.reply({ ephemeral: true, content: `⛔ #${itemId} sana ait bir zırh değil.` });
      const tierKey = row.armorKey.split('_')[1] || row.armorKey;
      const tier = ARMOR_TIERS.find(t => t.key === tierKey);
      if (!tier) return interaction.reply({ ephemeral: true, content: '⛔ Bu zırhın reçetesi bulunamadı.' });
      const refunded = refundRecipe(tier.craft);
      db.prepare('DELETE FROM mmo_armors WHERE id=?').run(itemId);
      return interaction.reply({
        content: `🔨 **${getArmorName(row.slot, tierKey)}** (+${row.enhancement}) bozuldu!\n📦 **%70 İade:**\n${formatRefund(refunded)}${row.enhancement > 0 ? '\n⚠️ Geliştirme (+' + row.enhancement + ') için harcanan ek malzemeler iade edilmedi.' : ''}`,
      });
    }

    if (sub === 'gelismis-malzeme') {
      const key    = interaction.options.getString('anahtar');
      const miktar = interaction.options.getInteger('miktar') || 1;
      const def    = ADVANCED_CRAFT_MATERIALS.find(m => m.key === key);
      if (!def) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz gelişmiş malzeme anahtarı.' });
      const owned = getCraftMats(gid, uid).find(m => m.matKey === key)?.quantity || 0;
      if (owned < miktar) return interaction.reply({ ephemeral: true, content: `⛔ Envanterinde yeterli **${def.name}** yok! Mevcut: ${owned}, İstenen: ${miktar}` });
      consumeCraftMat(gid, uid, key, miktar);
      const scaledRecipe = Object.fromEntries(Object.entries(def.craft).map(([k, v]) => [k, v * miktar]));
      const refunded = refundRecipe(scaledRecipe);
      return interaction.reply({
        content: `🔨 ${def.emoji} **${def.name}** × ${miktar} bozuldu!\n📦 **%70 İade:**\n${formatRefund(refunded)}`,
      });
    }
  }

  // ── /slot ─────────────────────────────────────────────────────────────
  if (cmd === 'slot') {
    const bet = interaction.options.getInteger('bahis');
    const bal = getBalance(gid, uid);
    if (bal.balance < bet) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Bakiye: **${bal.balance}**` });

    const plays = getSlotPlays(gid, uid);
    if (plays >= SLOT_MAX_DAILY) {
      return interaction.reply({ ephemeral: true, content: `🎰 Günlük ${SLOT_MAX_DAILY} hakkın doldu! Yarın tekrar gel.` });
    }

    incSlotPlays(gid, uid);
    addBalance(gid, uid, -bet);

    const spin = spinSlot();
    let payout = 0;
    if (spin.multiplier > 0) {
      payout = Math.floor(bet * spin.multiplier);
      addBalance(gid, uid, payout);
    }

    // Fırtına Seti bonusu — slot kazanımı artışı (RELIC_SETS.firtina.bonusFull.slotPct'ten okunur, artık senkron)
    const slotSetBonusPct = getRelicSetSlotBonus(gid, uid);
    if (slotSetBonusPct > 0 && payout > 0) {
      const extra = Math.floor(payout * (slotSetBonusPct / 100));
      addBalance(gid, uid, extra);
      payout += extra;
    }

    const net = payout - bet;
    const newBal = getBalance(gid, uid).balance;
    const color = spin.multiplier >= 5 ? 0xF1C40F : spin.multiplier >= 3 ? 0x9B59B6 : spin.multiplier > 0 ? 0x2ECC71 : 0xE74C3C;

    const randSymbol = () => SLOT_SYMBOLS_DEF[Math.floor(Math.random() * SLOT_SYMBOLS_DEF.length)].emoji;
    const spinningReel = (locked, count) => Array.from({ length: 3 }, (_, i) => (i < locked ? spin.reels[i] : randSymbol())).join(' ║ ');

    // ── Gerilim veren dönme animasyonu ────────────────────────
    // İlk mesajı gönder, sonra bobinleri soldan sağa tek tek "kilitleyerek"
    // birkaç kez düzenle — gerçek bir slot makinesi gibi gerilim yaratır.
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎰 Slot Makinesi')
        .setColor(0x95A5A6)
        .setDescription(`**╔══ ${spinningReel(0)} ══╗**\n\n🎲 Çekiliyor...`)],
    });

    for (let i = 0; i < 3; i++) {
      await sleep(500);
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('🎰 Slot Makinesi')
          .setColor(0x95A5A6)
          .setDescription(`**╔══ ${spinningReel(0)} ══╗**\n\n🎲 Çekiliyor...`)],
      });
    }

    await sleep(600);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('🎰 Slot Makinesi')
        .setColor(0x95A5A6)
        .setDescription(`**╔══ ${spinningReel(1)} ══╗**\n\n🔒 1. bobin kilitlendi...`)],
    });

    await sleep(700);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('🎰 Slot Makinesi')
        .setColor(0x95A5A6)
        .setDescription(`**╔══ ${spinningReel(2)} ══╗**\n\n🔒🔒 2. bobin kilitlendi...`)],
    });

    await sleep(800);
    const reelStr = spin.reels.join(' ║ ');
    const embed = new EmbedBuilder()
      .setTitle('🎰 Slot Makinesi')
      .setColor(color)
      .setDescription(`**╔══ ${reelStr} ══╗**\n\n${spin.label}`)
      .addFields(
        { name: '💰 Bahis',    value: `${bet} coin`,      inline: true },
        { name: '🎁 Kazanç',  value: `${payout} coin`,   inline: true },
        { name: `${net >= 0 ? '📈' : '📉'} Net`,  value: `${net >= 0 ? '+' : ''}${net} coin`, inline: true },
        { name: '💳 Bakiye',  value: `**${newBal}** coin`, inline: true },
        { name: '🎮 Hak',     value: `${plays + 1}/${SLOT_MAX_DAILY}`, inline: true },
      )
      .setFooter({ text: 'Slot: Günlük 10 hak • Max ödül 5x • Uzun vadede -%50' });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /relic-set ────────────────────────────────────────────────────────
  if (cmd === 'relic-set') {
    const setChoice     = interaction.options.getString('set');
    const sets          = setChoice ? { [setChoice]: RELIC_SETS[setChoice] } : RELIC_SETS;
    const ownedKeys     = getRelics(gid, uid);
    const equippedSets  = getEquippedRelicSets(gid, uid);

    const embed = new EmbedBuilder()
      .setTitle('💎 Relic Setleri')
      .setColor(0x9B59B6)
      .setFooter({ text: `Parça fiyatı: 20.000 coin (set başı 120.000) • Aynı anda en fazla ${RELIC_SET_MAX_EQUIPPED} set kuşanılabilir (${equippedSets.length}/${RELIC_SET_MAX_EQUIPPED}) • Sandıktan / Madenden / Zindandan da düşer` });

    for (const [key, def] of Object.entries(sets)) {
      const count = def.pieces.filter(p => ownedKeys.includes(p.key)).length;
      const progress = '🟩'.repeat(count) + '⬜'.repeat(def.pieces.length - count);
      const isEquipped = equippedSets.includes(key);
      const classTag = def.classKey ? ` ${RPG_CLASSES.find(c => c.key === def.classKey)?.emoji || '🔒'}` : '';

      if (setChoice) {
        // Tek set seçildiyse tam detay göster (parça listesi + tüm bonus kademeleri)
        const pieces = def.pieces.map(p => `${ownedKeys.includes(p.key) ? '✅' : '❌'} ${p.name} (${p.price}c)`).join('\n');
        let bonusText = '';
        if (def.bonus2)    bonusText += `**2 Parça:** ${def.bonus2.desc}\n`;
        if (def.bonus4)    bonusText += `**4 Parça:** ${def.bonus4.desc}\n`;
        if (def.bonusFull) bonusText += `**Tam Set:** ${def.bonusFull.desc}`;
        if (def.classKey) {
          const clsDef = RPG_CLASSES.find(c => c.key === def.classKey);
          bonusText += `\n\n🔒 Yalnızca **${clsDef?.emoji || ''} ${clsDef?.name || def.classKey}** sınıfı kuşanabilir.`;
        }
        embed.addFields({
          name: `${def.emoji} ${def.name} [${def.tier}]${classTag} — ${count}/${def.pieces.length} ${progress}${isEquipped ? ' 🟢 KUŞANILI' : ''}`,
          value: `${pieces}\n\n${bonusText}`,
          inline: false,
        });
      } else {
        // Hepsi listelendiğinde (19 set) embed limitlerini aşmamak için tek satır özet
        embed.addFields({
          name: `${def.emoji} ${def.name} [${def.tier}]${classTag} ${count}/${def.pieces.length} ${isEquipped ? '🟢' : ''}`,
          value: def.bonusFull?.desc || '—',
          inline: false,
        });
      }
    }

    // Yalnızca tek bir set seçildiyse eksik parçalar için satın alma butonu +
    // kuşan/çıkar butonu göster (Ejder Seti hariç — o parçalar zaten
    // pazardan/madencilikten geliyor, kural değişmedi)
    const components = [];
    if (setChoice && RELIC_SETS[setChoice]) {
      const missing = RELIC_SETS[setChoice].pieces.filter(p => !ownedKeys.includes(p.key));
      const bal = getBalance(gid, uid);
      for (let i = 0; i < missing.length; i += 5) {
        const row = new ActionRowBuilder().addComponents(
          missing.slice(i, i + 5).map(p =>
            new ButtonBuilder()
              .setCustomId(`mmo_buyrelic_${p.key}_${uid}`)
              .setLabel(`${p.name} (${p.price}c)`)
              .setEmoji(p.emoji)
              .setStyle(bal.balance >= p.price ? ButtonStyle.Success : ButtonStyle.Secondary)
          )
        );
        components.push(row);
      }

      const isEquipped = equippedSets.includes(setChoice);
      const equipRow = new ActionRowBuilder().addComponents(
        isEquipped
          ? new ButtonBuilder().setCustomId(`mmo_unequipset_${setChoice}_${uid}`).setLabel('Çıkar').setEmoji('🔻').setStyle(ButtonStyle.Danger)
          : new ButtonBuilder().setCustomId(`mmo_equipset_${setChoice}_${uid}`).setLabel('Kuşan').setEmoji('🔼').setStyle(ButtonStyle.Primary)
      );
      components.push(equipRow);
    }

    return interaction.reply({ embeds: [embed], components, ephemeral: true });
  }

  // ── /rpg-pet ──────────────────────────────────────────────────────────
  if (cmd === 'rpg-pet') {
    if (sub === 'liste') {
      const pets   = getMmoPets(gid, uid);
      const active = getMmoActivePets(gid, uid);

      if (!pets.length) {
        return interaction.reply({ ephemeral: true, content: '🐾 Henüz MMORPG petin yok. `/yumurta ac` ile yumurta aç!' });
      }

      const rarityStars = ['⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
      const petLines = pets.map((p, i) => {
        const def = MMORPG_PETS.find(x => x.key === p.petKey);
        const isActive = active.find(a => a.petKey === p.petKey && a.petHatchedAt === p.hatchedAt);
        const stat = RPG_STAT_NAMES[def?.bonusType];
        const bonus = (def?.bonusBase || 0) + (p.level - 1) * MMO_PET_BONUS_PER_LV;
        const shardCost = getPetShardCostForLevel(p.level);
        const shardNote = p.level >= MMO_PET_MAX_LEVEL
          ? ' *(MAX)*'
          : (shardCost > 0 ? ` — sonraki: ${shardCost}🔹 parça gerekir (sende: ${getPetShardCount(gid, uid, p.petKey)})` : '');
        return `${isActive ? `**[Slot ${isActive.slot}]**` : `[${i+1}]`} ${def?.emoji} **${def?.name}** Lv.${p.level} | ${rarityStars[def?.rarity || 0]} | ${stat?.emoji}+${bonus}%${shardNote}`;
      }).join('\n');

      const shards = getPetShards(gid, uid);
      const shardLines = shards.length
        ? shards.map(s => { const d = MMORPG_PETS.find(x => x.key === s.petKey); return `${d?.emoji || '🔹'} **${d?.name || s.petKey}** Parçası × ${s.quantity}`; }).join('\n')
        : '*Pet parçası yok*';

      const embed = new EmbedBuilder()
        .setTitle(`🐾 MMORPG Petlerin (${pets.length})`)
        .setColor(0x2ECC71)
        .setDescription(petLines)
        .addFields({ name: '🔹 Pet Parçaları', value: shardLines, inline: false })
        .setFooter({ text: `Aktif: ${active.length}/${MMO_PET_MAX_ACTIVE} slot • /rpg-pet kuşan ile kuşan` });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'kusan') {
      const petCombo  = interaction.options.getString('pet');
      const [petKey, hatchedAt] = (petCombo || '').split('|');
      const slot      = interaction.options.getInteger('slot');

      if (!petKey || !hatchedAt) return interaction.reply({ ephemeral: true, content: '⛔ Listeden bir pet seç (yazmaya başlayınca öneriler çıkar).' });
      const owns = db.prepare('SELECT * FROM mmo_pets WHERE guildId=? AND userId=? AND petKey=? AND hatchedAt=?').get(gid, uid, petKey, hatchedAt);
      if (!owns) return interaction.reply({ ephemeral: true, content: '⛔ Bu pet sende yok veya ID hatalı.' });

      const petDef = MMORPG_PETS.find(p => p.key === petKey);
      const pCls = getPlayerClass(gid, uid);
      if (pCls && petDef && !classAllowsStat(pCls, petDef.bonusType)) {
        const clsDef = RPG_CLASSES.find(c => c.key === pCls);
        return interaction.reply({ ephemeral: true, content: `⛔ **${clsDef.emoji} ${clsDef.name}** sınıfın **${petDef.emoji} ${petDef.name}** petini kuşanmana izin vermiyor!` });
      }

      equipMmoPet(gid, uid, petKey, hatchedAt, slot);
      const def = MMORPG_PETS.find(p => p.key === petKey);
      return interaction.reply({ content: `✅ ${def?.emoji} **${def?.name}** Slot **${slot}**'e kuşanıldı!` });
    }

    if (sub === 'cikar') {
      const slot = interaction.options.getInteger('slot');
      unequipMmoPet(gid, uid, slot);
      return interaction.reply({ content: `✅ Slot **${slot}** boşaltıldı.` });
    }

    if (sub === 'yukselt') {
      const petCombo  = interaction.options.getString('pet');
      const [petKey, hatchedAt] = (petCombo || '').split('|');
      if (!petKey || !hatchedAt) return interaction.reply({ ephemeral: true, content: '⛔ Listeden bir pet seç (yazmaya başlayınca öneriler çıkar).' });
      const result    = upgradeMmoPet(gid, uid, petKey, hatchedAt);
      const def       = MMORPG_PETS.find(p => p.key === petKey);

      if (!result.ok) {
        if (result.reason === 'shard') {
          return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz Pet Parçası! Gerekli: **${def?.emoji || '🐾'} ${result.shardCost}x ${def?.name || petKey} Parçası** (sende: ${result.haveShards})` });
        }
        if (result.reason === 'coin') {
          const shardNote = result.shardCost ? ` (ayrıca **${result.shardCost}x** Pet Parçası da gerekecek)` : '';
          return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${result.cost}**${shardNote}` });
        }
        return interaction.reply({ ephemeral: true, content: '⛔ Yükseltme yapılamadı (bulunamadı veya zaten max).' });
      }

      const newBonus = (def?.bonusBase || 0) + (result.newLevel - 1) * MMO_PET_BONUS_PER_LV;
      const shardNote = result.shardCost ? ` ve -${result.shardCost}x ${def?.emoji || '🐾'} Parça` : '';
      return interaction.reply({ content: `✨ ${def?.emoji} **${def?.name}** → **Lv.${result.newLevel}** yükseltildi! (-${result.cost} coin${shardNote})\n📊 Yeni bonus: +${newBonus}%` });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  STAT PANELİ (Button + Select Menu tabanlı)
// ─────────────────────────────────────────────────────────────────────────
async function showStatPanel(interaction, gid, uid) {
  const stats = getRpgStats(gid, uid);
  const bal   = getBalance(gid, uid);
  const power = getRpgPowerScore(gid, uid);

  const lines = RPG_STAT_KEYS.map(k => {
    const info     = RPG_STAT_NAMES[k];
    const level    = stats[k] || 1;
    const nextCost = level < RPG_MAX_STAT_LEVEL ? getStatCost(level + 1) : null;
    const bar      = buildBar(level, RPG_MAX_STAT_LEVEL, 8);
    return `${info.emoji} **${info.name}** Lv.${level}/${RPG_MAX_STAT_LEVEL} ${bar}${nextCost ? ` — ${nextCost}🪙` : ' *(MAX)*'}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📊 Stat Yükseltme Paneli')
    .setColor(0x5865F2)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: '💰 Bakiye', value: `**${bal.balance}** coin`, inline: true },
      { name: '⚔️ Toplam Güç', value: `**${power}** / 350`, inline: true },
    )
    .setFooter({ text: 'Lv.1-10: 1000c • Lv.11-20: 2000c • Lv.21-30: 3000c • Lv.31-40: 4000c • Lv.41-50: 5000c\nToplam Güç, /zindan başarı şansını belirler — zorlu zindanlara girmeden önce yükselt!' });

  const selectOptions = RPG_STAT_KEYS
    .filter(k => (stats[k] || 1) < RPG_MAX_STAT_LEVEL)
    .map(k => {
      const info = RPG_STAT_NAMES[k];
      const lvl  = stats[k] || 1;
      return {
        label: `${info.name} (Lv.${lvl} → ${lvl + 1})`,
        value: k,
        description: `Maliyet: ${getStatCost(lvl + 1)} coin`,
        emoji: info.emoji,
      };
    });

  if (!selectOptions.length) {
    embed.setDescription(lines.join('\n') + '\n\n✅ **Tüm statlar maksimum seviyede!**');
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('mmo_stat_upgrade')
    .setPlaceholder('Yükseltmek istediğin statı seç...')
    .addOptions(selectOptions.slice(0, 25));

  const row = new ActionRowBuilder().addComponents(select);
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ─────────────────────────────────────────────────────────────────────────
//  ENVANTER SİSTEMİ (Sekmeli buton tabanlı)
// ─────────────────────────────────────────────────────────────────────────
async function showInventory(interaction, gid, uid, tab, isUpdate = false) {
  const tabs = [
    { key: 'genel',    emoji: '🎒', label: 'Genel'       },
    { key: 'ekipman',  emoji: '⚔️', label: 'Ekipman'     },
    { key: 'sandik',   emoji: '📦', label: 'Sandık'      },
    { key: 'pet',      emoji: '🐉', label: 'Pet'         },
    { key: 'relic',    emoji: '💎', label: 'Relic'       },
    { key: 'craft',    emoji: '🧪', label: 'Craft'       },
    { key: 'antika',   emoji: '🖼️', label: 'Antika'      },
    { key: 'tuket',    emoji: '🍖', label: 'Tüketilebilir'},
  ];

  const embed = buildInventoryEmbed(gid, uid, tab, tabs);

  // Row 1: ilk 4 sekme
  const row1 = new ActionRowBuilder().addComponents(
    tabs.slice(0, 4).map(t =>
      new ButtonBuilder()
        .setCustomId(`mmo_inv_${t.key}_${uid}`)
        .setLabel(`${t.emoji} ${t.label}`)
        .setStyle(t.key === tab ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );
  // Row 2: son 4 sekme
  const row2 = new ActionRowBuilder().addComponents(
    tabs.slice(4, 8).map(t =>
      new ButtonBuilder()
        .setCustomId(`mmo_inv_${t.key}_${uid}`)
        .setLabel(`${t.emoji} ${t.label}`)
        .setStyle(t.key === tab ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );

  if (isUpdate) {
    return interaction.update({ embeds: [embed], components: [row1, row2] });
  }
  return interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
}

function buildInventoryEmbed(gid, uid, tab, tabs) {
  const tabDef = tabs.find(t => t.key === tab) || tabs[0];
  const embed = new EmbedBuilder()
    .setTitle(`${tabDef.emoji} Envanter — ${tabDef.label}`)
    .setColor(0x5865F2)
    .setTimestamp();

  if (tab === 'genel') {
    const bal  = getBalance(gid, uid);
    const rpg  = getRpgData(gid, uid);
    const lvl  = getLevel(gid, uid);
    embed.addFields(
      { name: '💰 Cüzdan',    value: `${bal.balance} coin`, inline: true },
      { name: '🏦 Banka',     value: `${bal.bank} coin`,   inline: true },
      { name: '📊 Chat Lv.',  value: `Lv.${lvl.level}`,    inline: true },
      { name: '⚔️ RPG Lv.',   value: `Lv.${rpg.rpgLevel}`, inline: true },
    );
  }

  else if (tab === 'ekipman') {
    const weapons = getWeapons(gid, uid);
    const armors  = getArmors(gid, uid);
    const wLines  = weapons.length
      ? weapons.map(w => `[ID:${w.id}] ${getWeaponName(w.weaponKey)} **+${w.enhancement}** — ⚔️${getWeaponBattlePower(w.weaponKey, w.enhancement)} güç`).join('\n')
      : '*Silah yok*';
    const aLines  = armors.length
      ? armors.map(a => `[ID:${a.id}] ${getArmorName(a.slot, a.armorKey.split('_')[1] || '')} **+${a.enhancement}** — 🛡️${getArmorBattlePower(a.armorKey.split('_')[1] || '', a.enhancement, a.slot)} güç`).join('\n')
      : '*Zırh yok*';
    embed.addFields(
      { name: '⚔️ Silahlar', value: wLines, inline: false },
      { name: '🛡️ Zırhlar',  value: aLines, inline: false },
    );
    embed.setFooter({ text: '/yukselt tur:silah id:<ID> ile güçlendir • /fight en iyi silah+zırhını otomatik kullanır' });
  }

  else if (tab === 'sandik') {
    const chests = getChests(gid, uid);
    const lines  = chests.length
      ? chests.map(c => {
          const def = MMORPG_CHESTS.find(x => x.key === c.chestType);
          return `${def?.emoji || '📦'} **${def?.name || c.chestType}** × ${c.quantity}`;
        }).join('\n')
      : '*Sandık yok*';
    embed.setDescription(lines);
    embed.setFooter({ text: '/sandik ac tur:<tür> ile aç' });
  }

  else if (tab === 'pet') {
    const eggs   = getEggs(gid, uid);
    const pets   = getMmoPets(gid, uid);
    const active = getMmoActivePets(gid, uid);
    const shards = getPetShards(gid, uid);

    const eggLines = eggs.length
      ? eggs.map(e => {
          const def = PET_EGG_TYPES.find(x => x.key === e.eggType);
          return `${def?.emoji || '🥚'} **${def?.name}** × ${e.quantity}`;
        }).join('\n')
      : '*Yumurta yok*';

    const petLines = pets.length
      ? pets.map((p, i) => {
          const def = MMORPG_PETS.find(x => x.key === p.petKey);
          const isAct = active.find(a => a.petKey === p.petKey && a.petHatchedAt === p.hatchedAt);
          return `${isAct ? `[Slot${isAct.slot}]` : `[${i+1}]`} ${def?.emoji} **${def?.name}** Lv.${p.level}`;
        }).join('\n')
      : '*MMORPG pet yok*';

    const shardLines = shards.length
      ? shards.map(s => { const d = MMORPG_PETS.find(x => x.key === s.petKey); return `${d?.emoji || '🔹'} **${d?.name || s.petKey}** × ${s.quantity}`; }).join('\n')
      : '*Pet parçası yok*';

    embed.addFields(
      { name: `🥚 Yumurtalar (${eggs.length} tür)`, value: eggLines, inline: false },
      { name: `🐾 Petler (${pets.length})`,          value: petLines, inline: false },
      { name: `🔹 Pet Parçaları (${shards.length} tür)`, value: shardLines, inline: false },
    );
    embed.setFooter({ text: '/yumurta ac ile aç • /rpg-pet liste ile yönet • Lv6+ yükseltme Parça ister' });
  }

  else if (tab === 'relic') {
    const ownedKeys   = getRelics(gid, uid);
    const equippedSets = getEquippedRelicSets(gid, uid);
    // Eski relicler
    const oldLines  = RELICS
      .filter(r => ownedKeys.includes(r.key))
      .map(r => `${r.emoji} **${r.name}**`)
      .join('\n') || '*Yok*';

    // Yeni set parçaları — kuşanılı setler 🟢 ile işaretlenir
    const setLines  = Object.entries(RELIC_SETS).map(([key, def]) => {
      const cnt  = def.pieces.filter(p => ownedKeys.includes(p.key)).length;
      const isEquipped = equippedSets.includes(key);
      return `${def.emoji} **${def.name}** [${def.tier}] ${cnt}/${def.pieces.length}${isEquipped ? ' 🟢 KUŞANILI' : ''}`;
    }).join('\n');

    embed.addFields(
      { name: '📿 Tek Relikler',  value: oldLines,  inline: false },
      { name: `💎 Set Parçaları (Kuşanılı: ${equippedSets.length}/${RELIC_SET_MAX_EQUIPPED})`, value: setLines,  inline: false },
    );
    embed.setFooter({ text: '/relic-set ile kuşan/detay • /market veya /craft kategori:set ile edin' });
  }

  else if (tab === 'craft') {
    const mats  = getCraftMats(gid, uid);
    const basic = mats.filter(m => !ADVANCED_MAT_KEYS.includes(m.matKey));
    const adv   = mats.filter(m => ADVANCED_MAT_KEYS.includes(m.matKey));
    const basicLines = basic.length
      ? basic.map(m => {
          const def = CRAFT_MATERIALS.find(x => x.key === m.matKey);
          return `${def?.emoji || '🔩'} **${def?.name || m.matKey}** × ${m.quantity}`;
        }).join('\n')
      : '*Yok — Zindan ve Sandıklardan toplanır*';
    const advLines = adv.length
      ? adv.map(m => {
          const def = ADVANCED_CRAFT_MATERIALS.find(x => x.key === m.matKey);
          return `${def?.emoji || '🌀'} **${def?.name || m.matKey}** × ${m.quantity}`;
        }).join('\n')
      : '*Yok — /craft kategori:malzeme ile üret*';
    embed.addFields(
      { name: '🔩 Ham Malzemeler',      value: basicLines, inline: false },
      { name: '🌀 Gelişmiş Malzemeler', value: advLines,   inline: false },
    );
    embed.setFooter({ text: '/craft ile eşya üret' });
  }

  else if (tab === 'antika') {
    const inv = getAntiqueInventory(gid, uid);
    const active = getActiveAntique(gid, uid);
    const lines = inv.length
      ? inv.map(a => {
          const def = ANTIQUES.find(x => x.key === a.antiqueKey);
          const isAct = active?.key === a.antiqueKey ? ' ✅ Aktif' : '';
          return `${def?.emoji || '🏺'} **${def?.name}** × ${a.count}${isAct}`;
        }).join('\n')
      : '*Antika yok*';
    embed.setDescription(lines);
    embed.setFooter({ text: '/antika aktif-et ile aktif et' });
  }

  else if (tab === 'tuket') {
    // Balıkçılık boost, pet mamaları, yemekler vb.
    const fishBoost = getFishBoostUses(gid, uid);
    const tempXp    = getTempBoostUses(gid, uid);

    const lines = [
      `🎣 **Balıkçılık Boost:** ${fishBoost} kullanım`,
      `✨ **Geçici XP Boost:** ${tempXp} kullanım`,
    ];

    // Pet mamaları (mevcut market'ten)
    for (const food of PET_FOODS) {
      // pet_food tablosuna bak — sadece mevcut besleme durumu
      const feedToday = getPetFedDate(gid, uid, food.petKey);
      lines.push(`${food.emoji} **${food.name}:** ${feedToday ? `Beslendi (${feedToday})` : 'Beslenmedi'}`);
    }

    embed.setDescription(lines.join('\n'));
    embed.setFooter({ text: '/market ile tüketilebilir satın al' });
  }

  return embed;
}

// ─────────────────────────────────────────────────────────────────────────
//  CRAFT KOMUTU
// ─────────────────────────────────────────────────────────────────────────
async function handleCraftCommand(interaction, gid, uid) {
  const kategori = interaction.options.getString('kategori');
  const itemStr  = interaction.options.getString('item').trim().toLowerCase();

  if (kategori === 'silah') {
    // itemStr = "kilic_altin"
    const parts = itemStr.split('_');
    const typeKey = parts[0];
    const tierKey = parts.slice(1).join('_');
    const wType = WEAPON_TYPES.find(t => t.key === typeKey);
    const wTier = WEAPON_TIERS.find(t => t.key === tierKey);

    if (!wType || !wTier) {
      const options = WEAPON_TYPES.map(t => WEAPON_TIERS.map(r => `\`${t.key}_${r.key}\``).join(', ')).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz silah! Seçenekler:\n${options}` });
    }

    const wCls = getPlayerClass(gid, uid);
    if (wCls && !classAllowsStat(wCls, wType.stat)) {
      const clsDef = RPG_CLASSES.find(c => c.key === wCls);
      return interaction.reply({ ephemeral: true, content: `⛔ **${clsDef.emoji} ${clsDef.name}** sınıfın **${wType.emoji} ${wType.name}** craftlamana izin vermiyor!` });
    }

    if (!hasCraftMats(gid, uid, wTier.craft)) {
      const needed = Object.entries(wTier.craft).map(([k,v]) => {
        const d = findAnyCraftMaterial(k);
        const have = getCraftMats(gid, uid).find(m => m.matKey === k)?.quantity || 0;
        return `${d?.emoji} ${d?.name}: ${have}/${v}`;
      }).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz malzeme!\n${needed}` });
    }

    spendCraftMats(gid, uid, wTier.craft);
    const id = addWeapon(gid, uid, `${typeKey}_${tierKey}`);
    // Craft XP
    const craftXp = wTier.key === 'godslayer' ? 150 : wTier.key === 'ejder' ? 80 : wTier.key === 'kristal' ? 50 : wTier.key === 'altin' ? 30 : 15;
    addRpgXp(gid, uid, craftXp);

    return interaction.reply({
      content: `✅ **${getWeaponName(`${typeKey}_${tierKey}`)}** crafted! (ID: ${id})\n+${craftXp} RPG XP kazandın!\n🛡️ \`/yukselt tur:silah id:${id}\` ile güçlendirebilirsin.`,
    });
  }

  else if (kategori === 'zirh') {
    // itemStr = "miğfer_altin"
    const lastUnder = itemStr.lastIndexOf('_');
    const slotKey   = itemStr.substring(0, lastUnder);
    const tierKey   = itemStr.substring(lastUnder + 1);
    const aSlot = ARMOR_SLOTS.find(s => s.key === slotKey);
    const aTier = ARMOR_TIERS.find(t => t.key === tierKey);

    if (!aSlot || !aTier) {
      const options = ARMOR_SLOTS.map(s => ARMOR_TIERS.map(t => `\`${s.key}_${t.key}\``).join(', ')).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz zırh! Seçenekler (örn):\n${ARMOR_SLOTS.slice(0,2).flatMap(s => ARMOR_TIERS.slice(0,3).map(t => `\`${s.key}_${t.key}\``)).join(', ')} ...` });
    }

    const aCls = getPlayerClass(gid, uid);
    if (aCls && !classAllowsStat(aCls, aSlot.stat)) {
      const clsDef = RPG_CLASSES.find(c => c.key === aCls);
      return interaction.reply({ ephemeral: true, content: `⛔ **${clsDef.emoji} ${clsDef.name}** sınıfın **${aSlot.emoji} ${aSlot.name}** craftlamana izin vermiyor!` });
    }

    if (!hasCraftMats(gid, uid, aTier.craft)) {
      const needed = Object.entries(aTier.craft).map(([k,v]) => {
        const d = findAnyCraftMaterial(k);
        const have = getCraftMats(gid, uid).find(m => m.matKey === k)?.quantity || 0;
        return `${d?.emoji} ${d?.name}: ${have}/${v}`;
      }).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz malzeme!\n${needed}` });
    }

    spendCraftMats(gid, uid, aTier.craft);
    const id = addArmor(gid, uid, `${slotKey}_${tierKey}`, slotKey);
    const craftXp = aTier.key === 'godslayer' ? 130 : aTier.key === 'ejder' ? 70 : aTier.key === 'kristal' ? 45 : aTier.key === 'altin' ? 25 : 12;
    addRpgXp(gid, uid, craftXp);

    return interaction.reply({
      content: `✅ **${getArmorName(slotKey, tierKey)}** crafted! (ID: ${id})\n+${craftXp} RPG XP kazandın!\n🛡️ \`/yukselt tur:zirh id:${id}\` ile güçlendirebilirsin.`,
    });
  }

  else if (kategori === 'yumurta') {
    const recipe = CRAFT_EGG_RECIPES[itemStr];
    if (!recipe) return interaction.reply({ ephemeral: true, content: `⛔ Geçerli yumurta türleri: ${Object.keys(CRAFT_EGG_RECIPES).join(', ')}` });
    if (!hasCraftMats(gid, uid, recipe)) {
      const needed = Object.entries(recipe).map(([k,v]) => {
        const d = findAnyCraftMaterial(k);
        const have = getCraftMats(gid, uid).find(m => m.matKey === k)?.quantity || 0;
        return `${d?.emoji} ${d?.name}: ${have}/${v}`;
      }).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz malzeme!\n${needed}` });
    }
    spendCraftMats(gid, uid, recipe);
    addEgg(gid, uid, itemStr, 1);
    const eggDef = PET_EGG_TYPES.find(e => e.key === itemStr);
    addRpgXp(gid, uid, 20);
    return interaction.reply({ content: `✅ **${eggDef?.name}** crafted! (+20 RPG XP)` });
  }

  else if (kategori === 'sandik') {
    const recipe = CRAFT_SANDIK_RECIPES[itemStr];
    if (!recipe) return interaction.reply({ ephemeral: true, content: `⛔ Geçerli sandık türleri: ${Object.keys(CRAFT_SANDIK_RECIPES).join(', ')}` });
    if (!hasCraftMats(gid, uid, recipe)) {
      const needed = Object.entries(recipe).map(([k,v]) => {
        const d = findAnyCraftMaterial(k);
        const have = getCraftMats(gid, uid).find(m => m.matKey === k)?.quantity || 0;
        return `${d?.emoji} ${d?.name}: ${have}/${v}`;
      }).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz malzeme!\n${needed}` });
    }
    spendCraftMats(gid, uid, recipe);
    addChest(gid, uid, itemStr, 1);
    const chestDef = MMORPG_CHESTS.find(c => c.key === itemStr);
    addRpgXp(gid, uid, 15);
    return interaction.reply({ content: `✅ **${chestDef?.name}** crafted! (+15 RPG XP)` });
  }

  else if (kategori === 'malzeme') {
    // Gelişmiş malzeme craftlama — madenden düşmez, tek yol burası.
    const def = ADVANCED_CRAFT_MATERIALS.find(m => m.key === itemStr);
    if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçerli gelişmiş malzemeler: ${ADVANCED_CRAFT_MATERIALS.map(m => `\`${m.key}\``).join(', ')}` });

    if (!hasCraftMats(gid, uid, def.craft)) {
      const needed = Object.entries(def.craft).map(([k, v]) => {
        const d = findAnyCraftMaterial(k);
        const have = getCraftMats(gid, uid).find(m => m.matKey === k)?.quantity || 0;
        return `${d?.emoji || ''} ${d?.name || k}: ${have}/${v}`;
      }).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz malzeme!\n${needed}` });
    }

    spendCraftMats(gid, uid, def.craft);
    addCraftMat(gid, uid, def.key, 1);
    addRpgXp(gid, uid, 60);

    return interaction.reply({
      content: `✅ ${def.emoji} **${def.name}** × 1 crafted! (+60 RPG XP)\n🌀 SSS tier ekipman/relic set üretiminde ve +5 sonrası geliştirmelerde kullanılır.`,
    });
  }

  else if (kategori === 'set') {
    // Tam Relic Seti craftlama — kılıç craft sisteminden örnek alınmış, %60 daha zor.
    const def = RELIC_SETS[itemStr];
    if (!def) return interaction.reply({ ephemeral: true, content: `⛔ Geçersiz set! Seçenekler: ${Object.keys(RELIC_SETS).join(', ')}` });

    if (def.classKey && getPlayerClass(gid, uid) !== def.classKey) {
      const clsDef = RPG_CLASSES.find(c => c.key === def.classKey);
      return interaction.reply({ ephemeral: true, content: `⛔ **${def.emoji} ${def.name}** yalnızca **${clsDef?.emoji || ''} ${clsDef?.name || def.classKey}** sınıfı tarafından craftlanabilir!` });
    }

    const ownedKeys = getRelics(gid, uid);
    const missing   = def.pieces.filter(p => !ownedKeys.includes(p.key));
    if (!missing.length) return interaction.reply({ ephemeral: true, content: `${def.emoji} **${def.name}** zaten tam (6/6) sende var.` });

    const recipe = getRelicSetCraftRecipe(def.tier);
    if (!hasCraftMats(gid, uid, recipe)) {
      const needed = Object.entries(recipe).map(([k, v]) => {
        const d = CRAFT_MATERIALS.find(m => m.key === k) || ADVANCED_CRAFT_MATERIALS.find(m => m.key === k);
        const have = getCraftMats(gid, uid).find(m => m.matKey === k)?.quantity || 0;
        return `${d?.emoji || ''} ${d?.name || k}: ${have}/${v}`;
      }).join('\n');
      return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz malzeme! **${def.emoji} ${def.name}** [${def.tier}] tam seti için gerekli:\n${needed}` });
    }

    spendCraftMats(gid, uid, recipe);
    for (const p of missing) buyRelic(gid, uid, p.key);
    const craftXp = { B: 60, A: 90, S: 130, SSS: 200 }[def.tier] || 60;
    addRpgXp(gid, uid, craftXp);

    return interaction.reply({
      content: `✅ **${def.emoji} ${def.name}** tam set (6/6) crafted! (+${craftXp} RPG XP)\n💎 \`/relic-set\` ekranından kuşanabilirsin (aynı anda max ${RELIC_SET_MAX_EQUIPPED} set).`,
    });
  }

  return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz kategori.' });
}

// ─────────────────────────────────────────────────────────────────────────
//  BUTON HANDLER
// ─────────────────────────────────────────────────────────────────────────
async function handleMMOButton(interaction) {
  const id  = interaction.customId; // format: mmo_inv_{tab}_{uid}
  const gid = interaction.guild?.id;
  const uid = interaction.user.id;

  // Relic Set parçası satın alma — /relic-set ekranındaki butonlar
  // (Daha önce bu özellik yalnızca yorum satırlarında planlanmış, hiç
  // bağlanmamıştı; /relic-set ve market UI'ları "market'ten satın al"
  // diyordu ama gerçekte satın alma yolu yoktu. Artık burada çalışıyor.)
  if (id.startsWith('mmo_buyrelic_')) {
    const rest = id.slice('mmo_buyrelic_'.length);
    const ownerId = rest.slice(rest.lastIndexOf('_') + 1);
    const pieceKey = rest.slice(0, rest.lastIndexOf('_'));

    if (uid !== ownerId) return interaction.reply({ ephemeral: true, content: '⛔ Bu buton sana ait değil.' });

    const piece = ALL_NEW_RELIC_PIECES.find(p => p.key === pieceKey);
    if (!piece) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz relic parçası.' });
    if (hasRelic(gid, uid, piece.key)) return interaction.reply({ ephemeral: true, content: `${piece.emoji} Bu relic parçası zaten sende var.` });
    const bal = getBalance(gid, uid);
    if (bal.balance < piece.price) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${piece.price}**, Bakiye: **${bal.balance}**` });

    addBalance(gid, uid, -piece.price);
    buyRelic(gid, uid, piece.key);
    return interaction.reply({ ephemeral: true, content: `✅ ${piece.emoji} **${piece.name}** satın alındı! (-${piece.price} coin)\n💰 Kalan: **${getBalance(gid, uid).balance}**` });
  }

  // Relic Set kuşanma — aynı anda en fazla RELIC_SET_MAX_EQUIPPED (2) set aktif olabilir
  if (id.startsWith('mmo_equipset_')) {
    const rest = id.slice('mmo_equipset_'.length);
    const ownerId = rest.slice(rest.lastIndexOf('_') + 1);
    const setKey  = rest.slice(0, rest.lastIndexOf('_'));

    if (uid !== ownerId) return interaction.reply({ ephemeral: true, content: '⛔ Bu buton sana ait değil.' });
    const def = RELIC_SETS[setKey];
    if (!def) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz set.' });

    const result = equipRelicSet(gid, uid, setKey);
    if (!result.ok) {
      if (result.reason === 'already') return interaction.reply({ ephemeral: true, content: `${def.emoji} **${def.name}** zaten kuşanılı.` });
      if (result.reason === 'full') {
        const equipped = getEquippedRelicSets(gid, uid).map(k => RELIC_SETS[k]?.name).filter(Boolean).join(', ');
        return interaction.reply({ ephemeral: true, content: `⛔ Aynı anda en fazla **${RELIC_SET_MAX_EQUIPPED} set** kuşanabilirsin! (Şu an: ${equipped})\nÖnce \`/relic-set\` üzerinden birini **Çıkar**.` });
      }
      if (result.reason === 'class') {
        const clsDef = RPG_CLASSES.find(c => c.key === result.requiredClass);
        return interaction.reply({ ephemeral: true, content: `⛔ ${def.emoji} **${def.name}** yalnızca **${clsDef?.emoji || ''} ${clsDef?.name || result.requiredClass}** sınıfı tarafından kuşanılabilir!\n\`/sinif\` komutuyla bu yolu seçmen gerekiyor.` });
      }
      return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz set.' });
    }
    return interaction.reply({ ephemeral: true, content: `✅ ${def.emoji} **${def.name}** kuşanıldı! Set bonusları artık aktif.` });
  }

  if (id.startsWith('mmo_unequipset_')) {
    const rest = id.slice('mmo_unequipset_'.length);
    const ownerId = rest.slice(rest.lastIndexOf('_') + 1);
    const setKey  = rest.slice(0, rest.lastIndexOf('_'));

    if (uid !== ownerId) return interaction.reply({ ephemeral: true, content: '⛔ Bu buton sana ait değil.' });
    const def = RELIC_SETS[setKey];
    if (!def) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz set.' });

    unequipRelicSet(gid, uid, setKey);
    return interaction.reply({ ephemeral: true, content: `🔻 ${def.emoji} **${def.name}** çıkarıldı. Set bonusları artık pasif.` });
  }

  if (id.startsWith('mmo_inv_')) {
    const parts   = id.split('_');
    const tab     = parts[2];
    const ownerId = parts[3];

    if (uid !== ownerId) {
      return interaction.reply({ ephemeral: true, content: '⛔ Bu envanter sana ait değil.' });
    }

    const tabs = [
      { key: 'genel',    emoji: '🎒', label: 'Genel'        },
      { key: 'ekipman',  emoji: '⚔️', label: 'Ekipman'      },
      { key: 'sandik',   emoji: '📦', label: 'Sandık'       },
      { key: 'pet',      emoji: '🐉', label: 'Pet'          },
      { key: 'relic',    emoji: '💎', label: 'Relic'        },
      { key: 'craft',    emoji: '🧪', label: 'Craft'        },
      { key: 'antika',   emoji: '🖼️', label: 'Antika'       },
      { key: 'tuket',    emoji: '🍖', label: 'Tüketilebilir' },
    ];

    return showInventory(interaction, gid, uid, tab, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  SELECT MENU HANDLER
// ─────────────────────────────────────────────────────────────────────────
async function handleMMOSelect(interaction) {
  const id  = interaction.customId;
  const gid = interaction.guild?.id;
  const uid = interaction.user.id;

  if (id === 'mmo_stat_upgrade') {
    const stat   = interaction.values[0];
    const result = upgradeRpgStat(gid, uid, stat);

    if (!result.ok) {
      if (result.reason === 'max')  return interaction.update({ content: '⛔ Bu stat zaten maksimum!', embeds: [], components: [] });
      if (result.reason === 'coin') return interaction.update({ content: `⛔ Yetersiz coin! Gerekli: **${result.cost}**`, embeds: [], components: [] });
    }

    const info = RPG_STAT_NAMES[stat];
    return interaction.update({
      content: `✅ ${info.emoji} **${info.name}** → **Lv.${result.newLevel}** yükseltildi! (-${result.cost} coin)\n💰 Kalan: **${getBalance(gid, uid).balance}** coin`,
      embeds: [],
      components: [],
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  YARDIMCI FONKSİYONLAR
// ─────────────────────────────────────────────────────────────────────────
function buildBar(current, max, length = 10) {
  const filled = Math.round((current / max) * length);
  return '█'.repeat(Math.min(filled, length)) + '░'.repeat(Math.max(length - filled, 0));
}

function buildChestResultDesc(result) {
  if (result.type === 'coin')        return `💰 **${result.amount} Coin** kazandın!`;
  if (result.type === 'craft_mat') {
    const def = CRAFT_MATERIALS.find(m => m.key === result.matKey);
    return `${def?.emoji || '🔩'} **${def?.name || result.matKey}** × ${result.quantity} craft malzemesi düştü!`;
  }
  if (result.type === 'egg') {
    const def = PET_EGG_TYPES.find(e => e.key === result.eggType);
    return `${def?.emoji || '🥚'} **${def?.name}** kazandın! \`/yumurta ac\` ile aç.`;
  }
  if (result.type === 'chest') {
    const def = MMORPG_CHESTS.find(c => c.key === result.chestType);
    return `${def?.emoji || '📦'} İçinden **${def?.name}** çıktı!`;
  }
  if (result.type === 'relic_piece') {
    const def = ALL_NEW_RELIC_PIECES.find(p => p.key === result.relicKey);
    return `${def?.emoji || '💎'} **Relic Parçası:** ${def?.name || result.relicKey} envanterine eklendi!`;
  }
  if (result.type === 'antique') {
    return `${result.antique?.emoji || '🏺'} **Antika:** ${result.antique?.name} bulundu!`;
  }
  return `✅ Sandık açıldı!`;
}

// ─────────────────────────────────────────────────────────────────────────
//  DURUM NOTU — Relic Set entegrasyonu (TAMAMLANDI)
//  Relic Set parçası satın alma /relic-set komutundaki butonlarla ve
//  handleMMOButton() içindeki 'mmo_buyrelic_' handler'ıyla çalışıyor.
//  Bonus entegrasyonu:
//    getRelicSetCoinBonus  → getTotalCoinBonusPct içinde
//    getRelicSetXpBonus    → getRelicXpBonus içinde
//    getRelicSetDailyBonus → getTotalDailyBonusPct içinde
//    getRelicSetFishBonus  → /balik-sat içinde
//    getRelicSetMineBonus  → mine_sell (madencilik satışı) içinde        [Gölge]
//    getRelicSetWoodBonus  → wood_sell (odunculuk satışı) içinde        [Güneş]
//    getRelicSetStealBonus → /çal ve /oyunlar cal (iptal süresini kısaltır) [Gölge]
//    getRelicSetBossBonus  → enterDungeon (relic parçası/antika drop şansı) [Gölge, full]
//    getRelicSetCritBonus  → enterDungeon (kritik vuruş: +%50 ödül şansı)  [Fırtına]
//    getRelicSetSlotBonus  → /slot (artık RELIC_SETS'ten dinamik okunuyor) [Fırtına, full]
//    getRelicSetPetXpBonus → getPetXpBonus içinde (pet XP bonusunu güçlendirir) [Güneş, full]
//
//  KUŞANMA SINIRI: Aynı anda en fazla RELIC_SET_MAX_EQUIPPED (2) set kuşanılabilir.
//  Parça sahipliği (relics tablosu) ile kuşanma (active_relic_sets tablosu) AYRI
//  şeylerdir — bir set 6/6 parça olsa bile kuşanılmadıysa bonusu SIFIRDIR.
//  Kuşan/Çıkar: /relic-set ekranındaki butonlar → equipRelicSet()/unequipRelicSet().
//  Fiyat: her parça 20.000 coin (tüm tier'lerde eşit), tam set 120.000 coin —
//  satın almayı caydırıp craftlamayı özendirmek için kasıtlı yüksek tutuldu.
// ─────────────────────────────────────────────────────────────────────────
//  DURUM NOTU — Zindan Zorluğu / RPG Stat Gücü (TAMAMLANDI)
//  /stat artık gerçekten işlevsel: 7 statın toplamı (getRpgPowerScore) bir
//  "Güç" puanı oluşturur (min 7, max 350). Her zindanın requiredPower alanı
//  var; getDungeonSuccessChance() gücünü requiredPower'a göre kıyaslayıp
//  %15-%95 arası bir başarı şansı hesaplıyor (DUNGEON_SUCCESS_BASE/SLOPE/
//  MIN/MAX sabitleriyle ayarlanır). enterDungeon() artık bu şansı roll'luyor:
//  başarısızlıkta coin/drop YOK, sadece baseXp'nin %25'i (DUNGEON_FAIL_XP_PCT)
//  kadar tecrübe XP'si veriliyor — cooldown yine de tüketiliyor. Zorluk
//  dengesini DUNGEON_SUCCESS_BASE/SLOPE/MIN/MAX ve her dungeon.requiredPower
//  değerinden ayarlayabilirsin.
// ─────────────────────────────────────────────────────────────────────────
//  DURUM NOTU — /fight (Oyuncular Arası Düello) (TAMAMLANDI)
//  Silah/zırh tier'ları artık E/C/B/A/S harfleriyle etiketli (GEAR_GRADE_
//  MULTIPLIER: E×1.0 → S×3.2). getBattlePower() bir oyuncunun toplam dövüş
//  gücünü hesaplar: RPG Seviyesi×3 + Stat Gücü (7-350) + Relic Gücü (tekli
//  relikler×10 + kuşanılı set parçaları×5 + Ejder Seti Lv×15) + en iyi
//  silahın gücü + her zırh slotundaki en iyi parçanın gücü (silah/zırh
//  gücü = taban değer × tier çarpanı × (1+geliştirme×%10)). Manuel bir
//  "kuşanma" sistemi YOK — /fight her zaman sahip olunan EN İYİ ekipmanı
//  otomatik kullanır (mmo_equipped tablosu hâlâ boş/kullanılmıyor; ileride
//  gerçek bir loadout sistemi istenirse buraya bağlanabilir).
//  resolveFight() güç oranına göre %15-%85 arası bir kazanma şansı hesaplar
//  (asla %100 garanti değil), kazanan kaybedenin bakiyesinden Gölge Seti
//  stealPct ile güçlenen bir yüzde çalar (FIGHT_STEAL_PCT/CAP), ikisi de
//  RPG XP kazanır. Meydan okuyan için FIGHT_COOLDOWN_MS (15dk) cooldown var.
// ─────────────────────────────────────────────────────────────────────────

console.log('✅ MMORPG Modülü yüklendi — Komutlar: ' + [...MMO_CMDS].join(', '));


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
