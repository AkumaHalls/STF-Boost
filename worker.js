const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

// --- PREVENÇÃO DE CRASH ---
process.on('uncaughtException', (err) => {
    console.error(`[WORKER CRASH PREVENTED] Erro não tratado:`, err);
    // Em caso de erro crítico, avisa o gestor para reiniciar este worker
    if (process.connected) process.exit(1);
});

// --- ESTADO INTERNO ---
const account = {
    client: null, // Instanciado sob demanda
    username: null,
    password: null,
    games: [],
    settings: {},
    sentryFileHash: null,
    steamGuardCallback: null,
    farmInterval: null,
    reloginTimeout: null,
    isStopping: false
};

// Mapa de cooldown para respostas automáticas (Anti-Spam)
const replyCooldowns = new Map();
let retryCount = 0;

// --- FUNÇÕES AUXILIARES ---

function cleanup() {
    if (account.farmInterval) clearInterval(account.farmInterval);
    if (account.reloginTimeout) clearTimeout(account.reloginTimeout);
    
    if (account.client) {
        account.client.removeAllListeners();
        // Não damos logOff aqui para evitar que a Steam bloqueie por "logouts frequentes" 
        // se a intenção for apenas reiniciar a lógica.
    }
    
    account.steamGuardCallback = null;
    account.farmInterval = null;
    account.reloginTimeout = null;
}

function farmGames() {
    // Segurança: Só farma se estiver logado e com SteamID válido
    if (!account.client || !account.client.steamID) return;

    let gamesToPlay = [];

    // Prioridade: Título Customizado
    if (account.settings.customInGameTitle && account.settings.customInGameTitle.trim().length > 0) {
        gamesToPlay = [account.settings.customInGameTitle];
        // Log reduzido para evitar spam no console
    } else {
        // Filtra e converte IDs para números
        gamesToPlay = account.games
            .map(id => parseInt(id, 10))
            .filter(id => !isNaN(id) && id > 0)
            .slice(0, 32); // Limite da Steam
    }

    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    
    try {
        // Define o status (Online/Invisível)
        account.client.setPersona(personaState);
        
        // Envia os jogos para a Steam
        if (gamesToPlay.length > 0) {
            account.client.gamesPlayed(gamesToPlay);
        } else {
            account.client.gamesPlayed([]); 
        }
    } catch (e) {
        console.error(`[${account.username}] Erro ao enviar status de jogo:`, e.message);
    }
}

function attemptLogin() {
    if (account.isStopping) return;

    // Configuração do objeto de login
    const logonOptions = { 
        accountName: account.username, 
        password: account.password 
    };

    // Adiciona Sentry (Hash do arquivo) se existir, para evitar Steam Guard repetitivo
    if (account.sentryFileHash) {
        try {
            logonOptions.shaSentryfile = Buffer.from(account.sentryFileHash, 'base64');
        } catch (e) {
            console.error(`[${account.username}] Erro ao processar Sentry Hash.`);
        }
    }

    // Gerenciamento de Machine ID (Simula o mesmo PC para evitar bloqueios)
    // O SteamUser gera um aleatório se não definido, mas idealmente deveria persistir.
    // O código original não passava isso, mantive o padrão para compatibilidade.

    console.log(`[${account.username}] Conectando à Steam... (Tentativa ${retryCount + 1})`);
    
    try {
        account.client.logOn(logonOptions);
    } catch (e) {
        console.error(`[${account.username}] Erro fatal ao chamar logOn:`, e);
        process.send({ type: 'statusUpdate', payload: { status: "Erro Interno" } });
    }
}

function handleDisconnect(eresult, msg) {
    if (account.isStopping) return;

    const EResult = SteamUser.EResult;
    let statusMsg = `Desconectado (${eresult})`;
    let waitTime = 10000; // Padrão 10s

    // Lógica de Retentativa Inteligente baseada no erro
    switch (eresult) {
        case EResult.InvalidPassword:
            statusMsg = "Senha Inválida";
            console.error(`[${account.username}] Senha incorreta. Parando tentativas.`);
            process.send({ type: 'statusUpdate', payload: { status: statusMsg } });
            return; // NÃO TENTA NOVAMENTE

        case EResult.AccountLoginDeniedThrottle:
        case EResult.RateLimitExceeded:
        case EResult.TryAnotherCM:
        case EResult.ServiceUnavailable:
            // Erros temporários da Steam, requerem espera maior
            waitTime = 30 * 60 * 1000; // 30 Minutos
            statusMsg = `Steam Instável/Throttle. Aguardando 30min...`;
            break;

        case EResult.AccountLogonDenied: // Steam Guard necessário
        case EResult.TwoFactorCodeMismatch: // Código errado
            statusMsg = "Pendente: Steam Guard";
            // Não agendamos reconexão automática aqui, esperamos o usuário ou o callback
            break;

        default:
            // Backoff exponencial para erros genéricos de conexão
            waitTime = Math.min(10000 * Math.pow(2, retryCount), 60 * 60 * 1000); // Max 1 hora
            statusMsg = `Reconectando em ${Math.ceil(waitTime / 1000)}s...`;
            break;
    }

    process.send({ type: 'statusUpdate', payload: { status: statusMsg } });

    // Se não for um erro terminal (senha/guard), agendamos reconexão
    if (eresult !== EResult.InvalidPassword && eresult !== EResult.AccountLogonDenied && eresult !== EResult.TwoFactorCodeMismatch) {
        if (account.reloginTimeout) clearTimeout(account.reloginTimeout);
        account.reloginTimeout = setTimeout(() => {
            retryCount++;
            attemptLogin();
        }, waitTime);
    }
}

