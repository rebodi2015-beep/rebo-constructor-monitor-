/**
 * Constructor.io — Monitor de Marcajes DOM
 * Banderas: Paris, Easy, Jumbo, Santaisabel
 *
 * Qué hace:
 *  1. Abre cada bandera con Playwright (headless Chromium)
 *  2. Visita Home / Búsqueda / PLP (categoría) / PDP (producto)
 *  3. Chequea presencia de window vars y atributos data-cnstrc-*
 *  4. Acumula el resultado en data/history.json (no pisa lo anterior)
 *  5. Regenera index.html con el historial completo (tabs por bandera)
 *
 * URLs de PLP/PDP ya completadas (jun-2026). Si el catálogo cambia y algún
 * producto/categoría deja de existir, esos tags van a marcar N/V — revisar
 * y actualizar la URL correspondiente en SITES[].
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const OUTPUT_HTML = path.join(__dirname, 'index.html');
const MAX_HISTORY_PER_SITE = 30; // días a conservar

// ─────────────────────────────────────────
// SITIOS — completar plpUrl / pdpUrl reales
// ─────────────────────────────────────────
const SITES = [
  {
    key: 'paris',
    name: 'Paris.cl',
    homeUrl: 'https://www.paris.cl',
    searchUrl: 'https://www.paris.cl/search?q=televisor',
    plpUrl: 'https://www.paris.cl/electro/television/televisores-led/',
    pdpUrl: 'https://www.paris.cl/qled-smart-tv-55-4k-vision-ai-q7fa-2025-128009999.html',
  },
  {
    key: 'easy',
    name: 'Easy.cl',
    homeUrl: 'https://www.easy.cl',
    searchUrl: 'https://www.easy.cl/busqueda?ft=silla',
    plpUrl: 'https://www.easy.cl/muebles/muebles-de-oficina/sillas-de-escritorio',
    pdpUrl: 'https://www.easy.cl/silla-de-escritorio-rio-negro-contatto-1322002/p',
  },
  {
    key: 'jumbo',
    name: 'Jumbo.cl',
    homeUrl: 'https://www.jumbo.cl',
    searchUrl: 'https://www.jumbo.cl/busqueda?ft=leche',
    plpUrl: 'https://www.jumbo.cl/lacteos-y-quesos/leches/leche-liquida',
    pdpUrl: 'https://www.jumbo.cl/leche-soprole-natural-1-litro/p',
  },
  {
    key: 'santaisabel',
    name: 'Santaisabel.cl',
    homeUrl: 'https://www.santaisabel.cl',
    searchUrl: 'https://www.santaisabel.cl/busqueda?ft=pan',
    plpUrl: 'https://www.santaisabel.cl/panaderia-y-pasteleria/panaderia-envasada/pan-de-molde',
    pdpUrl: 'https://www.santaisabel.cl/pan-molde-ideal-blanco-380-g-2011235/p',
  },
];

// ─────────────────────────────────────────
// DEFINICIÓN DE TAGS A CHEQUEAR
// type: 'window' (evalúa expresión JS) | 'selector' (busca elemento en DOM)
// page: 'home' | 'search' | 'plp' | 'pdp'
// notVerifiable: true → no se puede confirmar de forma confiable vía scraping pasivo
// notApplicable: true → depende de campaña activa, no siempre debe estar presente
// requiresCheckout: true → requiere completar una compra real, se excluye del check automático
// ─────────────────────────────────────────
const TAG_CHECKS = [
  // 1 — Window Variables (Global)
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.userId', page: 'home', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.userId' },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.testCell', page: 'home', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.testCell' },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.userSegments', page: 'home', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.userSegments' },
  { section: '1 — Window Variables (Global)', label: 'serviceURL', page: 'home', type: 'window', expr: '!!window.serviceURL' },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData', page: 'pdp', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.purchaseData', requiresCheckout: true },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData.revenue', page: 'pdp', type: 'window', expr: 'window.cnstrc && window.cnstrc.purchaseData && !!window.cnstrc.purchaseData.revenue', requiresCheckout: true },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData.orderId', page: 'pdp', type: 'window', expr: 'window.cnstrc && window.cnstrc.purchaseData && !!window.cnstrc.purchaseData.orderId', requiresCheckout: true },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData.items', page: 'pdp', type: 'window', expr: 'window.cnstrc && window.cnstrc.purchaseData && !!window.cnstrc.purchaseData.items', requiresCheckout: true },

  // 2 — Buscador & Autocomplete
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-search-form', page: 'home', type: 'selector', selector: '[data-cnstrc-search-form]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-search-input', page: 'home', type: 'selector', selector: '[data-cnstrc-search-input]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-search-submit-btn', page: 'home', type: 'selector', selector: '[data-cnstrc-search-submit-btn]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-autosuggest', page: 'search', type: 'selector', selector: '[data-cnstrc-autosuggest]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-section (srch)', page: 'search', type: 'selector', selector: '[data-cnstrc-item-section]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-name (suggest)', page: 'search', type: 'selector', selector: '[data-cnstrc-item-name]', notVerifiable: true },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-id (suggest)', page: 'search', type: 'selector', selector: '[data-cnstrc-item-id]', notVerifiable: true },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-group', page: 'search', type: 'selector', selector: '[data-cnstrc-item-group]' },

  // 3 — Páginas de Listados (PLP)
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'script#cnstrc-data', page: 'plp', type: 'selector', selector: 'script#cnstrc-data' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-search', page: 'plp', type: 'selector', selector: '[data-cnstrc-search]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-result-id', page: 'plp', type: 'selector', selector: '[data-cnstrc-result-id]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-num-results', page: 'plp', type: 'selector', selector: '[data-cnstrc-num-results]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-item-id (PLP)', page: 'plp', type: 'selector', selector: '[data-cnstrc-item-id]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-item-name (PLP)', page: 'plp', type: 'selector', selector: '[data-cnstrc-item-name]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-item-variation-id (PLP)', page: 'plp', type: 'selector', selector: '[data-cnstrc-item-variation-id]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-item-price (PLP)', page: 'plp', type: 'selector', selector: '[data-cnstrc-item-price]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-btn (PLP)', page: 'plp', type: 'selector', selector: '[data-cnstrc-btn]' },
  { section: '3 — Páginas de Listados (PLP — Search & Browse)', label: 'data-cnstrc-sl-campaign-id', page: 'plp', type: 'selector', selector: '[data-cnstrc-sl-campaign-id]', notApplicable: true },

  // 4 — Ficha de Producto (PDP)
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-product-detail', page: 'pdp', type: 'selector', selector: '[data-cnstrc-product-detail]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-id (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-id]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-name (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-name]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-variation-id (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-variation-id]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-price (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-price]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-btn (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-btn]' },

  // 5 — Recomendaciones
  { section: '5 — Recomendaciones (Recommendations Widget)', label: 'data-cnstrc-recommendations', page: 'pdp', type: 'selector', selector: '[data-cnstrc-recommendations]' },
  { section: '5 — Recomendaciones (Recommendations Widget)', label: 'data-cnstrc-recommendations-pod-id', page: 'pdp', type: 'selector', selector: '[data-cnstrc-recommendations-pod-id]' },
  { section: '5 — Recomendaciones (Recommendations Widget)', label: 'data-cnstrc-strategy-id', page: 'pdp', type: 'selector', selector: '[data-cnstrc-strategy-id]' },
];

// ─────────────────────────────────────────
// CHEQUEO POR SITIO
// ─────────────────────────────────────────
async function checkSite(browser, site) {
  console.log(`\n🔍 Chequeando ${site.name}...`);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const pageCache = {}; // pageType → ya navegado
  const results = {};

  async function ensurePage(pageType) {
    if (pageCache[pageType]) return true;
    const urlMap = { home: site.homeUrl, search: site.searchUrl, plp: site.plpUrl, pdp: site.pdpUrl };
    const url = urlMap[pageType];
    if (!url || url.includes('PLACEHOLDER')) return false; // no configurado
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);
      pageCache[pageType] = true;
      return true;
    } catch (err) {
      console.log(`  ⚠️  No se pudo cargar ${pageType} (${url}): ${err.message}`);
      pageCache[pageType] = false;
      return false;
    }
  }

  for (const tag of TAG_CHECKS) {
    if (tag.requiresCheckout) {
      results[tag.label] = 'N/V'; // requiere compra real, no se automatiza
      continue;
    }

    const loaded = await ensurePage(tag.page);
    if (!loaded) {
      results[tag.label] = tag.notApplicable ? 'N/A' : 'N/V';
      continue;
    }

    try {
      let found = false;
      if (tag.type === 'window') {
        found = await page.evaluate(`(() => { try { return !!(${tag.expr}); } catch(e) { return false; } })()`);
      } else if (tag.type === 'selector') {
        found = (await page.$(tag.selector)) !== null;
      }
      if (!found && tag.notApplicable) {
        results[tag.label] = 'N/A';
      } else if (!found && tag.notVerifiable) {
        results[tag.label] = 'N/V';
      } else {
        results[tag.label] = found ? 'OK' : 'MISSING';
      }
      console.log(`  ${found ? '✅' : '❌'} ${tag.label}`);
    } catch (err) {
      results[tag.label] = 'N/V';
    }
  }

  await context.close();
  return results;
}

// ─────────────────────────────────────────
// HISTORIAL — leer, agregar, truncar
// ─────────────────────────────────────────
function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveHistory(history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }); // YYYY-MM-DD
}

function scoreOf(tagResults) {
  const verificable = TAG_CHECKS.filter(t => !t.notVerifiable && !t.notApplicable && !t.requiresCheckout);
  const ok = verificable.filter(t => tagResults[t.label] === 'OK').length;
  return { ok, total: verificable.length, pct: Math.round((ok / verificable.length) * 100) };
}

// ─────────────────────────────────────────
// GENERAR index.html A PARTIR DEL HISTORIAL COMPLETO
// ─────────────────────────────────────────
function generateHtml(history) {
  const sections = [...new Set(TAG_CHECKS.map(t => t.section))];

  const siteBlocks = SITES.map(site => {
    const siteHistory = history[site.key] || [];
    const dates = siteHistory.map(h => h.date);
    const last = siteHistory[siteHistory.length - 1];
    const lastScore = last ? scoreOf(last.tags) : { pct: 0 };

    const sectionRows = sections.map(section => {
      const tagsInSection = TAG_CHECKS.filter(t => t.section === section);
      const rows = tagsInSection.map(tag => {
        const cells = siteHistory.map(h => {
          const v = h.tags[tag.label] || '—';
          const cls = v === 'OK' ? 'ok' : v === 'MISSING' ? 'missing' : 'neutral';
          return `<td class="${cls}">${v}</td>`;
        }).join('');
        return `<tr><td class="tag-label">${tag.label}</td>${cells}</tr>`;
      }).join('');
      return `<tr class="section-header"><td colspan="${1 + siteHistory.length}">${section}</td></tr>${rows}`;
    }).join('');

    const dateHeaders = dates.map(d => `<th>${d}</th>`).join('');

    return `
    <section class="site-block" id="site-${site.key}">
      <div class="site-title">
        <h2>${site.name}</h2>
        <span class="score-badge ${lastScore.pct >= 80 ? 'ok' : lastScore.pct >= 50 ? 'warn' : 'err'}">${lastScore.pct}%</span>
      </div>
      <table class="tag-table">
        <thead><tr><th>Tag</th>${dateHeaders}</tr></thead>
        <tbody>${sectionRows}</tbody>
      </table>
    </section>`;
  }).join('');

  const tabs = SITES.map((s, i) => `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-target="site-${s.key}">${s.name}</button>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Constructor.io — Historial · Cencosud Chile</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;padding:2rem}
  h1{font-size:20px;margin-bottom:4px}
  .subtitle{font-size:13px;color:#8b949e;margin-bottom:1.5rem}
  .tabs{display:flex;gap:8px;margin-bottom:1.5rem;flex-wrap:wrap}
  .tab-btn{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px}
  .tab-btn.active{background:#1f6feb;border-color:#1f6feb}
  .site-block{display:none}
  .site-block.active{display:block}
  .site-title{display:flex;align-items:center;gap:12px;margin-bottom:1rem}
  .score-badge{font-size:14px;font-weight:700;padding:4px 12px;border-radius:8px}
  .score-badge.ok{background:#1a7f37;color:#fff}
  .score-badge.warn{background:#9a6700;color:#fff}
  .score-badge.err{background:#cf222e;color:#fff}
  .tag-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:2rem}
  .tag-table th,.tag-table td{padding:6px 10px;border-bottom:1px solid #21262d;text-align:left;white-space:nowrap}
  .section-header td{background:#161b22;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em;color:#8b949e}
  .tag-label{font-family:monospace;color:#c9d1d9}
  td.ok{color:#3fb950}
  td.missing{color:#f85149}
  td.neutral{color:#6e7681}
  .footer{font-size:11px;color:#6e7681;margin-top:1rem}
</style>
</head>
<body>
<h1>Constructor.io — Historial de Monitoreo · Cencosud Chile</h1>
<div class="subtitle">Último run: <strong>${todayStr()}</strong> · Generado automáticamente vía GitHub Actions</div>
<div class="tabs">${tabs}</div>
${siteBlocks}
<div class="footer">OK · MISSING · N/A (no aplica, depende de campaña) · N/V (no verificable por scraping pasivo) · — (sin dato ese día)</div>
<script>
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.site-block').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });
  document.querySelector('.site-block').classList.add('active');
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  console.log('🚀 Monitor de tags Constructor.io arrancando...');
  const browser = await chromium.launch({ headless: true });
  const history = loadHistory();
  const today = todayStr();

  for (const site of SITES) {
    const tagResults = await checkSite(browser, site);
    if (!history[site.key]) history[site.key] = [];

    // Si ya corrió hoy, reemplaza la entrada de hoy en vez de duplicar
    history[site.key] = history[site.key].filter(h => h.date !== today);
    history[site.key].push({ date: today, tags: tagResults });

    // Truncar a los últimos N días
    if (history[site.key].length > MAX_HISTORY_PER_SITE) {
      history[site.key] = history[site.key].slice(-MAX_HISTORY_PER_SITE);
    }

    const score = scoreOf(tagResults);
    console.log(`  📊 ${site.name}: ${score.ok}/${score.total} tags OK (${score.pct}%)`);
  }

  await browser.close();
  saveHistory(history);
  fs.writeFileSync(OUTPUT_HTML, generateHtml(history));
  console.log('\n✅ index.html y data/history.json actualizados.');
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
