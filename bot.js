// Sistema de Atendimento FMJ (WhatsApp) - Versão Otimizada
const { Client, LocalAuth } = require('whatsapp-web.js');
const { google } = require('googleapis');
const QRCode = require('qrcode');
const moment = require('moment');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const http = require('http');

require('moment/locale/pt-br');
moment.locale('pt-br');

// ===== CONFIGURAÇÃO GLOBAL =====
const CONFIG = {
  SPREADSHEET_ID: '', // Id da sua planilha de cadastro
  SHEET_NAME: 'Cadastros',
  SHEET_RANGE: 'Cadastros!A2:L',
  FORM_URL: '', // Link do seu formulário de cadastro
  TCLE_URL: '', // Link do seu TCLE
  ADMIN_NUMBER: '5511999999999@c.us', // Número do administrador do sistema
  CACHE_TTL: 30000,
  TCLE_TIMEOUT_HORAS: 72,
  TCLE_MAX_TENTATIVAS: 3,
  DDD_PADRAO: '11',
  ENDERECO_PADRAO: '.',
  STATUS_INICIAL: 'Pendente',
  ESTADO_FILE: './estado_notificacoes.json',
  HORA_INICIO_NOTIFICACAO: 7,
  HORA_FIM_NOTIFICACAO: 20,
  TCLE_ACEITO_STATUS: 'TCLE_ACEITO',
  TCLE_REJEITADO_STATUS: 'TCLE_REJEITADO',
  MODO_PRODUCAO: process.env.NODE_ENV === 'production',
  MAX_TENTATIVAS_RECONEXAO: 10,
  INTERVALO_RECONEXAO: 30000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
  MAX_LOG_SIZE: 100,
  BACKUP_INTERVAL: 3600000
};

const auth = new google.auth.GoogleAuth({
  credentials: require('./credentials.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth: auth });

// ===== SISTEMA DE LOGS =====
class LogManager {
  constructor() {
    this.logs = [];
    this.logCount = 0;
  }

  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message, data: data ? JSON.stringify(data) : null };

    if (level === 'ERROR' || level === 'WARNING' || CONFIG.LOG_LEVEL === 'DEBUG') {
      this.logs.push(logEntry);
      if (this.logs.length > CONFIG.MAX_LOG_SIZE) {
        this.logs = this.logs.slice(-CONFIG.MAX_LOG_SIZE / 2);
      }
    }

    const shouldShow = CONFIG.MODO_PRODUCAO ? 
      (level === 'ERROR' || level === 'WARNING') : 
      (level !== 'DEBUG' || CONFIG.LOG_LEVEL === 'DEBUG');
      
    if (shouldShow) {
      console.log(`[${level}] ${timestamp} - ${message}`);
      if (data && !CONFIG.MODO_PRODUCAO) console.log(data);
    }
    this.logCount++;
  }

  debug(message, data) { this.log('DEBUG', message, data); }
  info(message, data) { this.log('INFO', message, data); }
  warning(message, data) { this.log('WARNING', message, data); }
  error(message, data) { this.log('ERROR', message, data); }
  getRecentLogs(count = 50) { return this.logs.slice(-count); }
}

// ===== SISTEMA DE RECUPERAÇÃO =====
class RecoveryManager {
  constructor() {
    this.tentativasReconexao = 0;
    this.ultimoErroGrave = null;
    this.statusSistema = 'INICIANDO';
    this.inicioUptime = Date.now();
  }

  async tentarRecuperacao(erro, contexto) {
    this.ultimoErroGrave = { erro: erro.message, contexto, timestamp: Date.now() };
    logger.error(`Erro em ${contexto}`, erro.message);

    switch (contexto) {
      case 'WHATSAPP_DISCONNECTED':
      case 'WHATSAPP_AUTH_FAILURE':
        return await this.recuperarWhatsApp(contexto);
      case 'GOOGLE_SHEETS_ERROR':
        return await this.recuperarGoogleSheets();
      case 'MEMORY_LEAK':
        return await this.limpezaMemoria();
      default:
        if (contexto === 'UNHANDLED_REJECTION' || contexto === 'MESSAGE_PROCESSING') {
          await this.notificarErroGrave(`Erro crítico no sistema: ${contexto} - ${erro.message}`);
        }
        return false;
    }
  }

  async recuperarWhatsApp(contexto) {
    if (this.tentativasReconexao >= CONFIG.MAX_TENTATIVAS_RECONEXAO) {
      await this.notificarErroGrave(`WhatsApp não conseguiu reconectar (${contexto}) após ${CONFIG.MAX_TENTATIVAS_RECONEXAO} tentativas.`);
      return false;
    }

    this.tentativasReconexao++;
    this.statusSistema = 'RECONECTANDO';
    
    try {
      await this.sleep(CONFIG.INTERVALO_RECONEXAO * this.tentativasReconexao);
      await client.destroy();
      await client.initialize();
      return true;
    } catch (error) {
      if (this.tentativasReconexao < CONFIG.MAX_TENTATIVAS_RECONEXAO) {
        return await this.recuperarWhatsApp(contexto);
      }
      await this.notificarErroGrave(`Falha crítica ao reconectar WhatsApp: ${error.message}`);
      return false;
    }
  }

  async recuperarGoogleSheets() {
    try {
      const conexaoOk = await verificarConexaoGoogleSheets();
      if (conexaoOk) {
        logger.info('Google Sheets reconectado');
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Erro ao recuperar Google Sheets', error.message);
      return false;
    }
  }

  async limpezaMemoria() {
    logger.info('Executando limpeza de memória...');
    try {
      const agora = Date.now();
      const umDiaAtras = agora - (24 * 60 * 60 * 1000);
      const seteDiasAtras = agora - (7 * 24 * 60 * 60 * 1000);

      // Limpeza das notificações
      this.limparNotificacoesAntigas(umDiaAtras);
      
      // Limpeza TCLE
      for (const [key, data] of state.usuariosAguardandoTCLE.entries()) {
        if (data.timestamp < seteDiasAtras) {
          state.usuariosAguardandoTCLE.delete(key);
        }
      }

      // NOVA: Sincronização com planilha
      await this.sincronizarEstadoComPlanilha();

      if (global.gc) global.gc();
      persistirEstado();
      logger.info('Limpeza de memória concluída.');
      return true;
    } catch (error) {
      logger.error('Erro na limpeza de memória', error.message);
      return false;
    }
  }

  limparNotificacoesAntigas(umDiaAtras) {
    for (const [key, timestamp] of state.notificacoesEnviadas.entries()) {
      if (typeof timestamp === 'object') {
        let hasActiveTimestamp = false;
        for (const typeKey in timestamp) {
          if (typeof timestamp[typeKey] === 'number' && timestamp[typeKey] >= umDiaAtras) {
            hasActiveTimestamp = true;
            break;
          }
        }
        if (!hasActiveTimestamp) {
          state.notificacoesEnviadas.delete(key);
        }
      } else if (typeof timestamp === 'number' && timestamp < umDiaAtras) {
        state.notificacoesEnviadas.delete(key);
      }
    }
  }

  async sincronizarEstadoComPlanilha() {
    try {
      await verificarCacheAtualizado();
      
      const telefonesAtivos = new Set();
      state.pacientesCache.forEach(paciente => {
        if (paciente && paciente[1]) {
          telefonesAtivos.add(normalizarTelefone(paciente[1]));
        }
      });

      let removidos = 0;
      
      // Limpar pacientes já notificados que não estão mais na planilha
      for (const numero of state.pacientesJaNotificados) {
        if (!telefonesAtivos.has(numero)) {
          state.pacientesJaNotificados.delete(numero);
          removidos++;
        }
      }

      // Limpar notificações de números que saíram da planilha
      for (const numero of state.notificacoesEnviadas.keys()) {
        if (!telefonesAtivos.has(numero)) {
          state.notificacoesEnviadas.delete(numero);
          removidos++;
        }
      }

      if (removidos > 10) {
        await client.sendMessage(CONFIG.ADMIN_NUMBER,
          `🧹 *Sincronização de Estado*\n\n${removidos} registros antigos removidos do sistema.\nAtivos na planilha: ${telefonesAtivos.size}`
        );
      }

      return removidos;
    } catch (error) {
      logger.error('Erro na sincronização com planilha:', error.message);
      return 0;
    }
  }

  async notificarErroGrave(mensagem) {
    try {
      const uptime = Math.floor((Date.now() - this.inicioUptime) / 1000 / 60);
      const logsRecentes = logger.getRecentLogs(10).map(log =>
        `${log.timestamp} [${log.level}]: ${log.message}`
      ).join('\n');

      const mensagemAdmin = 
        `🚨 **ERRO GRAVE NO SISTEMA FMJ**\n\n` +
        `📝 **Descrição:** ${mensagem}\n` +
        `⏰ **Uptime:** ${uptime} minutos\n` +
        `📊 **Status:** ${this.statusSistema}\n\n` +
        `**Últimos logs:**\n${logsRecentes || 'Nenhum log disponível.'}\n\n`;

      if (client && client.info) {
        await client.sendMessage(CONFIG.ADMIN_NUMBER, mensagemAdmin);
      }
    } catch (error) {
      logger.error('Falha ao notificar erro grave', error.message);
    }
  }

  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  getStatus() {
    return {
      status: this.statusSistema,
      tentativasReconexao: this.tentativasReconexao,
      ultimoErroGrave: this.ultimoErroGrave,
      uptimeMs: Date.now() - this.inicioUptime,
      uptimeHumano: moment.duration(Date.now() - this.inicioUptime).humanize(),
      logsCount: logger.logCount,
      memoriaUsada: process.memoryUsage().heapUsed / 1024 / 1024
    };
  }
}

// ===== ESTADO E INSTÂNCIAS =====
const logger = new LogManager();
const recovery = new RecoveryManager();

const state = {
  pacientesCache: [],
  ultimaAtualizacaoCache: 0,
  pacientesJaNotificados: new Set(),
  notificacoesEnviadas: new Map(),
  notificadosNesteCiclo: new Set(),
  usuariosRemarcando: new Map(),
  usuariosCancelando: new Map(),
  usuariosFeedback: new Map(),
  usuariosAguardandoTCLE: new Map(),
  // NOVO: Para detectar mudanças
  ultimasDatasPacientes: new Map(),
  ultimosStatusPacientes: new Map()
};

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './auth_data',
    clientId: 'fmj-bot-' + Date.now().toString(36)
  }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    headless: true
  },
  qrMaxRetries: 5,
  takeoverOnConflict: true,
  takeoverTimeoutMs: 10000
});

