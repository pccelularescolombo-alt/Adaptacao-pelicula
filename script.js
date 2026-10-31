/* ============================================================
   CONFIGURAÇÃO DO FIREBASE
   ============================================================
   1. Crie um projeto grátis em https://console.firebase.google.com
   2. No projeto, ative o "Firestore Database" (modo produção).
   3. Em "Configurações do projeto" > "Seus apps" > ícone </> (Web),
      registre um app e copie o objeto de configuração que aparece
      (algo parecido com o objeto abaixo) — cole no lugar deste.
   4. Em Firestore Database > Regras, cole as regras sugeridas no
      arquivo REGRAS_FIRESTORE.txt (enviado junto com este site) e
      publique.
   Sem isso preenchido, o site funciona normalmente (busca, placas
   etc.) mas o like/deslike fica desativado.
   ============================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyCIhqKbJcGiVdI1VrGapRxDH3OcF-0E1CM",
  authDomain: "adaptacao-de-peliculas.firebaseapp.com",
  projectId: "adaptacao-de-peliculas",
  storageBucket: "adaptacao-de-peliculas.firebasestorage.app",
  messagingSenderId: "1015716132252",
  appId: "1:1015716132252:web:910a222124c2628f73c459"
};

let db;
try {
  if (firebaseConfig.apiKey !== "COLE_AQUI_SUA_API_KEY" && typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  } else {
    console.warn('Firebase ainda não configurado — sistema de avaliação (like/deslike) desativado. Veja as instruções no topo do script.js.');
  }
} catch (e) {
  console.error('Erro ao iniciar o Firebase:', e);
}

/* ============================================================
   CATÁLOGO DE MODELOS E ADAPTAÇÕES
   ============================================================
   Antigamente essa lista ficava toda escrita aqui, à mão. Agora
   ela é 100% carregada do Firestore (coleção "modelos") pela
   função carregarCatalogo(), lá embaixo — inclui tanto o catálogo
   original (migrado uma vez com a página migrar-dados.html) quanto
   tudo que for cadastrado depois pelo painel "Adicionar / editar
   modelo". Não precisa mais editar nada aqui manualmente.

   Fica vazio até a primeira resposta do banco (ou do cache local,
   se a pessoa já visitou o site antes — ver USAR_CACHE_LOCAL logo
   abaixo).
   ============================================================ */
const dados = [];


const themeToggle = document.getElementById('themeToggle');
const savedTheme = localStorage.getItem('theme') || 'light';
document.body.setAttribute('data-theme', savedTheme);

themeToggle.addEventListener('click', () => {
  const current = document.body.getAttribute('data-theme');
  const newTheme = current === 'light' ? 'dark' : 'light';
  document.body.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
});

function switchTab(tabName, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
  
  document.getElementById(tabName).classList.add('active');
  if (btn) {
    btn.classList.add('active');
  } else {
    event.currentTarget.classList.add('active');
  }
}

const normalizar = (txt) => txt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

// Pré-computa os campos normalizados de cada item UMA vez ao carregar a página,
// em vez de normalizar o array inteiro (marca + modelo + todas as adaptações)
// a cada tecla digitada. Isso é o que mais pesava na busca com muitos resultados.
// Virou uma função (em vez de rodar direto) porque agora ela também precisa
// ser chamada de novo sempre que um modelo é adicionado pelo painel de admin.
function indexarDados() {
  dados.forEach(d => {
    d._marcaNorm = normalizar(d.marca);
    d._modeloNorm = normalizar(d.modelo);
    d._adaptNorm = d.adaptacoes ? d.adaptacoes.map(normalizar) : [];
  });
}
indexarDados();

const resultadoEl = document.getElementById('resultado');
const buscaInput = document.getElementById('busca');
let debounceTimer = null;

/* ============================================================
   SISTEMA DE AVALIAÇÃO DAS ADAPTAÇÕES (like / deslike)
   ============================================================
   Cada loja pode avaliar se uma adaptação "dá certo" (👍) ou
   "dá errado" (👎). Os votos ficam salvos no Firebase (Firestore),
   compartilhados entre todas as lojas que acessarem o site.

   Regras de negócio (ajuste as constantes abaixo se quiser):
   - MIN_VOTOS_REMOCAO: quantos votos uma adaptação precisa
     acumular antes de poder ser escondida automaticamente.
   - LIMITE_REPROVACAO: % de deslike a partir do qual, já tendo
     o mínimo de votos, a adaptação some da lista (mas o
     histórico de votos continua salvo no banco).
   ============================================================ */
const MIN_VOTOS_REMOCAO = 3;
const LIMITE_REPROVACAO = 50; // em %

let avaliacoesCache = {}; // slug -> {likes, dislikes}
let avaliacoesCarregadas = false;

function slugAvaliacao(marca, modelo, adaptacao) {
  return normalizar(marca + modelo) + '__' + normalizar(adaptacao);
}

function votosDoSlug(slug) {
  return avaliacoesCache[slug] || { likes: 0, dislikes: 0 };
}

function statusAdaptacao(slug) {
  const { likes, dislikes } = votosDoSlug(slug);
  const total = likes + dislikes;
  if (total === 0) return { total: 0, pctAprovacao: null, reprovada: false };
  const pctAprovacao = Math.round((likes / total) * 100);
  const pctReprovacao = 100 - pctAprovacao;
  const reprovada = total >= MIN_VOTOS_REMOCAO && pctReprovacao >= LIMITE_REPROVACAO;
  return { total, pctAprovacao, reprovada };
}

async function carregarAvaliacoes() {
  if (typeof db === 'undefined') return; // Firebase não configurado ainda
  try {
    const snap = await db.collection('avaliacoes').get();
    const novoCache = {};
    snap.forEach(doc => { novoCache[doc.id] = doc.data(); });
    avaliacoesCache = novoCache;
  } catch (e) {
    console.warn('Não foi possível carregar as avaliações do Firebase:', e);
  } finally {
    avaliacoesCarregadas = true;
    renderResultados(buscaInput.value);
    atualizarPainelSeAberto();
  }
}

// Mapa slug -> texto legível (marca/modelo de origem + nome da adaptação),
// usado no painel de ranking. É recalculado a partir de "dados", já que o
// Firestore só guarda os números (likes/dislikes), não o texto. Também virou
// função pra poder ser refeito quando o painel de admin adiciona um modelo.
let slugParaTexto = {};
function construirSlugParaTexto() {
  slugParaTexto = {};
  dados.forEach(d => {
    if (!d.adaptacoes) return;
    d.adaptacoes.forEach(a => {
      if (a === 'Sem Adaptação') return;
      const slug = slugAvaliacao(d.marca, d.modelo, a);
      slugParaTexto[slug] = { origem: `${d.marca} ${d.modelo}`, adaptacao: a };
    });
  });
}
construirSlugParaTexto();

async function votar(slug, tipo, event) {
  if (event) event.stopPropagation();
  if (typeof db === 'undefined') {
    alert('O banco de dados ainda não foi configurado neste site (veja as instruções no início do script.js).');
    return;
  }
  const chaveLocal = 'voto_' + slug;
  const votoAtual = localStorage.getItem(chaveLocal); // 'like' | 'dislike' | null
  const ref = db.collection('avaliacoes').doc(slug);
  try {
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      const atual = doc.exists ? doc.data() : { likes: 0, dislikes: 0 };
      let likes = atual.likes || 0;
      let dislikes = atual.dislikes || 0;

      if (!votoAtual) {
        // Primeiro voto desta loja nesta adaptação.
        if (tipo === 'like') likes += 1; else dislikes += 1;
      } else if (votoAtual === tipo) {
        // Clicou de novo no mesmo botão -> reverte (remove) o voto.
        if (tipo === 'like') likes = Math.max(0, likes - 1);
        else dislikes = Math.max(0, dislikes - 1);
      } else {
        // Clicou no botão oposto -> troca o voto de um lado pro outro.
        if (tipo === 'like') { likes += 1; dislikes = Math.max(0, dislikes - 1); }
        else { dislikes += 1; likes = Math.max(0, likes - 1); }
      }
      t.set(ref, { likes, dislikes }, { merge: true });
    });

    if (!votoAtual || votoAtual !== tipo) {
      localStorage.setItem(chaveLocal, tipo);
    } else {
      localStorage.removeItem(chaveLocal); // voto revertido
    }

    const doc = await ref.get();
    avaliacoesCache[slug] = doc.data();
    renderResultados(buscaInput.value);
    atualizarPainelSeAberto();
  } catch (e) {
    console.error(e);
    alert('Não foi possível registrar o voto agora. Verifique a conexão com a internet.');
  }
}
window.votar = votar;

