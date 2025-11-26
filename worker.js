const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

// Estado interno
let account = {
    client: new SteamUser(),
    username: null,
    password: null,
    games: [],
    settings: {},
    sentryFileHash: null,
    steamGuardCallback: null,
    farmInterval: null,
    reloginTimeout: null
};

// Controle de Anti-Spam e Reconexão
const replyCooldowns = new Map(); 
let retryCount = 0;
const MAX_RETRIES = 10;

// --- LIMPEZA DE RECURSOS ---
function cleanup() {
    if (account.farmInterval) clearInterval(account.farmInterval);
    if (account.reloginTimeout) clearTimeout(account.reloginTimeout);
    if (account.client) {
        account.client.removeAllListeners();
    }
    account.steamGuardCallback = null;
}

// --- FUNÇÃO CENTRAL DE FARM (CORRIGIDA) ---
function farmGames() {
    if (!account.client.steamID) return;

    let gamesToPlay = [];

    // Prioridade: Título Customizado (CORREÇÃO APLICADA)
    if (account.settings.customInGameTitle && account.settings.customInGameTitle.trim().length > 0) {
        // A biblioteca steam-user aceita a string diretamente para "Non-Steam Game"
        // Isso força o status "Em jogo não Steam: [Seu Texto]"
        gamesToPlay = [account.settings.customInGameTitle];
        console.log(`[${account.username}] FARM: Modo Título Customizado: "${account.settings.customInGameTitle}"`);
    } else {
        // Farm de IDs (Limitado a 32 jogos pela Steam)
        gamesToPlay = account.games
            .map(id => parseInt(id, 10))
            .filter(id => !isNaN(id) && id > 0)
            .slice(0, 32); 
        console.log(`[${account.username}] FARM: A rodar ${gamesToPlay.length} jogos.`);
    }

    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    
    try {
        account.client.setPersona(personaState);
        
        // Se o array tiver itens (seja string ou IDs), envia
        if (gamesToPlay.length > 0) {
            account.client.gamesPlayed(gamesToPlay);
        } else {
            account.client.gamesPlayed([]); 
            console.log(`[${account.username}] FARM: Lista vazia, ficando apenas Online.`);
        }
    } catch (e) {
        console.error(`[${account.username}] ERRO AO FARMAR:`, e.message);
    }
}

// --- LÓGICA DE RECONEXÃO ---
function scheduleReconnect() {
    const delay = Math.min(10000 * Math.pow(2, retryCount), 300000); 
    console.log(`[${account.username}] Conexão perdida. Tentando reconectar em ${delay / 1000}s... (Tentativa ${retryCount + 1})`);
    
    account.reloginTimeout = setTimeout(() => {
        retryCount++;
        if(!account.client.steamID) {
            account.client.logOn({ 
                accountName: account.username, 
                password: account.password,
                shaSentryfile: account.sentryFileHash ? Buffer.from(account.sentryFileHash, 'base64') : undefined
            });
        }
    }, delay);
}