// ===== FUNÇÕES AUXILIARES =====
function formatarNumeroWhatsApp(numero) {
  if (!numero) return '';
  const numeroStr = String(numero).trim();
  return numeroStr.endsWith('@c.us') ? numeroStr : `${normalizarTelefone(numeroStr)}@c.us`;
}

function normalizarTelefone(numero) {
  if (!numero) return '';
  let numerosApenas = String(numero).replace(/@c\.us/g, '').replace(/\D/g, '').trim();
  if (!numerosApenas) return '';

  if (numerosApenas.startsWith('0')) numerosApenas = numerosApenas.substring(1);

  if (numerosApenas.startsWith('55') && (numerosApenas.length === 12 || numerosApenas.length === 13)) {
    return numerosApenas;
  }
  
  if (numerosApenas.length === 10 || numerosApenas.length === 11) {
    return '55' + numerosApenas;
  }
  
  if (numerosApenas.length === 8 || numerosApenas.length === 9) {
    const numeroComNove = (numerosApenas.length === 8 && !numerosApenas.startsWith('9')) ? '9' + numerosApenas : numerosApenas;
    return '55' + CONFIG.DDD_PADRAO + numeroComNove;
  }
  
  if (numerosApenas.length > 11 && !numerosApenas.startsWith('55')) {
    return '55' + numerosApenas;
  }
  
  return numerosApenas;
}

function gerarVariacoesTelefone(numero) {
  try {
    const numeroBase = String(numero).replace('@c.us', '').trim();
    if (!numeroBase) return [];
    
    const numeroNormalizado = normalizarTelefone(numeroBase);
    const variacoes = new Set([numeroBase, numeroNormalizado]);
    
    if (numeroNormalizado.startsWith('55') && numeroNormalizado.length >= 12) {
      const semDDI = numeroNormalizado.substring(2);
      const ddd = numeroNormalizado.substring(2, 4);
      const numeroSemDDIeDDD = numeroNormalizado.substring(4);

      variacoes.add(semDDI);
      variacoes.add(ddd + numeroSemDDIeDDD);
      variacoes.add(numeroSemDDIeDDD);

      if (numeroSemDDIeDDD.length === 9 && numeroSemDDIeDDD.startsWith('9')) {
        variacoes.add(ddd + numeroSemDDIeDDD.substring(1));
        variacoes.add(numeroSemDDIeDDD.substring(1));
      }
    }
    
    return [...variacoes].filter(v => v && v.length >= 8);
  } catch (error) {
    logger.error('Erro ao gerar variações de telefone:', { numero, message: error.message });
    return [String(numero).replace('@c.us', '').trim()].filter(Boolean);
  }
}

// ===== PERSISTÊNCIA DE ESTADO =====
function persistirEstado() {
  try {
    const estadoParaSalvar = {
      pacientesJaNotificados: Array.from(state.pacientesJaNotificados),
      ultimaAtualizacaoCache: state.ultimaAtualizacaoCache,
      notificacoesEnviadas: Object.fromEntries(state.notificacoesEnviadas.entries()),
      usuariosAguardandoTCLE: Object.fromEntries(state.usuariosAguardandoTCLE.entries()),
      ultimasDatasPacientes: Object.fromEntries(state.ultimasDatasPacientes.entries()),
      ultimosStatusPacientes: Object.fromEntries(state.ultimosStatusPacientes.entries())
    };
    fs.writeFileSync(CONFIG.ESTADO_FILE, JSON.stringify(estadoParaSalvar, null, 2));
  } catch (error) {
    logger.error('Falha ao persistir estado:', error.message);
  }
}

function carregarEstado() {
  try {
    if (fs.existsSync(CONFIG.ESTADO_FILE)) {
      const estadoSalvo = JSON.parse(fs.readFileSync(CONFIG.ESTADO_FILE, 'utf8'));

      state.pacientesJaNotificados = new Set(estadoSalvo.pacientesJaNotificados || []);
      state.ultimaAtualizacaoCache = estadoSalvo.ultimaAtualizacaoCache || 0;
      
      ['notificacoesEnviadas', 'usuariosAguardandoTCLE', 'ultimasDatasPacientes', 'ultimosStatusPacientes'].forEach(key => {
        state[key].clear();
        if (estadoSalvo[key]) {
          Object.entries(estadoSalvo[key]).forEach(([k, v]) => state[key].set(k, v));
        }
      });

      logger.info('Estado carregado com sucesso');
    }
  } catch (error) {
    logger.error('Falha ao carregar estado:', error.message);
    // Reset em caso de erro
    Object.keys(state).forEach(key => {
      if (state[key] instanceof Set) state[key] = new Set();
      else if (state[key] instanceof Map) state[key] = new Map();
    });
  }
}

// ===== GOOGLE SHEETS =====
async function verificarConexaoGoogleSheets() {
  try {
    await sheets.spreadsheets.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      fields: 'spreadsheetId'
    });
    return true;
  } catch (error) {
    logger.error('Falha na conexão com Google Sheets:', error.message);
    return false;
  }
}

async function atualizarCache() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: CONFIG.SHEET_RANGE,
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    });

    const dados = response.data.values || [];
    const atualizacoesEnderecos = [];

    const dadosProcessados = dados
      .filter(linha => linha && linha.length > 0 && linha.some(cell => cell && String(cell).trim()))
      .map((linhaOriginal, indexLinhaPlanilha) => {
        const linha = [...linhaOriginal];
        while (linha.length < 12) linha.push('');

        // Processar datas e horários
        processarDataHora(linha, indexLinhaPlanilha);
        
        // Preencher endereço padrão se necessário
        const numeroNorm = normalizarTelefone(linha[1]);
        if (numeroNorm && (!linha[5] || !linha[5].trim())) {
          atualizacoesEnderecos.push({
            linhaPlanilha: indexLinhaPlanilha + 2,
            endereco: CONFIG.ENDERECO_PADRAO,
            telefone: numeroNorm
          });
          linha[5] = CONFIG.ENDERECO_PADRAO;
        }

        return linha;
      });

    // Atualizar endereços na planilha
    if (atualizacoesEnderecos.length > 0) {
      await atualizarEnderecosPlanilha(atualizacoesEnderecos);
    }

    state.pacientesCache = dadosProcessados;
    state.ultimaAtualizacaoCache = Date.now();

  } catch (error) {
    logger.error('Falha ao atualizar cache:', error.message);
    await recovery.tentarRecuperacao(error, 'GOOGLE_SHEETS_ERROR');
    throw error;
  }
}

