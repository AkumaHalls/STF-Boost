// index.js - Agora com busca de jogos da Steam

const express = require('express');
const path = require('path');
const SteamUser = require('steam-user');
const fetch = require('node-fetch'); // Importamos o node-fetch

const app = express();
const client = new SteamUser();
const PORT = process.env.PORT || 3000;

// --- NOVO: LÓGICA PARA BUSCAR JOGOS DA STEAM ---
let steamApps = []; // Guarda a lista de todos os jogos

async function fetchSteamApps() {
    try {
        console.log("A buscar a lista de jogos da Steam... Isto pode demorar um momento.");
        const response = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
        const data = await response.json();
        steamApps = data.applist.apps;
        console.log(`Lista de jogos carregada com sucesso: ${steamApps.length} apps encontrados.`);
    } catch (error) {
        console.error("Falha ao buscar a lista de jogos da Steam:", error);
    }
}
// --- FIM DA NOVA LÓGICA ---


let serverState = {
    status: "Parado",
    accountName: process.env.STEAM_USER || "N/D",
    games: (process.env.STEAM_GAMES || "730").split(',').map(Number)
};

let steamGuardCallback = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ROTAS DA API ---

app.get('/status', (req, res) => res.status(200).json(serverState));
app.post('/start', (req, res) => { /* ... (código sem alterações) ... */ });
app.post('/submit-guard', (req, res) => { /* ... (código sem alterações) ... */ });
app.post('/set-games', (req, res) => { /* ... (código sem alterações) ... */ });

// --- NOVA ROTA DE BUSCA ---
app.get('/search-games', (req, res) => {
    const query = req.query.q ? req.query.q.toLowerCase() : "";
    if (!query) {
        return res.json([]);
    }
    const results = steamApps
        .filter(app => app.name.toLowerCase().includes(query))
        .slice(0, 20); // Retorna os primeiros 20 resultados
    res.json(results);
});
// --- FIM DA NOVA ROTA ---


// --- OUVINTES DO CLIENTE STEAM (sem alterações) ---
client.on('loggedOn', () => { /* ... */ });
client.on('steamGuard', (domain, callback) => { /* ... */ });
client.on('disconnected', (eresult, msg) => { /* ... */ });
client.on('error', (err) => { /* ... */ });


// Iniciar o servidor e buscar a lista de jogos
app.listen(PORT, () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
  fetchSteamApps(); // Chama a função para carregar os jogos
});