function setupListeners() {
    // === LOGIN BEM SUCEDIDO ===
    account.client.on('loggedOn', () => {
        console.log(`[${account.username}] LOGIN: Sucesso!`);
        retryCount = 0; 
        process.send({ type: 'statusUpdate', payload: { status: "Rodando", sessionStartTime: Date.now() } });

        farmGames();

        // *** BUSCA DE JOGOS ***
        console.log(`[${account.username}] INFO: Solicitando biblioteca...`);
        try {
            const filter = { includePlayedFreeGames: true, includeFreeSubGames: true };
            account.client.getUserOwnedApps(account.client.steamID, filter, (err, response) => {
                if (err) return;

                let validApps = [];
                if (Array.isArray(response)) validApps = response;
                else if (response && Array.isArray(response.apps)) validApps = response.apps;
                else if (response && Array.isArray(response.games)) validApps = response.games;
                else if (response && response.response && Array.isArray(response.response.games)) validApps = response.response.games;

                if (validApps.length > 0) {
                    const owned = validApps.map(app => ({ appid: app.appid, name: app.name }));
                    process.send({ type: 'ownedGamesUpdate', payload: { games: owned } });
                    console.log(`[${account.username}] SUCESSO: ${owned.length} jogos carregados.`);
                } else {
                    console.warn(`[${account.username}] ATENÇÃO: 0 jogos encontrados. Verifique se o perfil é público.`);
                }
            });
        } catch (e) {}

        // *** HEARTBEAT ***
        if (account.farmInterval) clearInterval(account.farmInterval);
        account.farmInterval = setInterval(() => { farmGames(); }, 10 * 60 * 1000);
    });

    // === MENSAGEM AUTOMÁTICA ===
    account.client.on('friendMessage', (steamID, message) => {
        if (account.settings.customAwayMessage && account.settings.customAwayMessage.trim().length > 0) {
            const sid = steamID.getSteamID64();
            const now = Date.now();
            const lastReply = replyCooldowns.get(sid) || 0;

            if (now - lastReply > 300000) {
                account.client.chatMessage(steamID, account.settings.customAwayMessage);
                replyCooldowns.set(sid, now);
                console.log(`[${account.username}] CHAT: Auto-resposta enviada para ${sid}.`);
            }
        }
    });

    // === STEAM GUARD ===
    account.client.on('steamGuard', (domain, callback) => {
        if (account.settings.sharedSecret) {
            try {
                const code = SteamTotp.generateAuthCode(account.settings.sharedSecret);
                console.log(`[${account.username}] GUARD: Gerando código automático.`);
                callback(code);
            } catch (e) {
                console.error(`[${account.username}] GUARD: Erro no Shared Secret.`);
                process.send({ type: 'statusUpdate', payload: { status: "Erro: Secret Inválido" } });
            }
        } else {
            console.log(`[${account.username}] GUARD: Aguardando código manual.`);
            process.send({ type: 'statusUpdate', payload: { status: "Pendente: Steam Guard" } });
            account.steamGuardCallback = callback;
        }
    });

    // === CONFLITO DE SESSÃO ===
    account.client.on('playingState', (blocked) => {
        if (blocked) console.log(`[${account.username}] CONFLITO: Usuário iniciou jogo. Pausando.`);
    });

    // === ERROS ===
    account.client.on('error', (err) => {
        console.error(`[${account.username}] ERRO: ${err.message}`);
        process.send({ type: 'statusUpdate', payload: { status: `Erro: ${err.message}` } });
        scheduleReconnect();
    });

    account.client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] DESCONECTADO: ${msg} (${eresult})`);
        scheduleReconnect();
    });

    // === EXTRAS ===
    account.client.on('sentry', (sentryHash) => {
        process.send({ type: 'sentryUpdate', payload: { sentryFileHash: sentryHash.toString('base64') } });
    });
    
    account.client.on('friendRelationship', (steamID, relationship) => {
        if (relationship === 2 && account.settings.autoAcceptFriends) { 
            account.client.addFriend(steamID);
        }
    });
}

// === COMUNICAÇÃO (IPC) ===
process.on('message', (message) => {
    const { command, data } = message;

    if (command === 'start') {
        if (!data || !data.username || !data.password) {
            console.error("Tentativa de iniciar worker com dados inválidos.");
            return;
        }

        cleanup(); 

        account.username = String(data.username);
        account.password = String(data.password);
        account.settings = data.settings || {};
        account.sentryFileHash = data.sentryFileHash;
        
        account.games = Array.isArray(data.games) ? data.games : [];

        setupListeners();

        const logonOptions = { accountName: account.username, password: account.password };
        if (account.sentryFileHash) {
            logonOptions.shaSentryfile = Buffer.from(account.sentryFileHash, 'base64');
        }
        
        console.log(`[${account.username}] INICIANDO: Conectando à Steam...`);
        account.client.logOn(logonOptions);
    }

    if (command === 'submitGuard' && account.steamGuardCallback) {
        account.steamGuardCallback(data.code);
        account.steamGuardCallback = null;
    }
    
    if (command === 'updateSettings') {
        if (data.settings) account.settings = data.settings;
        if (Array.isArray(data.games)) account.games = data.games;
        console.log(`[${account.username}] UPDATE: Configurações atualizadas.`);
        farmGames(); 
    }
});