// Função auxiliar para processar datas e horários
function processarDataHora(linha, indexLinhaPlanilha) {
  // Data do Exame (índice 3)
  if (linha[3] && !String(linha[3]).includes('/')) {
    try {
      const dataSerial = parseFloat(linha[3]);
      if (!isNaN(dataSerial) && dataSerial > 1) {
        linha[3] = moment.utc('1899-12-30').add(dataSerial, 'days').format('DD/MM/YYYY');
      }
    } catch (e) {
      logger.warning(`Erro ao processar Data Exame linha ${indexLinhaPlanilha + 2}:`, e.message);
    }
  }

  // Horário (índice 4)
  if (linha[4] && !String(linha[4]).includes(':')) {
    try {
      const horaDecimal = parseFloat(linha[4]);
      if (!isNaN(horaDecimal) && horaDecimal >= 0 && horaDecimal < 1) {
        const totalSegundos = horaDecimal * 24 * 60 * 60;
        const horas = Math.floor(totalSegundos / 3600);
        const minutos = Math.floor((totalSegundos % 3600) / 60);
        linha[4] = `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}`;
      }
    } catch (e) {
      logger.warning(`Erro ao processar Horário linha ${indexLinhaPlanilha + 2}:`, e.message);
    }
  }

  // Data de Nascimento (índice 8)
  if (linha[8] && !String(linha[8]).includes('/')) {
    try {
      const dataSerial = parseFloat(linha[8]);
      if (!isNaN(dataSerial) && dataSerial > 1) {
        linha[8] = moment.utc('1899-12-30').add(dataSerial, 'days').format('DD/MM/YYYY');
      }
    } catch (e) {
      logger.warning(`Erro ao processar Data Nascimento linha ${indexLinhaPlanilha + 2}:`, e.message);
    }
  }
}

async function atualizarEnderecosPlanilha(atualizacoes) {
  logger.info(`Preenchendo endereço padrão para ${atualizacoes.length} cadastros`);
  for (const atualizacao of atualizacoes) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${CONFIG.SHEET_NAME}!F${atualizacao.linhaPlanilha}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[atualizacao.endereco]] }
      });
    } catch (error) {
      logger.error(`Erro ao atualizar endereço linha ${atualizacao.linhaPlanilha}:`, error.message);
    }
  }
}

async function atualizarCampoPlanilha(linhaPlanilha, colunaLetra, valor) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${CONFIG.SHEET_NAME}!${colunaLetra}${linhaPlanilha}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[valor]] }
    });
    logger.info(`Planilha atualizada: ${colunaLetra}${linhaPlanilha} = ${valor}`);
    return true;
  } catch (error) {
    logger.error(`Erro ao atualizar ${colunaLetra}${linhaPlanilha}:`, error.message);
    await recovery.tentarRecuperacao(new Error(`Falha ao atualizar planilha: ${error.message}`), 'GOOGLE_SHEETS_ERROR');
    return false;
  }
}

async function verificarCacheAtualizado() {
  try {
    const agora = Date.now();
    if ((agora - state.ultimaAtualizacaoCache) > CONFIG.CACHE_TTL || state.pacientesCache.length === 0) {
      await atualizarCache();
    }
  } catch (error) {
    logger.error('Falha ao verificar cache:', error.message);
    try {
      await atualizarCache();
    } catch (deepError) {
      logger.error('Falha crítica na segunda tentativa:', deepError.message);
    }
  }
}

// ===== BUSCA DE PACIENTES =====
async function buscarPaciente(numeroTelefoneInput) {
  await verificarCacheAtualizado();
  const variacoesTelefone = gerarVariacoesTelefone(numeroTelefoneInput);

  for (const paciente of state.pacientesCache) {
    if (!paciente || !paciente[1]) continue;

    const telefonePlanilha = String(paciente[1]).trim();
    const variacoesPlanilha = gerarVariacoesTelefone(telefonePlanilha);

    for (const varInput of variacoesTelefone) {
      for (const varPlanilha of variacoesPlanilha) {
        if (varInput === varPlanilha) {
          return paciente;
        }
      }
    }
  }
  return null;
}

function encontrarIndicePaciente(numeroTelefoneInput) {
  const variacoesTelefone = gerarVariacoesTelefone(numeroTelefoneInput);

  for (let i = 0; i < state.pacientesCache.length; i++) {
    const paciente = state.pacientesCache[i];
    if (!paciente || !paciente[1]) continue;

    const telefonePlanilha = String(paciente[1]).trim();
    const variacoesPlanilha = gerarVariacoesTelefone(telefonePlanilha);

    for (const varInput of variacoesTelefone) {
      for (const varPlanilha of variacoesPlanilha) {
        if (varInput === varPlanilha) {
          return i;
        }
      }
    }
  }
  return -1;
}

// ===== SISTEMA DE NOTIFICAÇÕES =====
function jaEnviouNotificacao(numeroTelefone, tipoNotificacao) {
  const numeroNorm = normalizarTelefone(String(numeroTelefone).replace('@c.us', ''));
  const notificacoesDoNumero = state.notificacoesEnviadas.get(numeroNorm);

  if (!notificacoesDoNumero || !notificacoesDoNumero[tipoNotificacao]) return false;

  const timestampEnvio = notificacoesDoNumero[tipoNotificacao];
  const agora = Date.now();
  
  const limites = {
    'tcle_enviado': 12 * 60 * 60 * 1000,
    '7dias': 20 * 60 * 60 * 1000,
    '2dias': 20 * 60 * 60 * 1000,
    'feedback': 3 * 24 * 60 * 60 * 1000,
    'info_bot_nao_cadastrado': 30 * 60 * 1000,
    'default': 23 * 60 * 60 * 1000
  };

  const limite = limites[tipoNotificacao] || limites.default;
  return (agora - timestampEnvio) < limite;
}

function registrarEnvioNotificacao(numeroTelefone, tipoNotificacao) {
  const numeroNorm = normalizarTelefone(String(numeroTelefone).replace('@c.us', ''));
  const agora = Date.now();

  if (!state.notificacoesEnviadas.has(numeroNorm)) {
    state.notificacoesEnviadas.set(numeroNorm, {});
  }

  state.notificacoesEnviadas.get(numeroNorm)[tipoNotificacao] = agora;
}

function temTCLEAceito(paciente) {
  return paciente && paciente[10] && String(paciente[10]).trim().toUpperCase() === CONFIG.TCLE_ACEITO_STATUS;
}

// ===== TCLE =====
async function enviarTCLE(paciente) {
  try {
    if (!paciente || !paciente[0] || !paciente[1]) return false;
    
    const nomePaciente = String(paciente[0]).trim();
    const numeroFormatado = formatarNumeroWhatsApp(paciente[1]);
    
    if (jaEnviouNotificacao(numeroFormatado, 'tcle_enviado')) return false;
    
    const usuarioExistente = state.usuariosAguardandoTCLE.get(numeroFormatado);
    const tentativasAtuais = usuarioExistente ? (usuarioExistente.tentativas || 0) : 0;
    
    if (tentativasAtuais >= CONFIG.TCLE_MAX_TENTATIVAS) {
      state.usuariosAguardandoTCLE.delete(numeroFormatado);
      persistirEstado();
      return false;
    }
    
    state.usuariosAguardandoTCLE.set(numeroFormatado, {
      nome: nomePaciente,
      timestamp: Date.now(),
      tentativas: tentativasAtuais + 1,
      primeiroEnvio: usuarioExistente ? usuarioExistente.primeiroEnvio : Date.now()
    });
    
    await client.sendMessage(numeroFormatado,
      `*Olá, ${nomePaciente}!* 👋\n\n` +
      `Seu cadastro para o exame de colonoscopia foi recebido! 🎉\n\n` +
      `📋 *IMPORTANTE - Termo de Consentimento*\n\n` +
      `Para continuarmos com seu agendamento, é essencial que você leia e aceite nosso Termo de Consentimento Livre e Esclarecido (TCLE).\n\n` +
      `📄 **Acesse o TCLE aqui:** ${CONFIG.TCLE_URL}\n\n` +
      `Após a leitura cuidadosa do documento, por favor, responda a esta mensagem com:\n` +
      `➡️ Digite *ACEITO* (ou 1) se você concorda com todos os termos.\n` +
      `➡️ Digite *NÃO ACEITO* (ou 2) se você não concorda com os termos.\n\n` +
      `⚠️ *Seu agendamento só poderá ser confirmado após sua resposta ao TCLE.* Agradecemos sua compreensão e colaboração!\n\n` +
      (tentativasAtuais > 0 ? `⏰ *Esta é sua ${tentativasAtuais + 1}ª tentativa. Você tem até 3 dias para responder.*` : '')
    );
    
    registrarEnvioNotificacao(numeroFormatado, 'tcle_enviado');
    persistirEstado();
    
    await client.sendMessage(CONFIG.ADMIN_NUMBER,
      `📋 *TCLE Enviado (Tentativa ${tentativasAtuais + 1})*\n\nNome: ${nomePaciente}\nTelefone: ${paciente[1]}\nStatus: Aguardando resposta do TCLE.`
    );
    return true;

  } catch (error) {
    logger.error(`[TCLE] Falha ao enviar TCLE para ${paciente ? paciente[0] : 'desconhecido'}:`, error.message);
    return false;
  }
}

