const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

// --- REDE DE SEGURANÇA ANTI-CRASH ---
process.on('uncaughtException', (err) => {
    console.error(`[CRASH PREVENIDO] Erro:`, err);
});

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

// --- LIMPEZA DE RECURSOS ---
function cleanup() {
    if (account.farmInterval) clearInterval(account.farmInterval);
    if (account.reloginTimeout) clearTimeout(account.reloginTimeout);
    if (account.client) {
        account.client.removeAllListeners();
    }
    account.steamGuardCallback = null;
}

// --- FUNÇÃO CENTRAL DE FARM ---
function farmGames() {
    if (!account.client.steamID) return;

    let gamesToPlay = [];

    if (account.settings.customInGameTitle && account.settings.customInGameTitle.trim().length > 0) {
        gamesToPlay = [account.settings.customInGameTitle];
        console.log(`[${account.username}] FARM: Título Customizado: "${account.settings.customInGameTitle}"`);
    } else {
        gamesToPlay = account.games
            .map(id => parseInt(id, 10))
            .filter(id => !isNaN(id) && id > 0)
            .slice(0, 32); 
        console.log(`[${account.username}] FARM: A rodar ${gamesToPlay.length} jogos.`);
    }

    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    
    try {
        account.client.setPersona(personaState);
        if (gamesToPlay.length > 0) account.client.gamesPlayed(gamesToPlay);
        else account.client.gamesPlayed([]); 
    } catch (e) {
        console.error(`[${account.username}] ERRO AO FARMAR:`, e.message);
    }
}

// --- LÓGICA DE RECONEXÃO INTELIGENTE (CORRIGIDA) ---
function handleLoginError(erroMsg) {
    // CASO 1: ERROS FATAIS (Não adianta tentar de novo rápido)
    if (erroMsg.includes('InvalidPassword') || erroMsg.includes('AccountLoginDeniedThrottle') || erroMsg.includes('RateLimitExceeded')) {
        
        let waitTime = 0;
        let statusMsg = "";

        if (erroMsg.includes('InvalidPassword')) {
            // Se deu senha errada, pode ser o IP bloqueado ou senha errada mesmo.
            // Vamos esperar 10 minutos antes de tentar de novo para limpar o IP.
            waitTime = 10 * 60 * 1000; 
            statusMsg = "Erro: Senha/IP (Aguardando 10m)";
        } else {
            // Se for Throttle explícito, espera 30 minutos
            waitTime = 30 * 60 * 1000;
            statusMsg = "Bloqueio Steam (Aguardando 30m)";
        }

        console.error(`[${account.username}] ERRO CRÍTICO: ${erroMsg}. Entrando em espera por ${waitTime/60000} min.`);
        process.send({ type: 'statusUpdate', payload: { status: statusMsg } });

        // Não usamos scheduleReconnect aqui para não somar ao backoff exponencial padrão
        // Usamos um timeout único longo.
        if (account.reloginTimeout) clearTimeout(account.reloginTimeout);
        account.reloginTimeout = setTimeout(() => {
            console.log(`[${account.username}] Tentando reconexão após espera longa...`);
            if(!account.client.steamID) {
                account.client.logOn({ 
                    accountName: account.username, 
                    password: account.password,
                    shaSentryfile: account.sentryFileHash ? Buffer.from(account.sentryFileHash, 'base64') : undefined
                });
            }
        }, waitTime);
        return;
    }

    // CASO 2: ERROS DE REDE COMUNS (Backoff Exponencial)
    const delay = Math.min(10000 * Math.pow(2, retryCount), 300000); 
    console.log(`[${account.username}] Erro comum (${erroMsg}). Reconectando em ${delay / 1000}s...`);
    
    process.send({ type: 'statusUpdate', payload: { status: `Reconectando (${Math.ceil(delay/1000)}s)...` } });

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

        // Busca Jogos
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
                }
            });
        } catch (e) {}

        // Heartbeat
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
        if (blocked) console.log(`[${account.username}] CONFLITO: Usuário iniciou jogo.`);
    });

    // === ERROS ===
    account.client.on('error', (err) => {
        handleLoginError(err.message);
    });

    account.client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] DESCONECTADO: ${msg} (${eresult})`);
        // EResult 5 = InvalidPassword, EResult 84 = RateLimit
        if (eresult === 5 || eresult === 84) {
            handleLoginError(eresult === 5 ? "InvalidPassword" : "AccountLoginDeniedThrottle");
        } else {
            handleLoginError("Disconnected");
        }
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

// === COMUNICAÇÃO ===
process.on('message', (message) => {
    const { command, data } = message;

    if (command === 'start') {
        if (!data || !data.username) return;

        cleanup(); 

        account.username = String(data.username);
        account.password = String(data.password);
        account.settings = data.settings || {};
        account.sentryFileHash = data.sentryFileHash;
        account.games = Array.isArray(data.games) ? data.games : [];

        setupListeners();

        const logonOptions = { accountName: account.username };
        if (account.password) logonOptions.password = account.password;
        if (account.sentryFileHash) {
            logonOptions.shaSentryfile = Buffer.from(account.sentryFileHash, 'base64');
        }
        
        console.log(`[${account.username}] INICIANDO: Conectando...`);
        try {
            account.client.logOn(logonOptions);
        } catch (e) {
            console.error(`[${account.username}] Erro FATAL no logOn:`, e);
        }
    }

    if (command === 'submitGuard' && account.steamGuardCallback) {
        try { account.steamGuardCallback(data.code); account.steamGuardCallback = null; } catch(e){}
    }
    
    if (command === 'updateSettings') {
        if (data.settings) account.settings = data.settings;
        if (Array.isArray(data.games)) account.games = data.games;
        farmGames(); 
    }
});
