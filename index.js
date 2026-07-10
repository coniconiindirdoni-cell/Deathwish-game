// ╔══════════════════════════════════════════════════════════════╗
// ║  DeathWish Game Bot — PostgreSQL Edition (v3.0)              ║
// ║  Veriler artık PostgreSQL'de kalıcı — restart'ta kaybolmaz! ║
// ╚══════════════════════════════════════════════════════════════╝

require('dotenv').config();
const {
  Client, GatewayIntentBits, Collection, ActivityType, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  SlashCommandBuilder, PermissionFlagsBits, ComponentType, ChannelType,
} = require('discord.js');

const db = require('./db.js');

// ── AYARLAR ─────────────────────────────────────────────────
const TOKEN  = process.env.DISCORD_TOKEN || '';
const OWNERS = (process.env.OWNERS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TOKEN) { console.error('⛔ DISCORD_TOKEN bulunamadı!'); process.exit(1); }

const OWNER_ROLE_ID = '1524107651510702160';
function hasOwnerAccess(userId, member) {
  if (OWNERS.includes(userId)) return true;
  if (member?.roles?.cache?.has(OWNER_ROLE_ID)) return true;
  return false;
}

// ── OYUN VERİLERİ ────────────────────────────────────────────
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

const DICE_GIFS   = [
  'https://media.tenor.com/9UeW5Qm4rREAAAAM/dice-roll.gif',
  'https://media.tenor.com/vyPpM1mR9WgAAAAM/rolling-dice.gif',
  'https://media.tenor.com/1Qm6kQxRMgAAAAAM/dices.gif',
];
const COOKED_GIFS = [
  'https://media.tenor.com/L7bG8GkZZxQAAAAM/gordon-ramsay-cooked.gif',
  'https://media.tenor.com/8y0K0b2v8b0AAAAM/burn-fire.gif',
  'https://media.tenor.com/3j2sQwEw1yAAAAAM/you-are-cooked.gif',
];
const PROPOSAL_HAPPY_GIFS = [
  'https://media.tenor.com/3zRz0Vt2sHIAAAAM/ring-propose.gif',
  'https://media.tenor.com/WYQv8r2m5LgAAAAM/marriage-proposal-propose.gif',
  'https://media.tenor.com/3qY9hQw9gAkAAAAM/marry-me-proposal.gif',
];
const PROPOSAL_SAD_GIFS = [
  'https://media.tenor.com/jjH1h1Q8fQoAAAAM/sad-anime.gif',
  'https://media.tenor.com/-cBz3s7f7GMAAAAM/sad-cry.gif',
  'https://media.tenor.com/7BqZyq7n0xAAAAAM/rejected.gif',
];

const FISH_TYPES = [
  { key: 'sardalya', name: 'Sardalya',            emoji: '🐟', value: 1,  weight: 30   },
  { key: 'hamsi',    name: 'Hamsi',                emoji: '🐠', value: 2,  weight: 26   },
  { key: 'levrek',   name: 'Levrek',               emoji: '🐡', value: 5,  weight: 18   },
  { key: 'cupra',    name: 'Çipura',               emoji: '🐟', value: 8,  weight: 13   },
  { key: 'somon',    name: 'Somon',                emoji: '🍣', value: 14, weight: 8    },
  { key: 'ton',      name: 'Ton Balığı',           emoji: '🐋', value: 22, weight: 4.5  },
  { key: 'yilanbal', name: 'Yılan Balığı',         emoji: '🐍', value: 30, weight: 2.5  },
  { key: 'kilic',    name: 'Kılıç Balığı',         emoji: '⚔️', value: 38, weight: 1.2  },
  { key: 'orkinos',  name: 'Dev Orkinos',          emoji: '🐳', value: 45, weight: 0.6  },
  { key: 'ejder',    name: 'Efsanevi Ejder Balığı',emoji: '🐉', value: 50, weight: 0.2  },
];

function pickFish(boosted) {
  let pool = FISH_TYPES.map(f => ({ ...f }));
  if (boosted) pool = pool.map(f => ({ ...f, weight: f.value >= 14 ? f.weight * 3 : f.weight }));
  const total = pool.reduce((a, f) => a + f.weight, 0);
  let r = Math.random() * total;
  for (const f of pool) { if (r < f.weight) return f; r -= f.weight; }
  return pool[0];
}

const FISH_MARKET_REFRESH_MS = 6 * 60 * 60 * 1000;
let fishMarketPool = null, fishMarketGeneratedAt = 0;
function generateFishMarketPool() {
  const pool = {};
  for (const f of FISH_TYPES) {
    const roll = Math.random();
    let value;
    if (roll < 0.05)       value = 30 + Math.floor(Math.random() * 21);
    else if (roll < 0.35)  value = 1;
    else { const v = f.value * 0.4; value = Math.max(1, Math.round(f.value + (Math.random() * 2 - 1) * v)); }
    pool[f.key] = value;
  }
  fishMarketPool = pool; fishMarketGeneratedAt = Date.now();
  return pool;
}
function ensureFishMarketPool() {
  if (!fishMarketPool || Date.now() - fishMarketGeneratedAt >= FISH_MARKET_REFRESH_MS) generateFishMarketPool();
  return fishMarketPool;
}
function getFishValue(key) {
  const pool = ensureFishMarketPool();
  return pool[key] ?? FISH_TYPES.find(f => f.key === key)?.value ?? 1;
}
function startFishMarketRefresh() {
  ensureFishMarketPool();
  setInterval(generateFishMarketPool, FISH_MARKET_REFRESH_MS);
  console.log('🎣 Balık market fiyat havuzu başlatıldı.');
}

const EMPTY_CAST_CHANCE = 0.18;
const LINE_SNAP_COST    = 2;
const ROD_BREAK_COST    = 5;

async function resolveFishCast(gid, uid, boosted) {
  const state = await db.getFishCastState(gid, uid);
  state.since_line++;
  state.since_rod++;
  if (state.since_rod >= state.rod_threshold) {
    state.since_rod = 0; state.rod_threshold = db.randBetween(20, 30);
    state.since_line = 0; state.line_threshold = db.randBetween(4, 8);
    await db.saveFishCastState(gid, uid, state);
    return { type: 'rod_break' };
  }
  if (state.since_line >= state.line_threshold) {
    state.since_line = 0; state.line_threshold = db.randBetween(4, 8);
    await db.saveFishCastState(gid, uid, state);
    return { type: 'line_snap' };
  }
  await db.saveFishCastState(gid, uid, state);
  if (Math.random() < EMPTY_CAST_CHANCE) return { type: 'empty' };
  return { type: 'catch', fish: pickFish(boosted) };
}

function resolveWinAmount(bet) {
  if (Math.random() < 0.001) return bet * 5;
  return bet * 2;
}

// ── SEVIYE ÖDÜL ROLLERİ ──────────────────────────────────────
const LEVEL_ROLE_REWARDS = {
  5:  '1524109066929045626',
  10: '1524109231719190678',
  20: '1524110815907811609',
  25: '1524112620976869446',
  30: '1524885044055773345',
  40: '1524885000112177203',
  50: '1524112044796805152',
};

