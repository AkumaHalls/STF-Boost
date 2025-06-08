// index.js - O nosso servidor Backend (Pronto para o Render)

const express = require('express');
const path = require('path');

const app = express();

// 1. AJUSTE PARA O RENDER.COM
// O Render fornece a porta através de uma variável de ambiente chamada 'PORT'.
// Usamos a porta do Render, ou a porta 3000 se estivermos a testar localmente.
const PORT = process.env.PORT || 3000;

// 2. Middleware para servir os ficheiros estáticos (HTML/CSS) da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// 3. Rota principal
// Quando o usuário aceder ao URL base, servimos o nosso painel de controle.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. Iniciar o servidor e fazê-lo "ouvir" na porta correta
app.listen(PORT, () => {
  console.log(`Servidor do STF Steam Boost iniciado na porta ${PORT}`);
});