function renderTagsAdaptacoes(marca, modelo, adaptacoes) {
  if (!adaptacoes || adaptacoes[0] === "Sem Adaptação") {
    return '<span class="no-adapt">Sem adaptações compatíveis</span>';
  }

  const visiveis = adaptacoes.filter(a => {
    if (!avaliacoesCarregadas) return true; // antes de carregar, mostra tudo
    return !statusAdaptacao(slugAvaliacao(marca, modelo, a)).reprovada;
  });

  if (!visiveis.length) {
    return '<span class="no-adapt">As adaptações cadastradas foram reprovadas pelas lojas.</span>';
  }

  return visiveis.map(a => {
    const slug = slugAvaliacao(marca, modelo, a);
    const st = statusAdaptacao(slug);
    const votoAtual = localStorage.getItem('voto_' + slug);
    return `
      <span class="tag">
        <span class="tag-texto">${a}</span>
        ${st.total > 0 ? `<span class="tag-pct" title="${st.total} avaliação(ões) de lojas">${st.pctAprovacao}% 👍</span>` : ''}
        <span class="tag-votos">
          <button type="button" class="voto-btn voto-like${votoAtual === 'like' ? ' votado' : ''}"
                  onclick="votar('${slug}','like',event)" title="Clique para avaliar / clique de novo para desfazer">👍</button>
          <button type="button" class="voto-btn voto-dislike${votoAtual === 'dislike' ? ' votado' : ''}"
                  onclick="votar('${slug}','dislike',event)" title="Clique para avaliar / clique de novo para desfazer">👎</button>
        </span>
      </span>`;
  }).join('');
}

/* ============================================================
   LOGOS DAS MARCAS (automático)
   ============================================================
   Ao cadastrar uma marca, o sistema procura sozinho uma imagem com o
   nome dela nas pastas "logos" e "logo2". Testa variações do nome
   (minúsculo, sem acento, sem espaços, com hífen/underline, como foi
   digitado) e as extensões png, jpg, jpeg, webp e svg. Basta colocar o
   arquivo na pasta com o nome da marca (ex: "logos/vivo.png").
   O resultado (achou ou não) fica em cache pra não repetir tentativas. */
const PASTAS_LOGO_CARDS = ['logos', 'logo2'];   // ordem de busca nos cards da pesquisa
const PASTAS_LOGO_PLACA = ['logo2', 'logos'];   // ordem de busca nas placas (canvas)
const EXTENSOES_LOGO = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
const cacheLogos = {}; // "pasta1|pasta2|marca" -> Promise<string|null>

function variacoesNomeMarca(marca) {
  const original = String(marca).trim();
  const minus = original.toLowerCase();
  const semAcento = minus.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return [...new Set([
    minus,
    semAcento,
    semAcento.replace(/\s+/g, ''),
    semAcento.replace(/\s+/g, '-'),
    semAcento.replace(/\s+/g, '_'),
    semAcento.replace(/[^a-z0-9]/g, ''),
    original,
    original.replace(/\s+/g, '')
  ].filter(Boolean))];
}