// ── YARDIMCILAR ───────────────────────────────────────────────
function todayTR()  { return new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }).split('.').reverse().join('-'); }
function nowTR()    { return new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }); }
function fmtVoice(s){ return `${Math.floor(s/3600)}sa ${Math.floor((s%3600)/60)}dk ${s%60}sn`; }
function fmtMin(s)  { return `${Math.floor(s/60)} dk ${s%60} sn`; }
function pick(arr)  { return arr[Math.floor(Math.random() * arr.length)]; }
function normalizeTR(s) {
  return String(s||'').toLocaleLowerCase('tr').replace(/[.,;:!?'"~^_()[\]{}<>/@#$%&=+\\|-]/g,' ').replace(/\s+/g,' ').trim();
}
function isWithinIstanbulWindow() {
  const h = (new Date().getUTCHours() + 3) % 24;
  return h >= 13 || h < 4;
}

// ── IN-MEMORY DURUM ───────────────────────────────────────────
const diceLossStreak    = new Map();
const activeTypingGames = new Map();
const dailyTypingWins   = new Map();
const activeSteals      = new Set();
const proposalCooldown  = new Map();
const voiceJoinTimes    = new Map();
const voiceDailySec     = new Map();
const voiceDailyClaimed = new Map();
const fishCooldown      = new Map();
const activeBlackjack   = new Map();
const activeRaces       = new Map();
let stealUseCounter     = 0;

// ── BANKA MUAF KOMUTLAR ───────────────────────────────────────
const BANK_EXEMPT_COMMANDS = new Set(['setup','yardim','banka']);

// ── SLASH KOMUTLAR ────────────────────────────────────────────
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Bot ayar panelini aç (sadece yöneticiler)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('banka')
    .setDescription('Banka hesabı işlemleri')
    .addSubcommand(s => s.setName('olustur').setDescription('Banka hesabı oluştur (diğer tüm komutlar için zorunlu)')),

  new SlashCommandBuilder()
    .setName('yardim')
    .setDescription('DeathWish Game komut rehberi'),

  new SlashCommandBuilder()
    .setName('ekonomi')
    .setDescription('Ekonomi komutları')
    .addSubcommand(s => s.setName('bakiye').setDescription('Coin bakiyeni gör').addUserOption(o => o.setName('kullanici').setDescription('Kullanıcı (boş=kendin)')))
    .addSubcommand(s => s.setName('gunluk').setDescription('Günlük ödülü al'))
    .addSubcommand(s => s.setName('yatir').setDescription('Bankaya coin yatır').addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('cek').setDescription('Bankadan coin çek').addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('gonder').setDescription('Başka birine coin gönder').addUserOption(o => o.setName('hedef').setDescription('Hedef kullanıcı').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('siralama').setDescription('Coin sıralamasını gör'))
    .addSubcommand(s => s.setName('ver').setDescription('[OWNER] Kullanıcıya coin ver').addUserOption(o => o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('al').setDescription('[OWNER] Kullanıcıdan coin al').addUserOption(o => o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('xp')
    .setDescription('XP ve seviye komutları')
    .addSubcommand(s => s.setName('seviye').setDescription('Seviye bilgisi').addUserOption(o => o.setName('hedef').setDescription('Kullanıcı (boş=kendin)')))
    .addSubcommand(s => s.setName('siralama').setDescription('Seviye sıralaması'))
    .addSubcommand(s => s.setName('ver').setDescription('[OWNER] Kullanıcıya XP ver').addUserOption(o => o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o => o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('ses')
    .setDescription('Ses süresi komutları')
    .addSubcommand(s => s.setName('benim').setDescription('Kendi ses süren'))
    .addSubcommand(s => s.setName('siralama').setDescription('Ses süresi sıralaması'))
    .addSubcommand(s => s.setName('gorev').setDescription('Günlük ses görevi durumu'))
    .addSubcommand(s => s.setName('sifirla').setDescription('[OWNER] Ses verilerini sıfırla')),

  new SlashCommandBuilder()
    .setName('sohbet')
    .setDescription('Sohbet mesaj sayacı komutları')
    .addSubcommand(s => s.setName('siralama').setDescription('Bugünkü mesaj liderliği'))
    .addSubcommand(s => s.setName('durum').setDescription('Pasif coin kazanımı hakkında bilgi'))
    .addSubcommand(s => s.setName('sifirla').setDescription('[OWNER] Sohbet sayaçlarını sıfırla')),

  new SlashCommandBuilder()
    .setName('zar')
    .setDescription('Zar oyunu')
    .addSubcommand(s => s.setName('ust').setDescription('Zarı üst için at (4–6 = üst)'))
    .addSubcommand(s => s.setName('alt').setDescription('Zarı alt için at (1–3 = alt)'))
    .addSubcommand(s => s.setName('bonus').setDescription('Günlük zar bonusu al (+15 coin)')),

  new SlashCommandBuilder()
    .setName('yazitura')
    .setDescription('Yazı/tura oyunu (kazanırsan +2, kaybedersen -1 coin)')
    .addStringOption(o => o.setName('secim').setDescription('yazı veya tura').setRequired(true)
      .addChoices({ name: 'yazı', value: 'yazı' }, { name: 'tura', value: 'tura' })),

  new SlashCommandBuilder()
    .setName('yazioyunu')
    .setDescription('Yazı oyunu komutları')
    .addSubcommand(s => s.setName('baslat').setDescription('Yazı oyununu başlat'))
    .addSubcommand(s => s.setName('iptal').setDescription('Aktif yazı oyununu iptal et (yetkili)'))
    .addSubcommand(s => s.setName('bonus').setDescription('Günlük yazı bonusu al (+15 coin)')),

  new SlashCommandBuilder()
    .setName('evlilik')
    .setDescription('Evlilik komutları')
    .addSubcommand(s => s.setName('yuzuk-al').setDescription('Evlilik yüzüğü al (150 coin)'))
    .addSubcommand(s => s.setName('yuzugum').setDescription('Yüzük durumunu gör'))
    .addSubcommand(s => s.setName('evlen').setDescription('Birine evlilik teklifi et').addUserOption(o => o.setName('hedef').setDescription('Hedef kullanıcı').setRequired(true)))
    .addSubcommand(s => s.setName('esim').setDescription('Eşini gör'))
    .addSubcommand(s => s.setName('bosan').setDescription('Boşan (130 coin)'))
    .addSubcommand(s => s.setName('liste').setDescription('Tüm evlilikler'))
    .addSubcommand(s => s.setName('ciftyazitura').setDescription('Evlilere özel yazı/tura (+5/-3 coin, günlük 10)')
      .addStringOption(o => o.setName('secim').setDescription('yazı veya tura').setRequired(true)
        .addChoices({ name: 'yazı', value: 'yazı' }, { name: 'tura', value: 'tura' }))),

  new SlashCommandBuilder()
    .setName('market')
    .setDescription('Market komutları')
    .addSubcommand(s => s.setName('liste').setDescription('Market listesini gör'))
    .addSubcommand(s => s.setName('al').setDescription('Rol satın al').addStringOption(o => o.setName('rolid').setDescription('Rol ID').setRequired(true)))
    .addSubcommand(s => s.setName('iade').setDescription('Rolü iade et').addStringOption(o => o.setName('rolid').setDescription('Rol ID').setRequired(true)))
    .addSubcommand(s => s.setName('esyalar').setDescription('Özel eşyaları gör'))
    .addSubcommand(s => s.setName('esya-al').setDescription('Özel eşya satın al')
      .addStringOption(o => o.setName('esya').setDescription('Eşya').setRequired(true)
        .addChoices({ name: '🛡️ Hırsızlık Kalkanı (45 coin)', value: 'kalkan' }, { name: '⚡ Geçici XP Boost (80 coin, 50 kullanım)', value: 'gecici_boost' }))),

  new SlashCommandBuilder()
    .setName('market-yonet')
    .setDescription('Market yönetimi (admin)')
    .addSubcommand(s => s.setName('ekle').setDescription('Markete rol ekle')
      .addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true))
      .addIntegerOption(o => o.setName('fiyat').setDescription('Fiyat').setRequired(true).setMinValue(1))
      .addBooleanOption(o => o.setName('premium').setDescription('Premium rol mu?')))
    .addSubcommand(s => s.setName('cikar').setDescription('Marketten rol çıkar').addRoleOption(o => o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand(s => s.setName('liste').setDescription('Market rol listesi')),

  new SlashCommandBuilder()
    .setName('oyunlar')
    .setDescription('Eğlence / oyun komutları')
    .addSubcommand(s => s.setName('sanskutusu').setDescription('Şans kutusu aç (8 coin, günlük 5 hak)'))
    .addSubcommand(s => s.setName('cal').setDescription('Birinin coinini çalmaya çalış').addUserOption(o => o.setName('hedef').setDescription('Hedef kullanıcı').setRequired(true))),

  new SlashCommandBuilder()
    .setName('xpboost')
    .setDescription('Kalıcı 1.5x XPBoost satın al (400 coin)'),

  new SlashCommandBuilder()
    .setName('renk')
    .setDescription('İsim rengi rolü komutları')
    .addSubcommand(s => s.setName('al').setDescription('Renk rolü satın al (50 coin, sadece 1 tane sahip olabilirsin)'))
    .addSubcommand(s => s.setName('liste').setDescription('Mevcut renk rollerini gör')),

  new SlashCommandBuilder()
    .setName('balik')
    .setDescription('Balıkçılık komutları')
    .addSubcommand(s => s.setName('tut').setDescription('Balık tutmayı dene'))
    .addSubcommand(s => s.setName('envanter').setDescription('Balık envanterini gör'))
    .addSubcommand(s => s.setName('boost-al').setDescription('Balıkçılık Şansı Boost satın al (200 coin, 100 kullanım)'))
    .addSubcommand(s => s.setName('durum').setDescription('Boost durumunu gör')),

  new SlashCommandBuilder()
    .setName('balik-market')
    .setDescription('Balık marketi')
    .addSubcommand(s => s.setName('liste').setDescription('Balık fiyat listesi'))
    .addSubcommand(s => s.setName('sat').setDescription('Balığını markete sat')
      .addStringOption(o => o.setName('balik').setDescription('Balık türü').setRequired(true)
        .addChoices(...FISH_TYPES.map(f => ({ name: `${f.emoji} ${f.name} (${f.value} coin)`, value: f.key }))))
      .addIntegerOption(o => o.setName('adet').setDescription('Adet').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('oyuncuya-sat').setDescription('Balığını başka bir üyeye sat')
      .addUserOption(o => o.setName('hedef').setDescription('Alıcı').setRequired(true))
      .addStringOption(o => o.setName('balik').setDescription('Balık türü').setRequired(true)
        .addChoices(...FISH_TYPES.map(f => ({ name: `${f.emoji} ${f.name} (${f.value} coin)`, value: f.key }))))
      .addIntegerOption(o => o.setName('adet').setDescription('Adet').setRequired(true).setMinValue(1))
      .addIntegerOption(o => o.setName('fiyat').setDescription('Toplam fiyat (coin)').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('yirmibir')
    .setDescription('Blackjack (21) oyna — botla')
    .addIntegerOption(o => o.setName('bahis').setDescription('Bahis miktarı').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('atyarisi')
    .setDescription('At yarışına bahis koy (20 saniyelik paylaşımlı yarış penceresi)')
    .addIntegerOption(o => o.setName('at').setDescription('At numarası (1-6)').setRequired(true).setMinValue(1).setMaxValue(6))
    .addIntegerOption(o => o.setName('bahis').setDescription('Bahis miktarı').setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName('sifirla')
    .setDescription('[OWNER] Sunucu verilerini sıfırla')
    .addSubcommand(s => s.setName('hersey').setDescription('[OWNER] Tüm sunucu verilerini sil')),

].map(c => c.toJSON());

// ── CLIENT ────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ── READY ─────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot aktif: ${client.user.tag}`);
  try {
    await db.initSchema();
  } catch (e) {
    console.error('⛔ Veritabanı şema hatası:', e);
    process.exit(1);
  }
  client.user.setPresence({ activities: [{ name: 'DeathWish Game | /yardim', type: ActivityType.Playing }], status: 'online' });
  try {
    const rest = new REST().setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: SLASH_COMMANDS });
    console.log(`✅ ${SLASH_COMMANDS.length} slash komutu kaydedildi.`);
  } catch (e) { console.error('⛔ Slash kayıt hatası:', e); }
  startFishMarketRefresh();
});

setInterval(() => {
  client.user?.setPresence({ activities: [{ name: 'DeathWish Game | /yardim', type: ActivityType.Playing }], status: 'online' });
}, 14 * 60 * 1000);

// ── LOG YARDIMCISI ────────────────────────────────────────────
async function sendLog(gid, logType, embed) {
  try {
    if (!gid) return;
    const settingKey = logType === 'voice' ? 'log_voice_channel' : `log_${logType}_channel`;
    const chId = await db.getSetting(gid, settingKey);
    if (!chId) return;
    const guild = client.guilds.cache.get(gid);
    if (!guild) return;
    const ch = guild.channels.cache.get(chId);
    if (ch?.isTextBased?.()) await ch.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}
function sendErrorLog(gid, context, err) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('⛔ Hata Logu').setColor(0xED4245)
      .addFields(
        { name: 'Bağlam', value: String(context || 'bilinmiyor') },
        { name: 'Hata', value: `\`\`\`${String(err?.message || err).slice(0, 500)}\`\`\`` },
      ).setTimestamp();
    if (gid) sendLog(gid, 'error', embed);
    else for (const g of client.guilds.cache.values()) sendLog(g.id, 'error', embed);
  } catch {}
}

// ── SES TAKİBİ ───────────────────────────────────────────────
const VOICE_TIERS = [
  { needSec: 3600, reward: 20, label: '60 dk → +20 coin' },
  { needSec: 1800, reward: 10, label: '30 dk → +10 coin' },
  { needSec:  600, reward:  5, label: '10 dk → +5 coin'  },
];

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    const gid = guild?.id; const uid = newState.id || oldState.id;
    if (!gid || !uid) return;
    const key = `${gid}:${uid}`; const was = oldState.channelId, now = newState.channelId; const day = todayTR();

    if (was && (!now || now !== was)) {
      const start = voiceJoinTimes.get(key);
      if (start) {
        const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
        await db.addVoiceTime(gid, uid, diffSec);
        voiceJoinTimes.delete(key);
        const prev = voiceDailySec.get(`${key}:${day}`) || 0;
        voiceDailySec.set(`${key}:${day}`, prev + diffSec);
        await checkVoiceReward(guild, uid, prev + diffSec, day);
      }
    }
    if (now && (!was || was !== now)) voiceJoinTimes.set(key, Date.now());

    const logCh = await db.getSetting(gid, 'log_voice_channel');
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
  } catch(e) { sendErrorLog(null, 'voiceStateUpdate', e); }
});

async function checkVoiceReward(guild, uid, totalSec, day) {
  const gid = guild.id;
  if (!await db.hasBankAccount(gid, uid)) return;
  const claimKey = `${gid}:${uid}:${day}`;
  if (voiceDailyClaimed.get(claimKey)) return;
  const tier = VOICE_TIERS.find(t => totalSec >= t.needSec);
  if (!tier) return;
  const boost = await db.getBoostMultiplier(gid, uid);
  const reward = Math.round(tier.reward * boost);
  await db.addBalance(gid, uid, reward);
  voiceDailyClaimed.set(claimKey, true);
  sendLog(gid, 'coin', new EmbedBuilder()
    .setTitle('💰 Coin — Ses Görevi Ödülü').setColor(0xF1C40F)
    .addFields(
      { name: 'Kullanıcı', value: `<@${uid}>`, inline: true },
      { name: 'Ödül', value: `+${reward} coin`, inline: true },
      { name: 'Tier', value: tier.label, inline: true },
    ).setTimestamp()
  );
  const voiceLogCh = await db.getSetting(gid, 'log_voice_channel');
  if (voiceLogCh) {
    const ch = guild.channels.cache.get(voiceLogCh);
    if (ch?.isTextBased?.()) {
      ch.send(`🎧 <@${uid}> günlük ses görevini tamamladı! **+${reward} coin** (${tier.label}${boost > 1 ? ' • Boost 🔥' : ''})`).catch(() => {});
    }
  }
}

setInterval(async () => {
  try {
    for (const [key, startedAt] of voiceJoinTimes.entries()) {
      const [gid, uid] = key.split(':');
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const day = todayTR();
      const base = voiceDailySec.get(`${key}:${day}`) || 0;
      const live = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      await checkVoiceReward(guild, uid, base + live, day);
    }
  } catch {}
}, 30_000);

// ── MESAJ CREATE ──────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const gid = message.guild.id, uid = message.author.id, cid = message.channel.id;

  // XP kazanma
  try {
    const xpGained = Math.round((Math.floor(Math.random() * 5) + 1) * 1.15);
    const result = await db.addXp(gid, uid, xpGained);
    if (result.leveled) {
      const lvlCh = await db.getSetting(gid, 'level_channel');
      const ch = lvlCh ? message.guild.channels.cache.get(lvlCh) : message.channel;
      if (ch) ch.send(`🎉 <@${uid}> seviye atladı! Yeni seviye: **${result.newLevel}** 🏆`).catch(() => {});
      sendLog(gid, 'level', new EmbedBuilder()
        .setTitle('🏆 Seviye Atlandı!').setColor(0xFFD700)
        .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }, { name: 'Yeni Seviye', value: `${result.newLevel}`, inline: true })
        .setTimestamp()
      );
      const rewardRoleId = LEVEL_ROLE_REWARDS[result.newLevel];
      if (rewardRoleId) {
        try {
          const member = message.member || await message.guild.members.fetch(uid);
          if (member && !member.roles.cache.has(rewardRoleId)) await member.roles.add(rewardRoleId);
        } catch {}
      }
    }
  } catch {}

  // Sohbet pasif coin
  try {
    const sohbetCh = await db.getSetting(gid, 'sohbet_channel');
    if (sohbetCh && cid === sohbetCh && await db.hasBankAccount(gid, uid)) {
      await db.addMsgCount(gid, cid, uid, todayTR());
      const total = await db.incChatCoinCounter(gid, uid);
      if (total % 2 === 0) {
        const mult = await db.getBoostMultiplier(gid, uid);
        const reward = Math.max(1, Math.round(1 * mult));
        await db.addBalance(gid, uid, reward);
      }
    }
  } catch {}

  // Yazı oyunu cevap
  try {
    const yaziCh = await db.getSetting(gid, 'yazi_oyunu_channel');
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
        await db.addBalance(gid, uid, 3);
        return void message.channel.send(`🏆 **${message.author.username}** doğru yazdı ve **+3 coin** kazandı! (Günlük: **${winsToday + 1}/4**)\n> _${game.sentence}_`);
      }
    }
  } catch {}
});