async function processarRespostaTCLE(numeroWhatsApp, textoResposta) {
  const numeroFormatado = formatarNumeroWhatsApp(numeroWhatsApp);
  const usuarioAguardando = state.usuariosAguardandoTCLE.get(numeroFormatado);

  if (!usuarioAguardando) return false;

  const paciente = await buscarPaciente(numeroWhatsApp);
  if (!paciente) {
    state.usuariosAguardandoTCLE.delete(numeroFormatado);
    persistirEstado();
    await client.sendMessage(numeroFormatado, "Houve um problema ao localizar seus dados. Por favor, entre em contato com a clínica.");
    return false;
  }
  
  const nomePaciente = paciente[0];
  const respostaNormalizada = textoResposta.toUpperCase().trim();
  let statusTCLEPlanilha = '';
  let mensagemAdmin = '';
  let mensagemPaciente = '';

  if (['ACEITO', '1', 'SIM', 'CONCORDO', 'ACEITAR'].includes(respostaNormalizada)) {
    statusTCLEPlanilha = CONFIG.TCLE_ACEITO_STATUS;
    mensagemPaciente =
      `✅ *Obrigado por aceitar o TCLE, ${nomePaciente}!* Seu consentimento foi registrado.\n\n` +
      `Agora podemos prosseguir com os detalhes do seu atendimento:\n\n` +
      `👨‍⚕️ **Seu Exame:** Colonoscopia\n` +
      `📅 Data: ${paciente[3] || 'Data a confirmar'}\n` +
      `🕒 Horário: ${paciente[4] || 'Horário a confirmar'}\n` +
      `📍 Local: ${paciente[5] || CONFIG.ENDERECO_PADRAO}\n\n` +
      `ℹ️ **Próximos Passos:**\n` +
      `• Você receberá um lembrete 7 dias antes do exame.\n` +
      `• Outro lembrete será enviado 2 dias antes com instruções finais.\n` +
      `• Após o exame, entraremos em contato para saber sobre sua experiência.\n\n` +
      `Agradecemos a preferência e estamos à disposição! 🙏`;
    
    mensagemAdmin = `✅ *TCLE Aceito*\n\nNome: ${nomePaciente}\nTelefone: ${paciente[1]}\nStatus: TCLE aceito. Paciente ativo no fluxo.`;

  } else if (['NÃO ACEITO', 'NAO ACEITO', '2', 'NAO', 'NÃO', 'DISCORDO', 'REJEITAR'].includes(respostaNormalizada)) {
    statusTCLEPlanilha = CONFIG.TCLE_REJEITADO_STATUS;
    mensagemPaciente =
      `❌ *TCLE Não Aceito*\n\n` +
      `Olá, ${nomePaciente}. Recebemos sua resposta indicando que não aceita os termos do TCLE.\n\n` +
      `Respeitamos sua decisão. No entanto, a aceitação do termo é um requisito para a realização do exame em nossa clínica.\n\n` +
      `Caso reconsidere ou tenha dúvidas, por favor, entre em contato conosco.\n\nObrigado.`;
    
    mensagemAdmin = `❌ *TCLE Rejeitado*\n\nNome: ${nomePaciente}\nTelefone: ${paciente[1]}\nStatus: TCLE rejeitado.`;

  } else {
    const tentativas = usuarioAguardando.tentativas || 1;
    
    if (tentativas >= CONFIG.TCLE_MAX_TENTATIVAS) {
      state.usuariosAguardandoTCLE.delete(numeroFormatado);
      persistirEstado();
      
      await client.sendMessage(numeroFormatado,
        `⚠️ *Máximo de tentativas atingido*\n\n` +
        `${nomePaciente}, você atingiu o limite de 3 tentativas para responder ao TCLE.\n\n` +
        `Para prosseguir com o agendamento, será necessário entrar em contato diretamente com a clínica ou refazer o cadastro.\n\n` +
        `📄 Formulário: ${CONFIG.FORM_URL}`
      );
      
      return true;
    }
    
    await client.sendMessage(numeroFormatado,
      `⚠️ *Resposta não compreendida* (Tentativa ${tentativas}/${CONFIG.TCLE_MAX_TENTATIVAS})\n\n` +
      `Olá, ${nomePaciente}. Para o Termo de Consentimento, responda apenas:\n` +
      `➡️ *ACEITO* (ou 1) - se concorda com o TCLE\n` +
      `➡️ *NÃO ACEITO* (ou 2) - se não concorda\n\n` +
      `📄 Você pode reler o TCLE aqui: ${CONFIG.TCLE_URL}\n\n` +
      `⏰ Você tem mais ${CONFIG.TCLE_MAX_TENTATIVAS - tentativas} tentativa(s).`
    );
    return false;
  }

  try {
    await atualizarStatusTCLE(numeroWhatsApp, statusTCLEPlanilha);
    state.usuariosAguardandoTCLE.delete(numeroFormatado);
    persistirEstado();

    await client.sendMessage(numeroFormatado, mensagemPaciente);
    if (mensagemAdmin) await client.sendMessage(CONFIG.ADMIN_NUMBER, mensagemAdmin);
    return true;

  } catch (error) {
    logger.error(`[TCLE] Erro ao processar resposta final para ${nomePaciente}:`, error.message);
    await client.sendMessage(numeroFormatado, "Houve um erro ao processar sua resposta ao TCLE. Nossa equipe foi notificada.");
    return false;
  }
}

async function limparUsuariosAguardandoTCLEExpirados() {
  const agora = Date.now();
  const timeoutMs = CONFIG.TCLE_TIMEOUT_HORAS * 60 * 60 * 1000;
  const usuariosRemovidos = [];
  
  for (const [numeroTelefone, dados] of state.usuariosAguardandoTCLE.entries()) {
    const tempoEspera = agora - (dados.primeiroEnvio || dados.timestamp);
    const tentativas = dados.tentativas || 1;
    
    if (tempoEspera > timeoutMs || tentativas >= CONFIG.TCLE_MAX_TENTATIVAS) {
      const nomePaciente = dados.nome;
      
      try {
        const motivoRemocao = tempoEspera > timeoutMs ? 'timeout' : 'max_tentativas';
        await client.sendMessage(formatarNumeroWhatsApp(numeroTelefone),
          `⏰ *Prazo para Resposta ao TCLE Expirado*\n\n` +
          `Olá, ${nomePaciente}. O prazo para responder ao Termo de Consentimento (TCLE) expirou.\n\n` +
          `Para prosseguir com um novo agendamento:\n` +
          `1. Preencha novamente o formulário de cadastro\n` +
          `2. Ou entre em contato diretamente com nossa clínica\n\n` +
          `📄 Formulário: ${CONFIG.FORM_URL}`
        );
      } catch (error) {
        logger.error(`Erro ao enviar mensagem de TCLE expirado para ${nomePaciente}:`, error.message);
      }
      
      state.usuariosAguardandoTCLE.delete(numeroTelefone);
      usuariosRemovidos.push({ nome: nomePaciente, telefone: numeroTelefone });
    }
  }
  
  if (usuariosRemovidos.length > 0) {
    persistirEstado();
    await client.sendMessage(CONFIG.ADMIN_NUMBER,
      `🧹 *Limpeza TCLE Expirados*\n\nRemovidos ${usuariosRemovidos.length} usuário(s) que não responderam ao TCLE.`
    );
  }
  
  return usuariosRemovidos.length;
}