function testarImagem(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

// Devolve a URL da primeira imagem que existir (ou null se nenhuma existir).
function descobrirLogoMarca(marca, pastas) {
  const chave = pastas.join('|') + '|' + marca;
  if (cacheLogos[chave]) return cacheLogos[chave];
  cacheLogos[chave] = (async () => {
    const nomes = variacoesNomeMarca(marca);
    for (const pasta of pastas) {
      for (const nome of nomes) {
        for (const ext of EXTENSOES_LOGO) {
          const url = `${pasta}/${encodeURIComponent(nome)}.${ext}`;
          if (await testarImagem(url)) return url;
        }
      }
    }
    return null;
  })();
  return cacheLogos[chave];
}

// Devolve um <img> já carregado da logo da marca, ou null se não achar.
async function carregarLogoMarca(marca, pastas) {
  const url = await descobrirLogoMarca(marca, pastas);
  if (!url) return null;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Preenche as logos dos cards da pesquisa depois que eles entram na tela.
function resolverLogosCards() {
  resultadoEl.querySelectorAll('img.brand-logo[data-marca]').forEach(async el => {
    const url = await descobrirLogoMarca(el.dataset.marca, PASTAS_LOGO_CARDS);
    if (url) el.src = url;
  });
}

function renderVazio(mensagemHtml) {
  resultadoEl.innerHTML = `<div class="vazio">${mensagemHtml}</div>`;
}

function renderResultados(busca) {
  if (!busca) {
    renderVazio(`<i class="fas fa-mobile-alt"></i><p>Digite o modelo ou fabricante para buscar compatibilidade de películas.</p>`);
    return;
  }

  const f = normalizar(busca);

  // Uma única varredura no array em vez de até 3 (marca, depois modelo, depois
  // adaptações), classificando por relevância para manter marca/modelo primeiro.
  let porMarca = [], porModelo = [], porAdaptacao = [];
  for (const d of dados) {
    if (d._marcaNorm.includes(f)) { porMarca.push(d); continue; }
    if (d._modeloNorm.includes(f)) { porModelo.push(d); continue; }
    if (d._adaptNorm.some(a => a.includes(f))) { porAdaptacao.push(d); }
  }
  let resultados = porMarca.length ? porMarca : (porModelo.length ? porModelo : porAdaptacao);

  if (!resultados.length) {
    renderVazio(`<i class="fas fa-search"></i><p>Nenhuma compatibilidade encontrada para "<strong>${busca}</strong>".</p>`);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = resultados.map((d, i) => `
    <div class="card" style="animation-delay:${Math.min(i, 12) * 0.04}s">
      <div class="card-header">
        <img class="brand-logo" data-marca="${escaparHtml(d.marca)}" alt="${escaparHtml(d.marca)}"
             src="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>📱</text></svg>">
        <div class="card-info">
          <div class="modelo">${d.modelo}</div>
          <div class="marca">${d.marca}</div>
        </div>
      </div>
      <div class="adaptacoes">
        <div class="adaptacoes-title">
          <i class="fas fa-exchange-alt"></i>
          Adaptação compatível
        </div>
        <div class="adaptacoes-list">
          ${renderTagsAdaptacoes(d.marca, d.modelo, d.adaptacoes)}
        </div>
      </div>
    </div>
  `).join('');
  resultadoEl.replaceChildren(...wrapper.childNodes);
  resolverLogosCards();
}

buscaInput.addEventListener('input', (e) => {
  const valor = e.target.value;
  clearTimeout(debounceTimer);
  // Pequeno atraso: evita refazer a busca e re-renderizar os cards a cada
  // tecla enquanto a pessoa ainda está digitando (isso é o que mais trava
  // a digitação quando há muitos resultados na tela).
  debounceTimer = setTimeout(() => renderResultados(valor), 150);
});

/* ============================================================
   PAINEL DE RANKING (mais like / mais deslike)
   ============================================================
   Lista todas as adaptações já avaliadas por alguma loja,
   ordenadas para destacar as mais reprovadas — pra você decidir
   quais tirar do catálogo manualmente (além das que já somem
   sozinhas ao passar do limite configurado em MIN_VOTOS_REMOCAO
   e LIMITE_REPROVACAO, lá em cima).
   ============================================================ */
const painelPagina = document.getElementById('painelPagina');
const painelBtn = document.getElementById('painelToggle');
const painelVoltarBtn = document.getElementById('painelVoltarBtn');
const painelLoginArea = document.getElementById('painelLoginArea');
const painelCorpoPagina = document.getElementById('painelCorpoPagina');
const painelCorpo = document.getElementById('painelCorpo');
const tabModelosBtn = document.getElementById('tabModelosBtn');
const tabRankingBtn = document.getElementById('tabRankingBtn');
const abaModelos = document.getElementById('abaModelos');
const abaRanking = document.getElementById('abaRanking');
let ordemPainelAtual = 'deslikes'; // 'deslikes' | 'likes'

function construirListaPainel() {
  const linhas = [];
  for (const slug in avaliacoesCache) {
    const info = slugParaTexto[slug];
    if (!info) continue; // slug de uma adaptação que não existe mais em "dados"
    const { likes, dislikes } = avaliacoesCache[slug];
    const total = (likes || 0) + (dislikes || 0);
    if (total === 0) continue;
    const st = statusAdaptacao(slug);
    linhas.push({
      origem: info.origem,
      adaptacao: info.adaptacao,
      likes: likes || 0,
      dislikes: dislikes || 0,
      total,
      pctAprovacao: st.pctAprovacao,
      reprovada: st.reprovada
    });
  }
  linhas.sort((a, b) => {
    if (ordemPainelAtual === 'deslikes') return b.dislikes - a.dislikes || b.total - a.total;
    return b.likes - a.likes || b.total - a.total;
  });
  return linhas;
}

function renderPainel() {
  if (!avaliacoesCarregadas) {
    painelCorpo.innerHTML = `<div class="vazio"><i class="fas fa-spinner fa-spin"></i><p>Carregando avaliações...</p></div>`;
    return;
  }
  const linhas = construirListaPainel();
  if (!linhas.length) {
    painelCorpo.innerHTML = `<div class="vazio"><i class="fas fa-chart-simple"></i><p>Nenhuma loja avaliou uma adaptação ainda.</p></div>`;
    return;
  }
  painelCorpo.innerHTML = `
    <table class="painel-tabela">
      <thead>
        <tr>
          <th>Modelo (origem)</th>
          <th>Adaptação avaliada</th>
          <th>👍</th>
          <th>👎</th>
          <th>% aprovação</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${linhas.map(l => `
          <tr class="${l.reprovada ? 'linha-reprovada' : ''}">
            <td>${l.origem}</td>
            <td>${l.adaptacao}</td>
            <td class="col-num">${l.likes}</td>
            <td class="col-num">${l.dislikes}</td>
            <td class="col-num">${l.pctAprovacao}%</td>
            <td>${l.reprovada
              ? '<span class="selo selo-removida">Removida do site</span>'
              : '<span class="selo selo-ativa">Ativa</span>'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function atualizarPainelSeAberto() {
  if (painelPagina && painelPagina.classList.contains('aberto') && abaRanking.classList.contains('active')) {
    renderPainel();
  }
}

/* ---------- Página em tela cheia: abrir/fechar e login embutido ---------- */

function abrirPainelPagina() {
  painelPagina.classList.add('aberto');
  document.body.style.overflow = 'hidden';
  if (estaLogado()) {
    mostrarConteudoPainel();
  } else {
    mostrarLoginPainel();
  }
}

function fecharPainelPagina() {
  painelPagina.classList.remove('aberto');
  document.body.style.overflow = '';
}

function mostrarLoginPainel() {
  painelLoginArea.style.display = 'flex';
  painelCorpoPagina.style.display = 'none';
  painelSairBtn.style.display = 'none';
  loginErro.style.display = 'none';
  loginUsuarioInput.value = '';
  loginSenhaInput.value = '';
  setTimeout(() => loginUsuarioInput.focus(), 50);
}

function mostrarConteudoPainel() {
  painelLoginArea.style.display = 'none';
  painelCorpoPagina.style.display = 'block';
  painelSairBtn.style.display = 'inline-flex';
  switchAbaPainel('modelos');
  renderListaModelosAdmin();
  renderPainel();
  if (!avaliacoesCarregadas) carregarAvaliacoes();
}

if (painelBtn) painelBtn.addEventListener('click', abrirPainelPagina);
if (painelVoltarBtn) painelVoltarBtn.addEventListener('click', fecharPainelPagina);

/* ---------- Abas: "Modelos cadastrados" e "Ranking de avaliações" ---------- */

function switchAbaPainel(aba) {
  const ehModelos = aba === 'modelos';
  abaModelos.classList.toggle('active', ehModelos);
  abaRanking.classList.toggle('active', !ehModelos);
  tabModelosBtn.classList.toggle('active', ehModelos);
  tabRankingBtn.classList.toggle('active', !ehModelos);
  if (!ehModelos) {
    renderPainel();
    if (!avaliacoesCarregadas) carregarAvaliacoes();
  }
}

if (tabModelosBtn) tabModelosBtn.addEventListener('click', () => switchAbaPainel('modelos'));
if (tabRankingBtn) tabRankingBtn.addEventListener('click', () => switchAbaPainel('ranking'));

document.querySelectorAll('.painel-ordenar button').forEach(btn => {
  btn.addEventListener('click', () => {
    ordemPainelAtual = btn.dataset.ordem;
    document.querySelectorAll('.painel-ordenar button').forEach(b => b.classList.toggle('ativo', b === btn));
    renderPainel();
  });
});

carregarAvaliacoes();

/* ============================================================
   ADMIN: adicionar / editar modelos e adaptações pelo site
   ============================================================
   Objetivo: acabar com a edição manual deste arquivo. Todo o
   catálogo (o que já existia + o que for cadastrado dali pra
   frente) mora na coleção "modelos" do Firestore. O painel
   "Adicionar / editar modelo", com usuário e senha, cadastra
   direto no banco — ninguém precisa mais editar o script.js.

   LIGAÇÃO AUTOMÁTICA (bidirecional): ao salvar um modelo novo
   com uma adaptação que já existe no sistema (ex: cadastrar o
   "iPhone 16e" com adaptação "iPhone 13"), o sistema também
   adiciona o "iPhone 16e" como adaptação do "iPhone 13"
   automaticamente. Assim as duas fichas ficam sincronizadas sem
   precisar cadastrar dos dois lados.

   SOBRE A SENHA (leia com atenção): como o site não tem um
   servidor próprio nem login de verdade (Firebase Authentication),
   essa senha serve só pra evitar que alguém mexa por engano — ela
   fica visível pra quem abrir o código do site (F12), então não é
   uma proteção contra alguém mal-intencionado. As regras do
   Firestore (REGRAS_FIRESTORE.txt) só validam o FORMATO dos dados
   enviados, não quem está enviando. Se um dia isso virar um
   problema (edições indevidas), o certo é migrar pra um login de
   verdade — posso implementar depois se precisar.
   ============================================================ */
const ADMIN_USUARIO = "admin";
const ADMIN_SENHA = "19021998"; // troque aqui pela senha que quiser usar

function normalizarSlugModelo(marca, modelo) {
  return normalizar(marca + modelo);
}

/* Edição das fichas no banco.
   O problema antigo: o salvamento usava arrayUnion, que só SOMA itens à lista.
   Por isso, remover ou trocar uma adaptação no formulário não tinha efeito no
   banco (e a ficha do outro modelo continuava apontando de volta). Agora cada
   ficha tem a lista de adaptações regravada por inteiro. */
const mesmoNome = (a, b) => normalizar(a) === normalizar(b);
const comNomes = (lista, nomes) => {
  const r = [...lista];
  nomes.forEach(n => { if (!r.some(x => mesmoNome(x, n))) r.push(n); });
  return r;
};
const semNomes = (lista, nomes) => lista.filter(x => !nomes.some(n => mesmoNome(x, n)));

// Lê a ficha no banco, aplica "alterar" na lista de adaptações reais e grava a
// lista completa. Lista vazia vira ["Sem Adaptação"]. Devolve a lista gravada.
function atualizarFicha(marca, modelo, alterar) {
  const ref = db.collection('modelos').doc(normalizarSlugModelo(marca, modelo));
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const atuais = snap.exists ? (snap.data().adaptacoes || []).filter(a => a !== 'Sem Adaptação') : [];
    const novas = alterar(atuais);
    const lista = novas.length ? novas : ['Sem Adaptação'];
    t.set(ref, { marca, modelo, adaptacoes: lista });
    return lista;
  });
}

// Troca (não soma) a lista de adaptações de uma ficha no array "dados" usado
// pela busca; cria a ficha se ainda não existir.
function definirAdaptacoesNoSistema(marca, modelo, adaptacoes) {
  const slug = normalizarSlugModelo(marca, modelo);
  const existente = dados.find(d => normalizarSlugModelo(d.marca, d.modelo) === slug);
  if (existente) existente.adaptacoes = adaptacoes;
  else dados.push({ marca, modelo, adaptacoes });
}

/* ------------------------------------------------------------
   Cache local (localStorage): guarda a última versão do catálogo
   que o navegador já baixou, pra pessoa que já visitou o site
   ver a busca funcionando IMEDIATAMENTE na próxima visita — sem
   esperar o Firestore responder de novo. O site sempre confere
   se tem algo mais novo no banco em seguida, em segundo plano.
   ------------------------------------------------------------ */
const CACHE_CATALOGO_CHAVE = 'catalogoCache_v1';

function salvarCacheCatalogo() {
  try {
    const limpo = dados.map(d => ({ marca: d.marca, modelo: d.modelo, adaptacoes: d.adaptacoes }));
    localStorage.setItem(CACHE_CATALOGO_CHAVE, JSON.stringify({ dados: limpo, ts: Date.now() }));
  } catch (e) {
    // localStorage cheio ou indisponível — sem problema, só não guarda cache.
  }
}

function carregarCacheCatalogo() {
  try {
    const bruto = localStorage.getItem(CACHE_CATALOGO_CHAVE);
    if (!bruto) return false;
    const { dados: cache } = JSON.parse(bruto);
    if (!Array.isArray(cache) || !cache.length) return false;
    cache.forEach(d => dados.push(d));
    return true;
  } catch (e) {
    return false;
  }
}

// Mostra/esconde o aviso de carregamento inicial da busca (só aparece na
// primeira visita, quando ainda não existe cache local no navegador).
function marcarCarregandoCatalogo(carregando) {
  if (carregando) {
    buscaInput.disabled = true;
    buscaInput.placeholder = 'Carregando modelos...';
    renderVazio('<i class="fas fa-spinner fa-spin"></i><p>Carregando o catálogo de modelos...</p>');
  } else {
    buscaInput.disabled = false;
    buscaInput.placeholder = 'Digite o modelo ou marca do celular...';
  }
}

async function carregarCatalogo() {
  const tinhaCache = carregarCacheCatalogo();
  if (tinhaCache) {
    indexarDados();
    construirSlugParaTexto();
    popularFabricantes();
    renderResultados(buscaInput.value);
  } else {
    marcarCarregandoCatalogo(true);
  }

  if (typeof db === 'undefined') {
    // Sem Firebase configurado: se não tinha cache, avisa e mantém a busca vazia.
    if (!tinhaCache) marcarCarregandoCatalogo(false);
    return;
  }

  try {
    const snap = await db.collection('modelos').get();
    dados.length = 0; // troca o conteúdo pelo que acabou de vir do banco, já atualizado
    snap.forEach(doc => dados.push(doc.data()));
  } catch (e) {
    console.warn('Não foi possível carregar o catálogo do Firebase:', e);
    if (!tinhaCache && !dados.length) {
      renderVazio('<i class="fas fa-triangle-exclamation"></i><p>Não foi possível carregar o catálogo agora. Verifique sua conexão e recarregue a página.</p>');
    }
  } finally {
    marcarCarregandoCatalogo(false);
    indexarDados();
    construirSlugParaTexto();
    popularFabricantes();
    renderResultados(buscaInput.value);
    atualizarPainelSeAberto();
    if (dados.length) salvarCacheCatalogo();
  }
}

/* ---------- Login (usuário e senha) ----------
   Agora o login protege a página inteira (ver abrirPainelPagina /
   mostrarLoginPainel / mostrarConteudoPainel, mais acima): a pessoa só
   enxerga as abas "Modelos cadastrados" e "Ranking de avaliações" depois
   de autenticar. O botão "Adicionar modelo" (dentro da aba 1) não precisa
   mais checar login separadamente, porque só existe depois de ele já ter
   acontecido. */
const loginUsuarioInput = document.getElementById('loginUsuario');
const loginSenhaInput = document.getElementById('loginSenha');
const loginErro = document.getElementById('loginErro');
const painelAdminBtn = document.getElementById('painelAdminBtn');
const painelSairBtn = document.getElementById('painelSairBtn');

// Fica logado até a pessoa clicar em "Sair" (ou limpar os dados do
// navegador) — não pede usuário/senha de novo a cada visita ao painel.
const CHAVE_ADMIN_LOGADO = 'pinheirinhoAdminLogado';
function estaLogado() {
  return localStorage.getItem(CHAVE_ADMIN_LOGADO) === '1';
}

if (painelAdminBtn) {
  painelAdminBtn.addEventListener('click', () => abrirAdmin());
}
if (painelSairBtn) {
  painelSairBtn.addEventListener('click', () => {
    localStorage.removeItem(CHAVE_ADMIN_LOGADO);
    mostrarLoginPainel();
  });
}

function tentarLogin() {
  if (loginUsuarioInput.value.trim() === ADMIN_USUARIO && loginSenhaInput.value === ADMIN_SENHA) {
    localStorage.setItem(CHAVE_ADMIN_LOGADO, '1');
    mostrarConteudoPainel();
  } else {
    loginErro.style.display = 'block';
  }
}
document.getElementById('loginEntrar').addEventListener('click', tentarLogin);
[loginUsuarioInput, loginSenhaInput].forEach(inp => {
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') tentarLogin(); });
});

/* ---------- Aba 1: lista dos modelos já cadastrados ---------- */
const listaModelosAdminEl = document.getElementById('listaModelosAdmin');
const buscaModelosAdminInput = document.getElementById('buscaModelosAdmin');

function renderListaModelosAdmin(filtro = '') {
  if (!listaModelosAdminEl) return;
  const f = normalizar(filtro);
  const itens = dados
    .filter(d => !f || d._marcaNorm.includes(f) || d._modeloNorm.includes(f))
    .slice()
    .sort((a, b) => (a.marca + a.modelo).localeCompare(b.marca + b.modelo, 'pt-BR'));

  if (!itens.length) {
    listaModelosAdminEl.innerHTML = `<div class="vazio"><i class="fas fa-mobile-screen-button"></i><p>${f ? 'Nenhum modelo encontrado.' : 'Nenhum modelo cadastrado ainda.'}</p></div>`;
    return;
  }

  listaModelosAdminEl.innerHTML = itens.map(d => `
    <button type="button" class="item-modelo-admin" data-slug="${normalizarSlugModelo(d.marca, d.modelo)}">
      <div class="item-modelo-admin-info">
        <span class="item-modelo-admin-modelo">${escaparHtml(d.modelo)}</span>
        <span class="item-modelo-admin-marca">${escaparHtml(d.marca)}</span>
      </div>
      <i class="fas fa-pen"></i>
    </button>
  `).join('');
}

if (listaModelosAdminEl) {
  listaModelosAdminEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.item-modelo-admin');
    if (!btn) return;
    const slug = btn.dataset.slug;
    const item = dados.find(d => normalizarSlugModelo(d.marca, d.modelo) === slug);
    if (item) abrirAdmin(item);
  });
}

if (buscaModelosAdminInput) {
  buscaModelosAdminInput.addEventListener('input', (e) => renderListaModelosAdmin(e.target.value));
}

/* ---------- Formulário de modelo / adaptação ----------
   Suporta cadastrar VÁRIOS modelos de uma vez para a mesma fabricante.
   Cada "grupo" (bloco) do formulário tem seu próprio campo de modelo e sua
   própria lista de adaptações; a fabricante é única e vale pra todos os
   grupos. Ao salvar, cada grupo vira um documento no Firestore (lista de
   adaptações regravada por inteiro) e as fichas ligadas são sincronizadas. */
const adminOverlay = document.getElementById('adminOverlay');
const adminGruposLista = document.getElementById('adminGruposLista');
const adminAddGrupoBtn = document.getElementById('adminAddGrupoBtn');
const adminMarcaSelect = document.getElementById('adminMarca');
const adminNovaMarcaInput = document.getElementById('adminNovaMarca');
const adminErro = document.getElementById('adminErro');
const adminSucesso = document.getElementById('adminSucesso');
const adminSalvarBtn = document.getElementById('adminSalvar');

// Cada item: { modelo: string, modeloExistente: objeto de "dados" ou null, chips: [{marca, modelo}] }
let adminGrupos = [];
// Guarda temporariamente os resultados de busca mostrados em cada grupo,
// pra saber a qual item corresponde quando a pessoa clica numa sugestão.
let adminAchadosModeloPorGrupo = {};
let adminAchadosAdaptPorGrupo = {};

function criarGrupoVazio() {
  return { modelo: '', modeloExistente: null, chips: [], semAdaptacao: false, criarNovasFichas: false };
}

function popularSelectMarcaAdmin() {
  adminMarcaSelect.innerHTML = '<option value="">Selecione a marca</option>';
  [...new Set(dados.map(d => d.marca))].sort().forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    adminMarcaSelect.appendChild(opt);
  });
  const optNova = document.createElement('option');
  optNova.value = '__nova__';
  optNova.textContent = '+ Nova marca';
  adminMarcaSelect.appendChild(optNova);
}