// ── INTERACTION CREATE ────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    // SETUP PANELİ
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      return sendSetupPanel(interaction);
    }

    // RENK ROLÜ SEÇİM MENÜSÜ
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('renkpick_')) {
      const ownerUid = interaction.customId.split('_')[1];
      if (interaction.user.id !== ownerUid) return interaction.reply({ ephemeral: true, content: 'Bu menü sana ait değil.' });
      const roleId = interaction.values[0];
      const gid2 = interaction.guild.id;
      const colorRoles = await db.getColorRoles(gid2);
      const cr = colorRoles.find(r => r.roleId === roleId);
      if (!cr) return interaction.update({ content: '⛔ Bu rol artık listede yok.', components: [] });
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) return interaction.update({ content: '⛔ Rol sunucuda bulunamadı.', components: [] });
      const me = interaction.guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
        return interaction.update({ content: '⛔ Bu rolü yönetemiyorum (hiyerarşi/izin).', components: [] });
      }
      const member = interaction.member;
      if (member.roles.cache.has(roleId)) return interaction.update({ content: 'ℹ️ Bu role zaten sahipsin.', components: [] });
      const deductedColor = await db.deductBalance(gid2, ownerUid, cr.price);
      if (!deductedColor) return interaction.update({ content: `⛔ Yetersiz coin! Gerekli: **${cr.price}**`, components: [] });
      const allColorRoleIds = colorRoles.map(r => r.roleId);
      const owned = allColorRoleIds.filter(rid => member.roles.cache.has(rid));
      for (const rid of owned) await member.roles.remove(rid).catch(() => {});
      await member.roles.add(roleId).catch(() => {});
      const newBal = await db.getBalance(gid2, ownerUid);
      return interaction.update({ content: `✅ <@&${roleId}> renk rolünü aldın! **-${cr.price}** coin. Bakiye: **${newBal.balance}**`, components: [] });
    }

    // SETUP SELECT MENÜ / BUTON
    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      const [prefix, ...rest] = (interaction.customId || '').split('_');
      if (prefix === 'setup') return handleSetupInteraction(interaction, rest.join('_'));
    }

    // Collector'da işlenen butonlar
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('macc_') || id.startsWith('mrej_')) return;
      if (id.startsWith('cancel_steal_')) return;
      if (id.startsWith('restore_yes_') || id.startsWith('restore_no_')) return;
      if (id.startsWith('bj_hit_') || id.startsWith('bj_stand_') || id.startsWith('bj_cancel_')) return;
      if (id.startsWith('fishtrade_yes_') || id.startsWith('fishtrade_no_')) return;
    }

    if (!interaction.isChatInputCommand()) return;
    const gid = interaction.guild?.id;
    const uid = interaction.user.id;
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand?.(false) || null;

    // Slash log
    try {
      const logSub = sub ? `/${cmd} ${sub}` : `/${cmd}`;
      sendLog(gid, 'slash', new EmbedBuilder()
        .setTitle('📝 Slash Komut Logu').setColor(0x5865F2)
        .addFields(
          { name: 'Kullanıcı', value: `<@${uid}> (${interaction.user.tag})`, inline: true },
          { name: 'Komut', value: `\`${logSub}\``, inline: true },
          { name: 'Saat', value: nowTR(), inline: true },
        ).setTimestamp()
      );
    } catch {}

    // Banka hesabı zorunluluğu
    if (gid && !BANK_EXEMPT_COMMANDS.has(cmd) && !await db.hasBankAccount(gid, uid)) {
      return interaction.reply({
        ephemeral: true,
        content: '🏦 Önce bir banka hesabı açman gerekiyor! `/banka olustur` komutunu kullan.',
      });
    }

    // ── /banka ──────────────────────────────────────────────
    if (cmd === 'banka') {
      if (sub === 'olustur') {
        if (await db.hasBankAccount(gid, uid)) {
          return interaction.reply({ ephemeral: true, content: '🏦 Zaten bir banka hesabın var.' });
        }
        await db.createBankAccount(gid, uid);
        await db.setShield(gid, uid, 6 * 60 * 60 * 1000);
        sendLog(gid, 'economy', new EmbedBuilder().setTitle('🏦 Banka Hesabı Açıldı').setColor(0x2ECC71)
          .addFields({ name: 'Kullanıcı', value: `<@${uid}>`, inline: true }).setTimestamp());
        return interaction.reply(`🏦 Banka hesabın oluşturuldu! Artık tüm komutları kullanabilirsin.\n🛡️ Ayrıca **6 saatlik hırsızlık koruması** kazandın.`);
      }
    }

    // ── /yardim ─────────────────────────────────────────────
    if (cmd === 'yardim') {
      const embed = new EmbedBuilder()
        .setTitle('📘 DeathWish Game — Komut Rehberi').setColor(0x5865F2)
        .setDescription('Tüm komutlar `/` ile çalışır. Veriler PostgreSQL\'de kalıcı olarak saklanır.')
        .addFields(
          { name: '🏦 Başlangıç', value: '`/banka olustur` — Banka hesabı aç (**zorunlu**). 6 saatlik hırsızlık koruması hediye!' },
          { name: '💰 Ekonomi', value: ['`/ekonomi bakiye`','`/ekonomi gunluk`','`/ekonomi yatir/cek`','`/ekonomi gonder`','`/ekonomi siralama`'].join('\n') },
          { name: '📊 Seviye / XP', value: ['`/xp seviye`','`/xp siralama`'].join('\n') },
          { name: '🎙️ Ses Takibi', value: ['`/ses benim`','`/ses siralama`','`/ses gorev`'].join('\n') },
          { name: '💬 Sohbet', value: '`/sohbet siralama` / `durum` — Her 2 mesajda 1 coin otomatik' },
          { name: '🎮 Oyunlar', value: ['`/zar ust/alt/bonus`','`/yazitura`','`/yazioyunu baslat/bonus`','`/oyunlar sanskutusu/cal`','`/yirmibir bahis:`','`/atyarisi at: bahis:`'].join('\n') },
          { name: '🎣 Balıkçılık', value: ['`/balik tut/envanter/boost-al`','`/balik-market liste/sat/oyuncuya-sat`'].join('\n') },
          { name: '💍 Evlilik', value: ['`/evlilik yuzuk-al/evlen/esim/bosan/liste/ciftyazitura`'].join('\n') },
          { name: '🛒 Market', value: ['`/market liste/al/iade/esyalar/esya-al`','`/xpboost`','`/renk al/liste`'].join('\n') },
          { name: '⚙️ Yönetim', value: ['`/setup` — Bot ayarları','`/market-yonet ekle/cikar`','`/ses sifirla` / `/sohbet sifirla`','`/xp ver` / `/ekonomi ver/al`','`/sifirla hersey`'].join('\n') },
        )
        .setFooter({ text: 'XP mesaj yazarak otomatik • Her 2 mesajda 1 coin • Veriler kalıcı (PostgreSQL)' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /ekonomi ────────────────────────────────────────────
    if (cmd === 'ekonomi') {
      if (sub === 'bakiye') {
        const target = interaction.options.getUser('kullanici') || interaction.user;
        const bal = await db.getBalance(gid, target.id);
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle(`💰 ${target.username} — Bakiye`).setColor(0xF1C40F)
            .setThumbnail(target.displayAvatarURL())
            .addFields(
              { name: '🪙 Cüzdan', value: `**${bal.balance}** coin`, inline: true },
              { name: '🏦 Banka', value: `**${bal.bank}** coin`, inline: true },
              { name: '💎 Toplam', value: `**${bal.balance + bal.bank}** coin`, inline: true },
            )
        ]});
      }
      if (sub === 'gunluk') {
        const day = todayTR();
        const base = parseInt(await db.getSetting(gid, 'daily_reward') || '80');
        if (await db.hasClaimed(gid, uid, day, 'daily')) return interaction.reply({ ephemeral: true, content: '⛔ Bugün zaten aldın. Yarın tekrar gel!' });
        await db.setClaimed(gid, uid, day, 'daily');
        const boost = await db.getBoostMultiplier(gid, uid);
        const reward = Math.floor(base * boost);
        await db.addBalance(gid, uid, reward);
        const bal = await db.getBalance(gid, uid);
        return interaction.reply(`✅ Günlük **+${reward} coin** aldın! ${boost > 1 ? '(Boost 🔥)' : ''}\n💰 Bakiye: **${bal.balance}**`);
      }
      if (sub === 'yatir') {
        const amt = interaction.options.getInteger('miktar');
        const bal = await db.getBalance(gid, uid);
        const deductedDeposit = await db.deductBalance(gid, uid, amt);
        if (!deductedDeposit) return interaction.reply({ ephemeral: true, content: '⛔ Yetersiz cüzdan bakiyesi.' });
        await db.addBank(gid, uid, amt);
        const nb = await db.getBalance(gid, uid);
        return interaction.reply(`🏦 **${amt}** coin bankaya yatırıldı.\n💰 Cüzdan: **${nb.balance}** | 🏦 Banka: **${nb.bank}**`);
      }
      if (sub === 'cek') {
        const amt = interaction.options.getInteger('miktar');
        const bal = await db.getBalance(gid, uid);
        if (bal.bank < amt) return interaction.reply({ ephemeral: true, content: '⛔ Yetersiz banka bakiyesi.' });
        await db.addBank(gid, uid, -amt);
        await db.addBalance(gid, uid, amt);
        const nb = await db.getBalance(gid, uid);
        return interaction.reply(`💸 **${amt}** coin bankadan çekildi.\n💰 Cüzdan: **${nb.balance}** | 🏦 Banka: **${nb.bank}**`);
      }
      if (sub === 'gonder') {
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        if (target.id === uid) return interaction.reply({ ephemeral: true, content: '⛔ Kendine coin gönderemezsin.' });
        if (target.bot) return interaction.reply({ ephemeral: true, content: '⛔ Botlara coin gönderemezsin.' });
        if (!await db.transfer(gid, uid, target.id, amt)) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz bakiye! Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
        const nb = await db.getBalance(gid, uid);
        return interaction.reply(`✅ <@${target.id}> kullanıcısına **${amt}** coin gönderildi!\n💰 Kalan bakiye: **${nb.balance}**`);
      }
      if (sub === 'siralama') {
        const top = await db.topBalance(gid, 10);
        if (!top.length) return interaction.reply('🏁 Henüz coin verisi yok.');
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('💰 Coin Sıralaması').setColor(0xF1C40F)
            .setDescription(top.map((r,i) => `**${i+1}.** <@${r.userId}> — **${r.balance}** coin`).join('\n'))
        ]});
      }
      if (sub === 'ver') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        await db.addBalance(gid, target.id, amt);
        const nb = await db.getBalance(gid, target.id);
        return interaction.reply(`✅ <@${target.id}> kullanıcısına **${amt}** coin verildi. Bakiye: **${nb.balance}**`);
      }
      if (sub === 'al') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        await db.addBalance(gid, target.id, -amt);
        const nb = await db.getBalance(gid, target.id);
        return interaction.reply(`✅ <@${target.id}> kullanıcısından **${amt}** coin alındı. Bakiye: **${nb.balance}**`);
      }
    }

    // ── /xp ─────────────────────────────────────────────────
    if (cmd === 'xp') {
      if (sub === 'seviye') {
        const target = interaction.options.getUser('hedef') || interaction.user;
        const lvl = await db.getLevel(gid, target.id);
        const needed = Math.round((lvl.level + 1) * 100 * 0.85);
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle(`📊 ${target.username} — Seviye`).setColor(0x57F287)
            .setThumbnail(target.displayAvatarURL())
            .addFields(
              { name: '🏆 Seviye', value: `**${lvl.level}**`, inline: true },
              { name: '⚡ XP', value: `**${lvl.xp} / ${needed}**`, inline: true },
            )
        ]});
      }
      if (sub === 'siralama') {
        const top = await db.topLevels(gid, 10);
        if (!top.length) return interaction.reply('🏁 Henüz seviye verisi yok.');
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('📊 Seviye Sıralaması').setColor(0x57F287)
            .setDescription(top.map((r,i) => `**${i+1}.** <@${r.userId}> — Seviye **${r.level}**`).join('\n'))
        ]});
      }
      if (sub === 'ver') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        const result = await db.addXp(gid, target.id, amt);
        let reply = `✅ <@${target.id}> kullanıcısına **${amt}** XP verildi.`;
        if (result.leveled) {
          reply += `\n🎉 Seviye atladı! Yeni seviye: **${result.newLevel}** 🏆`;
          const rewardRoleId = LEVEL_ROLE_REWARDS[result.newLevel];
          if (rewardRoleId) {
            try {
              const mbr = interaction.guild.members.cache.get(target.id) || await interaction.guild.members.fetch(target.id);
              if (mbr && !mbr.roles.cache.has(rewardRoleId)) { await mbr.roles.add(rewardRoleId); reply += `\n🏆 Seviye ödül rolü verildi.`; }
            } catch {}
          }
        }
        return interaction.reply(reply);
      }
    }

    // ── /ses ─────────────────────────────────────────────────
    if (cmd === 'ses') {
      if (sub === 'benim') {
        const key = `${gid}:${uid}`;
        let secs = await db.getVoiceTime(gid, uid);
        if (voiceJoinTimes.has(key)) secs += Math.max(0, Math.floor((Date.now() - voiceJoinTimes.get(key)) / 1000));
        return interaction.reply(`🎧 **${interaction.user.username}** — Toplam ses süresi: **${fmtVoice(secs)}**`);
      }
      if (sub === 'siralama') {
        const top = await db.topVoice(gid, 10);
        if (!top.length) return interaction.reply('Ses kanalları bomboş... yankı bile yok 😴');
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🎙️ Ses Süresi Sıralaması').setColor(0xEB459E)
            .setDescription(top.map((r,i) => `**${i+1}.** <@${r.userId}> — ${fmtVoice(r.totalSeconds)}`).join('\n'))
        ]});
      }
      if (sub === 'gorev') {
        const key = `${gid}:${uid}`; const day = todayTR();
        const base = voiceDailySec.get(`${key}:${day}`) || 0;
        let total = base;
        if (voiceJoinTimes.has(key)) total += Math.max(0, Math.floor((Date.now() - voiceJoinTimes.get(key)) / 1000));
        const claimed = voiceDailyClaimed.get(`${gid}:${uid}:${day}`);
        const boost = await db.getBoostMultiplier(gid, uid, false);
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🎧 Günlük Ses Görevi').setColor(0xEB459E)
            .addFields(
              { name: '⏱️ Bugünkü Süre', value: `**${fmtMin(total)}**`, inline: true },
              { name: '📊 Durum', value: claimed ? '✅ Ödül alındı' : '🕒 Devam ediyor', inline: true },
              { name: '🔥 Boost', value: `${boost}x`, inline: true },
              { name: '🎯 Eşikler', value: VOICE_TIERS.map(t => t.label).join('\n') },
            )
        ]});
      }
      if (sub === 'sifirla') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        await db.resetVoice(gid);
        for (const k of [...voiceJoinTimes.keys()]) { if (k.startsWith(`${gid}:`)) voiceJoinTimes.delete(k); }
        return interaction.reply('🎙️ Ses verileri sıfırlandı!');
      }
    }

    // ── /sohbet ──────────────────────────────────────────────
    if (cmd === 'sohbet') {
      const sohbetCh = await db.getSetting(gid, 'sohbet_channel');
      if (sub === 'siralama') {
        if (!sohbetCh) return interaction.reply({ ephemeral: true, content: '⛔ Sohbet kanalı ayarlanmamış. `/setup` ile ayarla.' });
        const top = await db.topMsgs(gid, sohbetCh, todayTR(), 10);
        if (!top.length) return interaction.reply('💬 Bugün mesaj yok.');
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('💬 Bugünkü Sohbet Liderliği').setColor(0x3498DB)
            .setDescription(top.map((r,i) => `**${i+1}.** <@${r.userId}> — ${r.count} mesaj`).join('\n'))
        ]});
      }
      if (sub === 'durum') {
        if (!sohbetCh) return interaction.reply({ ephemeral: true, content: '⛔ Sohbet kanalı ayarlanmamış.' });
        return interaction.reply({ ephemeral: true, content: `💬 **<#${sohbetCh}>** kanalında attığın her **2 mesajda 1 coin** otomatik ekleniyor!` });
      }
      if (sub === 'sifirla') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        await db.resetSohbet(gid);
        return interaction.reply('💬 Sohbet liderliği sıfırlandı!');
      }
    }

    // ── /zar ─────────────────────────────────────────────────
    if (cmd === 'zar') {
      if (sub === 'bonus') {
        const day = todayTR();
        if (await db.hasClaimed(gid, uid, day, 'zar_bonus')) return interaction.reply({ ephemeral: true, content: '⛔ Bugün zar bonusunu aldın. Yarın gel!' });
        await db.setClaimed(gid, uid, day, 'zar_bonus');
        await db.addBalance(gid, uid, 15);
        const bal = await db.getBalance(gid, uid);
        return interaction.reply(`✅ **+15** zar bonusu eklendi!\n💰 Bakiye: **${bal.balance}**`);
      }
      if (sub === 'ust' || sub === 'alt') {
        const secim = sub === 'ust' ? 'üst' : 'alt';
        const roll  = Math.floor(Math.random() * 6) + 1;
        const sonuc = roll <= 3 ? 'alt' : 'üst';
        const kazandi = secim === sonuc;
        const key = `${gid}:${uid}`;
        let delta = kazandi ? 3 : -1, extraMsg = '', gifUrl = pick(DICE_GIFS);
        if (!kazandi) {
          const streak = (diceLossStreak.get(key) || 0) + 1;
          diceLossStreak.set(key, streak);
          if (streak >= 2) { delta = -4; extraMsg = '\n🔥 **Cooked!** İki kez üst üste kaybettin, **-3 ek ceza.**'; gifUrl = pick(COOKED_GIFS); diceLossStreak.set(key, 0); }
        } else diceLossStreak.set(key, 0);
        await db.addBalance(gid, uid, delta);
        const newBal = await db.getBalance(gid, uid);
        return interaction.reply({
          content: `🎲 Zar: **${roll}** → **${sonuc.toUpperCase()}** ${kazandi ? 'Kazandın 🎉 (**+3** coin)' : 'Kaybettin 😿 (**-1** coin)'}\n💰 Bakiye: **${newBal.balance}**${extraMsg}`,
          files: [gifUrl],
        });
      }
    }

    // ── /yazitura ────────────────────────────────────────────
    if (cmd === 'yazitura') {
      const secim = interaction.options.getString('secim');
      const sonuc = Math.random() < 0.5 ? 'yazı' : 'tura';
      const kazandi = secim === sonuc;
      await db.addBalance(gid, uid, kazandi ? 2 : -1);
      const newBal = await db.getBalance(gid, uid);
      return interaction.reply(`🪙 **${sonuc.toUpperCase()}** geldi! ${kazandi ? 'Kazandın 🎉 (**+2** coin)' : 'Kaybettin 😿 (**-1** coin)'}\n💰 Bakiye: **${newBal.balance}**`);
    }

    // ── /yazioyunu ───────────────────────────────────────────
    if (cmd === 'yazioyunu') {
      if (sub === 'bonus') {
        const day = todayTR();
        if (await db.hasClaimed(gid, uid, day, 'yazi_bonus')) return interaction.reply({ ephemeral: true, content: '⛔ Bugün yazı bonusunu aldın. Yarın gel!' });
        await db.setClaimed(gid, uid, day, 'yazi_bonus');
        await db.addBalance(gid, uid, 15);
        const bal = await db.getBalance(gid, uid);
        return interaction.reply(`✅ **+15** yazı bonusu eklendi!\n💰 Bakiye: **${bal.balance}**`);
      }
      if (sub === 'baslat') {
        const yaziCh = await db.getSetting(gid, 'yazi_oyunu_channel');
        const cid = interaction.channelId;
        if (yaziCh && cid !== yaziCh) return interaction.reply({ ephemeral: true, content: `⛔ Yazı oyununu sadece <#${yaziCh}> kanalında başlatabilirsin.` });
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

    // ── /evlilik ─────────────────────────────────────────────
    if (cmd === 'evlilik') {
      if (sub === 'yuzuk-al') {
        if (await db.getMarriage(gid, uid)) return interaction.reply({ ephemeral: true, content: 'Zaten evlisin babuş, yüzüğe gerek kalmadı 😅' });
        if (await db.hasRing(gid, uid)) return interaction.reply({ ephemeral: true, content: 'Zaten bir yüzüğün var 💍 Teklif etmeyi dene: `/evlilik evlen`' });
        const deductedRing = await db.deductBalance(gid, uid, 150);
        if (!deductedRing) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **150 coin**, Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
        await db.giveRing(gid, uid);
        return interaction.reply('✅ **-150 coin** ile **tek kullanımlık** bir yüzük aldın! `/evlilik evlen @kişi` ile teklif et 💍');
      }
      if (sub === 'yuzugum') {
        if (await db.hasRing(gid, uid)) return interaction.reply('💍 Bir yüzüğün var. Şansını dene: `/evlilik evlen`');
        if (await db.getMarriage(gid, uid)) return interaction.reply('💍 Evlisin zaten; yüzüğün kalbinde ✨');
        return interaction.reply('💍 Henüz yüzüğün yok. Almak için: `/evlilik yuzuk-al` (150 coin)');
      }
      if (sub === 'evlen') {
        const target = interaction.options.getUser('hedef');
        if (target.bot) return interaction.reply({ ephemeral: true, content: 'Botlarla evlenemezsin babuş 😅' });
        if (target.id === uid) return interaction.reply({ ephemeral: true, content: 'Kendinle evlenemezsin… ama kendini sevmen güzel 😌' });
        const cdKey = `${gid}:${uid}`;
        if ((Date.now() - (proposalCooldown.get(cdKey) || 0)) < 5 * 60 * 1000) return interaction.reply({ ephemeral: true, content: '⏳ Biraz bekle. 5 dakikada bir teklif edebilirsin.' });
        if (!await db.hasRing(gid, uid)) return interaction.reply({ ephemeral: true, content: '💍 Önce yüzük al: `/evlilik yuzuk-al` (**150 coin**)' });
        if (await db.getMarriage(gid, uid)) return interaction.reply({ ephemeral: true, content: 'Zaten evlisin babuş.' });
        if (await db.getMarriage(gid, target.id)) return interaction.reply({ ephemeral: true, content: 'Hedef kişi zaten evli görünüyor.' });
        const ts = Date.now();
        const accId = `macc_${uid}_${target.id}_${ts}`, rejId = `mrej_${uid}_${target.id}_${ts}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(accId).setLabel('Kabul Et').setStyle(ButtonStyle.Success).setEmoji('💍'),
          new ButtonBuilder().setCustomId(rejId).setLabel('Reddet').setStyle(ButtonStyle.Danger).setEmoji('❌'),
        );
        await interaction.reply({ content: `${target}, **${interaction.user.username}** sana **evlilik teklifi** ediyor! 💞`, files: [pick(PROPOSAL_HAPPY_GIFS)], components: [row] });
        const m2 = await interaction.fetchReply();
        let resolved = false;
        const coll = m2.createMessageComponentCollector({ time: 30000, componentType: ComponentType.Button, filter: i => (i.customId === accId || i.customId === rejId) && i.user.id === target.id });
        coll.on('collect', async i => {
          resolved = true; proposalCooldown.set(cdKey, Date.now());
          if (i.customId === rejId) {
            return i.update({ content: `💔 ${target.username} teklifi **reddetti**.`, files: [pick(PROPOSAL_SAD_GIFS)], components: [] });
          }
          if (!await db.hasRing(gid, uid) || await db.getMarriage(gid, uid) || await db.getMarriage(gid, target.id)) {
            return i.update({ content: '⛔ Teklif geçersiz (durum değişti).', components: [] });
          }
          await db.setMarriage(gid, uid, target.id);
          await db.consumeRing(gid, uid);
          await i.update({ content: `💍 **${interaction.user.username}** ve **${target.username}** artık **EVLİ!** 🎉`, components: [] });
        });
        coll.on('end', async () => { if (!resolved) { proposalCooldown.set(cdKey, Date.now()); await m2.edit({ content: '⏰ Süre doldu, teklif geçersiz oldu.', components: [] }).catch(() => {}); } });
        return;
      }
      if (sub === 'esim') {
        const m = await db.getMarriage(gid, uid);
        if (!m) return interaction.reply('Bekârsın babuş. Belki bugün değişir? `/evlilik evlen`');
        const spouse = m.user1 === uid ? m.user2 : m.user1;
        return interaction.reply(`💞 Eşin: <@${spouse}>\n📅 Evlilik tarihi: **${m.marriedAt}**`);
      }
      if (sub === 'bosan') {
        const m = await db.getMarriage(gid, uid);
        if (!m) return interaction.reply({ ephemeral: true, content: 'Zaten bekârsın babuş.' });
        const spouse = m.user1 === uid ? m.user2 : m.user1;
        const deductedDivorce = await db.deductBalance(gid, uid, 130);
        if (!deductedDivorce) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin. Boşanma: **50 coin** + **80 coin** nafaka = **130 coin**. Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
        await db.addBalance(gid, spouse, 80);
        await db.removeMarriage(gid, uid);
        return interaction.reply(`📄 **Boşanma tamam.** **-50 coin** ücret + <@${spouse}> kullanıcısına **80 coin** nafaka ödendi. 💔`);
      }
      if (sub === 'liste') {
        const couples = await db.allMarriages(gid);
        if (!couples.length) return interaction.reply('Bu sunucuda aktif evlilik yok.');
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('👩‍❤️‍👨 Evlilik Listesi').setColor(0xFF73FA)
            .setDescription(couples.slice(0,10).map((c,i) => `**${i+1}.** <@${c.user1}> ❤️ <@${c.user2}> (${c.marriedAt||''})`).join('\n'))
        ]});
      }
      if (sub === 'ciftyazitura') {
        const secim = interaction.options.getString('secim');
        if (!await db.getMarriage(gid, uid)) return interaction.reply({ ephemeral: true, content: '⛔ Bu oyun **sadece evliler** için.' });
        const day = todayTR();
        const used = await db.getDailyCount(gid, uid, day, 'ciftyazitura');
        if (used >= 10) return interaction.reply({ ephemeral: true, content: '⛔ Günlük oyun limitine ulaştın (**10**). Yarın tekrar gel!' });
        const sonuc = Math.random() < 0.5 ? 'yazı' : 'tura';
        const kazandi = secim === sonuc;
        await db.incDailyCount(gid, uid, day, 'ciftyazitura');
        await db.addBalance(gid, uid, kazandi ? 5 : -3);
        const newBal = await db.getBalance(gid, uid);
        return interaction.reply(`🪙 Çift Yazı/Tura: **${sonuc.toUpperCase()}** ${kazandi ? '→ Kazandın! **+5 coin**' : '→ Kaybettin… **-3 coin**'}\n💰 Bakiye: **${newBal.balance}** • Günlük: **${used+1}/10**`);
      }
    }

    // ── /market ──────────────────────────────────────────────
    if (cmd === 'market') {
      if (sub === 'liste') {
        const roles = await db.getMarketRoles(gid);
        const normal  = roles.filter(r => !r.isPremium);
        const premium = roles.filter(r => r.isPremium);
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🛒 Market').setColor(0xE67E22)
            .setDescription('Aynı anda en fazla **1** market rolü alabilirsin.')
            .addFields(
              { name: '🔒 Normal Roller', value: normal.length ? normal.map(r => `<@&${r.roleId}> — \`${r.roleId}\` — **${r.price} coin**`).join('\n') : '_(boş)_' },
              { name: '👑 Premium Roller', value: premium.length ? premium.map(r => `<@&${r.roleId}> — \`${r.roleId}\` — **${r.price} coin**`).join('\n') : '_(boş)_' },
              { name: '🎁 Eşyalar', value: ['🛡️ **Hırsızlık Kalkanı** — 45 coin • `/market esya-al esya:kalkan`','⚡ **Geçici XP Boost** — 80 coin • `/market esya-al esya:gecici_boost`','💍 **Evlilik Yüzüğü** — 150 coin • `/evlilik yuzuk-al`','💎 **XPBoost** (Kalıcı 1.5x) — 400 coin • `/xpboost`','🎣 **Balıkçılık Boost** — 200 coin • `/balik boost-al`','🎨 **Renk Rolü** — 50 coin • `/renk al`'].join('\n') },
            )
        ]});
      }
      if (sub === 'al') {
        const roleId = (interaction.options.getString('rolid') || '').replace(/\D/g, '');
        if (!roleId) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz rol ID.' });
        const mRoles = await db.getMarketRoles(gid);
        const mRole  = mRoles.find(r => r.roleId === roleId);
        if (!mRole) return interaction.reply({ ephemeral: true, content: '⛔ Bu rol markette yok.' });
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) return interaction.reply({ ephemeral: true, content: '⛔ Rol sunucuda bulunamadı.' });
        const me = interaction.guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) return interaction.reply({ ephemeral: true, content: '⛔ Bu rolü yönetemiyorum.' });
        const member = interaction.member;
        if (member.roles.cache.has(roleId)) return interaction.reply({ ephemeral: true, content: 'ℹ️ Bu role zaten sahipsin.' });
        const owned = mRoles.find(r => member.roles.cache.has(r.roleId));
        if (owned) return interaction.reply({ ephemeral: true, content: `⛔ Zaten bir market rolün var: <@&${owned.roleId}>. Önce iade et.` });
        const deductedMarket = await db.deductBalance(gid, uid, mRole.price);
        if (!deductedMarket) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **${mRole.price}**, Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
        await member.roles.add(roleId).catch(() => {});
        const newBal = await db.getBalance(gid, uid);
        return interaction.reply(`✅ <@&${roleId}> rolünü aldın! **-${mRole.price}** coin. Bakiye: **${newBal.balance}**`);
      }
      if (sub === 'iade') {
        const roleId = (interaction.options.getString('rolid') || '').replace(/\D/g, '');
        if (!roleId) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz rol ID.' });
        const mRoles = await db.getMarketRoles(gid);
        const mRole  = mRoles.find(r => r.roleId === roleId);
        if (!mRole) return interaction.reply({ ephemeral: true, content: '⛔ Bu rol markette yok.' });
        const member = interaction.member;
        if (!member.roles.cache.has(roleId)) return interaction.reply({ ephemeral: true, content: 'ℹ️ Bu role sahip değilsin.' });
        const refund = Math.floor(mRole.price / 2);
        await member.roles.remove(roleId).catch(() => {});
        await db.addBalance(gid, uid, refund);
        const newBal = await db.getBalance(gid, uid);
        return interaction.reply(`↩️ <@&${roleId}> iade edildi. **+${refund}** coin geri yüklendi. Bakiye: **${newBal.balance}**`);
      }
      if (sub === 'esyalar') {
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🎁 Özel Eşyalar').setColor(0xE67E22)
            .addFields(
              { name: '🛡️ Hırsızlık Kalkanı', value: '**45 coin** — 4 saat boyunca `/oyunlar cal` komutundan korur.\nSatın al: `/market esya-al esya:kalkan`' },
              { name: '⚡ Geçici XP Boost', value: '**80 coin** — sonraki **50** ödülde **2 katı** kazanç.\nSatın al: `/market esya-al esya:gecici_boost`' },
            )
        ]});
      }
      if (sub === 'esya-al') {
        const esya = interaction.options.getString('esya');
        if (esya === 'kalkan') {
          if (await db.hasShield(gid, uid)) return interaction.reply({ ephemeral: true, content: '🛡️ Zaten aktif bir kalkanın var.' });
          const deductedKalkan = await db.deductBalance(gid, uid, 45);
          if (!deductedKalkan) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **45**, Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
          await db.setShield(gid, uid, 4 * 60 * 60 * 1000);
          return interaction.reply('🛡️ **Hırsızlık Kalkanı** aktif! 4 saat boyunca korunuyorsun.');
        }
        if (esya === 'gecici_boost') {
          const deductedBoost = await db.deductBalance(gid, uid, 80);
          if (!deductedBoost) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **80**, Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
          await db.addTempBoostUses(gid, uid, 50);
          const uses = await db.getTempBoostUses(gid, uid);
          return interaction.reply(`⚡ **Geçici XP Boost (2x)** satın alındı! Sonraki **50** ödülün 2 katı olacak. Kalan: **${uses}**`);
        }
      }
    }

    // ── /market-yonet ────────────────────────────────────────
    if (cmd === 'market-yonet') {
      if (!hasOwnerAccess(uid, interaction.member) && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ ephemeral: true, content: '⛔ Bu komut için yönetici izni gerekir.' });
      }
      if (sub === 'ekle') {
        const role = interaction.options.getRole('rol');
        const price = interaction.options.getInteger('fiyat');
        const premium = interaction.options.getBoolean('premium') || false;
        await db.addMarketRole(gid, role.id, price, premium);
        return interaction.reply(`✅ <@&${role.id}> markete eklendi. Fiyat: **${price} coin**${premium ? ' 👑 Premium' : ''}`);
      }
      if (sub === 'cikar') {
        const role = interaction.options.getRole('rol');
        await db.removeMarketRole(gid, role.id);
        return interaction.reply(`✅ <@&${role.id}> marketten çıkarıldı.`);
      }
      if (sub === 'liste') {
        const roles = await db.getMarketRoles(gid);
        if (!roles.length) return interaction.reply('🛒 Market boş.');
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🛒 Market Rolleri').setColor(0xE67E22)
            .setDescription(roles.map((r,i) => `**${i+1}.** <@&${r.roleId}> — **${r.price} coin**${r.isPremium ? ' 👑' : ''}`).join('\n'))
        ]});
      }
    }

    // ── /oyunlar ─────────────────────────────────────────────
    if (cmd === 'oyunlar') {
      if (sub === 'sanskutusu') {
        const day = todayTR();
        const used = await db.getDailyCount(gid, uid, day, 'sanskutusu');
        if (used >= 5) return interaction.reply({ ephemeral: true, content: '⛔ Bugün **5** kez kullandın. Yarın tekrar dene!' });
        const bal = await db.getBalance(gid, uid);
        const deductedBox = await db.deductBalance(gid, uid, 8);
        if (!deductedBox) return interaction.reply({ ephemeral: true, content: '⛔ Şans kutusu **8 coin** ister. Bakiyen yetersiz!' });
        await db.incDailyCount(gid, uid, day, 'sanskutusu');
        const roll = Math.random() * 100;
        let reward = 0, resultMsg = '';
        if      (roll < 40)   { resultMsg = '😔 Kutudan boş çıktı.' }
        else if (roll < 75)   { reward = 10;  resultMsg = `🪙 Küçük ödül! **${reward} coin**` }
        else if (roll < 95)   { reward = 28;  resultMsg = `💰 Orta ödül! **${reward} coin**` }
        else if (roll < 99.5) { reward = 49;  resultMsg = `💎 Büyük ödül! **${reward} coin**` }
        else                  { reward = 300; resultMsg = `🔥 **JACKPOT! ${reward} coin**` }
        if (reward > 0) await db.addBalance(gid, uid, reward);
        const newBal = await db.getBalance(gid, uid);
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🎁 Şans Kutusu').setColor(reward >= 100 ? 0xFFD700 : reward > 0 ? 0x57F287 : 0xED4245)
            .addFields(
              { name: '🎲 Sonuç', value: resultMsg },
              { name: '📆 Günlük Hak', value: `**${used+1}/5**`, inline: true },
              { name: '💰 Bakiye', value: `**${newBal.balance}** coin`, inline: true },
            )
        ]});
      }
      if (sub === 'cal') {
        if (!isWithinIstanbulWindow()) return interaction.reply({ ephemeral: true, content: 'Bu saatlerde bu komutu kullanamazsın knk; uyuyan var, işe giden var. Haksızlık değil mi?' });
        const calCh = await db.getSetting(gid, 'cal_channel');
        if (calCh && interaction.channelId !== calCh) return interaction.reply({ ephemeral: true, content: `⛔ Bu komutu sadece <#${calCh}> kanalında kullanabilirsin.` });
        const victim = interaction.options.getUser('hedef');
        if (victim.bot) return interaction.reply({ ephemeral: true, content: 'Botlardan çalamazsın 😅' });
        if (victim.id === uid) return interaction.reply({ ephemeral: true, content: 'Kendinden çalamazsın 🙂' });
        if (await db.hasShield(gid, victim.id)) return interaction.reply({ ephemeral: true, content: `🛡️ ${victim.username} şu anda **Hırsızlık Kalkanı** ile korunuyor.` });
        const key = `${uid}:${victim.id}`;
        if (activeSteals.has(key)) return interaction.reply({ ephemeral: true, content: 'Bu kullanıcıyla zaten aktif bir çalma denemen var.' });
        if ((await db.getBalance(gid, victim.id)).balance < 5) return interaction.reply({ ephemeral: true, content: 'Hedefin coin\'i yetersiz.' });
        activeSteals.add(key);
        const cancelId = `cancel_steal_${Date.now()}_${uid}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(cancelId).setLabel('İptal Et (30s)').setStyle(ButtonStyle.Danger).setEmoji('⛔')
        );
        await interaction.reply({ content: `${victim}, **${interaction.user.username}** senden **5 coin** çalmaya çalışıyor! 30 saniye içinde butona basmazsan para gider 😈`, components: [row] });
        const m2 = await interaction.fetchReply();
        let prevented = false;
        const coll = m2.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30000, filter: i => i.customId === cancelId && i.user.id === victim.id });
        coll.on('collect', async i => {
          prevented = true; activeSteals.delete(key);
          await i.update({ content: `🛡️ ${victim.username} çalmayı **iptal etti**! ${interaction.user.username} eli boş döndü.`, components: [] });
        });
        coll.on('end', async () => {
          if (prevented) return;
          activeSteals.delete(key);
          const stolen = await db.transfer(gid, victim.id, uid, 5);
          if (!stolen) return m2.edit({ content: '⚠️ Hedef coin\'i kalmamış, çalma iptal oldu.', components: [] });
          await m2.edit({ content: `💰 **${interaction.user.username}**, **${victim.username}**'den **5 coin** çaldı!`, components: [] });
          stealUseCounter++;
          if (stealUseCounter >= 50 && calCh) {
            stealUseCounter = 0;
            const ch = await client.channels.fetch(calCh).catch(() => null);
            if (ch?.isTextBased?.()) {
              const fetched = await ch.messages.fetch({ limit: 100 }).catch(() => null);
              if (fetched) { const botMsgs = fetched.filter(m => m.author.id === client.user.id); if (botMsgs.size) await ch.bulkDelete(botMsgs, true).catch(() => {}); }
            }
          }
        });
        return;
      }
    }

    // ── /xpboost ─────────────────────────────────────────────
    if (cmd === 'xpboost') {
      if (await db.hasBoost(gid, uid)) return interaction.reply({ ephemeral: true, content: '⚡ Zaten kalıcı **XPBoost (1.5x)** sahibisin!' });
      const deductedXpBoost = await db.deductBalance(gid, uid, 400);
      if (!deductedXpBoost) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **400**, Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
      await db.setBoost(gid, uid);
      return interaction.reply('✅ **Kalıcı XPBoost (1.5x)** satın alındı! 🔥 Artık görev ödüllerin 1.5x!');
    }

    // ── /renk ────────────────────────────────────────────────
    if (cmd === 'renk') {
      const colorRoles = await db.getColorRoles(gid);
      if (sub === 'liste') {
        if (!colorRoles.length) return interaction.reply({ ephemeral: true, content: '🎨 Henüz renk rolü eklenmemiş. Bir yönetici `/setup` üzerinden ekleyebilir.' });
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🎨 Renk Rolleri').setColor(0xEB459E)
            .setDescription(colorRoles.map(r => `<@&${r.roleId}> — **${r.price} coin**`).join('\n'))
        ]});
      }
      if (sub === 'al') {
        if (!colorRoles.length) return interaction.reply({ ephemeral: true, content: '⛔ Henüz renk rolü eklenmemiş.' });
        const menu = new StringSelectMenuBuilder().setCustomId(`renkpick_${uid}`).setPlaceholder('Bir renk rolü seç...')
          .addOptions(colorRoles.slice(0,25).map(r => {
            const role = interaction.guild.roles.cache.get(r.roleId);
            return { label: role ? role.name : r.roleId, value: r.roleId, description: `${r.price} coin` };
          }));
        return interaction.reply({ ephemeral: true, content: '🎨 Almak istediğin renk rolünü seç:', components: [new ActionRowBuilder().addComponents(menu)] });
      }
    }

    // ── /balik ───────────────────────────────────────────────
    if (cmd === 'balik') {
      if (sub === 'tut') {
        const key = `${gid}:${uid}`;
        const last = fishCooldown.get(key) || 0;
        if (Date.now() - last < 15000) {
          const wait = Math.ceil((15000 - (Date.now() - last)) / 1000);
          return interaction.reply({ ephemeral: true, content: `⏳ Oltanı topla, **${wait}** saniye sonra tekrar dene.` });
        }
        fishCooldown.set(key, Date.now());
        const boosted = await db.consumeFishBoost(gid, uid);
        const result = await resolveFishCast(gid, uid, boosted);
        if (result.type === 'rod_break') {
          await db.addBalance(gid, uid, -ROD_BREAK_COST);
          const bal = await db.getBalance(gid, uid);
          return interaction.reply(`💥 **Oltan kırıldı!** Tamir masrafı: **-${ROD_BREAK_COST} coin**. Bakiye: **${bal.balance}**`);
        }
        if (result.type === 'line_snap') {
          await db.addBalance(gid, uid, -LINE_SNAP_COST);
          const bal = await db.getBalance(gid, uid);
          return interaction.reply(`✂️ **Mısıra koptu!** **-${LINE_SNAP_COST} coin**. Bakiye: **${bal.balance}**`);
        }
        if (result.type === 'empty') return interaction.reply('🎣 Oltanı attın... olta **boş** döndü. Şansını tekrar dene!');
        const fish = result.fish;
        await db.addFish(gid, uid, fish.key, 1);
        const marketValue = getFishValue(fish.key);
        return interaction.reply(`🎣 Oltanı attın... ${fish.emoji} **${fish.name}** yakaladın! (şu an ~${marketValue} coin değerinde)${boosted ? ' ⚡ *Şans Boostu aktifti*' : ''}`);
      }
      if (sub === 'envanter') {
        const inv = await db.getInventory(gid, uid);
        if (!inv.length) return interaction.reply({ ephemeral: true, content: '🎣 Envanterin boş. `/balik tut` ile balık tutmayı dene!' });
        const lines = inv.map(i => {
          const f = FISH_TYPES.find(x => x.key === i.fishKey);
          return f ? `${f.emoji} **${f.name}** x${i.count} (${getFishValue(f.key)} coin/adet)` : `${i.fishKey} x${i.count}`;
        });
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle(`🎒 ${interaction.user.username} — Balık Envanteri`).setColor(0x3498DB)
            .setDescription(lines.join('\n')).setFooter({ text: 'Fiyatlar piyasaya göre dalgalanır.' })
        ]});
      }
      if (sub === 'boost-al') {
        const deductedFishBoost = await db.deductBalance(gid, uid, 200);
        if (!deductedFishBoost) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Gerekli: **200**, Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
        await db.addFishBoostUses(gid, uid, 100);
        const uses = await db.getFishBoostUses(gid, uid);
        return interaction.reply(`⚡ **Balıkçılık Şansı Boost** aktif! Sonraki **100** denemende nadir balık şansın artacak. Kalan: **${uses}**`);
      }
      if (sub === 'durum') {
        const uses = await db.getFishBoostUses(gid, uid);
        return interaction.reply({ ephemeral: true, content: `⚡ Kalan balıkçılık boost kullanımı: **${uses}**` });
      }
    }

    // ── /balik-market ────────────────────────────────────────
    if (cmd === 'balik-market') {
      if (sub === 'liste') {
        return interaction.reply({ embeds: [
          new EmbedBuilder().setTitle('🐟 Balık Marketi — Güncel Fiyatlar').setColor(0x1ABC9C)
            .setDescription(FISH_TYPES.map(f => `${f.emoji} **${f.name}** — **${getFishValue(f.key)} coin**`).join('\n'))
            .setFooter({ text: 'Fiyatlar 6 saatte bir yenilenir' })
        ]});
      }
      if (sub === 'sat') {
        const key  = interaction.options.getString('balik');
        const adet = interaction.options.getInteger('adet');
        const fish = FISH_TYPES.find(f => f.key === key);
        if (!fish) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz balık türü.' });
        if (!await db.removeFish(gid, uid, key, adet)) return interaction.reply({ ephemeral: true, content: '⛔ Envanterinde yeterli balık yok.' });
        const total = getFishValue(key) * adet;
        await db.addBalance(gid, uid, total);
        const bal = await db.getBalance(gid, uid);
        return interaction.reply(`✅ ${fish.emoji} **${adet}x ${fish.name}** sattın! **+${total} coin**. Bakiye: **${bal.balance}**`);
      }
      if (sub === 'oyuncuya-sat') {
        const target = interaction.options.getUser('hedef');
        const key    = interaction.options.getString('balik');
        const adet   = interaction.options.getInteger('adet');
        const fiyat  = interaction.options.getInteger('fiyat');
        const fish   = FISH_TYPES.find(f => f.key === key);
        if (!fish) return interaction.reply({ ephemeral: true, content: '⛔ Geçersiz balık türü.' });
        if (target.id === uid) return interaction.reply({ ephemeral: true, content: '⛔ Kendine satamazsın.' });
        if (target.bot) return interaction.reply({ ephemeral: true, content: '⛔ Botlara satamazsın.' });
        if (await db.getFishCount(gid, uid, key) < adet) return interaction.reply({ ephemeral: true, content: '⛔ Yeterli balığın yok.' });
        const yesId = `fishtrade_yes_${Date.now()}_${uid}_${target.id}`;
        const noId  = `fishtrade_no_${Date.now()}_${uid}_${target.id}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(yesId).setLabel('Satın Al').setStyle(ButtonStyle.Success).setEmoji('🐟'),
          new ButtonBuilder().setCustomId(noId).setLabel('Reddet').setStyle(ButtonStyle.Danger).setEmoji('❌'),
        );
        await interaction.reply({ content: `${target}, **${interaction.user.username}** sana **${adet}x ${fish.emoji} ${fish.name}**'ı **${fiyat} coin** karşılığında satmak istiyor. Kabul ediyor musun?`, components: [row] });
        const m2 = await interaction.fetchReply();
        const coll = m2.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30000, filter: i => (i.customId === yesId || i.customId === noId) && i.user.id === target.id });
        coll.on('collect', async i => {
          coll.stop();
          if (i.customId === noId) return i.update({ content: '❌ Teklif reddedildi.', components: [] });
          if ((await db.getBalance(gid, target.id)).balance < fiyat) return i.update({ content: '⛔ Yeterli coin\'in yok.', components: [] });
          if (await db.getFishCount(gid, uid, key) < adet) return i.update({ content: '⛔ Satıcının artık yeterli balığı yok.', components: [] });
          await db.removeFish(gid, uid, key, adet);
          await db.addFish(gid, target.id, key, adet);
          await db.addBalance(gid, target.id, -fiyat);
          await db.addBalance(gid, uid, fiyat);
          await i.update({ content: `✅ Takas tamam! <@${target.id}> **${adet}x ${fish.emoji} ${fish.name}** aldı, <@${uid}> **${fiyat} coin** kazandı.`, components: [] });
        });
        coll.on('end', (_, reason) => { if (reason === 'time') interaction.editReply({ content: '⏰ Süre doldu, teklif iptal oldu.', components: [] }).catch(() => {}); });
        return;
      }
    }

    // ── /yirmibir ────────────────────────────────────────────
    if (cmd === 'yirmibir') {
      const bet  = interaction.options.getInteger('bahis');
      const bkey = `${gid}:${uid}`;
      if (activeBlackjack.has(bkey)) return interaction.reply({ ephemeral: true, content: '⛔ Zaten aktif bir blackjack elin var.' });
      const bal = await db.getBalance(gid, uid);
      if (bal.balance < bet) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Bakiye: **${bal.balance}**` });
      let betCharged = false;
      try {
        const deducted = await db.deductBalance(gid, uid, bet);
        if (!deducted) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
        betCharged = true;
        const drawCard = () => pick([2,3,4,5,6,7,8,9,10,10,10,10,11]);
        const handValue = cards => { let s = cards.reduce((a,b) => a+b, 0); let a = cards.filter(c => c===11).length; while(s>21&&a>0){s-=10;a--;} return s; };
        const cardsStr = cards => cards.join(' + ');
        const player = [drawCard(), drawCard()], dealer = [drawCard(), drawCard()];
        activeBlackjack.set(bkey, { player, dealer, bet });
        const buildEmbed = (reveal=false, desc) => {
          const e = new EmbedBuilder().setTitle('🃏 Blackjack (21)').setColor(0x2ECC71)
            .addFields(
              { name: `${interaction.user.username} (${handValue(player)})`, value: cardsStr(player), inline: true },
              { name: `Bot (${reveal ? handValue(dealer) : '?'})`, value: reveal ? cardsStr(dealer) : `${dealer[0]} + ?`, inline: true },
            ).setFooter({ text: `Bahis: ${bet} coin` });
          if (desc) e.setDescription(desc);
          return e;
        };
        if (handValue(player) === 21) {
          activeBlackjack.delete(bkey);
          const win = resolveWinAmount(bet);
          await db.addBalance(gid, uid, win);
          return await interaction.reply({ embeds: [buildEmbed(true, `🎉 **BLACKJACK!** Kazandın: **+${win} coin**`)] });
        }
        const hitId = `bj_hit_${uid}_${Date.now()}`, standId = `bj_stand_${uid}_${Date.now()}`, cancelId = `bj_cancel_${uid}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(hitId).setLabel('Çek (Hit)').setStyle(ButtonStyle.Primary).setEmoji('🃏'),
          new ButtonBuilder().setCustomId(standId).setLabel('Dur (Stand)').setStyle(ButtonStyle.Secondary).setEmoji('✋'),
          new ButtonBuilder().setCustomId(cancelId).setLabel('Vazgeç').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
        );
        await interaction.reply({ embeds: [buildEmbed(false)], components: [row] });
        const m2 = await interaction.fetchReply();
        const finish = async (i, txt, won) => {
          activeBlackjack.delete(bkey);
          await i.update({ embeds: [buildEmbed(true, txt).setColor(won ? 0x2ECC71 : 0xED4245)], components: [] });
        };
        const coll = m2.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000, filter: i => i.user.id === uid && (i.customId===hitId||i.customId===standId||i.customId===cancelId) });
        coll.on('collect', async i => {
          try {
            if (i.customId === hitId) {
              player.push(drawCard());
              if (handValue(player) > 21) { coll.stop(); return await finish(i, `💥 **Battın!** ${handValue(player)} puan. **-${bet} coin**`, false); }
              return await i.update({ embeds: [buildEmbed(false)], components: [row] });
            }
            if (i.customId === standId) {
              coll.stop();
              while (handValue(dealer) < 17) dealer.push(drawCard());
              const pv = handValue(player), dv = handValue(dealer);
              if (dv > 21 || pv > dv) { const win = resolveWinAmount(bet); await db.addBalance(gid, uid, win); return await finish(i, `🎉 **Kazandın!** ${pv} vs ${dv}. **+${win} coin**`, true); }
              else if (pv === dv) { await db.addBalance(gid, uid, bet); return await finish(i, `🤝 **Berabere.** Bahsin iade edildi.`, true); }
              else return await finish(i, `😿 **Kaybettin.** ${pv} vs ${dv}. **-${bet} coin**`, false);
            }
            if (i.customId === cancelId) { coll.stop(); await db.addBalance(gid, uid, bet); return await finish(i, `🚫 **Vazgeçtin.** **${bet} coin** iade edildi.`, true); }
          } catch(err) {
            activeBlackjack.delete(bkey); await db.addBalance(gid, uid, bet);
            m2.edit({ content: '⛔ Hata oluştu, bahis iade edildi.', components: [] }).catch(() => {});
          }
        });
        coll.on('end', async (_, reason) => {
          if (reason === 'time' && activeBlackjack.has(bkey)) {
            activeBlackjack.delete(bkey);
            await db.addBalance(gid, uid, bet);
            m2.edit({ content: '⏰ Süre doldu, bahis iade edildi.', components: [] }).catch(() => {});
          }
        });
        return;
      } catch(err) {
        activeBlackjack.delete(bkey);
        if (betCharged) await db.addBalance(gid, uid, bet);
        sendErrorLog(gid, '/yirmibir', err);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ ephemeral: true, content: '⛔ Hata oluştu, bahis iade edildi.' }).catch(() => {});
        else await interaction.followUp({ ephemeral: true, content: '⛔ Hata oluştu, bahis iade edildi.' }).catch(() => {});
      }
    }

    // ── /atyarisi ────────────────────────────────────────────
    if (cmd === 'atyarisi') {
      const horse = interaction.options.getInteger('at');
      const bet   = interaction.options.getInteger('bahis');
      const cid   = interaction.channelId;
      let race = activeRaces.get(cid);
      const isNew = !race;
      if (!race) { race = { participants: [] }; activeRaces.set(cid, race); }
      if (race.participants.find(p => p.uid === uid)) return interaction.reply({ ephemeral: true, content: '⛔ Bu yarışa zaten bahis koydun.' });
      const deducted = await db.deductBalance(gid, uid, bet);
      if (!deducted) return interaction.reply({ ephemeral: true, content: `⛔ Yetersiz coin! Bakiye: **${(await db.getBalance(gid,uid)).balance}**` });
      race.participants.push({ uid, horse, bet });
      if (isNew) {
        await interaction.reply(`🐎 **At Yarışı** başladı! Katılmak için **20 saniye** içinde \`/atyarisi at:<1-6> bahis:<miktar>\` kullan.\n🏇 **${interaction.user.username}** → At **${horse}** — **${bet} coin**`);
        setTimeout(async () => {
          const winner = Math.floor(Math.random() * 6) + 1;
          const lines = [];
          for (const p of race.participants) {
            try {
              if (p.horse === winner) { const win = resolveWinAmount(p.bet); await db.addBalance(gid, p.uid, win); lines.push(`🏆 <@${p.uid}> — At ${p.horse} ✅ **+${win} coin**`); }
              else lines.push(`💨 <@${p.uid}> — At ${p.horse} ❌ **-${p.bet} coin**`);
            } catch { lines.push(`⚠️ <@${p.uid}> — At ${p.horse} ödeme hatası.`); }
          }
          activeRaces.delete(cid);
          const embed = new EmbedBuilder().setTitle('🏁 At Yarışı Sonuçlandı!').setColor(0xF1C40F)
            .setDescription(`🐎 Kazanan at: **${winner}**\n\n${lines.join('\n') || '_Katılımcı yok._'}`);
          const ch = await client.channels.fetch(cid).catch(() => null);
          if (ch?.isTextBased?.()) ch.send({ embeds: [embed] }).catch(() => {});
        }, 20_000);
        return;
      } else {
        return interaction.reply({ ephemeral: true, content: `✅ Yarışa katıldın! At **${horse}** — **${bet} coin**. Sonuçlar kısa süre sonra!` });
      }
    }

    // ── /sifirla ─────────────────────────────────────────────
    if (cmd === 'sifirla') {
      if (sub === 'hersey') {
        if (!hasOwnerAccess(uid, interaction.member)) return interaction.reply({ ephemeral: true, content: '⛔ Sadece bot sahipleri kullanabilir.' });
        await db.resetGuild(gid);
        return interaction.reply('🧨 Bu sunucuya ait tüm veriler temizlendi.');
      }
    }

  } catch(e) {
    sendErrorLog(interaction.guild?.id || null, `interactionCreate (${interaction.commandName || 'unknown'})`, e);
    try {
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '⛔ Bir hata oluştu.', ephemeral: true });
    } catch {}
  }
});

