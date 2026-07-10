// ──────────────────────────────────────────────────────────────
//  VERİTABANI — PostgreSQL (kalıcı, restart'lardan etkilenmez)
// ──────────────────────────────────────────────────────────────
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function q(text, params) {
  return pool.query(text, params);
}

// ── Schema ────────────────────────────────────────────────────
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (guild_id, key)
    );
    CREATE TABLE IF NOT EXISTS economy (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      balance INTEGER DEFAULT 0,
      bank INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS marriages (
      guild_id TEXT NOT NULL,
      user1 TEXT NOT NULL,
      user2 TEXT NOT NULL,
      married_at TEXT,
      PRIMARY KEY (guild_id, user1)
    );
    CREATE TABLE IF NOT EXISTS rings (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS voice_time (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      total_seconds INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS daily_claims (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id, date, claim_type)
    );
    CREATE TABLE IF NOT EXISTS daily_counts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, date, claim_type)
    );
    CREATE TABLE IF NOT EXISTS xp_boosts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS message_counts (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, channel_id, user_id, date)
    );
    CREATE TABLE IF NOT EXISTS market_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      price INTEGER DEFAULT 0,
      is_premium INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS level_data (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS theft_shields (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at BIGINT,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS temp_xp_boosts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      uses_left INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS color_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      price INTEGER DEFAULT 50,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS fish_inventory (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      fish_key TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, fish_key)
    );
    CREATE TABLE IF NOT EXISTS fish_boosts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      uses_left INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS chat_coin_counter (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS bank_accounts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at BIGINT,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS fish_cast_state (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      since_line INTEGER DEFAULT 0,
      line_threshold INTEGER DEFAULT 0,
      since_rod INTEGER DEFAULT 0,
      rod_threshold INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  console.log('✅ PostgreSQL şeması hazır.');
}

// ── Ayarlar ───────────────────────────────────────────────────
async function getSetting(gid, key) {
  const r = await q('SELECT value FROM guild_settings WHERE guild_id=$1 AND key=$2', [gid, key]);
  return r.rows[0]?.value ?? null;
}
async function setSetting(gid, key, value) {
  await q(`INSERT INTO guild_settings(guild_id,key,value) VALUES($1,$2,$3)
           ON CONFLICT(guild_id,key) DO UPDATE SET value=$3`, [gid, key, value]);
}
async function getAllSettings(gid) {
  const r = await q('SELECT key, value FROM guild_settings WHERE guild_id=$1', [gid]);
  const o = {};
  for (const row of r.rows) o[row.key] = row.value;
  return o;
}

// ── Ekonomi ───────────────────────────────────────────────────
async function getBalance(gid, uid) {
  const r = await q('SELECT balance, bank FROM economy WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows[0] || { balance: 0, bank: 0 };
}
async function addBalance(gid, uid, amt) {
  await q(`INSERT INTO economy(guild_id,user_id,balance,bank) VALUES($1,$2,0,0)
           ON CONFLICT DO NOTHING`, [gid, uid]);
  await q(`UPDATE economy SET balance=GREATEST(0,balance+$1) WHERE guild_id=$2 AND user_id=$3`, [amt, gid, uid]);
  return getBalance(gid, uid);
}
async function addBank(gid, uid, amt) {
  await q(`INSERT INTO economy(guild_id,user_id,balance,bank) VALUES($1,$2,0,0)
           ON CONFLICT DO NOTHING`, [gid, uid]);
  await q(`UPDATE economy SET bank=GREATEST(0,bank+$1) WHERE guild_id=$2 AND user_id=$3`, [amt, gid, uid]);
  return getBalance(gid, uid);
}
// Atomic: deduct amt from uid only if balance >= amt. Returns new balance row or null if insufficient.
async function deductBalance(gid, uid, amt) {
  const r = await q(
    `UPDATE economy SET balance=balance-$1
     WHERE guild_id=$2 AND user_id=$3 AND balance>=$1
     RETURNING balance, bank`,
    [amt, gid, uid]
  );
  return r.rows[0] || null; // null = insufficient balance
}

async function transfer(gid, from, to, amt) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the sender row to prevent concurrent double-spend
    const bal = await client.query(
      'SELECT balance FROM economy WHERE guild_id=$1 AND user_id=$2 FOR UPDATE',
      [gid, from]
    );
    if (!bal.rows[0] || bal.rows[0].balance < amt) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`UPDATE economy SET balance=balance-$1 WHERE guild_id=$2 AND user_id=$3`, [amt, gid, from]);
    await client.query(`INSERT INTO economy(guild_id,user_id,balance,bank) VALUES($1,$2,0,0) ON CONFLICT DO NOTHING`, [gid, to]);
    await client.query(`UPDATE economy SET balance=balance+$1 WHERE guild_id=$2 AND user_id=$3`, [amt, gid, to]);
    await client.query('COMMIT');
    return true;
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
async function topBalance(gid, n = 10) {
  const r = await q('SELECT user_id, balance FROM economy WHERE guild_id=$1 ORDER BY balance DESC LIMIT $2', [gid, n]);
  return r.rows.map(row => ({ userId: row.user_id, balance: row.balance }));
}

// ── Evlilik ───────────────────────────────────────────────────
async function getMarriage(gid, uid) {
  const r = await q('SELECT * FROM marriages WHERE guild_id=$1 AND (user1=$2 OR user2=$2)', [gid, uid]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { guildId: row.guild_id, user1: row.user1, user2: row.user2, marriedAt: row.married_at };
}
async function setMarriage(gid, u1, u2) {
  const now = nowTR();
  await q(`INSERT INTO marriages(guild_id,user1,user2,married_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [gid, u1, u2, now]);
  await q(`INSERT INTO marriages(guild_id,user1,user2,married_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [gid, u2, u1, now]);
}
async function removeMarriage(gid, uid) {
  const m = await getMarriage(gid, uid);
  if (!m) return;
  await q(`DELETE FROM marriages WHERE guild_id=$1 AND (user1=$2 OR user2=$2 OR user1=$3 OR user2=$3)`,
    [gid, m.user1, m.user2]);
}
async function allMarriages(gid) {
  const r = await q('SELECT * FROM marriages WHERE guild_id=$1', [gid]);
  const seen = new Set();
  return r.rows.filter(row => {
    const k = [row.user1, row.user2].sort().join(':');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(row => ({ user1: row.user1, user2: row.user2, marriedAt: row.married_at }));
}
async function hasRing(gid, uid) {
  const r = await q('SELECT 1 FROM rings WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows.length > 0;
}
async function giveRing(gid, uid) {
  await q(`INSERT INTO rings(guild_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [gid, uid]);
}
async function consumeRing(gid, uid) {
  await q('DELETE FROM rings WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
}

// ── Ses Süresi ────────────────────────────────────────────────
async function addVoiceTime(gid, uid, secs) {
  await q(`INSERT INTO voice_time(guild_id,user_id,total_seconds) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, [gid, uid]);
  await q(`UPDATE voice_time SET total_seconds=total_seconds+$1 WHERE guild_id=$2 AND user_id=$3`, [secs, gid, uid]);
}
async function getVoiceTime(gid, uid) {
  const r = await q('SELECT total_seconds FROM voice_time WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows[0]?.total_seconds ?? 0;
}
async function topVoice(gid, n = 10) {
  const r = await q('SELECT user_id, total_seconds FROM voice_time WHERE guild_id=$1 ORDER BY total_seconds DESC LIMIT $2', [gid, n]);
  return r.rows.map(row => ({ userId: row.user_id, totalSeconds: row.total_seconds }));
}
async function resetVoice(gid) {
  await q('DELETE FROM voice_time WHERE guild_id=$1', [gid]);
}

// ── Günlük Talep ──────────────────────────────────────────────
async function hasClaimed(gid, uid, date, type) {
  const r = await q('SELECT 1 FROM daily_claims WHERE guild_id=$1 AND user_id=$2 AND date=$3 AND claim_type=$4', [gid, uid, date, type]);
  return r.rows.length > 0;
}
async function setClaimed(gid, uid, date, type) {
  await q(`INSERT INTO daily_claims(guild_id,user_id,date,claim_type) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [gid, uid, date, type]);
}
async function getDailyCount(gid, uid, date, type) {
  const r = await q('SELECT count FROM daily_counts WHERE guild_id=$1 AND user_id=$2 AND date=$3 AND claim_type=$4', [gid, uid, date, type]);
  return r.rows[0]?.count ?? 0;
}
async function incDailyCount(gid, uid, date, type, n = 1) {
  await q(`INSERT INTO daily_counts(guild_id,user_id,date,claim_type,count) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING`, [gid, uid, date, type]);
  await q(`UPDATE daily_counts SET count=count+$1 WHERE guild_id=$2 AND user_id=$3 AND date=$4 AND claim_type=$5`, [n, gid, uid, date, type]);
  return getDailyCount(gid, uid, date, type);
}

// ── XP Boost (kalıcı) ─────────────────────────────────────────
async function hasBoost(gid, uid) {
  const r = await q('SELECT 1 FROM xp_boosts WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows.length > 0;
}
async function setBoost(gid, uid) {
  await q(`INSERT INTO xp_boosts(guild_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [gid, uid]);
}

// ── Mesaj Sayacı ──────────────────────────────────────────────
async function addMsgCount(gid, cid, uid, date) {
  await q(`INSERT INTO message_counts(guild_id,channel_id,user_id,date,count) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING`, [gid, cid, uid, date]);
  await q(`UPDATE message_counts SET count=count+1 WHERE guild_id=$1 AND channel_id=$2 AND user_id=$3 AND date=$4`, [gid, cid, uid, date]);
}
async function topMsgs(gid, cid, date, n = 10) {
  const r = await q('SELECT user_id, count FROM message_counts WHERE guild_id=$1 AND channel_id=$2 AND date=$3 ORDER BY count DESC LIMIT $4', [gid, cid, date, n]);
  return r.rows.map(row => ({ userId: row.user_id, count: row.count }));
}
async function resetSohbet(gid) {
  await q('DELETE FROM message_counts WHERE guild_id=$1', [gid]);
}

// ── Market Rolleri ────────────────────────────────────────────
async function getMarketRoles(gid) {
  const r = await q('SELECT role_id, price, is_premium FROM market_roles WHERE guild_id=$1', [gid]);
  return r.rows.map(row => ({ roleId: row.role_id, price: row.price, isPremium: row.is_premium }));
}
async function addMarketRole(gid, rid, price, prem) {
  await q(`INSERT INTO market_roles(guild_id,role_id,price,is_premium) VALUES($1,$2,$3,$4)
           ON CONFLICT(guild_id,role_id) DO UPDATE SET price=$3, is_premium=$4`, [gid, rid, price, prem ? 1 : 0]);
}
async function removeMarketRole(gid, rid) {
  await q('DELETE FROM market_roles WHERE guild_id=$1 AND role_id=$2', [gid, rid]);
}

// ── Seviye / XP ───────────────────────────────────────────────
async function getLevel(gid, uid) {
  const r = await q('SELECT xp, level FROM level_data WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows[0] || { xp: 0, level: 0 };
}
async function addXp(gid, uid, amt) {
  await q(`INSERT INTO level_data(guild_id,user_id,xp,level) VALUES($1,$2,0,0) ON CONFLICT DO NOTHING`, [gid, uid]);
  await q(`UPDATE level_data SET xp=xp+$1 WHERE guild_id=$2 AND user_id=$3`, [amt, gid, uid]);
  const d = await getLevel(gid, uid);
  const needed = Math.round((d.level + 1) * 100 * 0.85);
  if (d.xp >= needed) {
    await q(`UPDATE level_data SET level=level+1, xp=xp-$1 WHERE guild_id=$2 AND user_id=$3`, [needed, gid, uid]);
    return { leveled: true, newLevel: d.level + 1, xpGained: amt };
  }
  return { leveled: false, xpGained: amt };
}
async function topLevels(gid, n = 10) {
  const r = await q('SELECT user_id, level, xp FROM level_data WHERE guild_id=$1 ORDER BY level DESC, xp DESC LIMIT $2', [gid, n]);
  return r.rows.map(row => ({ userId: row.user_id, level: row.level, xp: row.xp }));
}

// ── Hırsızlık Kalkanı ─────────────────────────────────────────
async function hasShield(gid, uid) {
  const r = await q('SELECT expires_at FROM theft_shields WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  if (!r.rows[0]) return false;
  if (parseInt(r.rows[0].expires_at) < Date.now()) {
    await q('DELETE FROM theft_shields WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
    return false;
  }
  return true;
}
async function setShield(gid, uid, ms) {
  await q(`INSERT INTO theft_shields(guild_id,user_id,expires_at) VALUES($1,$2,$3)
           ON CONFLICT(guild_id,user_id) DO UPDATE SET expires_at=$3`, [gid, uid, Date.now() + ms]);
}

// ── Geçici XP Boost ───────────────────────────────────────────
async function getTempBoostUses(gid, uid) {
  const r = await q('SELECT uses_left FROM temp_xp_boosts WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows[0]?.uses_left ?? 0;
}
async function hasTempBoost(gid, uid) { return (await getTempBoostUses(gid, uid)) > 0; }
async function addTempBoostUses(gid, uid, n) {
  await q(`INSERT INTO temp_xp_boosts(guild_id,user_id,uses_left) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, [gid, uid]);
  await q(`UPDATE temp_xp_boosts SET uses_left=uses_left+$1 WHERE guild_id=$2 AND user_id=$3`, [n, gid, uid]);
}
async function consumeTempBoost(gid, uid) {
  if (!await hasTempBoost(gid, uid)) return false;
  await q(`UPDATE temp_xp_boosts SET uses_left=uses_left-1 WHERE guild_id=$1 AND user_id=$2`, [gid, uid]);
  return true;
}
async function getBoostMultiplier(gid, uid, consume = true) {
  let m = 1;
  if (await hasBoost(gid, uid)) m *= 1.5;
  if (await hasTempBoost(gid, uid)) {
    m *= 2;
    if (consume) await consumeTempBoost(gid, uid);
  }
  return m;
}

// ── Banka Hesabı ──────────────────────────────────────────────
async function hasBankAccount(gid, uid) {
  const r = await q('SELECT 1 FROM bank_accounts WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows.length > 0;
}
async function createBankAccount(gid, uid) {
  await q(`INSERT INTO bank_accounts(guild_id,user_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [gid, uid, Date.now()]);
  await q(`INSERT INTO economy(guild_id,user_id,balance,bank) VALUES($1,$2,0,0) ON CONFLICT DO NOTHING`, [gid, uid]);
}

// ── Renk Rolleri ──────────────────────────────────────────────
async function getColorRoles(gid) {
  const r = await q('SELECT role_id, price FROM color_roles WHERE guild_id=$1', [gid]);
  return r.rows.map(row => ({ roleId: row.role_id, price: row.price }));
}
async function addColorRole(gid, rid, price = 50) {
  await q(`INSERT INTO color_roles(guild_id,role_id,price) VALUES($1,$2,$3)
           ON CONFLICT(guild_id,role_id) DO UPDATE SET price=$3`, [gid, rid, price]);
}
async function removeColorRole(gid, rid) {
  await q('DELETE FROM color_roles WHERE guild_id=$1 AND role_id=$2', [gid, rid]);
}

// ── Sohbet Coin Sayacı ────────────────────────────────────────
async function incChatCoinCounter(gid, uid) {
  await q(`INSERT INTO chat_coin_counter(guild_id,user_id,count) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, [gid, uid]);
  await q(`UPDATE chat_coin_counter SET count=count+1 WHERE guild_id=$1 AND user_id=$2`, [gid, uid]);
  const r = await q('SELECT count FROM chat_coin_counter WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows[0]?.count ?? 0;
}

// ── Balık Envanteri ───────────────────────────────────────────
async function addFish(gid, uid, key, n = 1) {
  await q(`INSERT INTO fish_inventory(guild_id,user_id,fish_key,count) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING`, [gid, uid, key]);
  await q(`UPDATE fish_inventory SET count=count+$1 WHERE guild_id=$2 AND user_id=$3 AND fish_key=$4`, [n, gid, uid, key]);
}
async function getFishCount(gid, uid, key) {
  const r = await q('SELECT count FROM fish_inventory WHERE guild_id=$1 AND user_id=$2 AND fish_key=$3', [gid, uid, key]);
  return r.rows[0]?.count ?? 0;
}
async function removeFish(gid, uid, key, n) {
  const cur = await getFishCount(gid, uid, key);
  if (cur < n) return false;
  await q(`UPDATE fish_inventory SET count=count-$1 WHERE guild_id=$2 AND user_id=$3 AND fish_key=$4`, [n, gid, uid, key]);
  return true;
}
async function getInventory(gid, uid) {
  const r = await q('SELECT fish_key, count FROM fish_inventory WHERE guild_id=$1 AND user_id=$2 AND count>0', [gid, uid]);
  return r.rows.map(row => ({ fishKey: row.fish_key, count: row.count }));
}

// ── Balıkçılık Şansı Boost ────────────────────────────────────
async function getFishBoostUses(gid, uid) {
  const r = await q('SELECT uses_left FROM fish_boosts WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  return r.rows[0]?.uses_left ?? 0;
}
async function addFishBoostUses(gid, uid, n) {
  await q(`INSERT INTO fish_boosts(guild_id,user_id,uses_left) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, [gid, uid]);
  await q(`UPDATE fish_boosts SET uses_left=uses_left+$1 WHERE guild_id=$2 AND user_id=$3`, [n, gid, uid]);
}
async function consumeFishBoost(gid, uid) {
  const u = await getFishBoostUses(gid, uid);
  if (u <= 0) return false;
  await q(`UPDATE fish_boosts SET uses_left=uses_left-1 WHERE guild_id=$1 AND user_id=$2`, [gid, uid]);
  return true;
}

// ── Balık Cast State ─────────────────────────────────────────
function randBetween(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

async function getFishCastState(gid, uid) {
  const r = await q('SELECT * FROM fish_cast_state WHERE guild_id=$1 AND user_id=$2', [gid, uid]);
  if (!r.rows[0]) {
    const state = {
      since_line: 0, line_threshold: randBetween(4, 8),
      since_rod: 0, rod_threshold: randBetween(20, 30),
    };
    await q(`INSERT INTO fish_cast_state(guild_id,user_id,since_line,line_threshold,since_rod,rod_threshold)
             VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [gid, uid, state.since_line, state.line_threshold, state.since_rod, state.rod_threshold]);
    return state;
  }
  return r.rows[0];
}
async function saveFishCastState(gid, uid, state) {
  await q(`UPDATE fish_cast_state SET since_line=$1, line_threshold=$2, since_rod=$3, rod_threshold=$4
           WHERE guild_id=$5 AND user_id=$6`,
    [state.since_line, state.line_threshold, state.since_rod, state.rod_threshold, gid, uid]);
}

// ── Sıfırlama ─────────────────────────────────────────────────
async function resetGuild(gid) {
  const tables = [
    'economy','marriages','rings','xp_boosts','daily_claims','daily_counts',
    'message_counts','voice_time','level_data','theft_shields','temp_xp_boosts',
    'color_roles','fish_inventory','fish_boosts','chat_coin_counter',
    'bank_accounts','fish_cast_state'
  ];
  for (const t of tables) {
    await q(`DELETE FROM ${t} WHERE guild_id=$1`, [gid]);
  }
}

// ── Tarih yardımcıları (db.js'de kullanılanlar) ───────────────
function nowTR() { return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }); }

module.exports = {
  pool, initSchema,
  getSetting, setSetting, getAllSettings,
  getBalance, addBalance, addBank, deductBalance, transfer, topBalance,
  getMarriage, setMarriage, removeMarriage, allMarriages,
  hasRing, giveRing, consumeRing,
  addVoiceTime, getVoiceTime, topVoice, resetVoice,
  hasClaimed, setClaimed, getDailyCount, incDailyCount,
  hasBoost, setBoost,
  addMsgCount, topMsgs, resetSohbet,
  getMarketRoles, addMarketRole, removeMarketRole,
  getLevel, addXp, topLevels,
  hasShield, setShield,
  getTempBoostUses, hasTempBoost, addTempBoostUses, consumeTempBoost, getBoostMultiplier,
  hasBankAccount, createBankAccount,
  getColorRoles, addColorRole, removeColorRole,
  incChatCoinCounter,
  addFish, getFishCount, removeFish, getInventory,
  getFishBoostUses, addFishBoostUses, consumeFishBoost,
  getFishCastState, saveFishCastState, randBetween,
  resetGuild,
};