// ===== PROCESSAMENTO DE NOVOS CADASTROS =====
async function processarNovosCadastros() {
  state.notificadosNesteCiclo.clear();
  let novosPacientesParaTCLE = 0;

  for (let i = 0; i < state.pacientesCache.length; i++) {
    const paciente = state.pacientesCache[i];
    
    if (!paciente || !paciente[0] || !paciente[1]) continue;

    const nomePaciente = String(paciente[0]).trim();
    const numeroNormalizado = normalizarTelefone(paciente[1]);
    const dataAtual = paciente[3];
    const statusAtual = String(paciente[6] || '').trim();

    // NOVA LÓGICA: Detectar mudanças
    const ultimaData = state.ultimasDatasPacientes.get(numeroNormalizado);
    const ultimoStatus = state.ultimosStatusPacientes.get(numeroNormalizado);
    const dataMudou = ultimaData && ultimaData !== dataAtual;
    const statusMudou = ultimoStatus === 'Remarcado' && statusAtual !== 'Remarcado';
    const jaNotificado = state.pacientesJaNotificados.has(numeroNormalizado);
    const nesteCiclo = state.notificadosNesteCiclo.has(numeroNormalizado);

    // Resetar estado se data mudou ou saiu do status Remarcado
    if ((dataMudou || statusMudou) && jaNotificado) {
      logger.info(`Resetando estado para ${nomePaciente}: ${dataMudou ? 'Data mudou' : 'Saiu de Remarcado'}`);
      
      state.pacientesJaNotificados.delete(numeroNormalizado);
      
      // Limpar notificações (exceto TCLE aceito)
      const notifExistentes = state.notificacoesEnviadas.get(numeroNormalizado);
      if (notifExistentes && notifExistentes.tcle_enviado) {
        state.notificacoesEnviadas.set(numeroNormalizado, {
          tcle_enviado: notifExistentes.tcle_enviado
        });
      }
    }

    // Atualizar registros de controle
    state.ultimasDatasPacientes.set(numeroNormalizado, dataAtual);
    state.ultimosStatusPacientes.set(numeroNormalizado, statusAtual);

    // Verificar se deve processar
    if (state.pacientesJaNotificados.has(numeroNormalizado) || nesteCiclo) continue;

    const statusTCLE = paciente[10] ? String(paciente[10]).trim().toUpperCase() : '';
    if (statusTCLE === CONFIG.TCLE_ACEITO_STATUS || statusTCLE === CONFIG.TCLE_REJEITADO_STATUS) {
      state.pacientesJaNotificados.add(numeroNormalizado);
      state.notificadosNesteCiclo.add(numeroNormalizado);
      continue;
    }
    
    // Garantir campos padrão na planilha se vazios
    if (!paciente[5] || String(paciente[5]).trim() === '') {
      await atualizarCampoPlanilha(i + 2, 'F', CONFIG.ENDERECO_PADRAO);
      if(state.pacientesCache[i]) state.pacientesCache[i][5] = CONFIG.ENDERECO_PADRAO;
    }
    if (!paciente[6] || String(paciente[6]).trim() === '') {
      await atualizarCampoPlanilha(i + 2, 'G', CONFIG.STATUS_INICIAL);
      if(state.pacientesCache[i]) state.pacientesCache[i][6] = CONFIG.STATUS_INICIAL;
    }

    // Enviar TCLE
    if (await enviarTCLE(paciente)) {
      novosPacientesParaTCLE++;
      state.pacientesJaNotificados.add(numeroNormalizado);
      state.notificadosNesteCiclo.add(numeroNormalizado);
    }
  }

  if (novosPacientesParaTCLE > 0) {
    persistirEstado();
  }
}

async function garantirCamposPadrao(paciente, indice) {
  const linha = indice + 2;
  
  if (!paciente[5] || !paciente[5].trim()) {
    await atualizarCampoPlanilha(linha, 'F', CONFIG.ENDERECO_PADRAO);
    if (state.pacientesCache[indice]) state.pacientesCache[indice][5] = CONFIG.ENDERECO_PADRAO;
  }
  
  if (!paciente[6] || !paciente[6].trim()) {
    await atualizarCampoPlanilha(linha, 'G', CONFIG.STATUS_INICIAL);
    if (state.pacientesCache[indice]) state.pacientesCache[indice][6] = CONFIG.STATUS_INICIAL;
  }
}

// ===== ATUALIZAÇÕES DE STATUS =====
async function atualizarStatusTCLE(numeroTelefoneInput, novoStatusTCLE) {
  const indiceCache = encontrarIndicePaciente(numeroTelefoneInput);
  if (indiceCache === -1) throw new Error('Paciente não encontrado para atualização de TCLE');
  
  const linhaPlanilha = indiceCache + 2;
  const sucesso = await atualizarCampoPlanilha(linhaPlanilha, 'K', novoStatusTCLE);

  if (sucesso && state.pacientesCache[indiceCache]) {
    state.pacientesCache[indiceCache][10] = novoStatusTCLE;
  }
  
  return sucesso;
}

async function atualizarStatusConsulta(numeroTelefoneInput, novoStatus) {
  const indiceCache = encontrarIndicePaciente(numeroTelefoneInput);
  if (indiceCache === -1) throw new Error('Paciente não encontrado para atualização de status');

  const linhaPlanilha = indiceCache + 2;
  const sucesso = await atualizarCampoPlanilha(linhaPlanilha, 'G', novoStatus);

  if (sucesso && state.pacientesCache[indiceCache]) {
    state.pacientesCache[indiceCache][6] = novoStatus;
  }
  
  return sucesso;
}

async function registrarFeedback(numeroTelefoneInput, feedbackTexto) {
  const indiceCache = encontrarIndicePaciente(numeroTelefoneInput);
  if (indiceCache === -1) throw new Error('Paciente não encontrado para feedback');
  
  const linhaPlanilha = indiceCache + 2;
  
  const atualizacoes = [
    atualizarCampoPlanilha(linhaPlanilha, 'H', feedbackTexto),
    atualizarCampoPlanilha(linhaPlanilha, 'G', 'Concluído'),
    atualizarCampoPlanilha(linhaPlanilha, 'L', 'SIM')
  ];

  const resultados = await Promise.all(atualizacoes);
  const sucessoTotal = resultados.every(r => r);

  if (sucessoTotal && state.pacientesCache[indiceCache]) {
    state.pacientesCache[indiceCache][7] = feedbackTexto;
    state.pacientesCache[indiceCache][6] = 'Concluído';
    state.pacientesCache[indiceCache][11] = 'SIM';
  }

  return sucessoTotal;
}

// ===== LEMBRETES E NOTIFICAÇÕES =====
async function enviarLembrete7Dias(paciente) {
  if (!paciente || !paciente[0] || !paciente[1] || !paciente[3]) return false;

  const nomePaciente = paciente[0];
  const numeroFormatado = formatarNumeroWhatsApp(paciente[1]);

  if (!temTCLEAceito(paciente) || 
      ['Cancelado', 'Remarcado', 'Concluído'].includes(String(paciente[6]).trim()) ||
      jaEnviouNotificacao(numeroFormatado, '7dias')) {
    return false;
  }

  await client.sendMessage(numeroFormatado,
    `🔔 *Lembrete Importante: Seu exame é em 7 dias!*\n\n` +
    `Olá, ${nomePaciente}! Gostaríamos de lembrar que seu exame de colonoscopia está agendado para daqui a uma semana.\n\n` +
    `📅 **Data:** ${paciente[3]}\n` +
    `🕒 **Horário:** ${paciente[4] || 'Horário a confirmar'}\n` +
    `📍 **Local:** ${paciente[5] || CONFIG.ENDERECO_PADRAO}\n\n` +
    `**Por favor, confirme sua presença respondendo:**\n` +
    `✅ Digite *1* para CONFIRMAR sua presença.\n` +
    `📅 Digite *2* se precisar REMARCAR (entre em contato diretamente com sua UBS para fazer a remarcação).\n\n` +
    `Aguardamos sua resposta! 😊`
  );
  
  registrarEnvioNotificacao(numeroFormatado, '7dias');
  return true;
}

async function enviarLembrete2Dias(paciente) {
  if (!paciente || !paciente[0] || !paciente[1] || !paciente[3]) return false;

  const nomePaciente = paciente[0];
  const numeroFormatado = formatarNumeroWhatsApp(paciente[1]);

  if (!temTCLEAceito(paciente) || 
      ['Cancelado', 'Remarcado', 'Concluído'].includes(String(paciente[6]).trim()) ||
      jaEnviouNotificacao(numeroFormatado, '2dias')) {
    return false;
  }

  await client.sendMessage(numeroFormatado,
    `🔔 *Atenção: Seu exame é em 2 dias!*\n\n` +
    `Olá, ${nomePaciente}! Seu exame de colonoscopia está chegando!\n\n` +
    `📅 **Data:** ${paciente[3]}\n` +
    `🕒 **Horário:** ${paciente[4] || 'Horário a confirmar'}\n` +
    `📍 **Local:** ${paciente[5] || CONFIG.ENDERECO_PADRAO}\n\n` +
    `⚠️ **MUITO IMPORTANTE:**\n` +
    `1. Certifique-se de ter adquirido o kit de preparo intestinal.\n` +
    `2. Siga RIGOROSAMENTE todas as instruções de preparo.\n` +
    `3. Lembre-se de vir com um acompanhante maior de idade.\n\n` +
    `**Confirme sua presença respondendo:**\n` +
    `✅ Digite *1* para CONFIRMAR.\n` +
    `📅 Digite *2* se precisar REMARCAR (entre em contato diretamente com sua UBS para fazer a remarcação).\n\n` +
    `Contamos com você! 👍`
  );
  
  registrarEnvioNotificacao(numeroFormatado, '2dias');
  return true;
}

