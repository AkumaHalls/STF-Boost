const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

// --- REDE DE SEGURANÇA ANTI-CRASH ---
process.on('uncaughtException', (err) => {
    // Ignora erros de "Already attempting" para não sujar o log, pois já tratamos na lógica
    if (err.message && (err.message.includes('Already attempting') || err.message.includes('Already logged on'))) {
        return;
    }
    console.error(`[CRASH PREVENIDO] Erro:`, err);
});

// Estado interno
let account = {
    client: new SteamUser({ enablePicsCache: false }),
    username: null,
    password: null,
    games: [],
    settings: {},
    sentryFileHash: null,
    steamGuardCallback: null,
    farmInterval: null,
    reloginTimeout: null,
    isLoggingIn: false // <--- NOVA PROTEÇÃO
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
    account.isLoggingIn = false;
}

// --- FUNÇÃO CENTRAL DE FARM ---
function farmGames() {
    // Se não estiver logado, não tenta farmar
    if (!account.client.steamID) return;

    let gamesToPlay = [];

    if (account.settings.customInGameTitle && account.settings.customInGameTitle.trim().length > 0) {
        gamesToPlay = [account.settings.customInGameTitle];
    } else {
        gamesToPlay = account.games
            .map(id => parseInt(id, 10))
            .filter(id => !isNaN(id) && id > 0)
            .slice(0, 32); 
    }

    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    
    try {
        account.client.setPersona(personaState);
        if (gamesToPlay.length > 0) account.client.gamesPlayed(gamesToPlay);
        else account.client.gamesPlayed([]); 
    } catch (e) {
        // Ignora erro se for apenas falha de envio momentânea
    }
}

// --- FUNÇÃO DE LOGIN SEGURA ---
function performLogin() {
    // AQUI ESTÁ A CORREÇÃO: Se já estiver tentando ou logado, aborta
    if (account.isLoggingIn || account.client.steamID) return;

    account.isLoggingIn = true; // Levanta a bandeira

    const logonOptions = { accountName: account.username };
    if (account.password) logonOptions.password = account.password;
    if (account.sentryFileHash) {
        logonOptions.shaSentryfile = Buffer.from(account.sentryFileHash, 'base64');
    }
    
    // Tratamento de machineId para evitar repetição de Guard
    // (Opcional, mas recomendado se você persistir isso no futuro)
    
    console.log(`[${account.username}] Conectando...`);
    
    try {
        account.client.logOn(logonOptions);
    } catch (e) {
        console.error(`[${account.username}] Erro ao chamar logOn:`, e.message);
        account.isLoggingIn = false; // Libera a bandeira em caso de erro síncrono
        handleLoginError(e.message);
    }
}

// --- LÓGICA DE RECONEXÃO ---
function handleLoginError(erroMsg) {
    account.isLoggingIn = false; // Libera para tentar de novo

    if (erroMsg.includes('InvalidPassword')) {
        console.error(`[${account.username}] Senha Incorreta. Parando.`);
        process.send({ type: 'statusUpdate', payload: { status: "Erro: Senha Inválida" } });
        return; // Não tenta reconectar
    }

    if (erroMsg.includes('RateLimitExceeded') || erroMsg.includes('AccountLoginDeniedThrottle')) {
        const waitTime = 30 * 60 * 1000; // 30 minutos
        console.error(`[${account.username}] Throttle Steam. Aguardando 30min.`);
        process.send({ type: 'statusUpdate', payload: { status: "Bloqueio Temp. (30min)" } });
        
        if (account.reloginTimeout) clearTimeout(account.reloginTimeout);
        account.reloginTimeout = setTimeout(() => {
            performLogin();
        }, waitTime);
        return;
    }

    // Erros genéricos
    const delay = Math.min(10000 * Math.pow(2, retryCount), 120000); // Max 2 min
    console.log(`[${account.username}] Reconectando em ${Math.ceil(delay/1000)}s... (${erroMsg})`);
    process.send({ type: 'statusUpdate', payload: { status: `Reconectando (${Math.ceil(delay/1000)}s)` } });

    if (account.reloginTimeout) clearTimeout(account.reloginTimeout);
    account.reloginTimeout = setTimeout(() => {
        retryCount++;
        performLogin();
    }, delay);
}

function setupListeners() {
    if (account.client.listenerCount('loggedOn') > 0) return; // Evita duplicar listeners

    // === LOGIN BEM SUCEDIDO ===
    account.client.on('loggedOn', () => {
        console.log(`[${account.username}] LOGIN: Sucesso!`);
        account.isLoggingIn = false; // Libera a bandeira
        retryCount = 0; 
        process.send({ type: 'statusUpdate', payload: { status: "Rodando", sessionStartTime: Date.now() } });

        farmGames();

        // Busca Jogos
        try {
            const filter = { includePlayedFreeGames: true, includeFreeSubGames: true };
            account.client.getUserOwnedApps(account.client.steamID, filter, (err, response) => {
                if (err) return;
                let validApps = [];
                // Lógica de compatibilidade de versões da lib steam-user
                if (Array.isArray(response)) validApps = response;
                else if (response && Array.isArray(response.apps)) validApps = response.apps;
                
                if (validApps.length > 0) {
                    const owned = validApps.map(app => ({ appid: app.appid, name: app.name }));
                    process.send({ type: 'ownedGamesUpdate', payload: { games: owned } });
                }
            });
        } catch (e) {}

        // Heartbeat
        if (account.farmInterval) clearInterval(account.farmInterval);
        account.farmInterval = setInterval(() => { farmGames(); }, 5 * 60 * 1000);
    });

    // === MENSAGEM AUTOMÁTICA ===
    account.client.on('friendMessage', (steamID, message) => {
        if (account.settings.customAwayMessage && account.settings.customAwayMessage.trim().length > 0) {
            const sid = steamID.getSteamID64();
            const now = Date.now();
            const lastReply = replyCooldowns.get(sid) || 0;

            if (now - lastReply > 300000) { // 5 min
                account.client.chatMessage(steamID, account.settings.customAwayMessage);
                replyCooldowns.set(sid, now);
            }
        }
    });

    // === STEAM GUARD ===
    account.client.on('steamGuard', (domain, callback) => {
        account.isLoggingIn = false; // Paramos de "conectar", agora estamos "aguardando"
        
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

    // === ERROS ===
    account.client.on('error', (err) => {
        handleLoginError(err.message);
    });

    account.client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] Caiu: ${msg} (${eresult})`);
        if (eresult === 5) return handleLoginError("InvalidPassword"); // Evita loop
        handleLoginError("Disconnected");
    });

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

        // Garante que o cliente é novo ou limpo
        if (!account.client) account.client = new SteamUser({ enablePicsCache: false });
        account.client.removeAllListeners();
        
        setupListeners();
        performLogin(); // Usa a nova função segura
    }

    if (command === 'submitGuard' && account.steamGuardCallback) {
        try { account.steamGuardCallback(data.code); account.steamGuardCallback = null; } catch(e){}
    }
    
    if (command === 'updateSettings') {
        if (data.settings) account.settings = data.settings;
        if (Array.isArray(data.games)) account.games = data.games;
        if (account.client.steamID) farmGames(); 
    }
    
    if (command === 'stop') {
        cleanup();
        try { account.client.logOff(); } catch(e) {}
        process.exit(0);
    }
});
