# Workflow Datapar — Fluxo de E-mails e Chamados

App (Expo / React Native) + API (Node.js / Express / MySQL) que lê os e-mails do
Workflow no Gmail, transforma em tickets com histórico de interações e avisa a
equipe por push.

```
.
├── app/                 Telas (Expo Router)
│   ├── _layout.tsx      Fontes, sessão, guarda de rotas, push
│   ├── index.tsx        Redireciona para /home ou /login
│   ├── login.tsx        Login + conexão da conta Google
│   ├── home.tsx         Lista de tickets
│   ├── settings.tsx     Tema, cor do ícone, sair
│   ├── ticket/[id].tsx  Chat de interações do ticket
│   └── google-connected.tsx  Retorno do OAuth no Android
├── src/                 Lógica do app
│   ├── api.ts           Cliente HTTP único (URL, token seguro, timeout, cache offline)
│   ├── session.tsx      Sessão do usuário + preferências
│   ├── push.ts          Notificações push
│   └── ui.tsx           Componentes compartilhados
├── backend/             API
│   └── src/
│       ├── server.ts    Boot, shutdown, sincronização agendada
│       ├── app.ts       Express: segurança, logs, rotas, erros
│       ├── core.ts      Config validada, logger, banco, auth
│       ├── cli.ts       Administração de usuários
│       └── modules/     users · tickets · notifications · gmail
│   └── database/        schema.sql + migrations/
└── deploy/              Debian: setup.sh, diagnostico.sh, systemd, Caddy (HTTPS), DuckDNS
```

---

## 1. Deploy da API no Debian

### Arquitetura

```
Celular ──HTTPS :8443──▶ apkchamados.duckdns.org ──▶ roteador (8443) ──▶ Caddy :8443 ──▶ 127.0.0.1:8080 (API) ──▶ MariaDB
```

- **Servidor compartilhado:** nada usa as portas 80/443. O Caddy escuta **somente na 8443**.
- **DuckDNS** traduz o nome para o IP da internet (não é proxy) e também é usado
  para validar o certificado HTTPS **por DNS** — nenhuma porta precisa estar
  aberta para o Let's Encrypt.
- A **API** escuta só em `127.0.0.1:8080`: ninguém acessa a 8080 de fora.
- O `setup.sh` baixa o Caddy oficial com o plugin DuckDNS (o pacote do Debian
  não tem plugins) e trava o pacote com `apt-mark hold caddy`.

### Pré-requisitos

1. **Roteador:** encaminhar a porta **8443** (TCP) para o IP interno do servidor (`hostname -I`).
2. **Firewall do Debian** (se usar ufw): `sudo ufw allow 8443/tcp`
3. **Google Cloud Console → Credenciais → Cliente OAuth ("Aplicativo da Web"):**
   em *URIs de redirecionamento autorizados*, adicionar
   `https://apkchamados.duckdns.org:8443/auth/google/callback`.
4. **Token do DuckDNS** (painel duckdns.org). Se já existir um atualizador
   (`/opt/duckdns.sh`), o `setup.sh` copia o token dele automaticamente.
5. Sem **CGNAT**: o *IP WAN* do roteador deve ser igual ao IP público
   (`curl -4 https://api.ipify.org`). Com CGNAT nenhuma porta chega ao servidor.

### Instalação (e atualização)

```bash
cd /var/www/html/workflow-chamados
chmod +x deploy/*.sh                     # necessário se os arquivos vieram do Windows
sudo ./deploy/setup.sh                   # 1ª vez: cria os arquivos de configuração e para
sudo nano /etc/fluxo-api/fluxo-api.env   # DB_*, GOOGLE_*, GOOGLE_REDIRECT_URI com :8443
sudo nano /etc/fluxo-api/https.env       # HTTPS_PORT=8443 e DUCKDNS_API_TOKEN
sudo ./deploy/setup.sh                   # compila, sobe a API, configura o HTTPS e aguarda o certificado
```

Para **atualizar** depois: atualize a pasta do projeto e rode `sudo ./deploy/setup.sh`.

| Caminho | Conteúdo |
|---|---|
| `/var/www/html/workflow-chamados` | Código-fonte (de onde se roda o `setup.sh`) |
| `/var/www/html/fluxo-chamados` | API compilada que o serviço executa (gerada pelo setup) |
| `/etc/fluxo-api/fluxo-api.env` | Variáveis da API (segredos) |
| `/etc/fluxo-api/https.env` | Porta HTTPS e token DuckDNS (usado só pelo Caddy) |
| `/etc/caddy/Caddyfile` | Gerado pelo setup — não edite à mão |

