const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

let account = {
    client: new SteamUser(),
    username: null,
    password: null,
    games: [],
    settings: {},
    sentryFileHash: null,
    steamGuardCallback: null,
    reloginInterval: null,
    farmInterval: null
};

// --- FUNÇÃO CENTRAL DE FARM ---
function farmGames() {
    if (!account.client.steamID) return;

    // 1. Prepara os jogos
    let gamesToPlay = [];

    // Lógica de Prioridade: Se tiver Título Customizado, ignora os IDs dos jogos
    // (A Steam não permite farmar IDs reais E mostrar texto customizado ao mesmo tempo)
    if (account.settings.customInGameTitle && account.settings.customInGameTitle.trim().length > 0) {
        gamesToPlay = [{
            game_id: 15190, // ID genérico usado para Non-Steam Games
            game_extra_info: account.settings.customInGameTitle
        }];
        console.log(`[${account.username}] FARM: Modo Título Customizado: "${account.settings.customInGameTitle}"`);
    } else {
        // Farm normal de AppIDs
        gamesToPlay = account.games.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
        console.log(`[${account.username}] FARM: Modo Jogos (Qtd: ${gamesToPlay.length})`);
    }

    // 2. Define Status (Online/Offline)
    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    
    // 3. Envia comandos para a Steam
    try {
        account.client.setPersona(personaState);
        
        if (gamesToPlay.length > 0) {
            account.client.gamesPlayed(gamesToPlay);
        } else {
            account.client.gamesPlayed([]); // Fica apenas online sem jogar nada
            console.log(`[${account.username}] FARM: Nenhum jogo ou título configurado.`);
        }
    } catch (e) {
        console.error(`[${account.username}] ERRO AO FARMAR:`, e.message);
    }
}

function setupListeners() {
    // === LOGIN BEM SUCEDIDO ===
    account.client.on('loggedOn', () => {
        console.log(`[${account.username}] LOGIN: Sucesso!`);
        process.send({ type: 'statusUpdate', payload: { status: "Rodando", sessionStartTime: Date.now() } });

        // Inicia o Farm imediatamente
        farmGames();

        // *** BUSCA DE JOGOS (COM SUPORTE A JOGOS FREE E AVISO DE PRIVACIDADE) ***
        console.log(`[${account.username}] INFO: Solicitando biblioteca...`);
        
        try {
            const filter = { includePlayedFreeGames: true, includeFreeSubGames: true };

            account.client.getUserOwnedApps(account.client.steamID, filter, (err, response) => {
                if (err) { return; } // Ignora erro silenciosamente no log para não poluir

                let validApps = [];
                if (Array.isArray(response)) validApps = response;
                else if (response && Array.isArray(response.apps)) validApps = response.apps;
                else if (response && Array.isArray(response.games)) validApps = response.games;
                else if (response && response.response && Array.isArray(response.response.games)) validApps = response.response.games;

                if (validApps.length > 0) {
                    const owned = validApps.map(app => ({ appid: app.appid, name: app.name }));
                    process.send({ type: 'ownedGamesUpdate', payload: { games: owned } });
                    console.log(`[${account.username}] SUCESSO: ${owned.length} jogos carregados.`);
                }
            });
        } catch (e) {}

        // *** HEARTBEAT ***
        if (account.farmInterval) clearInterval(account.farmInterval);
        account.farmInterval = setInterval(() => { farmGames(); }, 10 * 60 * 1000); 
    });

    // === NOVA FUNÇÃO: AUTO-RESPOSTA (MENSAGEM AUTOMÁTICA) ===
    account.client.on('friendMessage', (steamID, message) => {
        if (account.settings.customAwayMessage && account.settings.customAwayMessage.trim().length > 0) {
            // Evita loop de resposta infinita ou responder a si mesmo
            // Apenas responde se tiver uma mensagem configurada
            account.client.chatMessage(steamID, account.settings.customAwayMessage);
            console.log(`[${account.username}] CHAT: Auto-resposta enviada para ${steamID}.`);
        }
    });

    // === STEAM GUARD NECESSÁRIO ===
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
    account.client.on('playingState', (blocked, playingAppId) => {
        if (blocked) {
            console.log(`[${account.username}] CONFLITO: Usuário iniciou jogo em outro lugar.`);
        }
    });

    // === ERROS E DESCONEXÕES ===
    account.client.on('error', (err) => {
        console.error(`[${account.username}] ERRO: ${err.message}`);
        process.send({ type: 'statusUpdate', payload: { status: `Erro: ${err.message}` } });
        setTimeout(() => {
            if(!account.client.steamID) account.client.logOn({ accountName: account.username, password: account.password });
        }, 60000);
    });

    account.client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] DESCONECTADO: ${msg} (${eresult})`);
        process.exit(0); 
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

// === COMUNICAÇÃO COM O GESTOR (index.js) ===
process.on('message', (message) => {
    const { command, data } = message;

    if (command === 'start') {
        account = { ...account, ...data };
        if (account.client.steamID) account.client.logOff();
        
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
        console.log(`[${account.username}] UPDATE: Configurações recebidas.`);
        account.settings = data.settings;
        account.games = data.games;
        farmGames(); // Reaplica o farm/título instantaneamente
    }
});
