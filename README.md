# Chatbot-FMJ
Chatbot via WhatsApp para reduzir o absenteísmo em exames de colonoscopia, desenvolvido em parceria entre a FMJ e a FATEC Jundiaí. Integração com Google Sheets, envio de lembretes, gestão de TCLE e coleta de feedback.

# 📱 Chatbot FMJ/FATEC – Redução do Absenteísmo em Colonoscopia

Este projeto é uma solução de chatbot via WhatsApp, desenvolvida para a **Faculdade de Medicina de Jundiaí (FMJ)** em parceria com a **FATEC Jundiaí**, com o objetivo de **reduzir o absenteísmo de pacientes nos exames de colonoscopia**, no contexto do SUS.

---

## 📌 Objetivo

Automatizar a comunicação com pacientes agendados para exame de colonoscopia, enviando lembretes, coletando confirmações de presença, gerenciando respostas de cancelamento/remarcação e coletando feedback pós-exame, de forma ética e segura.

---

## 🚀 Tecnologias Utilizadas

- **Node.js**
- **whatsapp-web.js**
- **Google Sheets API**
- **Moment.js**
- **Docker / Docker Compose (opcional)**
- **Ubuntu Server (VPS Hostinger)**

---

## ⚙️ Funcionalidades Principais

- ✅ Importação automática de agendamentos via Google Sheets  
- ✅ Envio de TCLE (Termo de Consentimento Livre e Esclarecido) e controle de aceite  
- ✅ Lembretes automáticos (7 dias e 2 dias antes do exame)  
- ✅ Resposta automatizada a confirmações, cancelamentos e pedidos de remarcação  
- ✅ Coleta de feedback pós-exame  
- ✅ Persistência de estado local (JSON)  
- ✅ Sistema de logs e monitoramento de erros  
- ✅ Recuperação automática em caso de falha de conexão com WhatsApp ou Google API  

---

## 📡 Pré-Requisitos para Execução

- Node.js (v16 ou superior)
- Conta no Google Cloud (Service Account com permissão para acessar o Google Sheets)
- VPS ou servidor com acesso à internet (recomenda-se Ubuntu 22.04 ou superior)
- Celular com WhatsApp Web autenticado (via QR Code)

---

## 🛠️ Como Subir o Projeto

1. **Clone o repositório:**

```
git clone https://github.com/arielreiseso/Chatbot-FMJ.git
cd Chatbot-FMJ
```

2. **Instale as dependências:**

```
npm install
```

3. **Configure as credenciais do Google:

- Crie um arquivo chamado `credentials.json` na raiz do projeto com suas credenciais da Google Service Account.

4. **Configure as variáveis de ambiente (se necessário):

Exemplo de `.env`:

```
NODE_ENV=production
LOG_LEVEL=INFO
```

5. **Inicie o chatbot:

```
node bot.js
```

6. **(Opcional) Executar com Docker:

```
docker-compose up --build
```

**👥 Equipe de Desenvolvimento**
- **Ariel Reises:**
Gestão do projeto (Scrum Master), QA, implantação, infraestrutura e validação junto aos stakeholders.

- **Breno de Oliveira Brocanello:**
Programação backend, desenvolvimento do chatbot, integração com Google Sheets e controle de fluxos.

**📝 Observações Finais**
Este projeto está vinculado ao estudo acadêmico aprovado pelo Comitê de Ética em Pesquisa da FMJ
(CAAE: 84179924.7.0000.5412 - Parecer: 7.586.604).