> O setup para com uma mensagem clara se: a porta 8443 ou 8080 estiver ocupada
> por outro programa, o `GOOGLE_REDIRECT_URI` não for exatamente
> `https://<domínio>:<HTTPS_PORT>/auth/google/callback`, ou faltar o token.

### Passo a passo de testes

1. **No servidor:** `sudo ./deploy/diagnostico.sh apkchamados.duckdns.org` —
   o item 6 deve estar todo ✔ (API, Caddy com plugin, HTTPS local 200 e nenhum
   uso das portas 80/443).
2. **Certificado:** `journalctl -u caddy --since "10 min ago" | grep -iE "obtained|error"`
   deve mostrar `certificate obtained successfully`.
3. **De fora da rede** (celular com Wi-Fi **desligado**, no 4G):
   `https://apkchamados.duckdns.org:8443/health` → `{"status":"ok","db":"connected"...}`.

| Resultado do passo 3 | Causa provável |
|---|---|
| Responde com cadeado | Tudo certo |
| Não carrega, mas o passo 1 está ✔ | Encaminhamento da 8443 no roteador, firewall ou CGNAT |
| Erro de certificado | Certificado ainda não emitido (passo 2) |

> Testar pelo Wi-Fi da própria rede pode falhar mesmo com tudo certo (muitos
> roteadores não fazem *NAT loopback*). Teste sempre pelo 4G.

### Migrando do serviço antigo

Se a porta 8080 estiver ocupada pela versão antiga, o `setup.sh` mostra o
processo. Conforme o caso:

```bash
pm2 ls && pm2 delete NOME && pm2 save         # se estiver no pm2
sudo systemctl disable --now NOME-DO-SERVICO  # se for um serviço systemd
```

A pasta antiga (`/opt/chamados-backend`) pode ser removida depois da validação.
**Não remova `/opt/duckdns.sh`**: é o atualizador de IP do DuckDNS.

## 2. Logs e diagnóstico

| O que ver | Comando |
|---|---|
| Diagnóstico completo (rede, portas, DuckDNS, API) | `sudo ./deploy/diagnostico.sh` |
| Log da API ao vivo | `journalctl -u fluxo-api -f` |
| Últimos erros | `journalctl -u fluxo-api -p err -n 50` |
| Status do serviço | `systemctl status fluxo-api` |
| HTTPS / certificado | `journalctl -u caddy -f` |
| Acessos HTTP | `tail -f /var/log/caddy/fluxo-api.log` |
| API respondendo (local) | `curl http://127.0.0.1:8080/health` |
| API respondendo (internet) | `curl https://apkchamados.duckdns.org:8443/health` |

Cada resposta traz o cabeçalho `X-Request-Id`; procure-o no journal para achar a
requisição exata. Erros de configuração (variável faltando, senha do banco
errada, porta ocupada) aparecem **na inicialização** com mensagem explícita.

**No celular:** a tela de login mostra o servidor configurado no rodapé — toque
nele para testar a conexão. Mensagens de erro de rede incluem a URL usada.
Para log nativo do APK: `adb logcat | grep -iE "ReactNativeJS|expo"`.

---

## 3. Build do app (APK)

A URL da API é gravada **no momento do build**, a partir do `eas.json`:

```json
"production": { "env": { "EXPO_PUBLIC_API_URL": "https://apkchamados.duckdns.org:8443" } }
```

1. Confira a URL (com `:8443`) nos perfis `preview` e `production` do `eas.json`.
2. `npm install`
3. `npx eas build -p android --profile production`

> Use sempre **https** e inclua a porta **:8443**. Builds de release do Android bloqueiam `http://`.

### Desenvolvimento local

```bash
# API
cd backend
cp .env.example .env        # ajuste; use HOST=0.0.0.0 e NODE_ENV=development
npm install
npm run dev

# App (outro terminal, na raiz)
cp .env.example .env        # EXPO_PUBLIC_API_URL
npm install
npx expo start
```