// --- CONFIGURAÇÃO DE EVENTOS ---
function setupClient() {
    // Se já existir cliente, remove listeners antigos
    if (account.client) {
        account.client.removeAllListeners();
    } else {
        account.client = new SteamUser();
    }

    const client = account.client;

    client.on('loggedOn', () => {
        console.log(`[${account.username}] LOGIN: Sucesso!`);
        retryCount = 0;
        
        // Informa o Gestor
        process.send({ type: 'statusUpdate', payload: { status: "Rodando", sessionStartTime: Date.now() } });

        // Inicia o Farm Imediatamente
        farmGames();

        // Configura Loop de Farm (Heartbeat a cada 5 min para garantir status)
        if (account.farmInterval) clearInterval(account.farmInterval);
        account.farmInterval = setInterval(farmGames, 300000);

        // Atualiza jogos na conta (apenas 1 vez por login)
        client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeFreeSubGames: true }, (err, res) => {
            if (err) return;
            const apps = res.apps || res.games || [];
            if (apps.length > 0) {
                const owned = apps.map(app => ({ appid: app.appid, name: app.name }));
                process.send({ type: 'ownedGamesUpdate', payload: { games: owned } });
            }
        });
    });

    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
        if (lastCodeWrong) {
            console.log(`[${account.username}] GUARD: Código anterior incorreto.`);
            process.send({ type: 'statusUpdate', payload: { status: "Erro: Guard Incorreto" } });
        }

        if (account.settings.sharedSecret) {
            try {
                const code = SteamTotp.generateAuthCode(account.settings.sharedSecret);
                console.log(`[${account.username}] GUARD: Gerando código automático (Secret).`);
                callback(code);
            } catch (e) {
                console.error(`[${account.username}] GUARD: Erro no Shared Secret.`);
                process.send({ type: 'statusUpdate', payload: { status: "Erro: Secret Inválido" } });
            }
        } else {
            console.log(`[${account.username}] GUARD: Aguardando inserção manual.`);
            process.send({ type: 'statusUpdate', payload: { status: "Pendente: Steam Guard" } });
            account.steamGuardCallback = callback;
        }
    });

    client.on('error', (err) => {
        console.error(`[${account.username}] ERRO CLIENTE:`, err.message);
        handleDisconnect(err.eresult || 0, err.message);
    });

    client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] DESCONEXÃO: ${msg} (${eresult})`);
        handleDisconnect(eresult, msg);
    });

    client.on('sentry', (sentryHash) => {
        // Salva o hash para logins futuros sem pedir código
        process.send({ type: 'sentryUpdate', payload: { sentryFileHash: sentryHash.toString('base64') } });
    });

    // Chat Auto-Reply
    client.on('friendMessage', (steamID, message) => {
        if (account.settings.customAwayMessage) {
            const sid = steamID.getSteamID64();
            const now = Date.now();
            const lastReply = replyCooldowns.get(sid) || 0;
            // Responde apenas a cada 5 minutos por pessoa para não parecer spam
            if (now - lastReply > 300000) {
                client.chatMessage(steamID, account.settings.customAwayMessage);
                replyCooldowns.set(sid, now);
            }
        }
    });

    client.on('friendRelationship', (steamID, relationship) => {
        // Auto-Aceitar (Relationship 2 = Pedido)
        if (relationship === 2 && account.settings.autoAcceptFriends) {
            client.addFriend(steamID);
        }
    });

    client.on('playingState', (blocked, playingApp) => {
        if (blocked) {
            console.log(`[${account.username}] AVISO: A conta iniciou um jogo em outro local.`);
            // Opcional: Pausar o farm temporariamente ou apenas logar
        }
    });
}

// --- COMUNICAÇÃO COM O GESTOR (IPC) ---
process.on('message', (msg) => {
    const { command, data } = msg;

    switch (command) {
        case 'start':
            if (!data || !data.username) return;
            
            // Reset total
            cleanup();
            account.isStopping = false;
            
            // Carrega dados
            account.username = String(data.username);
            account.password = String(data.password);
            account.settings = data.settings || {};
            account.sentryFileHash = data.sentryFileHash;
            account.games = Array.isArray(data.games) ? data.games : [];

            // Inicia
            setupClient();
            attemptLogin();
            break;

        case 'submitGuard':
            if (account.steamGuardCallback && data.code) {
                account.steamGuardCallback(data.code);
                account.steamGuardCallback = null;
            }
            break;

        case 'updateSettings':
            if (data.settings) account.settings = data.settings;
            if (Array.isArray(data.games)) account.games = data.games;
            
            // Se já estiver online, aplica as mudanças imediatamente
            if (account.client && account.client.steamID) {
                console.log(`[${account.username}] Configurações atualizadas em tempo real.`);
                farmGames();
            }
            break;
            
        case 'stop':
            account.isStopping = true;
            cleanup();
            if (account.client) account.client.logOff();
            process.exit(0); // Mata o processo worker de forma limpa
            break;
    }
});
