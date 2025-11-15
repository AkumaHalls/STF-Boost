const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { fork } = require('child_process');
const https = require('https'); // Módulo para fazer requisições HTTPSa

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; 

if (!MONGODB_URI || !SITE_PASSWORD) { console.error("ERRO CRÍTICO: As variáveis de ambiente MONGODB_URI e SITE_PASSWORD precisam de ser definidas!"); process.exit(1); }
const ALGORITHM = 'aes-256-cbc';
let appSecretKey; 
let steamAppListCache = { data: [], timestamp: 0 }; // Cache para a lista de jogos

// --- FUNÇÃO DE NOTIFICAÇÃO DISCORD ---
function sendDiscordNotification(title, message, color, username) {
    if (!DISCORD_WEBHOOK_URL) return;
    
    const safeTitle = title || '\u200b'; // Caractere invisível para campos vazios
    const safeMessage = message || '\u200b';
    const safeUsername = username || 'N/A';

    const embed = {
        title: safeTitle,
        description: safeMessage,
        color: color,
        fields: [{ name: "Conta", value: `\`${safeUsername}\``, inline: true }],
        footer: { text: "STF Boost Notifier" },
        timestamp: new Date().toISOString()
    };

    const payload = JSON.stringify({ embeds: [embed] });
    
    // CORREÇÃO FINAL: Usar Buffer.byteLength para calcular o tamanho correto em bytes.
    const payloadByteLength = Buffer.byteLength(payload);

    try {
        const url = new URL(DISCORD_WEBHOOK_URL);
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Content-Length': payloadByteLength // Usar o tamanho em bytes
            }
        };

        const req = https.request(options, res => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                console.error(`[DISCORD] Falha ao enviar notificação, status: ${res.statusCode}`);
                 res.on('data', (d) => {
                    console.error(`[DISCORD] Resposta de erro: ${d.toString()}`);
                });
            }
        });

        req.on('error', error => {
            console.error('[DISCORD] Erro na requisição do webhook:', error);
        });

        req.write(payload);
        req.end();
    } catch (e) {
        console.error("[DISCORD] URL do webhook inválida.", e);
    }
}


// --- FUNÇÕES DE CRIPTOGRAFIA ---
const encrypt = (text) => { if (!appSecretKey) { console.error("[ENCRIPTAR] ERRO CRÍTICO: appSecretKey não está definida!"); return null; } const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv(ALGORITHM, appSecretKey, iv); let encrypted = cipher.update(text, 'utf8', 'hex'); encrypted += cipher.final('hex'); return `${iv.toString('hex')}:${encrypted}`; };
const decrypt = (text) => { try { if (!appSecretKey) { return ""; } if (!text) { return ""; } const textParts = text.split(':'); const iv = Buffer.from(textParts.shift(), 'hex'); const encryptedText = Buffer.from(textParts.join(':'), 'hex'); const decipher = crypto.createDecipheriv(ALGORITHM, appSecretKey, iv); let decrypted = decipher.update(encryptedText, 'hex', 'utf8'); decrypted += decipher.final('utf8'); return decrypted; } catch (error) { console.error("[DESENCRIPTAR] Falha crítica na função de desencriptar:", error); return ""; }};

// --- GESTÃO DE CONTAS E BANCO DE DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let liveAccounts = {};
async function connectToDB() { try { await mongoClient.connect(); console.log("Conectado ao MongoDB Atlas com sucesso!"); const db = mongoClient.db("stf_boost_db"); accountsCollection = db.collection("accounts"); siteSettingsCollection = db.collection("site_settings"); } catch (e) { console.error("Não foi possível conectar ao MongoDB", e); process.exit(1); } }

async function initializeMasterKey() {
    let settings = await siteSettingsCollection.findOne({ _id: 'config' });
    if (!settings || !settings.appSecret) {
        console.log("[GESTOR] Nenhuma chave mestra encontrada. A gerar uma nova...");
        const newSecret = crypto.randomBytes(32).toString('hex');
        appSecretKey = crypto.createHash('sha256').update(newSecret).digest('base64').substr(0, 32);
        const sitePasswordEncrypted = encrypt(SITE_PASSWORD);
        await siteSettingsCollection.updateOne( { _id: 'config' }, { $set: { appSecret: newSecret, sitePassword: sitePasswordEncrypted } }, { upsert: true } );
        console.log("[GESTOR] Nova chave mestra gerada e guardada na base de dados.");
    } else {
        console.log("[GESTOR] Chave mestra carregada da base de dados.");
        appSecretKey = crypto.createHash('sha256').update(settings.appSecret).digest('base64').substr(0, 32);
    }
}

