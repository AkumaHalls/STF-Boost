# STF Steam Boost 🚀

Bem-vindo ao **STF Steam Boost**! O seu painel pessoal, elegante e poderoso para impulsionar as horas dos seus jogos favoritos da Steam. Este projeto foi construído do zero para ser leve, seguro, e super fácil de usar. Se você seguiu este guia, você agora é o mestre do seu próprio sistema de boost!

Este painel permite que você adicione múltiplas contas Steam e controle o processo de "farm" de horas de forma simples e visual, diretamente do seu navegador. Vamos começar!

![Painel em Ação](https://i.imgur.com/gK98h83.png)

## ✨ Funcionalidades Incríveis

* **Painel Web Cyberpunk:** Uma interface com identidade visual única, ícones, e transições suaves.
* **Acesso Seguro por Senha:** O seu painel é protegido por uma senha mestra para garantir que apenas você tenha acesso.
* **Suporte a Múltiplas Contas:** Adicione, remova e gira quantas contas Steam você quiser.
* **Gestão de Jogos por AppID:** Controlo total sobre quais jogos impulsionar, bastando inserir os seus AppIDs.
* **Contador de Tempo Ativo:** Acompanhe há quanto tempo cada conta está a "farmar" horas, em tempo real, incluindo dias!
* **Configurações por Conta:** Personalize cada conta com status offline, títulos customizados e respostas automáticas.
* **Armazenamento Seguro:** As suas senhas são criptografadas antes de serem guardadas num banco de dados seguro na nuvem.
* **Notificações Inteligentes:** Diga adeus aos `alertas`! Receba feedback através de notificações elegantes no canto do ecrã.
* **100% Gratuito:** Todo o sistema foi construído para funcionar nos planos gratuitos do Render.com e do MongoDB Atlas.

## ⚙️ Tecnologias Utilizadas

* **Backend:** Node.js + Express
* **Frontend:** HTML5, CSS3, JavaScript (Vanilla JS)
* **Banco de Dados:** MongoDB Atlas (Plano Gratuito)
* **Interação com a Steam:** `steam-user`
* **Hospedagem:** Render.com (Plano Gratuito)

---

## 🚀 Tutorial de Configuração: Do Zero ao Lançamento!

Vamos embarcar nesta missão e colocar a sua plataforma no ar. Siga os passos com atenção e prepare-se para o lançamento!

### **🌌 Parte 1: A Base de Dados - O Cofre Secreto**

Primeiro, precisamos de um lugar seguro na nuvem para guardar os dados das suas contas. Usaremos o MongoDB Atlas, que é gratuito e perfeito para o nosso projeto.

1.  **Crie uma Conta Gratuita:** Vá a [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) e registe-se.

2.  **Crie o seu "Cluster" Gratuito:** Após o login, a plataforma irá guiá-lo. Procure pela opção **M0 FREE** (geralmente já vem selecionada, é a que não tem custo!). Pode manter as configurações padrão (AWS, mesma região, etc.) e clicar no grande botão **"Create Cluster"**. A criação pode demorar 2-3 minutos. Tenha paciência, coisas incríveis estão a ser construídas!

3.  **Crie o Acesso ao Cofre (Usuário):**
    * No menu lateral do seu cluster, vá a **Database Access** > **Add New Database User**.
    * **Authentication Method:** Password.
    * **Username:** Escolha um nome, por exemplo: `stf_user`.
    * **Password:** Crie uma senha forte e clique em **"Autogenerate Secure Password"** ou crie a sua. **🚨 Anote esta senha num local seguro!** Vamos precisar dela já a seguir.
    * Clique em **Add User**.

4.  **Abra os Portões (Acesso de Rede):**
    * No menu lateral, vá a **Network Access** > **Add IP Address**.
    * Uma janela irá abrir. Clique no botão **ALLOW ACCESS FROM ANYWHERE**.
    * O campo de texto será preenchido automaticamente com `0.0.0.0/0`. Isto significa que a sua aplicação, não importa onde esteja hospedada no mundo (como no Render), poderá comunicar com o seu banco de dados.
    * Clique em **Confirm**.

5.  **Obtenha a Chave Mágica (Connection String):**
    * Volte à secção **Database** no menu lateral.
    * Clique no botão **Connect** do seu cluster.
    * Na janela que abrir, selecione a opção **Drivers**.
    * Copie a **Connection String** que aparece no passo 2. Ela será parecida com isto:
        `mongodb+srv://stf_user:<password>@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`
    * Agora, o passo mais importante: cole esta string num bloco de notas e **substitua `<password>` pela senha que você criou no passo 3**.
    * **Exemplo:** Se a sua senha for `MinhaSenhaSuperSegura123`, a string final ficará:
        `mongodb+srv://stf_user:MinhaSenhaSuperSegura123@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`
    * Guarde esta string final. É a chave secreta do seu cofre!

### **🛰️ Parte 2: A Hospedagem - A Estação Espacial**

Agora que temos o nosso cofre de dados, vamos construir a nossa base de operações no Render.com.

1.  **Envie o Código para o GitHub:** Crie um repositório no GitHub e envie todos os ficheiros do projeto para lá.

2.  **Crie uma Conta no Render:** Vá a [Render.com](https://render.com/) e crie uma conta gratuita, ligando-a à sua conta do GitHub para facilitar o processo.

3.  **Crie o "Web Service":**
    * No painel do Render, clique em **New +** > **Web Service**.
    * Selecione **"Build and deploy from a Git repository"** e escolha o repositório do seu projeto.
    * **Name:** Dê um nome único para o seu serviço (ex: `meu-stf-boost`). Este nome fará parte do seu URL.
    * Verifique se as configurações estão corretas: **Runtime** deve ser `Node`, **Build Command** `npm install`, e **Start Command** `node index.js`. O Render é inteligente e geralmente acerta nisto tudo sozinho.

4.  **Configure as Variáveis de Ambiente (O Painel Secreto!):**
    * Antes de finalizar, desça até à secção **Environment Variables**. É aqui que vamos contar os nossos segredos ao servidor de forma segura.
    * Clique em **"Add Environment Variable"** três vezes para criar as seguintes variáveis:

| Key (Chave) | Value (Valor) | Descrição |
| :--- | :--- | :--- |
| `APP_SECRET` | `UmaSenhaBemLongaParaCriptografia123!@#` | 🔑 Crie qualquer senha longa e secreta aqui. É usada para criptografar as senhas da Steam. |
| `MONGODB_URI`| `mongodb+srv://stf_user:SuaSenhaDoDBAqui@...`| 🌍 Cole aqui a sua "Connection String" completa e final que você preparou na Parte 1. |
| `SITE_PASSWORD`| `senha_para_entrar_no_site` | 🚪 A senha que **VOCÊ** usará para entrar no painel. Escolha uma senha boa! |

5.  **Lance o Foguete!**
    * Vá até ao final da página e clique em **"Create Web Service"**.

O Render vai começar a construir a sua aplicação. Pode acompanhar a magia a acontecer na aba de "Logs". Em poucos minutos, o seu serviço estará "Live" e pronto para a ação!

### **✨ Parte 3: Usando o Seu Painel!**

1.  **Acesse o seu URL:** `https://o-nome-do-seu-servico.onrender.com`.
2.  **Login Cyberpunk:** Você será recebido pela nossa página de login! Use a `SITE_PASSWORD` que você definiu nas variáveis de ambiente para entrar.
3.  **Adicione Contas:** O painel estará vazio. Clique no botão **"Adicionar Conta"** para começar a adicionar as suas contas Steam.
4.  **Domine as Ações:** Cada conta terá a sua própria linha de controlo:
    * **Iniciar/Parar:** Inicia ou para o processo de boost.
    * **Guard:** Se o status pedir um código do Steam Guard, este botão ficará a pulsar. Clique para inserir o código.
    * **Jogos:** Abre uma janela para você colar os AppIDs dos jogos que quer impulsionar.
    * **Config.:** Abre as configurações avançadas para essa conta (status offline, mensagens automáticas, etc.).
    * **Remover:** Apaga a conta do sistema.

---

É isso! Você agora tem o seu próprio sistema de hour boost para a Steam, totalmente funcional, seguro, estiloso e configurado por si.

**Parabéns pelo projeto incrível! Divirta-se a ver as horas a subir! 🎉**