// Busca modelos já cadastrados (marca ou modelo) pra usar tanto na busca do
// "qual modelo estou cadastrando" quanto na busca de "quais adaptações ligar".
function buscarModelosSistema(termo, excluirSlug) {
  const f = normalizar(termo);
  if (!f) return [];
  return dados
    .filter(d => normalizarSlugModelo(d.marca, d.modelo) !== excluirSlug)
    .filter(d => (d._modeloNorm || normalizar(d.modelo)).includes(f) || (d._marcaNorm || normalizar(d.marca)).includes(f))
    .slice(0, 8);
}

function escaparHtml(txt) {
  const div = document.createElement('div');
  div.textContent = txt || '';
  return div.innerHTML;
}

/* ---------- Renderização ---------- */

// Re-renderiza a lista inteira de grupos (usado ao abrir o painel e ao
// adicionar/remover um grupo). Digitar dentro de um grupo NÃO passa por
// aqui, pra não perder o foco do campo — só atualiza a parte necessária.
function renderGruposAdmin() {
  adminGruposLista.innerHTML = adminGrupos.map((g, i) => `
    <div class="admin-grupo" data-i="${i}">
      <div class="admin-grupo-topo">
        <span class="admin-grupo-numero">Modelo ${i + 1}</span>
        ${adminGrupos.length > 1 ? `
          <button type="button" class="admin-grupo-remover" data-i="${i}" title="Remover este modelo">
            <i class="fas fa-trash"></i>
          </button>` : ''}
      </div>

      <div class="admin-form-group">
        <label class="admin-label">Modelo (digite pra buscar um já cadastrado ou criar um novo)</label>
        <input type="text" class="admin-input admin-modelo-input" data-i="${i}" autocomplete="off"
               placeholder="Ex: iPhone 16e" value="${escaparHtml(g.modelo)}">
        <div class="admin-sugestoes admin-modelo-sugestoes" data-i="${i}"></div>
      </div>

      <label class="admin-checkbox-label admin-sem-adapt-label">
        <input type="checkbox" class="admin-sem-adapt-check" data-i="${i}" ${g.semAdaptacao ? 'checked' : ''}>
        Sem Adaptação (este modelo não tem nenhuma adaptação compatível)
      </label>

      ${g.semAdaptacao ? '' : `
      <div class="admin-form-group">
        <label class="admin-label">Adaptações compatíveis (busque e adicione quantas quiser)</label>
        <input type="text" class="admin-input admin-adapt-input" data-i="${i}" autocomplete="off"
               placeholder="Digite o nome de outro modelo já cadastrado ou de um modelo novo...">
        <div class="admin-sugestoes admin-adapt-sugestoes" data-i="${i}"></div>
        <div class="admin-chips-lista admin-chips-lista-grupo" data-i="${i}"></div>

        <label class="admin-checkbox-label admin-criar-fichas-label">
          <input type="checkbox" class="admin-criar-fichas-check" data-i="${i}" ${g.criarNovasFichas ? 'checked' : ''}>
          Criar ficha própria (mesma fabricante) pra adaptações digitadas que ainda não existem no sistema, já ligando de volta pra este modelo
        </label>
      </div>`}
    </div>
  `).join('');

  adminGrupos.forEach((g, i) => { if (!g.semAdaptacao) renderChipsGrupo(i); });
}