**Celular em outra rede (via USB):** ative *Depuração USB*, conecte o cabo e rode
`adb reverse tcp:8081 tcp:8081` e `adb reverse tcp:8080 tcp:8080`. Com
`EXPO_PUBLIC_API_URL=http://localhost:8080` o app alcança a API da sua máquina.
O `adb` vem no Android SDK Platform-Tools; o build Android local exige JDK 17 64-bit.

---

## 4. Banco de dados

MariaDB 10.11, banco `fluxo_workflow`. A estrutura completa está em
`backend/database/schema.sql` (8 tabelas: `users`, `user_settings`,
`user_push_tokens`, `google_tokens`, `tickets`, `interactions`,
`notifications`, `user_notifications`).

### Banco existente — aplicar a migração de índices (uma vez)

Não altera dados nem colunas; só cria/troca índices. Pode rodar de novo sem problema.

```bash
cd fluxo-emails-chamados/backend/database
sudo mysqldump --single-transaction fluxo_workflow > ~/backup_antes_001.sql
sudo mysql fluxo_workflow < migrations/001_indices.sql
```

| Tabela | Índice | Para quê |
|---|---|---|
| `interactions` | `idx_ticket_data_tipo (ticket_id, data_evento, tipo_evento)` | Listagem, detalhe e status do ticket (substitui `ticket_id`) |
| `user_notifications` | `idx_notification_lido (notification_id, lido)` | "Lido por" (substitui `notification_id`) |
| `user_push_tokens` | `idx_push_token (expo_push_token)` | Remoção de tokens inválidos |

### Usuário do banco para a API

A API só precisa ler e gravar dados (a migração acima roda como root):

```sql
CREATE USER IF NOT EXISTS 'fluxo'@'localhost' IDENTIFIED BY 'senha-forte';
GRANT SELECT, INSERT, UPDATE, DELETE ON fluxo_workflow.* TO 'fluxo'@'localhost';
FLUSH PRIVILEGES;
```

### Instalação nova (banco vazio)

```bash
sudo mysql -e "CREATE DATABASE fluxo_workflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
sudo mysql fluxo_workflow < backend/database/schema.sql
```

## 5. Administração de usuários

O cadastro pela API exige login. O primeiro usuário (e trocas de senha) é feito
no servidor — a senha é digitada sem aparecer na tela:

```bash
cd /var/www/html/fluxo-chamados
sudo -u fluxo node --env-file=/etc/fluxo-api/fluxo-api.env dist/cli.js create-user "Nome Completo" email@apk.com.br
sudo -u fluxo node --env-file=/etc/fluxo-api/fluxo-api.env dist/cli.js set-password email@apk.com.br
sudo -u fluxo node --env-file=/etc/fluxo-api/fluxo-api.env dist/cli.js list-users
```

---

## 6. Referência da API

Todas as rotas, exceto `/health`, `/users/login` e `/auth/google/callback`,
exigem `Authorization: Bearer <token>`.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Saúde da API e do banco |
| POST | `/users/login` | Login → `{ user, token, settings }` |
| GET / POST | `/users` | Listar / criar usuário |
| GET | `/users/settings` | Preferências |
| PUT | `/users/settings/icon-color` | `{ color: "#RRGGBB" }` |
| PUT | `/users/settings/dark-mode` | `{ enabled: boolean }` |
| POST / DELETE | `/users/push-token` | `{ expoPushToken }` |
| GET | `/tickets` | Tickets dos últimos `TICKETS_MONTHS` meses |
| GET | `/tickets/:ticketId` | Detalhe com interações e leitores |
| GET | `/notifications` | Notificações não lidas |
| GET | `/notifications/unread-tickets` | IDs dos tickets não lidos |
| PUT | `/notifications/ticket/:ticketId/read-all` | Marca o ticket como lido |
| PUT | `/notifications/:id/read` | Marca uma notificação |
| GET | `/notifications/readers/:interactionId` | Quem leu a interação |
| GET | `/auth/google?redirect=` | URL de autorização do Gmail |
| GET | `/auth/google/status` | `{ connected }` |
| POST | `/sync` | Sincroniza e-mails novos |

Erros seguem o formato `{ "error": "mensagem", "code": "CODIGO" }`
(ex.: `GOOGLE_NOT_CONNECTED`, `UNAUTHENTICATED`, `VALIDATION`).

> **Google OAuth em modo "Teste":** o Google invalida o refresh token a cada
> 7 dias. Se o app pedir para reconectar o Google toda semana, publique o app
> OAuth (Tela de consentimento → *Publicar app*).
