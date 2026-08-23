// discord-network-test.js
// DeathWish - Discord Gateway RAW Network Test
//
// Bu test discord.js KULLANMAZ.
// Doğrudan Discord REST + WebSocket Gateway bağlantısını test eder.
//
// Node 22+ gerektirir.
// Render'daki Node 26 ile çalışır.
//
// index.js'ye hiçbir şey ekleme.

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!TOKEN) {
    console.error('❌ DISCORD_TOKEN veya TOKEN bulunamadı.');
    process.exit(1);
}

const API = 'https://discord.com/api/v10';

const TIMEOUT = 20_000;

function timeout(ms) {
    return new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error(`${ms / 1000} saniyelik timeout`));
        }, ms);
    });
}

async function restRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bot ${TOKEN}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }

    return {
        status: response.status,
        ok: response.ok,
        data
    };
}

// ============================================================
// 1. DISCORD REST API TEST
// ============================================================

async function testRest() {

    console.log('');
    console.log('==========================================');
    console.log('🌐 1) DISCORD REST API TESTİ');
    console.log('==========================================');

    try {

        const result = await Promise.race([
            restRequest(`${API}/gateway/bot`),
            timeout(TIMEOUT)
        ]);

        console.log(`HTTP Status: ${result.status}`);

        if (!result.ok) {

            console.error('❌ Discord REST API hata döndürdü.');

            console.error(
                'Discord cevabı:',
                JSON.stringify(result.data, null, 2)
            );

            return null;
        }

        console.log('✅ Discord REST API erişilebilir.');

        console.log(
            'Gateway URL:',
            result.data.url
        );

        console.log(
            'Önerilen shard:',
            result.data.shards
        );

        if (result.data.session_start_limit) {

            console.log(
                'Session remaining:',
                result.data.session_start_limit.remaining
            );

            console.log(
                'Session total:',
                result.data.session_start_limit.total
            );

            console.log(
                'Max concurrency:',
                result.data.session_start_limit.max_concurrency
            );
        }

        return result.data.url;

    } catch (error) {

        console.error('❌ REST TEST HATASI');
        console.error(error.message);

        return null;
    }
}

// ============================================================
// 2. RAW WEBSOCKET TEST
// ============================================================

