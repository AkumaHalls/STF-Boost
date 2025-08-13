const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

let account = {
    client: new SteamUser(),
    username: null,
    password: null,
    games: [],
    settings: {},
    sentryFileHash: null,
    steamGuardCallback: null
};

function applyLiveSettings() {
    if (!account.client.steamID) return; // Só aplica se estiver logado
    console.log(`[${account.username}] WORKER: Aplicando configurações.`);
    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
    account.client.setPersona(personaState);
    let gamesToPlay = account.settings.customInGameTitle ? [{ game_id: 0, game_extra_info: account.settings.customInGameTitle }] : [...account.games];
    if (gamesToPlay.length > 0) {
        account.client.gamesPlayed(gamesToPlay);
    }
}

function setupListeners() {
    account.client.on('loggedOn', () => {
        console.log(`[${account.username}] WORKER: Login OK!`);
        process.send({ type: 'statusUpdate', payload: { status: "Rodando", sessionStartTime: Date.now() } });
        
        // Período de Cortesia para estabilização
        setTimeout(() => {
            applyLiveSettings();
        }, 3000);
    });

    account.client.on('steamGuard', (domain, callback) => {
        if (account.settings.sharedSecret) {
            try {
                const code = SteamTotp.generateAuthCode(account.settings.sharedSecret);
                console.log(`[${account.username}] WORKER: Gerando código TOTP.`);
                callback(code);
            } catch (e) {
                console.error(`[${account.username}] WORKER: Erro ao gerar código TOTP.`, e);
                process.send({ type: 'statusUpdate', payload: { status: "Erro: Shared Secret Inválido" } });
            }
        } else {
            console.log(`[${account.username}] WORKER: Pedido de Steam Guard por e-mail.`);
            process.send({ type: 'statusUpdate', payload: { status: "Pendente: Steam Guard" } });
            account.steamGuardCallback = callback;
        }
    });

    account.client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] WORKER: Desconectado - ${msg}`);
        process.send({ type: 'statusUpdate', payload: { status: "Desconectado", sessionStartTime: null } });
        // O Gestor irá decidir se reinicia este worker.
        process.exit(1); // Encerra o processo para ser reiniciado pelo gestor se necessário.
    });

    account.client.on('error', (err) => {
        console.error(`[${account.username}] WORKER: Erro - ${err.message} (${err.eresult})`);
        process.send({ type: 'statusUpdate', payload: { status: `Erro: ${err.eresult}`, sessionStartTime: null } });
    });

    account.client.on('sentry', (sentryHash) => {
        const hashString = sentryHash.toString('base64');
        console.log(`[${account.username}] WORKER: Nova sentry file recebida.`);
        process.send({ type: 'sentryUpdate', payload: { sentryFileHash: hashString } });
    });

    account.client.on('friendRelationship', (steamID, relationship) => {
        if (relationship === SteamUser.EFriendRelationship.RequestRecipient && account.settings.autoAcceptFriends) {
            account.client.addFriend(steamID);
        }
    });

    account.client.on('friendMessage', (sender, message) => {
        if (account.settings.customAwayMessage) {
            account.client.chatMessage(sender, account.settings.customAwayMessage);
        }
    });
}

// Ouve por comandos do Gestor (index.js)
process.on('message', (message) => {
    const { command, data } = message;

    if (command === 'start') {
        account = { ...account, ...data };
        console.log(`[${account.username}] WORKER: Recebeu comando para iniciar.`);
        setupListeners();
        const logonOptions = { accountName: account.username, password: account.password };
        if (account.sentryFileHash) {
            logonOptions.shaSentryfile = Buffer.from(account.sentryFileHash, 'base64');
        }
        account.client.logOn(logonOptions);
    }

    if (command === 'submitGuard') {
        if (account.steamGuardCallback) {
            console.log(`[${account.username}] WORKER: Enviando código Steam Guard.`);
            account.steamGuardCallback(data.code);
            account.steamGuardCallback = null;
        }
    }
    
    if (command === 'updateSettings') {
        console.log(`[${account.username}] WORKER: Atualizando configurações.`);
        account.settings = data.settings;
        account.games = data.games;
        applyLiveSettings();
    }
});

// Garante que o worker morre se o processo principal morrer
process.on('disconnect', () => {
    console.log('Gestor desconectou, a encerrar o worker.');
    process.exit(0);
});