async function solicitarFeedbackConsulta(paciente) {
  if (!paciente || !paciente[0] || !paciente[1] || !paciente[3]) return false;

  const nomePaciente = paciente[0];
  const numeroFormatado = formatarNumeroWhatsApp(paciente[1]);

  if (!temTCLEAceito(paciente) || 
      ['Cancelado', 'Remarcado'].includes(String(paciente[6]).trim()) ||
      (paciente[7] && String(paciente[7]).trim()) ||
      String(paciente[6]).trim() === 'Concluído' ||
      jaEnviouNotificacao(numeroFormatado, 'feedback')) {
    return false;
  }
  
  await client.sendMessage(numeroFormatado,
    `🌟 *Como foi sua experiência conosco?*\n\n` +
    `Olá, ${nomePaciente}! Esperamos que seu exame de colonoscopia tenha ocorrido bem.\n\n` +
    `Sua opinião é muito valiosa para nós! Gostaríamos de saber como foi sua experiência geral.\n\n` +
    `**Por favor, avalie nosso serviço respondendo com um número de 1 a 5:**\n` +
    `*5* - Excelente ✨\n*4* - Muito Bom 👍\n*3* - Bom / Razoável ✅\n*2* - Ruim 👎\n*1* - Péssimo 😠\n\n` +
    `Se desejar, pode adicionar um breve comentário após o número.\nAgradecemos sua colaboração! 🙏`
  );
  
  state.usuariosFeedback.set(numeroFormatado, true);
  registrarEnvioNotificacao(numeroFormatado, 'feedback');
  return true;
}

async function verificarNotificacoes() {
  await verificarCacheAtualizado();
  
  const agora = moment();
  if (agora.hour() < CONFIG.HORA_INICIO_NOTIFICACAO || agora.hour() >= CONFIG.HORA_FIM_NOTIFICACAO) {
    return;
  }

  let notificacoesEnviadas = 0;
  const processados = new Set();

  for (const paciente of state.pacientesCache) {
    try {
      if (!paciente || !paciente[0] || !paciente[1] || !paciente[3]) continue;

      const numeroNorm = normalizarTelefone(paciente[1]);
      if (processados.has(numeroNorm)) continue;

      if (!temTCLEAceito(paciente) || 
          ['Cancelado', 'Remarcado', 'Concluído'].includes(String(paciente[6] || '').trim())) {
        continue;
      }

      const dataConsultaStr = String(paciente[3]).trim();
      if (!moment(dataConsultaStr, 'DD/MM/YYYY', true).isValid()) continue;

      const dataConsulta = moment(dataConsultaStr, 'DD/MM/YYYY').startOf('day');
      const hoje = moment().startOf('day');
      const diasParaConsulta = dataConsulta.diff(hoje, 'days');
      
      let enviouNotificacao = false;

      if (diasParaConsulta === 7) {
        if (await enviarLembrete7Dias(paciente)) enviouNotificacao = true;
      } else if (diasParaConsulta === 2) {
        if (await enviarLembrete2Dias(paciente)) enviouNotificacao = true;
      } else if (diasParaConsulta === -1) {
        const statusConsulta = String(paciente[6] || '').trim();
        if (statusConsulta !== 'Cancelado' && statusConsulta !== 'Remarcado' && 
            (!paciente[7] || !String(paciente[7]).trim())) {
          
          const horarioStr = String(paciente[4] || '00:00').trim();
          const dataHoraConsulta = moment(`${dataConsultaStr} ${horarioStr}`, 'DD/MM/YYYY HH:mm');
          
          if (!dataHoraConsulta.isValid() || moment().isAfter(dataHoraConsulta.add(4, 'hours'))) {
            if (await solicitarFeedbackConsulta(paciente)) enviouNotificacao = true;
          }
        }
      }
      
      if (enviouNotificacao) {
        notificacoesEnviadas++;
        processados.add(numeroNorm);
      }

    } catch (error) {
      logger.error(`Erro ao processar notificação para ${paciente ? paciente[0] : 'desconhecido'}:`, error.message);
    }
  }

  if (notificacoesEnviadas > 0) {
    persistirEstado();
  }
}

// ===== INTERAÇÕES COM USUÁRIOS =====
async function enviarMensagemInicial(numeroTelefone, paciente) {
  const nomePaciente = paciente[0];
  const numeroFormatado = formatarNumeroWhatsApp(numeroTelefone);

  if (!temTCLEAceito(paciente)) {
    await client.sendMessage(numeroFormatado,
      `Olá, ${nomePaciente}!\n\n` +
      `Para que possamos prosseguir, é necessário que seu Termo de Consentimento (TCLE) esteja aceito.\n\n` +
      `📄 Se precisar do link: ${CONFIG.TCLE_URL}\n\n` +
      `Responda *ACEITO* ou *NÃO ACEITO* após ler o documento.`
    );
    
    if (!state.usuariosAguardandoTCLE.has(numeroFormatado) && (!paciente[10] || !paciente[10].trim())) {
      state.usuariosAguardandoTCLE.set(numeroFormatado, { nome: nomePaciente, timestamp: Date.now() });
      persistirEstado();
    }
    return true;
  }

  // Verificar spam de menu
  const chaveCacheMenu = `menu_inicial_${normalizarTelefone(numeroTelefone)}`;
  const ultimoEnvio = state.notificacoesEnviadas.get(chaveCacheMenu)?.['menu_inicial_ts'];
  if (ultimoEnvio && (Date.now() - ultimoEnvio) < (1 * 1000)) return true; // 1 segundo

  const statusConsulta = paciente[6] || 'Pendente';
  let mensagemMenu = `👋 *Olá, ${nomePaciente}!* Como posso ajudar hoje?\n\n`;

  if (['Confirmado', 'Pendente', CONFIG.STATUS_INICIAL].includes(statusConsulta)) {
    mensagemMenu +=
      `📋 **Seu Exame Agendado:**\n` +
      `   Colonoscopia\n` +
      `   📅 Data: *${paciente[3] || 'Não definida'}*\n` +
      `   🕒 Horário: *${paciente[4] || 'Não definida'}*\n` +
      `   📍 Local: ${paciente[5] || CONFIG.ENDERECO_PADRAO}\n` +
      `   Status: ${statusConsulta}\n\n` +
      `**Escolha uma opção:**\n` +
      `1️⃣ - CONFIRMAR consulta\n` +
      `2️⃣ - REMARCAR consulta (entre em contato diretamente com sua UBS)\n` +
      `3️⃣ - Informações sobre o PREPARO do exame\n` +
      `Digite o número da opção desejada.`;
  } else if (statusConsulta === 'Remarcado') {
    mensagemMenu +=
      `📋 **Status:** REMARCAÇÃO PENDENTE\n\n` +
      `Para remarcar a consulta entre em contato com a UBS!`;
  } else if (statusConsulta === 'Cancelado') {
    mensagemMenu +=
      `📋 **Status:** CANCELADA\n\n` +
      `Sua consulta foi cancelada conforme solicitado.\n\n` +
      `Para novo agendamento, digite *4* para FALAR COM ATENDENTE.`;
  } else if (statusConsulta === 'Concluído') {
    mensagemMenu +=
      `🎉 **Consulta Concluída!**\n\n` +
      `Agradecemos por escolher nossos serviços!\n\n`
  } else {
    //mensagemMenu += `Para informações, digite *4* para FALAR COM ATENDENTE.`;
  }

  await client.sendMessage(numeroFormatado, mensagemMenu);
  
  // Registrar envio do menu
  if (!state.notificacoesEnviadas.has(chaveCacheMenu)) {
    state.notificacoesEnviadas.set(chaveCacheMenu, {});
  }
  state.notificacoesEnviadas.get(chaveCacheMenu)['menu_inicial_ts'] = Date.now();
  
  return true;
}

async function enviarMensagemCadastro(numeroTelefone) {
  const numeroFormatado = formatarNumeroWhatsApp(numeroTelefone);
  
  if (jaEnviouNotificacao(numeroFormatado, 'info_bot_nao_cadastrado')) return false;

  await client.sendMessage(numeroFormatado,
    `🤖 *Olá!*\n\n` +
    `Seu número não está em nossa lista de pacientes ativos.\n\n` +
    `**Este sistema é utilizado para:**\n` +
    `✅ Envio e confirmação do TCLE\n` +
    `🔔 Lembretes de consultas\n` +
    `📝 Coleta de feedback\n` +
    `🔄 Confirmação, remarcação\n\n` +
    `🏥 **Para agendar um exame, entre em contato com a UBS**\n` 
  );
  
  registrarEnvioNotificacao(numeroFormatado, 'info_bot_nao_cadastrado');
  persistirEstado();
  return true;
}

