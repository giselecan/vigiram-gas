/**
 * SCRIPT SÉNIOR: Exportação de Código para Markdown (.md)
 * Versão: Otimizada para Documentação, Backup Estruturado e Correção de URL
 */
function exportarProjetoCompletoParaMD() {
  try {
    const scriptId = ScriptApp.getScriptId();
    const token = ScriptApp.getOAuthToken();
    
    let nomeProjeto = "Projeto_Apps_Script";
    try {
      nomeProjeto = DriveApp.getFileById(scriptId).getName();
    } catch(e) {
      Logger.log("Aviso: Não foi possível capturar o nome do arquivo via DriveApp.");
    }
    
    // CORREÇÃO APLICADA: Uso do encodeURI para limpar qualquer espaço ou caractere invisível
    const url = encodeURI("https://script.googleapis.com/v1/projects/" + scriptId + "/content");
    
    const opcoes = {
      method: "GET", // CORREÇÃO APLICADA: Escrito em maiúsculas
      headers: {
        "Authorization": "Bearer " + token
      },
      muteHttpExceptions: true
    };
    
    const resposta = UrlFetchApp.fetch(url, opcoes);
    const respostaTexto = resposta.getContentText();
    const statusCode = resposta.getResponseCode();
    
    // 🔍 JANELA DE DIAGNÓSTICO NO CONSOLA
    Logger.log("============================ DEBUG API ============================");
    Logger.log("Código de Estado HTTP: " + statusCode);
    Logger.log("Resposta Real do Google: " + respostaTexto);
    Logger.log("===================================================================");
    
    const resultado = JSON.parse(respostaTexto);
    
    // Se o Google retornou um objeto de erro estruturado
    if (resultado.error) {
      throw new Error(`[API Error ${resultado.error.code}]: ${resultado.error.message}`);
    }
    
    if (!resultado.files || resultado.files.length === 0) {
      throw new Error("A API não devolveu nenhum arquivo de código.");
    }
    
    const dataAtual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm");
    
    // Iniciar a estrutura do documento Markdown
    let mdContext = '# RELATÓRIO DE CONSOLIDAÇÃO DE CÓDIGO FONTE\n\n';
    mdContext += '## 📋 Informações do Projeto\n';
    mdContext += '- **Sistema/Folha de Cálculo:** ' + nomeProjeto + '\n';
    mdContext += '- **ID do Projeto Script:** `' + scriptId + '`\n';
    mdContext += '- **Compilado em:** ' + dataAtual + '\n\n';
    mdContext += '---\n\n';
    
    const arquivosOrdenados = resultado.files.sort((a, b) => a.name.localeCompare(b.name));
    
    arquivosOrdenados.forEach((arquivo, index) => {
      let extensao = ".gs";
      let linguagemMarkdown = "javascript"; // Sintaxe recomendada para .gs no Markdown
      
      if (arquivo.type === "HTML") {
        extensao = ".html";
        linguagemMarkdown = "html";
      }
      if (arquivo.name === "appsscript") {
        extensao = ".json";
        linguagemMarkdown = "json";
      }
      
      const nomeCompletoArquivo = arquivo.name + extensao;
      
      mdContext += '## 📄 Arquivo [' + (index + 1) + '/' + arquivosOrdenados.length + ']: ' + nomeCompletoArquivo + '\n\n';
      
      let codigoTratado = arquivo.source ? arquivo.source : "// Arquivo sem conteúdo estruturado.";
      
      // Insere o código dentro de um bloco de código Markdown com realce de sintaxe
      mdContext += '```' + linguagemMarkdown + '\n' + codigoTratado + '\n```\n\n';
      
      if (index < arquivosOrdenados.length - 1) {
        mdContext += '---\n\n'; // Separador visual entre os arquivos
      }
    });
    
    const nomeMd = "BACKUP_CODIGO_" + nomeProjeto.toUpperCase().replace(/\s+/g, "_") + ".md";
    
    // Cria o Blob como text/markdown e guarda diretamente no Google Drive
    const mdBlob = Utilities.newBlob(mdContext, "text/markdown", nomeMd);
    DriveApp.createFile(mdBlob);
    
    Logger.log("=========================================");
    Logger.log("✅ EXPORTAÇÃO CONCLUÍDA COM SUCESSO!");
    Logger.log("=========================================");
    Logger.log("Nome do arquivo Markdown no Drive: " + nomeMd);
    
  } catch (erro) {
    Logger.log("=========================================");
    Logger.log("❌ FALHA NA EXPORTAÇÃO");
    Logger.log("=========================================");
    Logger.log("Detalhes do Erro: " + erro.toString());
  }
}