function renderChipsGrupo(i) {
  const el = adminGruposLista.querySelector(`.admin-chips-lista-grupo[data-i="${i}"]`);
  if (!el) return;
  const g = adminGrupos[i];
  const chips = g.chips;
  if (!chips.length) {
    el.innerHTML = '<span class="admin-chip-vazio">Nenhuma adaptação adicionada ainda.</span>';
    return;
  }
  const marcaAtualForm = adminMarcaSelect.value === '__nova__' ? adminNovaMarcaInput.value.trim() : adminMarcaSelect.value;
  const marcasDisponiveis = [...new Set([marcaAtualForm, ...dados.map(d => d.marca)])].filter(Boolean).sort();
  el.innerHTML = chips.map((c, j) => {
    if (c.marca) {
      // Já é uma ficha existente no sistema — marca fixa, não dá pra trocar.
      return `
        <span class="admin-chip">
          ${escaparHtml(c.marca)} • ${escaparHtml(c.modelo)}
          <button type="button" data-i="${i}" data-j="${j}" class="admin-chip-remover" title="Remover">&times;</button>
        </span>`;
    }
    if (!g.criarNovasFichas) {
      // Texto livre e "criar ficha" desmarcado — só aparece como texto.
      return `
        <span class="admin-chip">
          ${escaparHtml(c.modelo)}
          <button type="button" data-i="${i}" data-j="${j}" class="admin-chip-remover" title="Remover">&times;</button>
        </span>`;
    }
    // Texto livre e "criar ficha" marcado — deixa escolher de qual
    // fabricante é essa adaptação nova (pode ser outra marca).
    return `
      <span class="admin-chip admin-chip-com-select">
        <select class="admin-chip-marca-select" data-i="${i}" data-j="${j}">
          ${marcasDisponiveis.map(f => `<option value="${escaparHtml(f)}" ${c.marcaNova === f ? 'selected' : ''}>${escaparHtml(f)}</option>`).join('')}
        </select>
        • ${escaparHtml(c.modelo)}
        <button type="button" data-i="${i}" data-j="${j}" class="admin-chip-remover" title="Remover">&times;</button>
      </span>`;
  }).join('');
}

function renderModeloSugestoesGrupo(i, achados) {
  const el = adminGruposLista.querySelector(`.admin-modelo-sugestoes[data-i="${i}"]`);
  if (!el) return;
  adminAchadosModeloPorGrupo[i] = achados;
  if (!achados.length) { el.innerHTML = ''; return; }
  el.innerHTML = achados.map((d, j) => `
    <button type="button" class="admin-sugestao-item admin-sugestao-modelo" data-i="${i}" data-j="${j}">${d.marca} • ${d.modelo}</button>
  `).join('');
}

function renderAdaptSugestoesGrupo(i, achados) {
  const el = adminGruposLista.querySelector(`.admin-adapt-sugestoes[data-i="${i}"]`);
  if (!el) return;
  adminAchadosAdaptPorGrupo[i] = achados;
  if (!achados.length) { el.innerHTML = ''; return; }
  el.innerHTML = achados.map((d, j) => `
    <button type="button" class="admin-sugestao-item admin-sugestao-adapt" data-i="${i}" data-j="${j}">${d.marca} • ${d.modelo}</button>
  `).join('');
}

function selecionarModeloExistenteGrupo(i, item) {
  const g = adminGrupos[i];
  g.modeloExistente = item;
  g.modelo = item.modelo;
  const jaSemAdaptacao = !!(item.adaptacoes && item.adaptacoes[0] === 'Sem Adaptação');
  g.semAdaptacao = jaSemAdaptacao;
  g.chips = (item.adaptacoes && !jaSemAdaptacao)
    ? item.adaptacoes.map(a => {
        const origem = dados.find(d => normalizar(d.modelo) === normalizar(a));
        return { marca: origem ? origem.marca : null, modelo: a };
      })
    : [];

  // A fabricante do formulário é ÚNICA pra todos os grupos (é o que o rótulo
  // "vale para todos os modelos abaixo" quer dizer). Se ela não bater com a
  // marca de verdade do modelo escolhido, o ID calculado na hora de salvar
  // fica diferente do documento original — e como não é possível apagar
  // documentos (regra do Firestore), isso cria uma ficha nova e deixa a
  // antiga esquecida no banco, parecendo "duplicado". Por isso, ao escolher
  // um modelo já existente, sincroniza a fabricante do formulário com a
  // marca real dele automaticamente.
  const marcaAtualForm = adminMarcaSelect.value === '__nova__' ? adminNovaMarcaInput.value.trim() : adminMarcaSelect.value;
  if (item.marca && item.marca !== marcaAtualForm) {
    const opcaoExiste = [...adminMarcaSelect.options].some(o => o.value === item.marca);
    if (opcaoExiste) {
      adminMarcaSelect.value = item.marca;
      adminNovaMarcaInput.style.display = 'none';
    }
  }

  // Precisa re-renderizar tudo (não só os chips) pra refletir a marcação
  // "Sem Adaptação" e mostrar/esconder o campo de adaptações corretamente.
  renderGruposAdmin();
}

/* ---------- Abrir / fechar ---------- */

function abrirAdmin(itemParaEditar) {
  adminNovaMarcaInput.value = '';
  adminNovaMarcaInput.style.display = 'none';
  adminGrupos = [criarGrupoVazio()];
  adminAchadosModeloPorGrupo = {};
  adminAchadosAdaptPorGrupo = {};
  adminErro.style.display = 'none';
  adminSucesso.style.display = 'none';
  popularSelectMarcaAdmin();
  adminMarcaSelect.value = itemParaEditar ? itemParaEditar.marca : '';
  renderGruposAdmin();
  adminOverlay.classList.add('aberto');
  // Veio de um clique na lista de modelos cadastrados (aba 1): pré-preenche
  // o formulário com o modelo e as adaptações que ele já tem.
  if (itemParaEditar) selecionarModeloExistenteGrupo(0, itemParaEditar);
  setTimeout(() => {
    const primeiro = adminGruposLista.querySelector('.admin-modelo-input');
    if (primeiro) primeiro.focus();
  }, 50);
}
function fecharAdmin() {
  adminOverlay.classList.remove('aberto');
  if (buscaModelosAdminInput) renderListaModelosAdmin(buscaModelosAdminInput.value);
}

document.getElementById('adminFechar').addEventListener('click', fecharAdmin);
document.getElementById('adminCancelar').addEventListener('click', fecharAdmin);
adminOverlay.addEventListener('click', (e) => { if (e.target === adminOverlay) fecharAdmin(); });

adminMarcaSelect.addEventListener('change', () => {
  adminNovaMarcaInput.style.display = adminMarcaSelect.value === '__nova__' ? 'block' : 'none';
});

/* ---------- Adicionar / remover grupos ---------- */

adminAddGrupoBtn.addEventListener('click', () => {
  adminGrupos.push(criarGrupoVazio());
  renderGruposAdmin();
  const inputs = adminGruposLista.querySelectorAll('.admin-modelo-input');
  const ultimo = inputs[inputs.length - 1];
  if (ultimo) ultimo.focus();
});

