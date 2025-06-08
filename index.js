const express = require('express');
const path = require('path');
const SteamUser = require('steam-user');
const fetch = require('node-fetch');

const app = express();
const client = new SteamUser();
const PORT = process.env.PORT || 3000;

let steamApps = [];
let steamGuardCallback = null;

// Objeto de estado expandido para uma melhor UI
let serverState = {
    status: "Parado",
    accountName: process.env.STEAM_USER || "N/D",
    games: (process.env.STEAM_GAMES || "730").split(',').map(Number),
    appListReady: false // Flag para controlar o carregamento da lista de jogos
};

// Função para buscar os jogos da Steam
async function fetchSteamApps() {
    try {
        console.log("A buscar a lista de jogos da Steam...");
        const response = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
        const data = await response.json();
        steamApps = data.applist.apps;
        serverState.appListReady = true; // Sinaliza que a lista está pronta
        console.log(`Lista de jogos carregada: ${steamApps.length} apps.`);
    } catch (error) {
        console.error("Falha ao buscar a lista de jogos da Steam:", error);
    }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ROTAS DA API ---

app.get('/status', (req, res) => res.status(200).json(serverState));

app.post('/start', (req, res) => {
    console.log('Recebido pedido para iniciar o boost.');
    serverState.status = "Iniciando..."; // Novo status de preparação
    client.logOn({ accountName: process.env.STEAM_USER, password: process.env.STEAM_PASS });
    res.status(200).json({ message: 'Tentativa de login iniciada.' });
});

app.post('/stop', (req, res) => {
    console.log('Recebido pedido para parar o boost.');
    serverState.status = "Parando...";
    client.logOff();
    res.status(200).json({ message: 'Processo de logoff iniciado.' });
});

app.post('/submit-guard', (req, res) => {
    const { code } = req.body;
    if (steamGuardCallback) {
        console.log(`Recebido código do Steam Guard: ${code}`);
        steamGuardCallback(code);
        steamGuardCallback = null;
        res.status(200).json({ message: 'Código enviado.' });
    } else {
        res.status(400).json({ message: 'Nenhum pedido de código estava ativo.' });
    }
});

app.post('/set-games', (req, res) => {
    const { games } = req.body;
    if (games && Array.isArray(games)) {
        serverState.games = games;
        if (serverState.status === "Rodando") {
            client.gamesPlayed(serverState.games);
        }
        console.log(`Jogos atualizados para: ${games.join(', ')}`);
        res.status(200).json({ message: `Jogos atualizados.` });
    } else {
        res.status(400).json({ message: 'Formato inválido.' });
    }
});

app.get('/search-games', (req, res) => {
    if (!serverState.appListReady) {
        return res.json([{ name: "A lista de jogos ainda está a ser carregada, tente novamente em alguns segundos.", appid: 0 }]);
    }
    const query = req.query.q ? req.query.q.toLowerCase() : "";
    if (query.length < 2) return res.json([]);
    
    const results = steamApps
        .filter(app => app.name && app.name.toLowerCase().includes(query))
        .slice(0, 20);
    res.json(results);
});

// --- OUVINTES DO CLIENTE STEAM ---

client.on('loggedOn', () => {
    console.log(`Login efetuado com sucesso!`);
    serverState.status = "Rodando"; // Status alterado
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(serverState.games);
    console.log(`Boost iniciado.`);
});

client.on('steamGuard', (domain, callback) => {
    console.log(`Steam Guard solicitado.`);
    serverState.status = "Pendente: Steam Guard"; // Novo status para guiar o usuário
    steamGuardCallback = callback;
});

client.on('disconnected', (eresult, msg) => {
    console.log(`Desconectado: ${msg}`);
    serverState.status = "Parado";
});

client.on('error', (err) => {
    console.error(`Erro: ${SteamUser.EResult[err.eresult]}`);
    serverState.status = "Erro";
});

app.listen(PORT, () => {
    console.log(`Servidor iniciado na porta ${PORT}`);
    fetchSteamApps();
});