// ── SETUP PANELİ ─────────────────────────────────────────────
async function sendSetupPanel(interaction) {
  const gid = interaction.guild.id;
  const s = await db.getAllSettings(gid);
  const fmt = key => s[key] ? `<#${s[key]}>` : '_(ayarlanmamış)_';
  const colorRoles = await db.getColorRoles(gid);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ DeathWish Game — Ayar Paneli').setColor(0x5865F2)
    .setDescription('Aşağıdaki menüden ayarlamak istediğin bölümü seç.')
    .addFields(
      { name: '📊 Seviye',      value: `Kanal: ${fmt('level_channel')}` },
      { name: '💬 Sohbet',      value: `Kanal: ${fmt('sohbet_channel')}` },
      { name: '⌨️ Yazı Oyunu', value: `Kanal: ${fmt('yazi_oyunu_channel')}` },
      { name: '💰 Çal Kanalı', value: `Kanal: ${fmt('cal_channel')}` },
      { name: '🎨 Renk Rolleri', value: colorRoles.length ? colorRoles.map(r => `<@&${r.roleId}> — ${r.price} coin`).join('\n') : '_(henüz eklenmedi)_' },
      { name: '📋 Log Kanalları', value: [
        `⚡ XP: ${fmt('log_xp_channel')}`,
        `🏆 Level: ${fmt('log_level_channel')}`,
        `💰 Coin: ${fmt('log_coin_channel')}`,
        `💸 Ekonomi: ${fmt('log_economy_channel')}`,
        `🛒 Market: ${fmt('log_market_channel')}`,
        `💍 Evlilik: ${fmt('log_marriage_channel')}`,
        `🎙️ Ses: ${fmt('log_voice_channel')}`,
        `📝 Slash: ${fmt('log_slash_channel')}`,
        `⛔ Hata: ${fmt('log_error_channel')}`,
      ].join('\n') },
      { name: '💰 Ekonomi', value: `Günlük Ödül: **${s.daily_reward || '80'}** coin` },
    );

  const mainMenu = new StringSelectMenuBuilder()
    .setCustomId('setup_category')
    .setPlaceholder('Ayarlamak istediğin bölümü seç...')
    .addOptions([
      { label: '📊 Seviye Kanalı',        value: 'level_channel',       description: 'Seviye atlama mesajı kanalı' },
      { label: '💬 Sohbet Kanalı',        value: 'sohbet_channel',       description: 'Mesaj sayacı ve pasif coin kanalı' },
      { label: '⌨️ Yazı Oyunu Kanalı',   value: 'yazi_oyunu_channel',   description: '/yazioyunu baslat için özel kanal' },
      { label: '💰 Çal Komutu Kanalı',   value: 'cal_channel',           description: '/oyunlar cal komutunun kanalı' },
      { label: '🎨 Renk Rolü Ekle',       value: '__color_add__',         description: 'Renk rolü listesine ekle (50 coin)' },
      { label: '🎨 Renk Rolü Çıkar',      value: '__color_remove__',      description: 'Renk rolünü listeden çıkar' },
      { label: '⚡ XP Log Kanalı',        value: 'log_xp_channel',       description: 'XP logları' },
      { label: '🏆 Seviye Log',           value: 'log_level_channel',    description: 'Seviye log kanalı' },
      { label: '💰 Coin Log',             value: 'log_coin_channel',     description: 'Coin log kanalı' },
      { label: '💸 Ekonomi Log',          value: 'log_economy_channel',  description: 'Ekonomi log kanalı' },
      { label: '🛒 Market Log',           value: 'log_market_channel',   description: 'Market log kanalı' },
      { label: '💍 Evlilik Log',          value: 'log_marriage_channel', description: 'Evlilik log kanalı' },
      { label: '🎙️ Ses Log',             value: 'log_voice_channel',    description: 'Ses log kanalı' },
      { label: '📝 Slash Log',            value: 'log_slash_channel',    description: 'Slash komut log kanalı' },
      { label: '⛔ Hata Log',             value: 'log_error_channel',    description: 'Hata log kanalı' },
      { label: '💰 Günlük Ödül Miktarı', value: '__daily_reward__',      description: 'Günlük /ekonomi gunluk ödülü' },
    ]);

  const row = new ActionRowBuilder().addComponents(mainMenu);
  const msg = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true, fetchReply: true });

  const coll = msg.createMessageComponentCollector({ time: 120000 });
  coll.on('collect', async i => {
    if (!i.customId.startsWith('setup')) return;
    await handleSetupInteraction(i, i.customId.replace('setup_', ''));
  });
}