/* ---------- Eventos delegados (funcionam pra qualquer grupo, mesmo os
   adicionados depois) ---------- */

adminGruposLista.addEventListener('input', (e) => {
  const i = Number(e.target.dataset.i);
  if (Number.isNaN(i)) return;

  if (e.target.classList.contains('admin-modelo-input')) {
    adminGrupos[i].modelo = e.target.value;
    adminGrupos[i].modeloExistente = null;
    const achados = buscarModelosSistema(e.target.value, null);
    renderModeloSugestoesGrupo(i, achados);
  }

  if (e.target.classList.contains('admin-adapt-input')) {
    const g = adminGrupos[i];
    const slugAtual = g.modeloExistente ? normalizarSlugModelo(g.modeloExistente.marca, g.modeloExistente.modelo) : null;
    const achados = buscarModelosSistema(e.target.value, slugAtual);
    renderAdaptSugestoesGrupo(i, achados);
  }
});

adminGruposLista.addEventListener('change', (e) => {
  const i = Number(e.target.dataset.i);
  if (Number.isNaN(i)) return;

  if (e.target.classList.contains('admin-sem-adapt-check')) {
    adminGrupos[i].semAdaptacao = e.target.checked;
    if (e.target.checked) adminGrupos[i].chips = []; // marcado como "sem adaptação" não faz sentido ter chips
    renderGruposAdmin();
    return;
  }

  if (e.target.classList.contains('admin-criar-fichas-check')) {
    adminGrupos[i].criarNovasFichas = e.target.checked;
    // Precisa re-renderizar os chips pra mostrar/esconder os seletores de
    // fabricante das adaptações digitadas sem ficha própria ainda.
    renderChipsGrupo(i);
    return;
  }

  if (e.target.classList.contains('admin-chip-marca-select')) {
    const j = Number(e.target.dataset.j);
    if (Number.isNaN(j) || !adminGrupos[i].chips[j]) return;
    adminGrupos[i].chips[j].marcaNova = e.target.value;
  }
});

adminGruposLista.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList.contains('admin-adapt-input')) return;
  const i = Number(e.target.dataset.i);
  if (Number.isNaN(i) || !e.target.value.trim()) return;
  e.preventDefault();
  const texto = e.target.value.trim();
  const jaTem = adminGrupos[i].chips.some(c => normalizar(c.modelo) === normalizar(texto));
  if (!jaTem) {
    // Se o texto digitado bate (nome exato) com um modelo já cadastrado no
    // sistema, usa a mesma ficha (com a marca) em vez de texto livre — assim
    // a ligação recíproca é criada ao salvar, igual quando se clica na
    // sugestão da lista, mesmo que o usuário só tenha apertado Enter.
    const existente = dados.find(d => normalizar(d.modelo) === normalizar(texto));
    const marcaAtualForm = adminMarcaSelect.value === '__nova__' ? adminNovaMarcaInput.value.trim() : adminMarcaSelect.value;
    adminGrupos[i].chips.push(existente
      ? { marca: existente.marca, modelo: existente.modelo }
      : { marca: null, modelo: texto, marcaNova: marcaAtualForm }); // marcaNova = fabricante padrão sugerida, editável pelo seletor
  }
  e.target.value = '';
  renderAdaptSugestoesGrupo(i, []);
  renderChipsGrupo(i);
});

adminGruposLista.addEventListener('click', (e) => {
  const btnModelo = e.target.closest('.admin-sugestao-modelo');
  if (btnModelo) {
    const i = Number(btnModelo.dataset.i);
    const j = Number(btnModelo.dataset.j);
    const item = (adminAchadosModeloPorGrupo[i] || [])[j];
    if (item) selecionarModeloExistenteGrupo(i, item);
    return;
  }

  const btnAdapt = e.target.closest('.admin-sugestao-adapt');
  if (btnAdapt) {
    const i = Number(btnAdapt.dataset.i);
    const j = Number(btnAdapt.dataset.j);
    const d = (adminAchadosAdaptPorGrupo[i] || [])[j];
    if (d) {
      const jaTem = adminGrupos[i].chips.some(c => normalizar(c.modelo) === normalizar(d.modelo));
      if (!jaTem) adminGrupos[i].chips.push({ marca: d.marca, modelo: d.modelo });
      const input = adminGruposLista.querySelector(`.admin-adapt-input[data-i="${i}"]`);
      if (input) input.value = '';
      renderAdaptSugestoesGrupo(i, []);
      renderChipsGrupo(i);
    }
    return;
  }

  const btnRemoverChip = e.target.closest('.admin-chips-lista-grupo .admin-chip-remover');
  if (btnRemoverChip) {
    const i = Number(btnRemoverChip.dataset.i);
    const j = Number(btnRemoverChip.dataset.j);
    adminGrupos[i].chips.splice(j, 1);
    renderChipsGrupo(i);
    return;
  }

  const btnRemoverGrupo = e.target.closest('.admin-grupo-remover');
  if (btnRemoverGrupo) {
    const i = Number(btnRemoverGrupo.dataset.i);
    adminGrupos.splice(i, 1);
    renderGruposAdmin();
  }
});

/* ---------- Salvar (grava cada grupo como um modelo no Firestore) ---------- */

adminSalvarBtn.addEventListener('click', async () => {
  adminErro.style.display = 'none';
  adminSucesso.style.display = 'none';

  const marcaNome = adminMarcaSelect.value === '__nova__' ? adminNovaMarcaInput.value.trim() : adminMarcaSelect.value;

  if (!marcaNome) {
    adminErro.textContent = 'Escolha (ou digite) a fabricante.';
    adminErro.style.display = 'block';
    return;
  }

  // Lê o valor mais atual de cada campo de modelo direto do DOM (garantia
  // extra, embora já fiquem sincronizados a cada tecla digitada).
  adminGruposLista.querySelectorAll('.admin-modelo-input').forEach(input => {
    const i = Number(input.dataset.i);
    if (!Number.isNaN(i) && adminGrupos[i]) adminGrupos[i].modelo = input.value;
  });

  for (let i = 0; i < adminGrupos.length; i++) {
    if (!adminGrupos[i].modelo.trim()) {
      adminErro.textContent = `Preencha o nome do modelo ${i + 1}.`;
      adminErro.style.display = 'block';
      return;
    }
    if (!adminGrupos[i].semAdaptacao && !adminGrupos[i].chips.length) {
      adminErro.textContent = `Adicione ao menos uma adaptação no modelo ${i + 1}, ou marque a opção "Sem Adaptação".`;
      adminErro.style.display = 'block';
      return;
    }
  }
  if (typeof db === 'undefined') {
    adminErro.textContent = 'O banco de dados (Firebase) não está configurado neste site — veja as instruções no topo do script.js.';
    adminErro.style.display = 'block';
    return;
  }

  // Se algum grupo começou a partir de um modelo já existente e o nome (ou a
  // fabricante) foi alterado depois, o ID salvo no Firestore muda — e como
  // não é permitido apagar documentos, a ficha antiga fica esquecida no
  // banco (parece "duplicada"). Avisa antes de salvar pra dar chance de
  // corrigir.
  const renomeados = adminGrupos
    .filter(g => g.modeloExistente)
    .filter(g => normalizarSlugModelo(g.modeloExistente.marca, g.modeloExistente.modelo) !== normalizarSlugModelo(marcaNome, g.modelo.trim()));
  if (renomeados.length) {
    const lista = renomeados.map(g => `"${g.modeloExistente.marca} • ${g.modeloExistente.modelo}" → "${marcaNome} • ${g.modelo.trim()}"`).join('\n');
    const continuar = confirm(
      `Você mudou o nome ou a fabricante de um modelo que já existia:\n\n${lista}\n\n` +
      `Isso vai criar uma ficha NOVA com o nome atualizado, e a ficha antiga vai continuar no banco ` +
      `(o sistema não apaga fichas automaticamente). Quer continuar mesmo assim?`
    );
    if (!continuar) return;
  }

  adminSalvarBtn.disabled = true;
  adminSalvarBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';

  try {
    const nomesModelosSalvos = [];

    for (const g of adminGrupos) {
      const modeloNome = g.modelo.trim();
      // "Sem Adaptação" = lista vazia: nada é ligado, e tudo que estava ligado é desfeito.
      const chips = g.semAdaptacao ? [] : g.chips;
      const nomesAdaptacoes = chips.map(c => c.modelo);

      // Adaptações que a ficha tinha ANTES de editar (lidas do estado atual de
      // "dados", ainda sem a alteração) e que foram retiradas agora.
      const fichaAtual = dados.find(d => normalizarSlugModelo(d.marca, d.modelo) === normalizarSlugModelo(marcaNome, modeloNome));
      const removidas = (fichaAtual ? fichaAtual.adaptacoes : [])
        .filter(a => a !== 'Sem Adaptação' && !nomesAdaptacoes.some(n => mesmoNome(n, a)));

      // 1) Ficha principal: grava exatamente a lista que está no formulário.
      const listaPrincipal = await atualizarFicha(marcaNome, modeloNome, () => nomesAdaptacoes);
      definirAdaptacoesNoSistema(marcaNome, modeloNome, listaPrincipal);

      // 2) Ligação recíproca EM MALHA: se A tem as adaptações B e C, então B
      // ganha A e C, e C ganha A e B. Se "c.marca" não veio de uma ficha
      // existente (texto digitado livre), só criamos a ficha nova quando o
      // admin marcou "criar ficha própria" — com a fabricante escolhida no chip.
      for (const c of chips) {
        const marcaLigacao = c.marca || (g.criarNovasFichas ? (c.marcaNova || marcaNome) : null);
        if (!marcaLigacao) continue;
        const ligacoes = [modeloNome, ...nomesAdaptacoes.filter(n => n !== c.modelo)];
        const lista = await atualizarFicha(marcaLigacao, c.modelo, atuais => comNomes(atuais, ligacoes));
        definirAdaptacoesNoSistema(marcaLigacao, c.modelo, lista);
      }

      // 3) Adaptação removida: a ficha do outro modelo deixa de apontar de volta.
      for (const nome of removidas) {
        const fichasLigadas = dados.filter(d => mesmoNome(d.modelo, nome) && (d.adaptacoes || []).some(a => mesmoNome(a, modeloNome)));
        for (const d of fichasLigadas) {
          const lista = await atualizarFicha(d.marca, d.modelo, atuais => semNomes(atuais, [modeloNome]));
          definirAdaptacoesNoSistema(d.marca, d.modelo, lista);
        }
      }

      nomesModelosSalvos.push(modeloNome);
    }

    salvarCacheCatalogo(); // sem isso, a próxima visita mostraria o catálogo antigo por um instante
    indexarDados();
    construirSlugParaTexto();
    popularFabricantes();
    if (buscaModelosAdminInput) renderListaModelosAdmin(buscaModelosAdminInput.value);

    adminSucesso.innerHTML = `<i class="fas fa-circle-check"></i> ${nomesModelosSalvos.length > 1 ? `${nomesModelosSalvos.length} modelos salvos` : 'Modelo salvo'}! Já aparece${nomesModelosSalvos.length > 1 ? 'm' : ''} na pesquisa.`;
    adminSucesso.style.display = 'flex';
    buscaInput.value = nomesModelosSalvos[0];
    renderResultados(nomesModelosSalvos[0]);
    atualizarPainelSeAberto();
    setTimeout(fecharAdmin, 1400);
  } catch (e) {
    console.error(e);
    adminErro.textContent = 'Não foi possível salvar agora. Verifique a conexão com a internet e tente de novo.';
    adminErro.style.display = 'block';
  } finally {
    adminSalvarBtn.disabled = false;
    adminSalvarBtn.innerHTML = '<i class="fas fa-floppy-disk"></i> Salvar';
  }
});

