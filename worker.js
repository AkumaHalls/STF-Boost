// worker.js - O nosso script para o "boost" de horas (Atualizado)

const SteamUser = require('steam-user');
const client = new SteamUser();

// --- INFORMAÇÕES DE LOGIN ---
// Agora, lemos os dados das Variáveis de Ambiente do Render.
// Isto é muito mais seguro pois as suas credenciais não ficam no código.
const logOnOptions = {
    accountName: process.env.STEAM_USER,
    password: process.env.STEAM_PASS,
    authCode: process.env.STEAM_GUARD_CODE // Adicionado para o código do Steam Guard
};

// Verificar se as variáveis de ambiente essenciais foram definidas
if (!logOnOptions.accountName || !logOnOptions.password) {
    console.error("ERRO: As variáveis de ambiente STEAM_USER e STEAM_PASS precisam de ser configuradas no Render.");
} else {
    client.logOn(logOnOptions);
}

client.on('loggedOn', () => {
    console.log(`Login na Steam para o usuário ${logOnOptions.accountName} efetuado com sucesso!`);
    client.setPersona(SteamUser.EPersonaState.Online);
    
    // AppIDs dos jogos para fazer o boost. Ex: 2923300 para Banana, 730 para CS:GO.
    client.gamesPlayed([2923300, 730]); 
    console.log('Boost de horas iniciado.');
});

// Este ouvinte é para quando a Steam pede o código de autenticação.
client.on('steamGuard', (domain, callback) => {
    // Se a variável STEAM_GUARD_CODE não foi definida, o login irá falhar aqui.
    console.log(`A Steam está a pedir um código de autenticação.`);
    if (!process.env.STEAM_GUARD_CODE) {
        console.error("ERRO: É necessário um código do Steam Guard. Defina a variável de ambiente STEAM_GUARD_CODE no Render e reinicie o serviço.");
    }
});

client.on('error', (err) => {
    // Converte o erro para um formato mais legível
    const errorName = SteamUser.EResult[err.eresult] || `Código de Erro Desconhecido: ${err.eresult}`;
    console.error(`Ocorreu um erro no worker: ${errorName}`);
});
