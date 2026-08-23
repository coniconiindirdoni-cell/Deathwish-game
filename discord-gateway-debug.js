// discord-gateway-debug.js
// DeathWish Bot - Discord Gateway bağlantı teşhis dosyası
//
// index.js'ye hiçbir şey eklemen gerekmez.
// Sadece Discord Gateway bağlantısını test eder.

const { Client, GatewayIntentBits } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!TOKEN) {
    console.error('❌ DISCORD_TOKEN veya TOKEN environment variable bulunamadı.');
    console.error('Render Environment bölümünde token değişkeninin adını kontrol et.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
    ],
});

let finished = false;

function finish(code = 0) {
    if (finished) return;

    finished = true;

    try {
        client.destroy();
    } catch (_) {}

    setTimeout(() => process.exit(code), 250);
}

// ============================================================
// DISCORD GATEWAY OLAYLARI
// ============================================================

client.on('debug', (message) => {
    console.log(`🔎 DEBUG: ${message}`);
});

client.on('warn', (message) => {
    console.warn(`⚠️ WARN: ${message}`);
});

client.on('error', (error) => {
    console.error('🧨 CLIENT ERROR:');
    console.error(error);
});

client.on('shardError', (error, shardId) => {
    console.error(`🔌 SHARD ERROR (Shard ${shardId}):`);
    console.error(error);
});

client.on('shardReconnecting', (shardId) => {
    console.log(`♻️ SHARD ${shardId} yeniden bağlanıyor...`);
});

client.on('shardDisconnect', (event, shardId) => {
    console.error(`🔴 SHARD ${shardId} DISCONNECT`);

    if (event) {
        console.error('Close code:', event.code);
        console.error('Close reason:', event.reason || '(boş)');
    }

    console.error('Close event:', event);
});

client.on('shardReady', (shardId) => {
    console.log(`🟢 SHARD ${shardId} READY`);
});

client.on('ready', () => {
    console.log('');
    console.log('========================================');
    console.log('✅ DISCORD GATEWAY BAĞLANTISI BAŞARILI');
    console.log(`🤖 Bot: ${client.user?.tag || 'bilinmiyor'}`);
    console.log(`🆔 ID: ${client.user?.id || 'bilinmiyor'}`);
    console.log(`🏠 Guild sayısı: ${client.guilds.cache.size}`);
    console.log(`📡 client.isReady(): ${client.isReady()}`);
    console.log('========================================');
    console.log('');

    console.log('⏱️ Gateway 60 saniye stabilite testi başlıyor...');

    setTimeout(() => {
        if (client.isReady()) {
            console.log('');
            console.log('========================================');
            console.log('✅ 60 SANİYELİK TEST BAŞARILI');
            console.log('Gateway bağlantısı stabil görünüyor.');
            console.log('========================================');

            finish(0);
        } else {
            console.error('');
            console.error('========================================');
            console.error('❌ 60 SANİYE SONUNDA client.isReady() FALSE');
            console.error('Gateway bağlantısı stabil değil.');
            console.error('========================================');

            finish(1);
        }
    }, 60_000);
});

// ============================================================
// LOGIN TIMEOUT
// ============================================================

const LOGIN_TIMEOUT_MS = 30_000;

const loginTimeout = setTimeout(() => {
    console.error('');
    console.error('========================================');
    console.error('❌ LOGIN TIMEOUT');
    console.error('========================================');

    console.error(
        `Discord Gateway ${LOGIN_TIMEOUT_MS / 1000} saniye içinde READY olmadı.`
    );

    console.error(`client.isReady(): ${client.isReady()}`);

    console.error('');
    console.error('Bu durumda interaction/komut kodlarına henüz gelinmemiş demektir.');
    console.error('Render → Discord Gateway bağlantısını teşhis etmemiz gerekiyor.');
    console.error('========================================');

    finish(2);

}, LOGIN_TIMEOUT_MS);

// ============================================================
// LOGIN
// ============================================================

(async () => {

    try {

        console.log('');
        console.log('========================================');
        console.log('🔑 DISCORD GATEWAY TEST BAŞLIYOR');
        console.log('========================================');

        console.log(`🌐 Node: ${process.version}`);

        try {
            console.log(
                `📦 discord.js: ${require('discord.js').version || 'sürüm okunamadı'}`
            );
        } catch (_) {
            console.log('📦 discord.js sürümü okunamadı.');
        }

        console.log('⏳ 30 saniye içinde READY bekleniyor...');
        console.log('');

        await client.login(TOKEN);

        clearTimeout(loginTimeout);

        if (client.isReady()) {

            console.log('✅ client.login() tamamlandı.');
            console.log('✅ Client READY durumda.');

        } else {

            console.log(
                'ℹ️ client.login() tamamlandı fakat READY henüz gelmedi.'
            );

            console.log('ℹ️ ready event bekleniyor...');

        }

    } catch (error) {

        clearTimeout(loginTimeout);

        console.error('');
        console.error('========================================');
        console.error('❌ DISCORD LOGIN HATASI');
        console.error('========================================');

        console.error(error);

        if (error?.code) {
            console.error('Discord hata kodu:', error.code);
        }

        if (error?.message) {
            console.error('Mesaj:', error.message);
        }

        console.error('========================================');

        finish(1);
    }

})();

// ============================================================
// GENEL NODE HATALARI
// ============================================================

process.on('unhandledRejection', (reason) => {

    console.error('');
    console.error('❌ UNHANDLED REJECTION:');
    console.error(reason);

});

process.on('uncaughtException', (error) => {

    console.error('');
    console.error('❌ UNCAUGHT EXCEPTION:');
    console.error(error);

});