const fabSelect = document.getElementById('fabricante');
const fabSelectCapa = document.getElementById('fabricanteCapa');

// Função (em vez de bloco fixo) pra poder repopular os selects quando o
// painel de admin cadastra uma marca nova, sem precisar recarregar a página.
function popularFabricantes() {
  const fabricantes = [...new Set(dados.map(d => d.marca))].sort();
  const valorAtual = fabSelect.value;
  const valorAtualCapa = fabSelectCapa.value;

  fabSelect.innerHTML = '<option value="">Fabricante</option>';
  fabSelectCapa.innerHTML = '<option value="">Fabricante</option>';

  fabricantes.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    fabSelect.appendChild(opt);

    const optCapa = document.createElement('option');
    optCapa.value = f;
    optCapa.textContent = f;
    fabSelectCapa.appendChild(optCapa);
  });

  if (fabricantes.includes(valorAtual)) fabSelect.value = valorAtual;
  if (fabricantes.includes(valorAtualCapa)) fabSelectCapa.value = valorAtualCapa;
}

carregarCatalogo();

const cores = {
  samsung: { fundo:"#1428a0", texto:"#ffffff" },
  motorola: { fundo:"#001526", texto:"#ffffff" },
  xiaomi: { fundo:"#ff6a08", texto:"#000000" },
  apple: { fundo:"#dcdcdc", texto:"#000000" },
  asus: { fundo:"#000000", texto:"#ffffff" },
  infinix: { fundo:"#8ec142", texto:"#000000" },
  itel: { fundo:"#fd0137", texto:"#ffffff" },
  lg: { fundo:"#a50034", texto:"#ffffff" },
  nokia: { fundo:"#1c4598", texto:"#ffffff" },
  oppo: { fundo:"#006b33", texto:"#ffffff" },
  oscal: { fundo:"#9c40dd", texto:"#ffffff" },
  realme: { fundo:"#ffc913", texto:"#000000" },
  tecno: { fundo:"#0064fe", texto:"#ffffff" },
  jovi: { fundo:"#1c4598", texto:"#ffffff" },
  Honor: { fundo:"#9c40dd", texto:"#ffffff" },
};

popularFabricantes();