// --- BUSCA DE JOGOS STEAM (VERSÃO COM FETCH) ---
async function getSteamAppList() {
    // Retorna do cache se for válido (menos de 24h)
    if (Date.now() - steamAppListCache.timestamp < 24 * 60 * 60 * 1000 && steamAppListCache.data.length > 0) {
        return steamAppListCache.data;
    }

    console.log("[GESTOR] Cache da lista de apps da Steam expirado. A buscar nova lista...");
    
    // --- INÍCIO DA CORREÇÃO (HTTP) ---
    const url = 'http://api.steampowered.com/ISteamApps/GetAppList/v2/';
    const options = {
        method: 'GET',
        headers: {
            // Adiciona um User-Agent para simular um navegador
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    };
    // --- FIM DA CORREÇÃO (HTTP) ---

    try {
        // Usa o fetch nativo do Node.js (v18+)
        const response = await fetch(url, options);

        if (!response.ok) {
            // Se a resposta não for 2xx, lança um erro
            throw new Error(`Falha ao buscar lista de apps. Status: ${response.status} ${response.statusText}`);
        }

        // Tenta processar o JSON
        const jsonData = await response.json();
        
        if (!jsonData || !jsonData.applist || !jsonData.applist.apps) {
             throw new Error("Resposta JSON da Steam recebida, mas em formato inesperado.");
        }

        // Se deu tudo certo, salva no cache e retorna
        steamAppListCache = { data: jsonData.applist.apps, timestamp: Date.now() };
        console.log("[GESTOR] Cache da lista de apps da Steam atualizado.");
        return steamAppListCache.data;

    } catch (e) {
        // Se 'await response.json()' falhar (ex: HTML), o erro será pego aqui
        console.error("[GESTOR] Erro ao processar lista de apps da Steam:", e);
        if (e.name === 'SyntaxError') {
             console.error("[GESTOR] A API da Steam provavelmente retornou HTML em vez de JSON. Verifique bloqueios de IP no Render.");
        }
        // Retorna o cache antigo (se houver) em caso de falha total
        return steamAppListCache.data;
    }
}


function startWorkerForAccount(accountData) {
    const username = accountData.username;
    console.log(`[GESTOR] A iniciar worker para ${username}`);

    if (liveAccounts[username] && liveAccounts[username].worker) {
        liveAccounts[username].worker.kill();
    }
    
    if (liveAccounts[username] && liveAccounts[username].startupTimeout) {
        clearTimeout(liveAccounts[username].startupTimeout);
    }

    const worker = fork(path.join(__dirname, 'worker.js'));
    liveAccounts[username].worker = worker;
    liveAccounts[username].status = "Iniciando...";
    liveAccounts[username].manual_logout = false;
    liveAccounts[username].timed_out = false; 

    const startupTimeout = setTimeout(() => {
        if (liveAccounts[username] && liveAccounts[username].status === "Iniciando...") {
            console.error(`[GESTOR] Worker para ${username} demorou muito para iniciar (Timeout). Acionando reinicialização automática.`);
            sendDiscordNotification("❄️ Conta Congelada (Timeout)", "O worker não respondeu a tempo e será reiniciado.", 16776960, username);
            liveAccounts[username].timed_out = true; 
            worker.kill(); 
        }
    }, 60000); 

    liveAccounts[username].startupTimeout = startupTimeout;

    worker.send({ command: 'start', data: accountData });

    worker.on('message', (message) => {
        if (!liveAccounts[username]) return;
        clearTimeout(liveAccounts[username].startupTimeout);
        liveAccounts[username].startupTimeout = null;

        const { type, payload } = message;
        if (liveAccounts[username]) {
            if (type === 'statusUpdate') {
                const oldStatus = liveAccounts[username].status;
                const newStatus = payload.status;
                
                if (oldStatus !== newStatus) {
                    if (newStatus === 'Rodando') {
                        sendDiscordNotification("✅ Conta Online", "A conta conectou-se com sucesso e está a farmar horas.", 5763719, username);
                    } else if (newStatus === 'Pendente: Steam Guard') {
                        sendDiscordNotification("🛡️ Steam Guard Requerido", "A conta precisa de um código de autenticação para continuar.", 3447003, username);
                    } else if (newStatus.startsWith('Erro:')) {
                        sendDiscordNotification("❌ Erro Crítico", `Ocorreu um erro: **${newStatus}**. A conta parou.`, 15548997, username);
                    }
                }
                
                Object.assign(liveAccounts[username], payload);
            }
            if (type === 'sentryUpdate') {
                liveAccounts[username].sentryFileHash = payload.sentryFileHash;
                accountsCollection.updateOne({ username }, { $set: { sentryFileHash: payload.sentryFileHash } });
            }
        }
    });

    worker.on('exit', (code) => {
        if (liveAccounts[username] && liveAccounts[username].startupTimeout) {
            clearTimeout(liveAccounts[username].startupTimeout);
            liveAccounts[username].startupTimeout = null;
        }
        
        const accountExited = liveAccounts[username];
        if (!accountExited) return;

        const wasTimeout = accountExited.timed_out;
        accountExited.timed_out = false; 

        console.log(`[GESTOR] Worker para ${username} saiu com código ${code}.`);
        if (accountExited.manual_logout === false && accountExited.settings.autoRelogin === true) {
            const restartDelay = wasTimeout ? 5000 : 30000;
            const reason = wasTimeout ? "devido a um timeout" : "após uma desconexão";
            sendDiscordNotification("🔄 A Reiniciar Conta", `A conta será reiniciada em ${restartDelay / 1000}s ${reason}.`, 16776960, username);

            console.log(`[GESTOR] A reiniciar worker para ${username} em ${restartDelay / 1000} segundos...`);
            
            accountExited.status = "Reiniciando...";

            setTimeout(() => {
                if(liveAccounts[username]) {
                    const accData = { ...liveAccounts[username], password: decrypt(liveAccounts[username].encryptedPassword) };
                    if (accData.password) startWorkerForAccount(accData);
                }
            }, restartDelay);
        } else {
            accountExited.status = wasTimeout ? "Erro: Timeout" : "Parado";
            accountExited.sessionStartTime = null;
        }
    });
}

async function loadAccountsIntoMemory() {
    const defaultSettings = { customInGameTitle: '', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false, autoRelogin: true, sharedSecret: '' };
    const savedAccounts = await accountsCollection.find({}).toArray();
    savedAccounts.forEach((acc, index) => {
        liveAccounts[acc.username] = { username: acc.username, encryptedPassword: acc.password, games: acc.games || [730], settings: { ...defaultSettings, ...(acc.settings || {}) }, sentryFileHash: acc.sentryFileHash || null, status: 'Parado', worker: null, sessionStartTime: null, manual_logout: false };
        if (liveAccounts[acc.username].settings.autoRelogin) {
            const delay = index * 15000;
            console.log(`[GESTOR] Worker para ${acc.username} agendado para iniciar em ${delay / 1000}s.`);
            setTimeout(() => {
                const accountData = { ...liveAccounts[acc.username], password: decrypt(acc.password) };
                if (accountData.password) {
                    startWorkerForAccount(accountData);
                } else {
                    console.error(`[GESTOR] Falha ao desencriptar senha para ${acc.username}, início automático abortado.`);
                }
            }, delay);
        }
    });
    console.log(`[GESTOR] ${savedAccounts.length} contas carregadas.`);
}

// --- EXPRESS APP E ROTAS ---
app.use(express.json()); app.use(express.urlencoded({ extended: true })); app.use(session({ secret: 'FallbackSecretForSession', resave: false, saveUninitialized: false, store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf_boost_db' }), cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }})); const isAuthenticated = (req, res, next) => { if (req.session.isLoggedIn) { return next(); } res.redirect('/login?error=unauthorized'); };
app.get('/login', async (req, res) => { if (req.session.isLoggedIn) { return res.redirect('/'); } res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.post('/login', async (req, res) => { let settings = await siteSettingsCollection.findOne({ _id: 'config' }); const submittedPass = req.body.password; const decryptedSitePassword = decrypt(settings.sitePassword); if (decryptedSitePassword && decryptedSitePassword === submittedPass) { req.session.isLoggedIn = true; res.redirect('/'); } else { res.status(401).redirect('/login?error=1'); } });
app.get('/health', (req, res) => { res.status(200).send('OK'); }); app.get('/', isAuthenticated, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); }); app.use(express.static(path.join(__dirname, 'public'), { index: false })); const apiRouter = express.Router(); apiRouter.use(isAuthenticated);

apiRouter.get('/status', (req, res) => {
    const publicState = { accounts: {} };
    for (const username in liveAccounts) {
        const acc = liveAccounts[username];
        const publicData = {
            username: acc.username,
            status: acc.status,
            games: acc.games,
            settings: acc.settings,
            uptime: acc.sessionStartTime ? Date.now() - acc.sessionStartTime : 0
        };
        publicState.accounts[username] = publicData;
    }
    res.json(publicState);
});

apiRouter.post('/start/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (account) { const accountData = { ...account, password: decrypt(account.encryptedPassword) }; if (accountData.password) { startWorkerForAccount(accountData); res.status(200).json({ message: "Iniciando worker..." }); } else { res.status(500).json({ message: "Erro ao desencriptar senha."}); } } else { res.status(404).json({ message: "Conta não encontrada." }); } });

apiRouter.post('/stop/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account && account.worker) {
        if(account.startupTimeout) {
            clearTimeout(account.startupTimeout);
            account.startupTimeout = null;
        }
        account.manual_logout = true;
        account.worker.kill();
        account.status = "Parado";
        account.sessionStartTime = null; 
        res.status(200).json({ message: "Parando worker..." });
    } else {
        res.status(404).json({ message: "Conta ou worker não encontrado." });
    }
});

// --- NOVOS ENDPOINTS DE AÇÕES EM MASSA ---
apiRouter.post('/bulk-start', (req, res) => {
    const { usernames } = req.body;
    if (!usernames || !Array.isArray(usernames)) return res.status(400).json({ message: "Requisição inválida." });

    let startedCount = 0;
    usernames.forEach(username => {
        const account = liveAccounts[username];
        if (account) {
            const accountData = { ...account, password: decrypt(account.encryptedPassword) };
            if (accountData.password) {
                startWorkerForAccount(accountData);
                startedCount++;
            }
        }
    });
    res.status(200).json({ message: `${startedCount} contas enviadas para início.` });
});

apiRouter.post('/bulk-stop', (req, res) => {
    const { usernames } = req.body;
    if (!usernames || !Array.isArray(usernames)) return res.status(400).json({ message: "Requisição inválida." });

    let stoppedCount = 0;
    usernames.forEach(username => {
        const account = liveAccounts[username];
        if (account && account.worker) {
            if(account.startupTimeout) {
                clearTimeout(account.startupTimeout);
                account.startupTimeout = null;
            }
            account.manual_logout = true;
            account.worker.kill();
            account.status = "Parado";
            account.sessionStartTime = null; 
            stoppedCount++;
        }
    });
    res.status(200).json({ message: `${stoppedCount} contas paradas.` });
});

apiRouter.post('/bulk-remove', async (req, res) => {
    const { usernames } = req.body;
    if (!usernames || !Array.isArray(usernames)) return res.status(400).json({ message: "Requisição inválida." });

    usernames.forEach(username => {
        const account = liveAccounts[username];
        if (account) {
            if (account.worker) {
                account.manual_logout = true;
                account.worker.kill();
            }
            delete liveAccounts[username];
        }
    });
    await accountsCollection.deleteMany({ username: { $in: usernames } });
    res.status(200).json({ message: `${usernames.length} contas removidas.` });
});
// --- FIM DOS ENDPOINTS DE AÇÕES EM MASSA ---

apiRouter.post('/add-account', async (req, res) => { const { username, password } = req.body; if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios."}); const existing = await accountsCollection.findOne({ username }); if (existing) return res.status(400).json({ message: "Conta já existe." }); const encryptedPassword = encrypt(password); if (!encryptedPassword) { return res.status(500).json({ message: "Falha ao encriptar senha ao adicionar conta."}); } const newAccountData = { username, password: encryptedPassword, games: [730], settings: {}, sentryFileHash: null }; await accountsCollection.insertOne(newAccountData); liveAccounts[username] = { ...newAccountData, encryptedPassword: newAccountData.password, status: 'Parado', worker: null }; res.status(200).json({ message: "Conta adicionada." }); });
apiRouter.delete('/remove-account/:username', async (req, res) => { const account = liveAccounts[req.params.username]; if (account) { if (account.worker) { account.manual_logout = true; account.worker.kill(); } delete liveAccounts[req.params.username]; await accountsCollection.deleteOne({ username: req.params.username }); res.status(200).json({ message: "Conta removida." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } });
apiRouter.post('/submit-guard/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (account && account.worker) { account.worker.send({ command: 'submitGuard', data: { code: req.body.code } }); res.status(200).json({ message: "Código enviado ao worker." }); } else { res.status(404).json({ message: "Conta ou worker não encontrado." }); } });

apiRouter.post('/save-settings/:username', async (req, res) => {
    const { username } = req.params;
    const { settings, newPassword } = req.body; // newPassword virá daqui
    const account = liveAccounts[username];

    if (!account) return res.status(404).json({ message: "Conta não encontrada." });

    let message = "Configurações salvas.";

    // 1. Salva as configurações normais
    if (settings) {
        await accountsCollection.updateOne({ username }, { $set: { settings } });
        account.settings = settings;
        if (account.worker) {
            account.worker.send({ command: 'updateSettings', data: { settings, games: account.games } });
        }
    }

    // 2. Atualiza a senha se foi fornecida
    if (newPassword) {
        const encryptedPassword = encrypt(newPassword);
        if (!encryptedPassword) {
            return res.status(500).json({ message: "Falha ao encriptar nova senha." });
        }
        await accountsCollection.updateOne({ username }, { $set: { password: encryptedPassword } });
        account.encryptedPassword = encryptedPassword;
        
        message = "Configurações e senha atualizadas.";

        // Para o worker para forçar o reinício com a nova senha
        if (account.worker) {
            account.manual_logout = true; // Impede o auto-relogin imediato da função 'exit'
            account.worker.kill();
            account.status = "Parado";
            account.sessionStartTime = null; 
            message += " A conta foi parada para aplicar a nova senha.";
            
            // Se o auto-relogin estiver ativo, ele vai tentar reiniciar com a nova senha na próxima vez
            // A lógica de reinício já está no 'exit' handler, mas paramos manualmente aqui.
            // Para garantir que tente reiniciar (se autoRelogin=true), re-configuramos manual_logout
            setTimeout(() => {
                if (liveAccounts[username]) {
                    liveAccounts[username].manual_logout = false;
                }
            }, 1000);
        }
    }

    res.status(200).json({ message });
});

apiRouter.post('/set-games/:username', async (req, res) => { const { username } = req.params; const { games } = req.body; const account = liveAccounts[username]; if (account && games) { await accountsCollection.updateOne({ username }, { $set: { games } }); account.games = games; if (account.worker) { account.worker.send({ command: 'updateSettings', data: { settings: account.settings, games } }); } res.status(200).json({ message: "Jogos atualizados." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } });

// --- NOVO ENDPOINT DE BUSCA DE JOGOS ---
apiRouter.get('/search-game', async (req, res) => {
    const searchTerm = req.query.q ? req.query.q.toLowerCase() : '';
    if (searchTerm.length < 2) {
        return res.json([]);
    }
    
    try {
        const appList = await getSteamAppList();
        // Filtra e limita a 50 resultados para performance
        const results = appList
            .filter(app => app.name.toLowerCase().includes(searchTerm))
            .slice(0, 50);
        res.json(results);
    } catch (e) {
        res.status(500).json({ message: "Erro ao buscar lista de jogos." });
    }
});

app.use(apiRouter);

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
    await connectToDB();
    await initializeMasterKey();
    await loadAccountsIntoMemory();
    app.listen(PORT, () => console.log(`[GESTOR] Servidor iniciado na porta ${PORT}`));
}
startServer();
