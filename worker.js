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

    // 1. Prepara os jogos (Converte para Inteiro e Filtra)
    let gamesToPlay = [];

    // Se tiver Título Customizado (Prioridade)
    if (account.settings.customInGameTitle) {
        gamesToPlay = [{
            game_id: 15190, // ID genérico para permitir texto customizado
            game_extra_info: account.settings.customInGameTitle
        }];
    } else {
        // Farm normal de AppIDs
        gamesToPlay = account.games.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    }

    // 2. Define Status (Online/Offline)
    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    
    // 3. Envia comandos para a Steam
    try {
        account.client.setPersona(personaState);
        
        if (gamesToPlay.length > 0) {
            account.client.gamesPlayed(gamesToPlay);
            console.log(`[${account.username}] FARM: A rodar ${gamesToPlay.length} jogos/título.`);
        } else {
            account.client.gamesPlayed([]); // Para o farm se a lista estiver vazia
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

        // Inicia o Farm imediatamente
        farmGames();

        // *** CORREÇÃO DO ERRO DE JOGOS (PLANO B) ***
        // Busca jogos com verificação de segurança
        account.client.getUserOwnedApps(account.client.steamID, (err, response) => {
            if (err) {
                console.error(`[${account.username}] Erro ao buscar jogos:`, err.message);
                return;
            }

            // BLINDAGEM: Verifica o formato da resposta antes de usar .map()
            let appsList = [];
            if (Array.isArray(response)) {
                appsList = response;
            } else if (response && Array.isArray(response.games)) {
                appsList = response.games;
            } else if (response && Array.isArray(response.apps)) {
                appsList = response.apps;
            }

            // Só processa se encontrou uma lista válida
            if (appsList.length > 0) {
                try {
                    const owned = appsList.map(app => ({ appid: app.appid, name: app.name }));
                    process.send({ type: 'ownedGamesUpdate', payload: { games: owned } });
                } catch (mapErr) {
                    console.error(`[${account.username}] Erro ao processar lista de jogos:`, mapErr);
                }
            }
        });

        // *** HEARTBEAT ***: Re-envia o comando de farm a cada 10 minutos para garantir que não caiu
        if (account.farmInterval) clearInterval(account.farmInterval);
        account.farmInterval = setInterval(() => {
            console.log(`[${account.username}] HEARTBEAT: Reforçando farm...`);
            farmGames();
        }, 10 * 60 * 1000); // 10 minutos
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

    // === CONFLITO DE SESSÃO (Você abriu um jogo no PC) ===
    account.client.on('playingState', (blocked, playingAppId) => {
        if (blocked) {
            console.log(`[${account.username}] CONFLITO: Usuário iniciou jogo em outro lugar. Pausando farm temporariamente.`);
            // Não precisamos fazer nada, a Steam pausa o bot automaticamente.
            // O nosso Heartbeat vai tentar retomar daqui a 10 minutos.
        }
    });

    // === ERROS E DESCONEXÕES ===
    account.client.on('error', (err) => {
        console.error(`[${account.username}] ERRO: ${err.message}`);
        process.send({ type: 'statusUpdate', payload: { status: `Erro: ${err.message}` } });
        // Se for erro fatal, tenta relogar em 60s
        setTimeout(() => {
            if(!account.client.steamID) account.client.logOn({ accountName: account.username, password: account.password });
        }, 60000);
    });

    account.client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] DESCONECTADO: ${msg} (${eresult})`);
        // Deixa o index.js decidir se reinicia o processo
        process.exit(0); 
    });

    // === EXTRAS ===
    account.client.on('sentry', (sentryHash) => {
        process.send({ type: 'sentryUpdate', payload: { sentryFileHash: sentryHash.toString('base64') } });
    });
    
    account.client.on('friendRelationship', (steamID, relationship) => {
        if (relationship === 2 && account.settings.autoAcceptFriends) { // 2 = RequestRecipient
            account.client.addFriend(steamID);
            console.log(`[${account.username}] AMIGO: Pedido aceito automaticamente.`);
        }
    });
}

// === COMUNICAÇÃO COM O GESTOR (index.js) ===
process.on('message', (message) => {
    const { command, data } = message;

    if (command === 'start') {
        account = { ...account, ...data };
        // Limpeza preventiva
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
        farmGames(); // Reaplica o farm instantaneamente
    }
});