fabSelect.addEventListener('change', () => {
  const modeloSelect = document.getElementById('modelo');
  modeloSelect.innerHTML = '<option value="">Modelo</option>';
  modeloSelect.disabled = !fabSelect.value;
  
  if (fabSelect.value) {
    const modelos = dados.filter(d => d.marca === fabSelect.value).map(d => d.modelo);
    modelos.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      modeloSelect.appendChild(opt);
    });
  }
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function gerarImagemPelicula() {
  const fabricante = document.getElementById('fabricante').value;
  const modelo = document.getElementById('modelo').value;
  
  if (!fabricante || !modelo) {
    alert("Selecione a fabricante e o modelo!");
    return;
  }

  const achado = dados.find(d => d.marca === fabricante && d.modelo === modelo);
  if (!achado) {
    alert("Modelo não encontrado!");
    return;
  }

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext("2d");
  const est = cores[achado.marca.toLowerCase()] || { fundo:"#fff", texto:"#000" };

  ctx.clearRect(0, 0, 591, 591);
  ctx.fillStyle = est.fundo;
  ctx.fillRect(0, 0, 591, 591);

  const b = 12;
  ctx.fillStyle = "#0051ff";
  ctx.fillRect(0, 0, 591, b);
  ctx.fillRect(0, 0, b, 591);
  ctx.fillStyle = "#ff7a00";
  ctx.fillRect(0, 591 - b, 591, b);
  ctx.fillRect(591 - b, 0, b, 591);

  ctx.textAlign = "center";
  ctx.fillStyle = est.texto;
  ctx.textBaseline = "alphabetic";

  let y = b + 20;

  const boxW = 300, boxH = 110;
  const boxX = (591 - boxW) / 2;
  const boxY = y;

  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#fff";
  roundRect(ctx, boxX, boxY, boxW, boxH, 14);
  ctx.fill();
  ctx.shadowColor = "transparent";

  carregarLogoMarca(achado.marca, PASTAS_LOGO_PLACA).then(logo => {
    if (!logo) {
      // Sem imagem nas pastas: escreve o nome da marca no quadro branco.
      ctx.fillStyle = "#000000";
      ctx.textAlign = "center";
      ctx.font = "bold 40px Arial";
      ctx.fillText(achado.marca.toUpperCase(), 591 / 2, boxY + boxH / 2 + 14);
      return;
    }
    let imgW = boxW - 40;
    let imgH = logo.height * (imgW / logo.width);
    if (imgH > boxH - 20) {
      imgH = boxH - 20;
      imgW = logo.width * (imgH / logo.height);
    }
    ctx.drawImage(logo, boxX + (boxW - imgW) / 2, boxY + (boxH - imgH) / 2, imgW, imgH);
  });

  y = boxY + boxH + 50;

  let tamanho = 65;
  do {
    ctx.font = `bold ${tamanho}px Arial`;
    tamanho--;
  } while (ctx.measureText(achado.modelo).width > 591 - 60);

  ctx.fillStyle = est.texto;
  ctx.fillText(achado.modelo, 591 / 2, y);

  y += 60;

  ctx.font = "bold 30px Arial";
  ctx.fillText("Adaptações:", 591 / 2, y);

  y += 25;

  const areaAltura = 591 - y - b - 10;
  const areaLargura = 591 - 50;
  const numAdaptacoes = achado.adaptacoes.length;
  
  let colunas;
  if (numAdaptacoes <= 5) colunas = 1;
  else if (numAdaptacoes <= 10) colunas = 2;
  else if (numAdaptacoes <= 18) colunas = 3;
  else colunas = 4;
  
  const linhasPorCol = Math.ceil(numAdaptacoes / colunas);
  const gap = 17;
  const larguraCol = (areaLargura - (gap * (colunas - 1))) / colunas;
  
  let fonte = 35;
  let espacamento = fonte * 0.45;
  
  while ((linhasPorCol * (fonte + espacamento)) > areaAltura && fonte > 15) {
    fonte -= 1;
    espacamento = fonte * 0.45;
  }
  
  ctx.font = `bold ${fonte}px Arial`;
  let textoMuitoLongo = true;
  
  while (textoMuitoLongo && fonte > 15) {
    textoMuitoLongo = false;
    ctx.font = `bold ${fonte}px Arial`;
    
    achado.adaptacoes.forEach(t => {
      if (ctx.measureText(t).width > larguraCol - 8) textoMuitoLongo = true;
    });
    
    if (textoMuitoLongo) {
      fonte -= 1;
      espacamento = fonte * 0.45;
    }
  }
  
  ctx.font = `bold ${fonte}px Arial`;
  const inicioX = (591 - ((larguraCol * colunas) + (gap * (colunas - 1)))) / 2;
  const alturaTotal = linhasPorCol * (fonte + espacamento) - espacamento;
  const yInicio = y + (areaAltura - alturaTotal) / 2;
  
  achado.adaptacoes.forEach((t, i) => {
    const col = Math.floor(i / linhasPorCol);
    const lin = i % linhasPorCol;
    const x = inicioX + col * (larguraCol + gap) + larguraCol / 2;
    const yy = yInicio + lin * (fonte + espacamento);
    ctx.fillText(t, x, yy);
  });
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function addDpiToPng(base64Data, dpi) {
  const base64 = base64Data.split(',')[1];
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const ppm = Math.round(dpi / 0.0254);
  const ppmBytes = new Uint8Array([
    (ppm >> 24) & 0xFF,
    (ppm >> 16) & 0xFF,
    (ppm >> 8) & 0xFF,
    ppm & 0xFF
  ]);

  const physData = new Uint8Array(9);
  physData.set(ppmBytes, 0);
  physData.set(ppmBytes, 4);
  physData[8] = 1;

  const crcData = new Uint8Array(4 + 9);
  crcData[0] = 0x70; crcData[1] = 0x48; crcData[2] = 0x59; crcData[3] = 0x73;
  crcData.set(physData, 4);
  const crc = crc32(crcData);

  const crcBytes = new Uint8Array([
    (crc >> 24) & 0xFF,
    (crc >> 16) & 0xFF,
    (crc >> 8) & 0xFF,
    crc & 0xFF
  ]);

  const physChunk = new Uint8Array(4 + 4 + 9 + 4);
  physChunk[0] = 0; physChunk[1] = 0; physChunk[2] = 0; physChunk[3] = 9;
  physChunk[4] = 0x70; physChunk[5] = 0x48; physChunk[6] = 0x59; physChunk[7] = 0x73;
  physChunk.set(physData, 8);
  physChunk.set(crcBytes, 17);

  const newBytes = new Uint8Array(bytes.length + physChunk.length);
  newBytes.set(bytes.subarray(0, 33), 0);
  newBytes.set(physChunk, 33);
  newBytes.set(bytes.subarray(33), 33 + physChunk.length);

  let binary = '';
  for (let i = 0; i < newBytes.length; i++) {
    binary += String.fromCharCode(newBytes[i]);
  }
  return 'data:image/png;base64,' + btoa(binary);
}

function baixarImagemPelicula() {
  const fabricante = document.getElementById('fabricante').value;
  const modelo = document.getElementById('modelo').value;
  
  if (!fabricante || !modelo) {
    alert("Gere a imagem primeiro!");
    return;
  }

  const canvas = document.getElementById('canvas');
  const a = document.createElement("a");
  a.download = `${fabricante} ${modelo}.png`;
  a.href = addDpiToPng(canvas.toDataURL("image/png"), 300);
  a.click();
}

function gerarImagemCapa() {
  const fabricante = document.getElementById('fabricanteCapa').value;
  const linha1 = document.getElementById('linha1Capa').value.trim();
  const linha2 = document.getElementById('linha2Capa').value.trim();
  const linha3 = document.getElementById('linha3Capa').value.trim();
  
  if (!fabricante || (!linha1 && !linha2 && !linha3)) {
    alert("Selecione a fabricante e preencha pelo menos uma linha do modelo!");
    return;
  }

  const canvas = document.getElementById('canvasCapa');
  const ctx = canvas.getContext("2d");
  const est = cores[fabricante.toLowerCase()] || { fundo:"#0047AB", texto:"#000000" };

  // 1. Fundo totalmente branco
  ctx.clearRect(0, 0, 591, 591);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 591, 591);

  // 2. Borda com a cor da fabricante selecionada
  const b = 15;
  ctx.fillStyle = est.fundo;
  ctx.fillRect(0, 0, 591, b);
  ctx.fillRect(0, 0, b, 591);
  ctx.fillRect(0, 591 - b, 591, b);
  ctx.fillRect(591 - b, 0, b, 591);

  // 3. Círculo preto de 5x5 mm (marca de corte/furo)
  const mmToPx = 591 / 50;
  const raioCirculo = 2.5 * mmToPx; 
  const centroX = 25 * mmToPx;      
  const centroY = 10 * mmToPx;      

  ctx.beginPath();
  ctx.arc(centroX, centroY, raioCirculo, 0, 2 * Math.PI);
  ctx.fillStyle = "#000000";
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // 4. Box para a logo da fabricante (posicionado abaixo do círculo)
  const boxW = 320;
  const boxH = 120;
  const boxX = (591 - boxW) / 2;
  const boxY = 180; 



  // 5. Carregar e desenhar a logo
  const linhasTexto = [linha1, linha2, linha3].filter(l => l !== "");

  carregarLogoMarca(fabricante, PASTAS_LOGO_PLACA).then(logo => {
    if (!logo) {
      // Fallback caso nenhuma imagem exista nas pastas
      ctx.fillStyle = est.fundo;
      ctx.font = "bold 42px Arial";
      ctx.fillText(fabricante.toUpperCase(), 591 / 2, boxY + boxH / 2 + 15);
      desenharTextoModeloCapa(ctx, linhasTexto, b, boxY + boxH);
      return;
    }
    let imgW = boxW - 40;
    let imgH = imgW / (logo.width / logo.height);
    if (imgH > boxH - 20) {
      imgH = boxH - 20;
      imgW = imgH * (logo.width / logo.height);
    }
    ctx.drawImage(logo, boxX + (boxW - imgW) / 2, boxY + (boxH - imgH) / 2, imgW, imgH);
    desenharTextoModeloCapa(ctx, linhasTexto, b, boxY + boxH);
  });
}

function desenharTextoModeloCapa(ctx, linhasTexto, b, startY) {
  let y = startY + 40;
  ctx.fillStyle = "#000000"; 
  ctx.textAlign = "center";
  
  const maxWidth = 591 - 80; // Margem de 40px de cada lado
  let tamanhoFonte = 60;
  
  // Filtrar linhas vazias
  const linhas = linhasTexto.filter(l => l.length > 0);
  
  // Ajustar fonte para caber na largura máxima
  while (tamanhoFonte >= 30) {
    let cabe = true;
    ctx.font = `bold ${tamanhoFonte}px Arial`;
    for (let i = 0; i < linhas.length; i++) {
      if (ctx.measureText(linhas[i]).width > maxWidth) {
        cabe = false;
        break;
      }
    }
    if (cabe) break;
    tamanhoFonte -= 2;
  }
  
  const alturaLinha = tamanhoFonte * 1.3;
  const alturaTotalTexto = linhas.length * alturaLinha;
  const espacoRestante = 591 - b - y;
  
  // Centralizar o bloco de texto no espaço restante abaixo da logo
  const yInicio = y + (espacoRestante - alturaTotalTexto) / 2 + alturaLinha;
  
  linhas.forEach((linha, i) => {
    ctx.fillText(linha, 591 / 2, yInicio + i * alturaLinha);
  });
}

function baixarImagemCapa() {
  const fabricante = document.getElementById('fabricanteCapa').value;
  const linha1 = document.getElementById('linha1Capa').value.trim();
  const linha2 = document.getElementById('linha2Capa').value.trim();
  const linha3 = document.getElementById('linha3Capa').value.trim();
  
  if (!fabricante || (!linha1 && !linha2 && !linha3)) {
    alert("Gere a imagem primeiro!");
    return;
  }

  const canvas = document.getElementById('canvasCapa');
  const partesModelo = [linha1, linha2, linha3].filter(p => p !== "").join(" ");
  const a = document.createElement("a");
  a.download = `${fabricante} ${partesModelo}.png`;
  a.href = addDpiToPng(canvas.toDataURL("image/png"), 300);
  a.click();
}

renderResultados('');