// ===== PROCESSAMENTO DE OPÇÕES =====
async function processarConfirmacao(numeroWhatsApp, paciente) {
  const nomePaciente = paciente[0];
  const estavaConfirmado = String(paciente[6]).trim() === 'Confirmado';

  await atualizarStatusConsulta(numeroWhatsApp, 'Confirmado');
  
  const indiceCache = encontrarIndicePaciente(numeroWhatsApp);
  if (indiceCache !== -1) {
    await atualizarCampoPlanilha(indiceCache + 2, 'L', 'Confirmado (Bot)');
    if (state.pacientesCache[indiceCache]) {
      state.pacientesCache[indiceCache][11] = 'Confirmado (Bot)';
    }
  }

  await client.sendMessage(numeroWhatsApp,
    `✅ *Consulta Confirmada!*\n\n` +
    `Olá, ${nomePaciente}! Sua presença no exame de colonoscopia do dia ${paciente[3]} às ${paciente[4]} está confirmada.\n\n` +
    `Lembre-se das instruções de preparo e de comparecer com um acompanhante.\n\nNos vemos em breve! 😊`
  );
  
  if (!estavaConfirmado) {
    await notificarAdmin('Consulta Confirmada pelo Paciente', paciente);
  }
}

async function processarRemarcacao(numeroWhatsApp, paciente) {
  const nomePaciente = paciente[0];
  const numeroFormatado = formatarNumeroWhatsApp(numeroWhatsApp);

  try {
    await atualizarStatusConsulta(numeroFormatado, "Remarcado");
    
    const indiceCache = encontrarIndicePaciente(numeroFormatado);
    if (indiceCache !== -1) {
      await atualizarCampoPlanilha(indiceCache + 2, 'L', 'NÃO (Solicitou Remarcação)');
      if (state.pacientesCache[indiceCache]) {
        state.pacientesCache[indiceCache][11] = 'NÃO (Solicitou Remarcação)';
      }
    }

    await client.sendMessage(numeroFormatado,
      `📅 *Para remarcar a consulta entre em contato com a UBS!*\n\n`
    );
    
    await notificarAdmin('Remarcação Solicitada por Paciente', paciente);
    return true;
  } catch (error) {
    logger.error(`Falha ao processar remarcação para ${nomePaciente}:`, error.message);
    await client.sendMessage(numeroFormatado, "Houve um problema. Tente novamente ou contate a clínica.");
    return false;
  }
}

async function processarSolicitacaoAtendente(numeroWhatsApp, paciente) {
  const nomePaciente = paciente[0];
  
  await client.sendMessage(numeroWhatsApp,
    `💬 *Solicitação Recebida!*\n\n` +
    `Olá, ${nomePaciente}. Sua solicitação para falar com um atendente foi registrada.\n\n` +
    `Em breve, nossa equipe entrará em contato pelo WhatsApp ou telefone cadastrado.\n\nAguarde nosso retorno. Obrigado! 🙏`
  );
  
  await notificarAdmin('Paciente Solicitou Atendente', paciente);
}

async function processarInformacoesPreparo(numeroWhatsApp, paciente) {
  const nomePaciente = paciente[0];
  
  await client.sendMessage(numeroWhatsApp,
    `📄 *Informações sobre o Preparo do Exame de Colonoscopia*\n\n` +
    `Olá, ${nomePaciente}! O preparo intestinal adequado é FUNDAMENTAL para o sucesso do seu exame.\n\n` +
    `**Principais Pontos:**\n` +
    `1. **Dieta Especial:** Iniciar alguns dias antes, conforme orientação médica.\n` +
    `2. **Líquidos Claros:** Na véspera e no dia do exame.\n` +
    `3. **Laxativos:** Utilizar a medicação prescrita nos horários corretos.\n` +
    `4. **Jejum:** Observar o período de jejum total antes do exame.\n` +
    `5. **Acompanhante:** É OBRIGATÓRIO vir com um acompanhante maior de 18 anos.\n\n` +
    `‼️ **IMPORTANTE:** Siga sempre as instruções DETALHADAS fornecidas pelo seu médico.\n\n` 
  );
}

async function processarFeedbackRecebido(numeroWhatsApp, paciente, textoFeedback) {
  const nomePaciente = paciente[0];
  const matchNota = textoFeedback.match(/^([1-5])(\s*-?\s*.*)?$/);
  let notaFormatada = textoFeedback;

  if (matchNota) {
    const notaNumerica = matchNota[1];
    const comentario = matchNota[2] ? matchNota[2].replace(/^[-\s]+/, '') : '';
    
    const avaliacoes = {
      '5': 'Excelente ✨', '4': 'Muito Bom 👍', '3': 'Bom / Razoável ✅', 
      '2': 'Ruim 👎', '1': 'Péssimo 😠'
    };
    
    notaFormatada = `Nota: ${notaNumerica}/5 (${avaliacoes[notaNumerica]})${comentario ? '. Comentário: ' + comentario : ''}`;
  }
  
  try {
    await registrarFeedback(numeroWhatsApp, notaFormatada);
    state.usuariosFeedback.delete(formatarNumeroWhatsApp(numeroWhatsApp));
    persistirEstado();

    await client.sendMessage(numeroWhatsApp,
      `🌟 *Obrigado pelo seu feedback, ${nomePaciente}!* 🌟\n\n` +
      `Sua avaliação foi registrada e é muito importante para nós!\n\n` +
      `Continuaremos trabalhando para melhorar nossos serviços. Desejamos muita saúde! 💙`
    );
    
    await notificarAdmin('Feedback Recebido de Paciente', [...paciente, notaFormatada]);

  } catch (error) {
    logger.error(`Falha ao registrar feedback de ${nomePaciente}:`, error.message);
    await client.sendMessage(numeroWhatsApp, "Obrigado pelo feedback! Houve um problema ao registrá-lo, mas nossa equipe foi informada.");
  }
}

async function notificarAdmin(acao, dadosPacienteArray) {
  try {
    const [nome, telefone, email, dataConsulta, horaConsulta, , statusAtual] = dadosPacienteArray;

    const mensagemAdmin =
      `🔔 *${acao}*\n\n` +
      `👤 Nome: ${nome || 'N/A'}\n` +
      `📱 Telefone: ${telefone || 'N/A'}\n` +
      (email ? `📧 Email: ${email}\n` : '') +
      `📅 Data: ${dataConsulta || 'N/A'}\n` +
      `🕒 Horário: ${horaConsulta || 'N/A'}\n` +
      `📊 Status: ${statusAtual || 'N/A'}`;

    await client.sendMessage(CONFIG.ADMIN_NUMBER, mensagemAdmin);
    return true;
  } catch (error) {
    logger.error(`Falha ao notificar admin sobre "${acao}":`, error.message);
    return false;
  }
}

// ===== PROCESSAMENTO PRINCIPAL DE MENSAGENS =====
async function processarMensagem(msg) {
  const numeroWhatsApp = msg.from;
  const textoRecebido = msg.body ? msg.body.trim() : "";

  if (msg.isGroupMsg || msg.isStatus || !textoRecebido) return;
  
  try {
    await verificarCacheAtualizado();
    const numeroFormatado = formatarNumeroWhatsApp(numeroWhatsApp);

    // 1. Prioridade: Resposta ao TCLE
    if (state.usuariosAguardandoTCLE.has(numeroFormatado)) {
      await processarRespostaTCLE(numeroWhatsApp, textoRecebido);
      return;
    }

    const paciente = await buscarPaciente(numeroWhatsApp);

    if (!paciente) {
      await enviarMensagemCadastro(numeroWhatsApp);
      return;
    }
    
    const nomePaciente = paciente[0];

    // 2. TCLE não aceito
    if (!temTCLEAceito(paciente)) {
      if (!state.usuariosAguardandoTCLE.has(numeroFormatado)) {
        state.usuariosAguardandoTCLE.set(numeroFormatado, { nome: nomePaciente, timestamp: Date.now() });
      }
      await processarRespostaTCLE(numeroWhatsApp, textoRecebido);
      return;
    }

    // 3. Aguardando feedback
    if (state.usuariosFeedback.has(numeroFormatado)) {
      await processarFeedbackRecebido(numeroWhatsApp, paciente, textoRecebido);
      return;
    }

    // 4. Processamento de opções do menu
    const statusConsulta = String(paciente[6] || '').trim();
    
    if (['Cancelado', 'Concluído', 'Remarcado'].includes(statusConsulta) && 
        !['4', 'ajuda', 'atendente'].includes(textoRecebido.toLowerCase())) {
      await enviarMensagemInicial(numeroWhatsApp, paciente);
      return;
    }

    switch (textoRecebido.toLowerCase()) {
      case '1':
        await processarConfirmacao(numeroWhatsApp, paciente);
        break;
      case '2':
        await processarRemarcacao(numeroWhatsApp, paciente);
        break;
      case '3':
        await processarInformacoesPreparo(numeroWhatsApp, paciente);
        break;
      case '4':
      case 'ajuda':
      case 'atendente':
        await processarSolicitacaoAtendente(numeroWhatsApp, paciente);
        break;
      default:
        await enviarMensagemInicial(numeroWhatsApp, paciente);
    }

  } catch (error) {
    logger.error(`Erro crítico no processamento da mensagem de ${numeroWhatsApp}:`, error.message);
    await recovery.tentarRecuperacao(error, 'MESSAGE_PROCESSING');
    
    try {
      await client.sendMessage(numeroWhatsApp,
        `⚠️ Ops! Ocorreu um erro inesperado.\n\nNossa equipe foi notificada. Tente novamente em alguns instantes.\n\nSe persistir, entre em contato diretamente com a clínica. 🙏`
      );
    } catch (sendError) {
      logger.error('Falha crítica: Não foi possível enviar mensagem de erro ao usuário.', sendError.message);
    }
  }
}

