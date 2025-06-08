# STF Steam Boost 🚀

Bem-vindo ao **STF Steam Boost**! O seu painel pessoal, elegante e poderoso para impulsionar as horas dos seus jogos favoritos da Steam. Este projeto foi construído do zero para ser leve, seguro, e super fácil de usar. Se você seguiu este guia, você agora é o mestre do seu próprio sistema de boost!

Este painel permite que você adicione múltiplas contas Steam e controle o processo de "farm" de horas de forma simples e visual, diretamente do seu navegador. Vamos começar!

![Painel em Ação](https://imgur.com/a/8Tcn6zv)

## ✨ Funcionalidades Incríveis

* **Painel Web Moderno:** Uma interface limpa, com ícones e transições suaves que tornam a experiência de uso super agradável.
* **Suporte a Múltiplas Contas:** Adicione, remova e gira quantas contas Steam você quiser.
* **Gestão de Jogos por AppID:** Controlo total sobre quais jogos impulsionar, bastando inserir os seus AppIDs.
* **Contador de Tempo Ativo:** Acompanhe há quanto tempo cada conta está a "farmar" horas, em tempo real.
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

## 📚 Tutorial Completo: Do Zero à Glória!

Siga estes passos para configurar o seu próprio STF Steam Boost.

### **Parte 1: Configurando o Banco de Dados Gratuito (MongoDB Atlas)**

Os seus dados precisam de um lar seguro! Vamos criar um na nuvem.

1.  **Crie uma Conta:** Vá a [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) e crie uma conta gratuita.
2.  **Crie um Cluster Gratuito (M0):** Após o login, o site irá guiá-lo para criar um "Cluster". Escolha a opção **M0 FREE**, que é gratuita. Pode deixar as outras configurações como estão e clicar em **"Create Cluster"**. (Pode demorar alguns minutos para ele ficar pronto).
3.  **Crie um Usuário de Banco de Dados:**
    * No menu do seu cluster, vá a **Database Access** > **Add New Database User**.
    * Escolha um nome de usuário (ex: `stf_user`) e uma senha forte. **Guarde bem estes dados!**
4.  **Libere o Acesso de Rede:**
    * Vá a **Network Access** > **Add IP Address**.
    * Clique em **ALLOW ACCESS FROM ANYWHERE**. Isto vai preencher o campo com `0.0.0.0/0`, permitindo que a sua aplicação no Render se conecte.
    * Clique em **Confirm**.
5.  **Obtenha a "Chave Mágica" (Connection String):**
    * Volte para **Database** e clique em **Connect** no seu cluster.
    * Escolha a opção **Drivers**.
    * Copie a **Connection String** fornecida. Ela será algo como:
        `mongodb+srv://stf_user:<password>@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`
    * **Passo crucial:** Substitua `<password>` pela senha que você criou no passo 3. Guarde esta string completa!

### **Parte 2: Publicando o Projeto no Render.com**

Agora vamos colocar o nosso código na internet!

1.  **Crie um Repositório no GitHub:** Crie um novo repositório na sua conta do GitHub e envie os 4 ficheiros do nosso projeto para lá:
    * `package.json`
    * `index.js`
    * A pasta `public` com os ficheiros `index.html` e `style.css` dentro.

2.  **Crie uma Conta no Render:** Vá a [Render.com](https://render.com/) e crie uma conta gratuita, pode ligá-la à sua conta do GitHub para facilitar.

3.  **Crie um "Web Service":**
    * No painel do Render, clique em **New +** > **Web Service**.
    * Escolha o repositório do GitHub que você acabou de criar.
    * Dê um nome para o seu serviço (ex: `stf-steam-boost`). As outras configurações (Branch `main`, Build Command `npm install`, Start Command `npm start`) geralmente são detetadas automaticamente e estão corretas.

4.  **Configure as Variáveis de Ambiente (O Painel Secreto!):**
    * Antes de criar o serviço, desça até à secção **Environment Variables**. Esta é a parte mais importante para a segurança e funcionamento do projeto.
    * Clique em **"Add Environment Variable"** duas vezes para criar as seguintes variáveis:

| Key (Chave)   | Value (Valor)                                     | Descrição                                                                              |
| :------------ | :------------------------------------------------ | :------------------------------------------------------------------------------------- |
| `APP_SECRET`  | `UmaSenhaMuitoForteInventadaPorVoce123!`          | 🔑 Crie qualquer senha longa e secreta aqui. É usada para criptografar as senhas da Steam. |
| `MONGODB_URI` | `mongodb+srv://stf_user:SuaSenhaDoDBAqui@...`     | 🌍 Cole a sua "Connection String" completa do MongoDB Atlas que você preparou.           |

5.  **Lance o Foguete!**
    * Desça até ao final da página e clique em **"Create Web Service"**.

O Render irá buscar o seu código, instalar as dependências e iniciar o servidor. Você pode acompanhar o progresso na aba de "Logs". Se tudo correu bem, em poucos minutos o seu serviço estará "Live"!

### **Parte 3: Como Usar o Seu Painel**

1.  Acesse o URL do seu serviço (ex: `https://boost.onrender.com`).
2.  O painel estará vazio. Clique no botão **"Adicionar Conta"** no canto superior direito.
3.  Insira o nome de usuário e a senha da sua conta Steam.
4.  A sua conta aparecerá na lista! Agora você pode usar os botões de **Ações**:
    * **Iniciar/Parar:** Inicia ou para o processo de boost para aquela conta. O botão e o status mudam de cor dinamicamente.
    * **Guard:** Se o status mudar para "Pendente: Steam Guard", este botão começará a pulsar. Clique nele para inserir o código de autenticação.
    * **Jogos:** Abre uma janela para você colar os AppIDs dos jogos que quer impulsionar, separados por vírgula.
    * **Remover:** Apaga a conta do sistema de forma segura (após uma confirmação).

---

É isso! Você agora tem o seu próprio sistema de hour boost para a Steam, totalmente funcional, seguro e configurado por si.

**Parabéns pelo projeto incrível! Divirta-se a ver as horas a subir! 🎉**
