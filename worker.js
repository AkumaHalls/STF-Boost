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

    let gamesToPlay = [];

    if (account.settings.customInGameTitle) {
        gamesToPlay = [{
            game_id: 15190, 
            game_extra_info: account.settings.customInGameTitle
        }];
    } else {
        gamesToPlay = account.games.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    }

    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    
    try {
        account.client.setPersona(personaState);
        
        if (gamesToPlay.length > 0) {
            account.client.gamesPlayed(gamesToPlay);
            console.log(`[${account.username}] FARM: A rodar ${gamesToPlay.length} jogos/título.`);
        } else {
            account.client.gamesPlayed([]); 
            console.log(`[${account.username}] FARM: Lista vazia, ficando apenas Online.`);
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

        // 1. Inicia o Farm
        farmGames();

        // 2. Busca jogos da conta para cache (PLANO B)
        account.client.getUserOwnedApps(account.client.steamID, (err, apps) => {
            if (!err && apps) {
                // Mapeia para enviar apenas ID e Nome (reduz tamanho)
                const owned = apps.map(app => ({ appid: app.appid, name: app.name }));
                process.send({ type: 'ownedGamesUpdate', payload: { games: owned } });
            }
        });

        // *** HEARTBEAT ***
        if (account.farmInterval) clearInterval(account.farmInterval);
        account.farmInterval = setInterval(() => {
            farmGames();
        }, 10 * 60 * 1000); 
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
    account.client.on('playingState', (blocked, playingAppId) => {
        if (blocked) {
            console.log(`[${account.username}] CONFLITO: Pausando farm temporariamente.`);
        }
    });

    // === ERROS ===
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

// === COMUNICAÇÃO COM O GESTOR ===
process.on('message', (message) => {
    const { command, data } = message;

    if (command === 'start') {
        account = { ...account, ...data };
        if (account.client.steamID) account.client.logOff();
        setupListeners();
        const logonOptions = { accountName: account.username, password: account.password };
        if (account.sentryFileHash) logonOptions.shaSentryfile = Buffer.from(account.sentryFileHash, 'base64');
        account.client.logOn(logonOptions);
    }

    if (command === 'submitGuard' && account.steamGuardCallback) {
        account.steamGuardCallback(data.code);
        account.steamGuardCallback = null;
    }
    
    if (command === 'updateSettings') {
        account.settings = data.settings;
        account.games = data.games;
        farmGames();
    }
});