// ===== EVENTOS DO CLIENTE WHATSAPP =====
client.on('qr', (qr) => {
  logger.info('QR Code gerado. Escaneie para conectar o WhatsApp.');
  qrcodeTerminal.generate(qr, { small: true, width: 25 });
  
  QRCode.toFile('qr.png', qr, { scale: 6 })
    .then(() => logger.info('QR Code salvo como: qr.png'))
    .catch(err => logger.error('Erro ao salvar QR Code:', err.message));
});

client.on('authenticated', () => {
  logger.info('WhatsApp autenticado com sucesso!');
  recovery.statusSistema = 'AUTENTICADO';
});

client.on('auth_failure', async (msg) => {
  logger.error('Falha na autenticação do WhatsApp!', msg);
  recovery.statusSistema = 'FALHA_AUTENTICACAO';
  await recovery.notificarErroGrave(`Falha crítica na autenticação: ${msg}. Verifique o QR Code.`);
});

client.on('ready', async () => {
  logger.info(`Bot FMJ conectado! WhatsApp Web v${await client.getWWebVersion()}`);
  recovery.statusSistema = 'ATIVO';
  recovery.tentativasReconexao = 0;
  recovery.inicioUptime = Date.now();

  try {
    carregarEstado();

    const conexaoSheetsOk = await verificarConexaoGoogleSheets();
    if (!conexaoSheetsOk) {
      await recovery.notificarErroGrave('Conexão com Google Sheets falhou na inicialização.');
    }

    await verificarAlteracoesPlanilha();
    await verificarNotificacoes();

    // Intervalos
    setInterval(async () => {
      try {
        const sheetsOk = await verificarConexaoGoogleSheets();
        if (!sheetsOk) await recovery.recuperarGoogleSheets();
      } catch (error) {
        logger.error('Erro na verificação Google Sheets:', error.message);
      }
    }, 5 * 60 * 1000);

    setInterval(async () => {
      try { await verificarAlteracoesPlanilha(); } 
      catch (error) { /* silencioso */ }
    }, 60 * 1000);

    setInterval(async () => {
      try { await verificarNotificacoes(); } 
      catch (error) { logger.warning('Erro nas notificações:', error.message); }
    }, CONFIG.MODO_PRODUCAO ? 2 * 60 * 1000 : 60 * 1000);

    setInterval(() => {
      try { persistirEstado(); } 
      catch (error) { logger.error('Erro ao persistir estado:', error.message); }
    }, 5 * 60 * 1000);

    setInterval(async () => {
      try { await recovery.limpezaMemoria(); } 
      catch (error) { logger.error('Erro na limpeza de memória:', error.message); }
    }, CONFIG.BACKUP_INTERVAL);

    setInterval(async () => {
      try { await limparUsuariosAguardandoTCLEExpirados(); } 
      catch (error) { logger.error('Erro na limpeza TCLE:', error.message); }
    }, 4 * 60 * 60 * 1000);

    // Status para admin
    const status = recovery.getStatus();
    await client.sendMessage(CONFIG.ADMIN_NUMBER,
      `🚀 **Sistema FMJ Online!**\n\n` +
      `✅ WhatsApp Conectado\n` +
      `✅ Google Sheets: ${conexaoSheetsOk ? 'OK' : 'FALHA'}\n` +
      `✅ Sistema TCLE Ativo\n` +
      `✅ Recuperação Automática Ativa\n\n` +
      `Modo: ${CONFIG.MODO_PRODUCAO ? 'PRODUÇÃO' : 'DESENVOLVIMENTO'}\n` +
      `Uptime: ${status.uptimeHumano}\n` +
      `Memória: ${status.memoriaUsada.toFixed(2)} MB`
    );

  } catch (error) {
    logger.error('Falha durante evento READY:', error.message);
    await recovery.notificarErroGrave(`Erro na rotina READY: ${error.message}`);
  }
});

client.on('message', processarMensagem);

client.on('disconnected', async (reason) => {
  logger.warning(`WhatsApp desconectado: ${reason}`);
  recovery.statusSistema = 'DESCONECTADO';
  await recovery.tentarRecuperacao(new Error(String(reason)), 'WHATSAPP_DISCONNECTED');
});

client.on('change_state', state => {
  recovery.statusSistema = String(state).toUpperCase();
});

client.on('qr_timeout', () => {
  logger.warning('Timeout do QR Code. Ninguém escaneou a tempo.');
});

// ===== HANDLERS GLOBAIS DE ERRO =====
process.on('unhandledRejection', async (reason, promise) => {
  const errorMsg = (reason instanceof Error) ? reason.message : String(reason);
  logger.error('Rejeição não tratada:', errorMsg);
  await recovery.tentarRecuperacao(new Error(`Unhandled Rejection: ${errorMsg}`), 'UNHANDLED_REJECTION');
});

process.on('uncaughtException', async (error, origin) => {
  logger.error('Exceção não tratada:', { message: error.message, origin });
  await recovery.notificarErroGrave(`Exceção crítica: ${error.message}. Origem: ${origin}`);
  
  try {
    persistirEstado();
    logger.info('Estado salvo antes do shutdown.');
  } catch (saveError) {
    logger.error('Falha ao salvar estado durante shutdown:', saveError.message);
  }
  
  if (CONFIG.MODO_PRODUCAO) {
    setTimeout(() => process.exit(1), 10000);
  } else {
    process.exit(1);
  }
});

// ===== SHUTDOWN GRACIOSO =====
const shutdown = async (signal) => {
  logger.info(`Sinal ${signal} recebido. Iniciando shutdown gracioso...`);
  recovery.statusSistema = 'DESLIGANDO';

  try {
    persistirEstado();
    
    if (client && client.info && recovery.statusSistema !== 'FALHA_AUTENTICACAO') {
      const uptimeMs = Date.now() - recovery.inicioUptime;
      await client.sendMessage(CONFIG.ADMIN_NUMBER,
        `🔄 **Sistema FMJ Desligando...**\n\nSinal: ${signal}\nUptime: ${moment.duration(uptimeMs).humanize()}`
      );
    }

    if (client && client.destroy) {
      await client.destroy();
    }
    
    logger.info('Shutdown gracioso completo. Adeus!');
    process.exit(0);

  } catch (error) {
    logger.error('Erro durante shutdown:', error.message);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ===== ENDPOINT DE STATUS =====
if (process.env.ENABLE_STATUS_ENDPOINT === 'true') {
  const statusServer = http.createServer((req, res) => {
    if (req.url === '/status' && req.method === 'GET') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(recovery.getStatus(), null, 2));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Erro ao gerar status", details: e.message }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });
  
  const statusPort = process.env.STATUS_PORT || 3000;
  statusServer.listen(statusPort, () => {
    logger.info(`Endpoint de status HTTP disponível em http://localhost:${statusPort}/status`);
  });
}

// ===== FUNÇÕES AUXILIARES FINAIS =====
async function verificarAlteracoesPlanilha() {
  try {
    await atualizarCache();
    await processarNovosCadastros();
    return true;
  } catch (error) {
    return false;
  }
}

// ===== INICIALIZAÇÃO =====
logger.info('======================================================');
logger.info('🚀 INICIALIZANDO Sistema de Atendimento FMJ (WhatsApp) 🚀');
logger.info('======================================================');
logger.info(`Data/Hora: ${moment().format('DD/MM/YYYY HH:mm:ss Z')}`);
logger.info(`Modo: ${CONFIG.MODO_PRODUCAO ? 'PRODUÇÃO' : 'DESENVOLVIMENTO'}`);
logger.info(`Log Level: ${CONFIG.LOG_LEVEL}`);
logger.info(`Admin: ${CONFIG.ADMIN_NUMBER}`);
logger.info('------------------------------------------------------');

try {
  client.initialize();
} catch (error) {
  logger.error('Falha crítica na inicialização:', error.message);
  recovery.notificarErroGrave(`Falha crítica ao inicializar: ${error.message}`)
    .finally(() => process.exit(1));
}