/**
 * @fileoverview FrontendApi.gs — repasse de 1 linha para cada função que o
 * front-end (index.html, form.html, js_*.html) chama via google.script.run.
 *
 * google.script.run só consegue chamar funções definidas NESTE projeto (não
 * consegue chamar direto uma library), então toda a superfície de RPC usada
 * pelos HTMLs precisa de um espelho aqui — a lógica real está toda na
 * library Backend (github.com/giselecan/vigiram-backend).
 *
 * Lista derivada de forma mecânica: toda função pública (sem `_` no fim) dos
 * módulos migrados que aparece em algum *.html deste projeto.
 */

function _repassar_(nome, args) {
  return Backend[nome].apply(Backend, args);
}

// Auth.gs
function autenticarUsuario() { return _repassar_('autenticarUsuario', arguments); }
function validarSessao() { return _repassar_('validarSessao', arguments); }
function encerrarSessao() { return _repassar_('encerrarSessao', arguments); }

// Admin.gs (usuários/auditoria) e Config write.gs (gatilhos)
function listarUsuarios() { return _repassar_('listarUsuarios', arguments); }
function criarUsuario() { return _repassar_('criarUsuario', arguments); }
function editarUsuario() { return _repassar_('editarUsuario', arguments); }
function alterarStatusUsuario() { return _repassar_('alterarStatusUsuario', arguments); }
function trocarSenhaUsuario() { return _repassar_('trocarSenhaUsuario', arguments); }
function listarGatilhos() { return _repassar_('listarGatilhos', arguments); }
function salvarGatilho() { return _repassar_('salvarGatilho', arguments); }
function alternarStatusGatilho() { return _repassar_('alternarStatusGatilho', arguments); }
function excluirGatilho() { return _repassar_('excluirGatilho', arguments); }
function listarLogsAuditoria() { return _repassar_('listarLogsAuditoria', arguments); }

// Config.gs / Config write.gs
function getConfig() { return _repassar_('getConfig', arguments); }
function getSetoresPublico() { return _repassar_('getSetoresPublico', arguments); }
function invalidarConfig() { return _repassar_('invalidarConfig', arguments); }
function salvarConfigGeral() { return _repassar_('salvarConfigGeral', arguments); }
function salvarSetores() { return _repassar_('salvarSetores', arguments); }
function salvarListas() { return _repassar_('salvarListas', arguments); }
function diagnosticarSetoresDuplicados() { return _repassar_('diagnosticarSetoresDuplicados', arguments); }
function mesclarSetoresDuplicados() { return _repassar_('mesclarSetoresDuplicados', arguments); }

// Cases.gs — kanban, triagem, investigação
function getTodosOsCasos() { return _repassar_('getTodosOsCasos', arguments); }
function getCasoDetalhado() { return _repassar_('getCasoDetalhado', arguments); }
function registrarTriagem() { return _repassar_('registrarTriagem', arguments); }
function registrarInvestigacao() { return _repassar_('registrarInvestigacao', arguments); }
function reabrirInvestigacao() { return _repassar_('reabrirInvestigacao', arguments); }
function registrarImportacaoVigimed() { return _repassar_('registrarImportacaoVigimed', arguments); }
function salvarDemandaEspontanea() { return _repassar_('salvarDemandaEspontanea', arguments); }

// E2b.gs
function gerarXmlE2B() { return _repassar_('gerarXmlE2B', arguments); }

// Notify.gs
function enviarEmailTeste() { return _repassar_('enviarEmailTeste', arguments); }