async function testGateway(gatewayUrl) {

    console.log('');
    console.log('==========================================');
    console.log('🔌 2) RAW DISCORD GATEWAY TESTİ');
    console.log('==========================================');

    if (!gatewayUrl) {

        console.error(
            '❌ Gateway URL alınamadığı için WebSocket testi yapılamıyor.'
        );

        return false;
    }

    const wsUrl =
        `${gatewayUrl}?v=10&encoding=json`;

    console.log('WebSocket bağlantısı açılıyor...');
    console.log('Adres:', wsUrl);

    return new Promise((resolve) => {

        let finished = false;
        let identified = false;

        const finish = (success) => {

            if (finished) return;

            finished = true;

            try {
                ws.close();
            } catch (_) {}

            resolve(success);
        };

        let ws;

        try {

            // Node 22+ / Render Node 26
            ws = new WebSocket(wsUrl);

        } catch (error) {

            console.error('');
            console.error('❌ WebSocket oluşturulamadı.');
            console.error(error);

            finish(false);

            return;
        }

        const timer = setTimeout(() => {

            console.error('');
            console.error('==========================================');
            console.error('❌ WEBSOCKET TIMEOUT');
            console.error('==========================================');
            console.error(
                `Discord Gateway ${TIMEOUT / 1000} saniye içinde READY göndermedi.`
            );

            console.error(
                'identified:',
                identified
            );

            finish(false);

        }, TIMEOUT);

        ws.addEventListener('open', () => {

            console.log('');
            console.log('🟢 WEBSOCKET OPEN');

            console.log(
                'Render → Discord Gateway WebSocket bağlantısı açıldı.'
            );

            console.log('');
            console.log('⏳ Discord HELLO paketi bekleniyor...');

        });

        ws.addEventListener('message', async (event) => {

            let packet;

            try {

                packet =
                    JSON.parse(
                        typeof event.data === 'string'
                            ? event.data
                            : event.data.toString()
                    );

            } catch (error) {

                console.error(
                    '❌ Gateway mesajı JSON olarak okunamadı.'
                );

                return;
            }

            console.log('');
            console.log(
                `📨 Gateway paketi geldi → OP ${packet.op}`
            );

            // ------------------------------------------------
            // OP 10 = HELLO
            // ------------------------------------------------

            if (packet.op === 10) {

                console.log('🟢 DISCORD HELLO GELDİ');

                console.log(
                    'Heartbeat interval:',
                    packet.d?.heartbeat_interval,
                    'ms'
                );

                console.log('');
                console.log('📤 IDENTIFY gönderiliyor...');

                const identify = {

                    op: 2,

                    d: {

                        token: TOKEN,

                        intents: 1, // Guilds

                        properties: {

                            os: 'linux',

                            browser: 'deathwish-network-test',

                            device: 'deathwish-network-test'

                        }

                    }

                };

                try {

                    ws.send(
                        JSON.stringify(identify)
                    );

                    identified = true;

                    console.log(
                        '✅ IDENTIFY gönderildi.'
                    );

                    console.log(
                        '⏳ READY bekleniyor...'
                    );

                } catch (error) {

                    console.error(
                        '❌ IDENTIFY gönderilemedi.'
                    );

                    console.error(error);

                    clearTimeout(timer);

                    finish(false);
                }

            }

            // ------------------------------------------------
            // OP 0 = DISPATCH
            // ------------------------------------------------

            else if (packet.op === 0) {

                console.log(
                    '📦 EVENT:',
                    packet.t
                );

                // READY
                if (packet.t === 'READY') {

                    clearTimeout(timer);

                    console.log('');
                    console.log('==========================================');
                    console.log('🎉 RAW GATEWAY TEST BAŞARILI');
                    console.log('==========================================');

                    console.log(
                        '✅ WebSocket OPEN'
                    );

                    console.log(
                        '✅ Discord HELLO alındı'
                    );

                    console.log(
                        '✅ IDENTIFY kabul edildi'
                    );

                    console.log(
                        '✅ Discord READY gönderdi'
                    );

                    console.log('');

                    console.log(
                        'Bot user ID:',
                        packet.d?.user?.id
                    );

                    console.log(
                        'Bot username:',
                        packet.d?.user?.username
                    );

                    console.log(
                        'Guild sayısı:',
                        packet.d?.guilds?.length
                    );

                    console.log('');
                    console.log(
                        '🔥 Render → Discord Gateway bağlantısı ÇALIŞIYOR.'
                    );

                    finish(true);
                }
            }

            // ------------------------------------------------
            // OP 9 = INVALID SESSION
            // ------------------------------------------------

            else if (packet.op === 9) {

                clearTimeout(timer);

                console.error('');
                console.error(
                    '❌ DISCORD: INVALID SESSION'
                );

                console.error(
                    'd:',
                    packet.d
                );

                finish(false);
            }

            // ------------------------------------------------
            // OP 7 = RECONNECT
            // ------------------------------------------------

            else if (packet.op === 7) {

                console.error('');
                console.error(
                    '🔄 Discord Gateway RECONNECT istedi.'
                );

                clearTimeout(timer);

                finish(false);
            }

            // ------------------------------------------------
            // OP 11 = HEARTBEAT ACK
            // ------------------------------------------------

            else if (packet.op === 11) {

                console.log(
                    '💓 HEARTBEAT ACK'
                );
            }
        });

        ws.addEventListener('error', (event) => {

            clearTimeout(timer);

            console.error('');
            console.error('==========================================');
            console.error('❌ RAW WEBSOCKET ERROR');
            console.error('==========================================');

            console.error(event);

            finish(false);

        });

        ws.addEventListener('close', (event) => {

            clearTimeout(timer);

            console.error('');
            console.error('==========================================');
            console.error('🔴 WEBSOCKET CLOSED');
            console.error('==========================================');

            console.error(
                'Close code:',
                event.code
            );

            console.error(
                'Close reason:',
                event.reason || '(boş)'
            );

            if (!finished) {
                finish(false);
            }

        });

    });
}

// ============================================================
// MAIN
// ============================================================

(async () => {

    console.log('');
    console.log('==========================================');
    console.log('🧪 DEATHWISH DISCORD NETWORK TEST');
    console.log('==========================================');

    console.log(
        'Node:',
        process.version
    );

    console.log(
        'Test: discord.js KULLANILMIYOR'
    );

    console.log(
        'Test: doğrudan Discord Gateway'
    );

    console.log('');

    const gatewayUrl = await testRest();

    if (!gatewayUrl) {

        console.error('');
        console.error(
            '❌ REST testi başarısız.'
        );

        console.error(
            'Gateway testine geçilmiyor.'
        );

        process.exit(1);
    }

    const success =
        await testGateway(gatewayUrl);

    console.log('');

    if (success) {

        console.log(
            '🟢 SONUÇ: Discord Gateway çalışıyor.'
        );

        console.log(
            'Sorun discord.js / mevcut bot yapılandırması tarafında aranmalı.'
        );

        process.exit(0);

    } else {

        console.error(
            '🔴 SONUÇ: Raw Gateway testi başarısız.'
        );

        console.error(
            'Render → Discord Gateway bağlantısında problem var.'
        );

        process.exit(2);
    }

})();
