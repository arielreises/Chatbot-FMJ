# Usa uma imagem base otimizada que já tem o Chromium instalado
FROM mcr.microsoft.com/playwright:v1.41.1-jammy

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos do projeto
COPY package.json ./
COPY bot.js ./
COPY estado_notificacoes.json ./
COPY package-lock.json ./
COPY credentials.json ./

# Instala as dependências
RUN npm install

# Expõe a porta necessária (caso precise)
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["node", "bot.js"]