async function handleSetupInteraction(interaction, action) {
  const gid = interaction.guild.id;
  try {
    if (action === 'category') {
      const val = interaction.values[0];
      if (val === '__color_add__') {
        const menu = new RoleSelectMenuBuilder().setCustomId('setup___color_add___role').setPlaceholder('Eklenecek renk rolünü seç');
        return interaction.update({ content: '🎨 Eklenecek renk rolünü seç:', components: [new ActionRowBuilder().addComponents(menu)] });
      }
      if (val === '__color_remove__') {
        const colorRoles = await db.getColorRoles(gid);
        if (!colorRoles.length) return interaction.update({ content: '⛔ Henüz renk rolü yok.', components: [] });
        const menu = new StringSelectMenuBuilder().setCustomId('setup___color_remove___role').setPlaceholder('Çıkarılacak renk rolünü seç')
          .addOptions(colorRoles.slice(0,25).map(r => { const role = interaction.guild.roles.cache.get(r.roleId); return { label: role ? role.name : r.roleId, value: r.roleId }; }));
        return interaction.update({ content: '🎨 Çıkarılacak renk rolünü seç:', components: [new ActionRowBuilder().addComponents(menu)] });
      }
      if (val === '__daily_reward__') {
        await interaction.update({ content: '💰 Günlük ödül miktarı (10-500 arası sayı gir, 30 saniye içinde mesaj at):', components: [] });
        const coll = interaction.channel.createMessageCollector({ time: 30000, max: 1, filter: m => m.author.id === interaction.user.id });
        coll.on('collect', async m => {
          const n = parseInt(m.content);
          if (isNaN(n) || n < 10 || n > 500) return m.reply('⛔ Geçersiz sayı. 10-500 arası bir değer gir.').catch(() => {});
          await db.setSetting(gid, 'daily_reward', String(n));
          m.reply(`✅ Günlük ödül **${n} coin** olarak ayarlandı.`).catch(() => {});
          m.delete().catch(() => {});
        });
        return;
      }
      // Kanal seçimi
      const menu = new ChannelSelectMenuBuilder().setCustomId(`setup_${val}_chan`).setPlaceholder('Kanal seç').setChannelTypes([ChannelType.GuildText]);
      return interaction.update({ content: `📌 **${val}** için kanal seç:`, components: [new ActionRowBuilder().addComponents(menu)] });
    }

    if (action.endsWith('_chan')) {
      const key = action.replace('_chan', '');
      const chId = interaction.values[0];
      await db.setSetting(gid, key, chId);
      return interaction.update({ content: `✅ **${key}** kanalı <#${chId}> olarak ayarlandı.`, components: [] });
    }

    if (action === '__color_add___role') {
      const roleId = interaction.values[0];
      await db.addColorRole(gid, roleId, 50);
      return interaction.update({ content: `✅ <@&${roleId}> renk rolü **50 coin** ile listeye eklendi. Fiyatı değiştirmek için `/market-yonet` kullan.`, components: [] });
    }
    if (action === '__color_remove___role') {
      const roleId = interaction.values[0];
      await db.removeColorRole(gid, roleId);
      return interaction.update({ content: `✅ <@&${roleId}> renk rolü listeden çıkarıldı.`, components: [] });
    }
  } catch(e) {
    sendErrorLog(gid, 'handleSetupInteraction', e);
    interaction.update({ content: '⛔ Bir hata oluştu.', components: [] }).catch(() => {});
  }
}

// ── BAŞLAT ────────────────────────────────────────────────────
client.login(TOKEN).catch(e => { console.error('⛔ Giriş hatası:', e); process.exit(1); });
