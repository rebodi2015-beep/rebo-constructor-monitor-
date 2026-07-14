/**
 * Constructor.io — Monitor de Marcajes DOM
 * Banderas: Paris, Easy, Jumbo, Santaisabel (SISA CL)
 *
 * v3 — reescritura según lista de atributos esenciales de Constructor (Luis Nunez, jul/2026):
 *  - Matriz condicional banner × página × atributo (fin de falsos positivos)
 *  - item-variation-id: esencial SOLO en Paris (resto usa Deduplicador de Variaciones → N/A)
 *  - Recomendaciones: SOLO Paris (Easy/Jumbo/SISA no tienen Constructor Recommendations → N/A)
 *  - price/btn en PLP: condicionados a que exista add_to_cart en esa PLP (auto-detección)
 *  - result-id: movido a Recomendaciones (no es de Search PLP)
 *  - Nuevas superficies: Browse (categoría + colección), carruseles home con ATC, autocomplete item-section
 *  - Browse-colección: URL en placeholder por banner hasta que Constructor pase el ejemplo (marca N/V)
 *  - Disclaimer visible: valida PRESENCIA, no exactitud del dato (feedback Constructor)
 *
 * PENDIENTE DE VERIFICACIÓN (no confirmado por Diego al momento de esta versión):
 *  - Que Santaisabel.cl == SISA CL en los logs de Constructor (Luis valida "SisaCL")
 *  - URLs de Browse-colección Constructor por banner
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const OUTPUT_HTML = path.join(__dirname, 'index.html');
const MAX_HISTORY_PER_SITE = 30;

// ─────────────────────────────────────────
// SITIOS
// browseCollectionUrl: PLACEHOLDER hasta que Constructor pase ejemplo de Colección.
// ─────────────────────────────────────────
const SITES = [
  {
    key: 'paris',
    name: 'Paris.cl',
    sisa: false,
    hasRecommendations: true,   // único banner con Constructor Recommendations
    usesVariationDedup: false,  // Paris NO usa Deduplicador → variation-id es esencial
    homeUrl: 'https://www.paris.cl',
    searchUrl: 'https://www.paris.cl/search?q=televisor',
    plpUrl: 'https://www.paris.cl/electro/television/televisores-led/',
    // Patrón de link de colecciones en home. AJUSTAR: confirmar patrón real de Paris.
    collectionLinkPatterns: ['/search?', '/collection'],
    pdpUrl: 'https://www.paris.cl/qled-smart-tv-55-4k-vision-ai-q7fa-2025-128009999.html',
  },
  {
    key: 'easy',
    name: 'Easy.cl',
    sisa: false,
    hasRecommendations: false,
    usesVariationDedup: true,   // usa Deduplicador → variation-id N/A
    homeUrl: 'https://www.easy.cl',
    searchUrl: 'https://www.easy.cl/busqueda?ft=silla',
    plpUrl: 'https://www.easy.cl/muebles/muebles-de-oficina/sillas-de-escritorio',
    // AJUSTAR: confirmar patrón real de Easy.
    collectionLinkPatterns: ['/busca?', '/busqueda?'],
    pdpUrl: 'https://www.easy.cl/silla-de-escritorio-rio-negro-contatto-1322002/p',
  },
  {
    key: 'jumbo',
    name: 'Jumbo.cl',
    sisa: false,
    hasRecommendations: false,
    usesVariationDedup: true,
    homeUrl: 'https://www.jumbo.cl',
    searchUrl: 'https://www.jumbo.cl/busqueda?ft=leche',
    plpUrl: 'https://www.jumbo.cl/lacteos-y-quesos/leches/leche-liquida',
    // Confirmado por Diego: colecciones de home apuntan a /busca?fq=...
    collectionLinkPatterns: ['/busca?fq=', '/busca?'],
    pdpUrl: 'https://www.jumbo.cl/leche-soprole-natural-1-litro/p',
  },
  {
    key: 'santaisabel',
    name: 'Santaisabel.cl',
    sisa: true,                 // ⚠️ verificar que == SisaCL en logs de Constructor
    hasRecommendations: false,
    usesVariationDedup: true,
    homeUrl: 'https://www.santaisabel.cl',
    searchUrl: 'https://www.santaisabel.cl/busqueda?ft=pan',
    plpUrl: 'https://www.santaisabel.cl/panaderia-y-pasteleria/panaderia-envasada/pan-de-molde',
    // AJUSTAR: mismo patrón que Jumbo probablemente (stack VTEX Cencosud), confirmar.
    collectionLinkPatterns: ['/busca?fq=', '/busca?'],
    pdpUrl: 'https://www.santaisabel.cl/pan-de-molde-blanco-ideal-bolsa-700-g-tipo-sa/p',
  },
];

// ─────────────────────────────────────────
// PÁGINAS
// Cada página declara su URL y si debe auto-detectar add_to_cart
// (para condicionar price/btn en PLP y carruseles).
// ─────────────────────────────────────────
const PAGES = {
  home:   { urlKey: 'homeUrl' },
  search: { urlKey: 'searchUrl' },
  plp:    { urlKey: 'plpUrl' },            // Browse categoría (URL fija estable)
  pdp:    { urlKey: 'pdpUrl' },
};

// Cuántas colecciones de home seguir por banner (descubrimiento dinámico)
const MAX_COLLECTIONS_PER_SITE = 6;

// Tags de Browse que se chequean en cada colección descubierta.
// (variation-id se agrega solo para Paris en runtime)
const COLLECTION_TAG_CHECKS = [
  { label: 'data-cnstrc-browse',       selector: '[data-cnstrc-browse]' },
  { label: 'data-cnstrc-filter-name',  selector: '[data-cnstrc-filter-name]' },
  { label: 'data-cnstrc-filter-value', selector: '[data-cnstrc-filter-value]' },
  { label: 'data-cnstrc-num-results',  selector: '[data-cnstrc-num-results]' },
  { label: 'data-cnstrc-item-id',      selector: '[data-cnstrc-item-id]' },
];

// ─────────────────────────────────────────
// MATRIZ DE CHECKS (según lista esencial de Constructor)
//
// Cada check declara:
//  - section, label, page, y (selector | expr)
//  - applies(site): función que decide si el atributo aplica a ESE banner
//  - conditional: 'atc'  → solo se exige si la página tiene add_to_cart
//  - notVerifiable: true → depende de interacción (no verificable en scraping pasivo)
//
// applies() devuelve true=esencial, false=N/A (no penaliza el score)
// ─────────────────────────────────────────
const ALWAYS = () => true;
const ONLY_PARIS = (s) => !s.usesVariationDedup;        // variation-id solo Paris
const ONLY_RECS = (s) => s.hasRecommendations;          // recomendaciones solo Paris

const TAG_CHECKS = [
  // ── 1 — Global / Window ─────────────────
  { section: '1 — Global (Window)', label: 'window.cnstrc.userId', page: 'home', type: 'window',
    expr: 'window.cnstrc && !!window.cnstrc.userId', applies: ALWAYS },
  { section: '1 — Global (Window)', label: 'purchaseData (estructura completa)', page: 'pdp', type: 'window',
    expr: 'window.cnstrc && !!window.cnstrc.purchaseData', applies: ALWAYS, requiresCheckout: true },

  // ── 2 — Autocomplete ────────────────────
  { section: '2 — Autocomplete', label: 'data-cnstrc-search-form', page: 'home', type: 'selector',
    selector: '[data-cnstrc-search-form]', applies: ALWAYS },
  { section: '2 — Autocomplete', label: 'data-cnstrc-search-input', page: 'home', type: 'selector',
    selector: '[data-cnstrc-search-input]', applies: ALWAYS },
  { section: '2 — Autocomplete', label: 'data-cnstrc-search-submit-btn', page: 'home', type: 'selector',
    selector: '[data-cnstrc-search-submit-btn]', applies: ALWAYS },
  { section: '2 — Autocomplete', label: 'data-cnstrc-autosuggest', page: 'search', type: 'selector',
    selector: '[data-cnstrc-autosuggest]', applies: ALWAYS, notVerifiable: true },
  { section: '2 — Autocomplete', label: 'data-cnstrc-item-section', page: 'search', type: 'selector',
    selector: '[data-cnstrc-item-section]', applies: ALWAYS, notVerifiable: true },
  { section: '2 — Autocomplete', label: 'data-cnstrc-item-id (autocomplete)', page: 'search', type: 'selector',
    selector: '[data-cnstrc-item-id]', applies: ALWAYS, notVerifiable: true },

  // ── 3 — Search PLP ──────────────────────
  { section: '3 — Search PLP', label: 'data-cnstrc-search', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-search]', applies: ALWAYS },
  { section: '3 — Search PLP', label: 'data-cnstrc-num-results', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-num-results]', applies: ALWAYS },
  { section: '3 — Search PLP', label: 'data-cnstrc-item-id (PLP)', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-item-id]', applies: ALWAYS },
  { section: '3 — Search PLP', label: 'data-cnstrc-item-variation-id (PLP)', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-item-variation-id]', applies: ONLY_PARIS },
  { section: '3 — Search PLP', label: 'data-cnstrc-item-price (PLP)', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-item-price]', applies: ALWAYS, conditional: 'atc' },
  { section: '3 — Search PLP', label: 'data-cnstrc-btn (PLP)', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-btn]', applies: ALWAYS, conditional: 'atc' },

  // ── 4 — Browse PLP (Categoría + Colección) ──
  // Nota: reusa plpUrl como categoría; browseCollection como colección (placeholder).
  { section: '4 — Browse PLP', label: 'data-cnstrc-browse', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-browse]', applies: ALWAYS },
  { section: '4 — Browse PLP', label: 'data-cnstrc-filter-name', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-filter-name]', applies: ALWAYS },
  { section: '4 — Browse PLP', label: 'data-cnstrc-filter-value', page: 'plp', type: 'selector',
    selector: '[data-cnstrc-filter-value]', applies: ALWAYS },
  // Nota: las colecciones de home se chequean aparte (descubrimiento dinámico),
  // no como fila fija acá. Ver checkCollections() y sección '4b — Colecciones (Home)'.

  // ── 5 — PDP ─────────────────────────────
  { section: '5 — PDP', label: 'data-cnstrc-product-detail', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-product-detail]', applies: ALWAYS },
  { section: '5 — PDP', label: 'data-cnstrc-item-id (PDP)', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-item-id]', applies: ALWAYS },
  { section: '5 — PDP', label: 'data-cnstrc-item-variation-id (PDP)', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-item-variation-id]', applies: ONLY_PARIS },
  { section: '5 — PDP', label: 'data-cnstrc-item-price (PDP)', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-item-price]', applies: ALWAYS },
  { section: '5 — PDP', label: 'data-cnstrc-btn="add_to_cart" (PDP)', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-btn]', applies: ALWAYS },

  // ── 6 — Carruseles con ATC (home) ───────
  // Solo se exige si el carrusel permite add_to_cart (conditional atc).
  { section: '6 — Carruseles ATC (Home)', label: 'data-cnstrc-item-id (carrusel)', page: 'home', type: 'selector',
    selector: '[data-cnstrc-item-id]', applies: ALWAYS, conditional: 'atc' },
  { section: '6 — Carruseles ATC (Home)', label: 'data-cnstrc-item-variation-id (carrusel)', page: 'home', type: 'selector',
    selector: '[data-cnstrc-item-variation-id]', applies: ONLY_PARIS, conditional: 'atc' },
  { section: '6 — Carruseles ATC (Home)', label: 'data-cnstrc-item-price (carrusel)', page: 'home', type: 'selector',
    selector: '[data-cnstrc-item-price]', applies: ALWAYS, conditional: 'atc' },
  { section: '6 — Carruseles ATC (Home)', label: 'data-cnstrc-btn (carrusel)', page: 'home', type: 'selector',
    selector: '[data-cnstrc-btn]', applies: ALWAYS, conditional: 'atc' },

  // ── 7 — Recomendaciones (solo Paris) ────
  { section: '7 — Recomendaciones', label: 'data-cnstrc-recommendations', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-recommendations]', applies: ONLY_RECS },
  { section: '7 — Recomendaciones', label: 'data-cnstrc-recommendations-pod-id', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-recommendations-pod-id]', applies: ONLY_RECS },
  { section: '7 — Recomendaciones', label: 'data-cnstrc-result-id', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-result-id]', applies: ONLY_RECS },
  { section: '7 — Recomendaciones', label: 'data-cnstrc-num-results (recs)', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-num-results]', applies: ONLY_RECS },
  { section: '7 — Recomendaciones', label: 'data-cnstrc-item-id (recs)', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-item-id]', applies: ONLY_RECS },
  { section: '7 — Recomendaciones', label: 'data-cnstrc-item-variation-id (recs)', page: 'pdp', type: 'selector',
    selector: '[data-cnstrc-item-variation-id]', applies: ONLY_RECS },
];

// Textos típicos de botones de modales de cookies / selección de comuna (es-CL)
const DISMISS_BUTTON_TEXTS = [
  'Aceptar', 'Acepto', 'Entendido', 'Continuar', 'Cerrar', 'OK', 'Aceptar todo',
  'Aceptar todas', 'Ingresar dirección', 'Más tarde', 'Ahora no', 'No, gracias', 'Confirmar',
];

async function dismissModals(page) {
  for (const text of DISMISS_BUTTON_TEXTS) {
    try {
      const btn = page.getByText(text, { exact: false }).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {}
  }
}

// Detecta si una página tiene add_to_cart de Constructor (para checks condicionales)
async function pageHasATC(page) {
  try {
    const el = await page.$('[data-cnstrc-btn="add_to_cart"], [data-cnstrc-btn]');
    return el !== null;
  } catch { return false; }
}

// ─────────────────────────────────────────
// POLLING — reintenta antes de marcar MISSING
// ─────────────────────────────────────────
async function pollCheck(page, tag, attempts = 6, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      let found = false;
      if (tag.type === 'window') {
        found = await page.evaluate(`(() => { try { return !!(${tag.expr}); } catch(e) { return false; } })()`);
      } else if (tag.type === 'selector') {
        found = (await page.$(tag.selector)) !== null;
      }
      if (found) return true;
    } catch {}
    await page.waitForTimeout(delayMs);
  }
  return false;
}

// ─────────────────────────────────────────
// COLECCIONES DE HOME — descubrimiento dinámico
// Levanta la home, junta los <a> que matcheen los patrones del banner,
// sigue hasta MAX_COLLECTIONS_PER_SITE y chequea los tags de Browse en cada una.
// Devuelve: { measured: [{url, tags:{...}, pct}], summaryPct, discovered }
// ─────────────────────────────────────────
async function discoverCollectionLinks(page, site) {
  // Junta todos los href visibles y filtra por los patrones del banner.
  const hrefs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => out.push(a.getAttribute('href')));
    return out;
  });

  const patterns = site.collectionLinkPatterns || [];
  const seen = new Set();
  const matched = [];
  for (const href of hrefs) {
    if (!href) continue;
    if (!patterns.some(p => href.includes(p))) continue;
    // Normalizo a URL absoluta
    let abs;
    try { abs = new URL(href, site.homeUrl).toString(); } catch { continue; }
    if (seen.has(abs)) continue;      // dedup: un mismo destino puede estar linkeado 2 veces
    seen.add(abs);
    matched.push(abs);
    if (matched.length >= MAX_COLLECTIONS_PER_SITE) break;
  }
  return matched;
}

async function checkCollections(context, site) {
  const page = await context.newPage();
  const result = { measured: [], summaryPct: null, discovered: 0 };

  try {
    await page.goto(site.homeUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => {
      await page.goto(site.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    });
    await dismissModals(page);
    await page.waitForTimeout(3000);

    const links = await discoverCollectionLinks(page, site);
    result.discovered = links.length;

    if (links.length === 0) {
      // Home sin bloques de colección reconocibles ese día → N/V, no penaliza.
      console.log(`  ⚠️  ${site.name}: 0 colecciones descubiertas (patrón: ${(site.collectionLinkPatterns||[]).join(', ')})`);
      await page.close();
      return result;
    }

    console.log(`  🔗 ${site.name}: ${links.length} colecciones descubiertas`);

    // Tags a chequear: base + variation-id solo si Paris
    const checks = [...COLLECTION_TAG_CHECKS];
    if (!site.usesVariationDedup) {
      checks.push({ label: 'data-cnstrc-item-variation-id', selector: '[data-cnstrc-item-variation-id]' });
    }

    let okColls = 0;
    for (const url of links) {
      const collResult = { url, tags: {}, pct: 0 };
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        });
        await dismissModals(page);
        await page.waitForTimeout(3000);

        let ok = 0;
        for (const c of checks) {
          const found = await pollCheck(page, { type: 'selector', selector: c.selector }, 4, 900);
          collResult.tags[c.label] = found ? 'OK' : 'MISSING';
          if (found) ok++;
        }
        collResult.pct = Math.round((ok / checks.length) * 100);
        if (collResult.pct === 100) okColls++;
        console.log(`     ${collResult.pct === 100 ? '✅' : '⚠️'} ${collResult.pct}% — ${url.slice(0, 70)}`);
      } catch (err) {
        collResult.error = err.message;
        console.log(`     ❌ error — ${url.slice(0, 70)}: ${err.message}`);
      }
      result.measured.push(collResult);
    }

    // Summary: % de colecciones con todos los tags OK
    result.summaryPct = links.length > 0 ? Math.round((okColls / links.length) * 100) : null;
  } catch (err) {
    console.log(`  ⚠️  ${site.name}: no se pudo procesar colecciones: ${err.message}`);
  }

  await page.close();
  return result;
}

async function checkSite(browser, site) {
  console.log(`\n🔍 Chequeando ${site.name}...`);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'es-CL',
  });
  const page = await context.newPage();

  const pageCache = {};
  const pageATC = {};   // cache de add_to_cart detectado por página
  const results = {};

  async function ensurePage(pageType) {
    if (pageType in pageCache) return pageCache[pageType];
    const url = site[PAGES[pageType].urlKey];
    if (!url || url === 'PLACEHOLDER' || url.includes('PLACEHOLDER')) {
      pageCache[pageType] = false;
      return false;
    }
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await dismissModals(page);
      await page.waitForTimeout(3500);
      pageCache[pageType] = true;
    } catch (err) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await dismissModals(page);
        await page.waitForTimeout(4000);
        pageCache[pageType] = true;
      } catch (err2) {
        console.log(`  ⚠️  No se pudo cargar ${pageType} (${url}): ${err2.message}`);
        pageCache[pageType] = false;
      }
    }
    if (pageCache[pageType]) {
      pageATC[pageType] = await pageHasATC(page);
    }
    return pageCache[pageType];
  }

  for (const tag of TAG_CHECKS) {
    // 1) ¿Aplica a este banner?  (variation-id/recs → N/A donde corresponde)
    if (!tag.applies(site)) {
      results[tag.label] = 'N/A';
      continue;
    }
    // 2) purchaseData: requiere checkout, no verificable en scraping pasivo
    if (tag.requiresCheckout) {
      results[tag.label] = 'N/V';
      continue;
    }

    const loaded = await ensurePage(tag.page);
    if (!loaded) {
      // URL placeholder (browse-colección) o página caída → N/V
      results[tag.label] = 'N/V';
      continue;
    }

    // 3) Condicional ATC: si la página no tiene add_to_cart, el atributo no se exige
    if (tag.conditional === 'atc' && !pageATC[tag.page]) {
      results[tag.label] = 'N/A';
      continue;
    }

    try {
      const found = await pollCheck(page, tag);
      if (!found && tag.notVerifiable) {
        results[tag.label] = 'N/V';
      } else {
        results[tag.label] = found ? 'OK' : 'MISSING';
      }
      console.log(`  ${found ? '✅' : '❌'} ${tag.label}`);
    } catch (err) {
      results[tag.label] = 'N/V';
    }
  }

  // Colecciones de home (descubrimiento dinámico) — reusa el mismo context
  console.log(`  🧭 ${site.name}: chequeando colecciones de home...`);
  const collections = await checkCollections(context, site);

  await context.close();
  return { results, collections };
}

// ─────────────────────────────────────────
// HISTORIAL
// ─────────────────────────────────────────
function loadHistory() {
  let history = {};
  if (fs.existsSync(HISTORY_PATH)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')); } catch { history = {}; }
  }
  return history;
}

function saveHistory(history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

// Score cuenta SOLO atributos aplicables y verificables para ESE banner.
// N/A y N/V no penalizan (esto elimina los falsos positivos del %).
function scoreOf(site, tagResults) {
  const applicable = TAG_CHECKS.filter(t => {
    if (typeof t.applies === 'function' && !t.applies(site)) return false;
    if (t.requiresCheckout || t.notVerifiable) return false;
    return true;
  });
  let ok = 0, counted = 0;
  for (const t of applicable) {
    const v = tagResults[t.label];
    if (v === 'N/A' || v === 'N/V' || v === undefined || v === '—') continue;
    counted++;
    if (v === 'OK') ok++;
  }
  const pct = counted > 0 ? Math.round((ok / counted) * 100) : 0;
  return { ok, total: counted, pct };
}

// ─────────────────────────────────────────
// GRÁFICO DE BARRAS
// ─────────────────────────────────────────
function generateChart(site, siteHistory) {
  if (siteHistory.length === 0) return '';
  const W = 700, H = 140, padBottom = 28, padTop = 10, barGap = 8;
  const barW = Math.min(48, (W - barGap * (siteHistory.length + 1)) / siteHistory.length);
  const usableH = H - padBottom - padTop;

  const bars = siteHistory.map((h, i) => {
    const sc = scoreOf(site, h.tags);
    const x = barGap + i * (barW + barGap);
    const barH = (sc.pct / 100) * usableH;
    const y = padTop + (usableH - barH);
    const color = sc.pct >= 80 ? '#28a745' : sc.pct >= 50 ? '#fd7e14' : '#dc3545';
    const legacyMark = h.source === 'manual_legacy' ? `<text x="${x + barW / 2}" y="${y - 14}" font-size="8" fill="#aeaeb2" text-anchor="middle">hist.</text>` : '';
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(barH, 2)}" rx="4" fill="${color}" />
      <text x="${x + barW / 2}" y="${y - 4}" font-size="11" font-weight="600" fill="#1d1d1f" text-anchor="middle">${sc.pct}%</text>
      ${legacyMark}
      <text x="${x + barW / 2}" y="${H - 8}" font-size="9" fill="#6e6e73" text-anchor="middle">${h.date.slice(5)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="max-width:${W}px">
    <line x1="0" y1="${padTop + usableH}" x2="${W}" y2="${padTop + usableH}" stroke="#e5e5ea" stroke-width="1" />
    ${bars}
  </svg>`;
}

// ─────────────────────────────────────────
// HTML
// ─────────────────────────────────────────
// Render del bloque de colecciones descubiertas del último día
function renderCollections(lastEntry) {
  const coll = lastEntry && lastEntry.collections;
  if (!coll) {
    return `<div class="coll-block"><div class="coll-title">Colecciones de Home</div>
      <div class="coll-empty">Sin datos de colecciones (versión previa del monitor).</div></div>`;
  }
  if (!coll.measured || coll.measured.length === 0) {
    return `<div class="coll-block"><div class="coll-title">Colecciones de Home</div>
      <div class="coll-empty">0 colecciones descubiertas en la home ese día (N/V — no penaliza el score). Revisar patrón de link o layout de home.</div></div>`;
  }
  const rows = coll.measured.map(c => {
    const cls = c.error ? 'err' : c.pct === 100 ? 'ok' : c.pct >= 50 ? 'warn' : 'err';
    const missing = c.tags ? Object.entries(c.tags).filter(([, v]) => v === 'MISSING').map(([k]) => k) : [];
    const detail = c.error ? `error: ${c.error}` : (missing.length ? `faltan: ${missing.join(', ')}` : 'todos OK');
    return `<tr>
      <td class="coll-url" title="${c.url}">${c.url.replace(/^https?:\/\//, '').slice(0, 60)}…</td>
      <td class="coll-pct ${cls}">${c.error ? 'ERR' : c.pct + '%'}</td>
      <td class="coll-detail">${detail}</td>
    </tr>`;
  }).join('');
  const summary = coll.summaryPct !== null ? `${coll.summaryPct}% con todos los tags OK` : 'N/V';
  return `<div class="coll-block">
    <div class="coll-title">Colecciones de Home <span class="coll-summary">${coll.discovered} descubiertas · ${summary}</span></div>
    <table class="coll-table"><tbody>${rows}</tbody></table>
    <div class="coll-note">Descubrimiento dinámico: las colecciones cambian día a día. Se mide "¿el tag de Browse está presente en las colecciones vivas de hoy?", no una promo puntual trazable.</div>
  </div>`;
}

function generateHtml(history) {
  const sections = [...new Set(TAG_CHECKS.map(t => t.section))];

  const siteCards = SITES.map(site => {
    const siteHistory = history[site.key] || [];
    const last = siteHistory[siteHistory.length - 1];
    const lastScore = last ? scoreOf(site, last.tags) : { pct: 0 };

    const dateHeaders = siteHistory.map(h => {
      const sc = scoreOf(site, h.tags);
      const legacyTag = h.source === 'manual_legacy' ? '<span class="legacy-tag" title="Carga manual histórica">hist.</span>' : '';
      return `<th><div class="date-score ${sc.pct >= 80 ? 'ok' : sc.pct >= 50 ? 'warn' : 'err'}">${sc.pct}%</div><div class="date-label">${h.date}${legacyTag}</div></th>`;
    }).join('');

    const sectionRows = sections.map(section => {
      const tagsInSection = TAG_CHECKS.filter(t => t.section === section);
      const rows = tagsInSection.map(tag => {
        // Si el atributo no aplica al banner, lo mostramos como N/A permanente (sin ruido)
        const naForBanner = typeof tag.applies === 'function' && !tag.applies(site);
        const cells = siteHistory.map(h => {
          const v = naForBanner ? 'N/A' : (h.tags[tag.label] || '—');
          const cls = v === 'OK' ? 'ok' : v === 'MISSING' ? 'err' : 'neutral';
          return `<td class="${cls}">${v}</td>`;
        }).join('');
        return `<tr><td class="tag-label">${tag.label}</td>${cells}</tr>`;
      }).join('');
      return `<tr class="section-header"><td colspan="${1 + siteHistory.length}">${section}</td></tr>${rows}`;
    }).join('');

    return `
    <div class="site-card" id="site-${site.key}">
      <div class="site-header">
        <div>
          <div class="site-name">${site.name}${site.sisa ? ' <span class="sisa-tag" title="Verificar que corresponde a SisaCL en logs de Constructor">SISA?</span>' : ''}</div>
          <div class="site-meta">${siteHistory.length} ejecuciones · Recs: ${site.hasRecommendations ? 'sí' : 'N/A'} · variation-id: ${site.usesVariationDedup ? 'N/A (dedup)' : 'esencial'}</div>
        </div>
        <div class="site-score ${lastScore.pct >= 80 ? 'ok' : lastScore.pct >= 50 ? 'warn' : 'err'}">${lastScore.pct}%</div>
      </div>
      <div class="chart-wrap">${generateChart(site, siteHistory)}</div>
      <table class="event-table">
        <thead><tr><th>Tag</th>${dateHeaders}</tr></thead>
        <tbody>${sectionRows}</tbody>
      </table>
      ${renderCollections(last)}
    </div>`;
  }).join('');

  const tabs = SITES.map((s, i) => `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-target="site-${s.key}">${s.name}</button>`).join('');
  const date = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' });

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Constructor.io — Historial · Cencosud Chile</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;padding:2rem}
  h1{font-size:20px;font-weight:600;margin-bottom:4px}
  .subtitle{font-size:13px;color:#6e6e73;margin-bottom:1rem}
  .disclaimer{background:#fff3cd;border:1px solid #ffe69c;color:#856404;font-size:12px;padding:10px 14px;border-radius:8px;margin-bottom:1.25rem}
  .tabs{display:flex;gap:8px;margin-bottom:1.5rem;flex-wrap:wrap}
  .tab-btn{background:#fff;border:1px solid #e5e5ea;color:#1d1d1f;padding:8px 16px;border-radius:99px;cursor:pointer;font-size:13px;font-weight:500}
  .tab-btn.active{background:#1d1d1f;color:#fff;border-color:#1d1d1f}
  .site-card{display:none;background:#fff;border-radius:12px;border:1px solid #e5e5ea;padding:1.25rem;margin-bottom:1rem}
  .site-card.active{display:block}
  .site-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
  .site-name{font-size:16px;font-weight:600}
  .site-meta{font-size:12px;color:#6e6e73;margin-top:2px}
  .sisa-tag{display:inline-block;background:#ffe69c;color:#856404;font-size:9px;padding:1px 5px;border-radius:4px;vertical-align:middle}
  .site-score{font-size:20px;font-weight:700;padding:6px 14px;border-radius:8px}
  .site-score.ok{background:#d4edda;color:#155724}
  .site-score.warn{background:#fff3cd;color:#856404}
  .site-score.err{background:#f8d7da;color:#721c24}
  .chart-wrap{margin-bottom:1.25rem}
  .event-table{width:100%;border-collapse:collapse;font-size:12px}
  .event-table th{text-align:left;padding:6px 10px;border-bottom:1px solid #e5e5ea;vertical-align:bottom}
  .event-table td{padding:7px 10px;border-bottom:1px solid #f5f5f7;vertical-align:middle;white-space:nowrap}
  .section-header td{font-size:11px;font-weight:600;color:#6e6e73;text-transform:uppercase;letter-spacing:.05em;background:#f5f5f7;padding:6px 10px}
  .tag-label{font-family:monospace;font-size:11px;color:#1d1d1f}
  td.ok{color:#155724;font-weight:500}
  td.err{color:#721c24;font-weight:500}
  td.neutral{color:#aeaeb2}
  .date-score{font-size:13px;font-weight:700;border-radius:6px;padding:2px 8px;display:inline-block}
  .date-score.ok{background:#d4edda;color:#155724}
  .date-score.warn{background:#fff3cd;color:#856404}
  .date-score.err{background:#f8d7da;color:#721c24}
  .date-label{font-size:10px;color:#6e6e73;margin-top:2px;font-weight:400}
  .legacy-tag{display:inline-block;background:#e2e3e5;color:#41464b;font-size:9px;padding:1px 5px;border-radius:4px;margin-left:4px;text-transform:uppercase}
  .footer{font-size:11px;color:#aeaeb2;margin-top:1rem}
  .legend{font-size:11px;color:#6e6e73;margin-bottom:1rem}
  .coll-block{margin-top:1.5rem;border-top:1px solid #e5e5ea;padding-top:1rem}
  .coll-title{font-size:13px;font-weight:600;color:#1d1d1f;margin-bottom:8px}
  .coll-summary{font-size:11px;font-weight:400;color:#6e6e73;margin-left:6px}
  .coll-empty{font-size:12px;color:#856404;background:#fff3cd;border:1px solid #ffe69c;padding:8px 12px;border-radius:6px}
  .coll-table{width:100%;border-collapse:collapse;font-size:11px}
  .coll-table td{padding:6px 10px;border-bottom:1px solid #f5f5f7;vertical-align:middle}
  .coll-url{font-family:monospace;color:#6e6e73;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .coll-pct{font-weight:700;text-align:center;width:52px;border-radius:6px}
  .coll-pct.ok{color:#155724}
  .coll-pct.warn{color:#856404}
  .coll-pct.err{color:#721c24}
  .coll-detail{color:#6e6e73}
  .coll-note{font-size:10px;color:#aeaeb2;margin-top:8px;font-style:italic}
</style>
</head>
<body>
<h1>Constructor.io — Historial de Monitoreo · Cencosud Chile</h1>
<div class="subtitle">Última actualización: <strong>${date}</strong> · Automatizado vía GitHub Actions (cron diario)</div>
<div class="disclaimer">⚠️ Este monitor valida <strong>presencia</strong> de atributos en el DOM, no la <strong>exactitud</strong> del dato (que el valor coincida con el catálogo). Constructor mantiene alertas propias para problemas no cubiertos aquí. Verde ≠ garantía de tracking correcto.</div>
<div class="legend">OK · MISSING (rojo) · N/A no aplica a este banner (dedup de variaciones / sin recomendaciones / sin add_to_cart) · N/V no verificable por scraping pasivo · — sin dato</div>
<div class="tabs">${tabs}</div>
${siteCards}
<div class="footer">Generado automáticamente · Cencosud Chile · Constructor.io tag monitoring · v3</div>
<script>
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.site-card').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });
  document.querySelector('.site-card').classList.add('active');
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  console.log('🚀 Monitor de tags Constructor.io v3 arrancando...');
  const browser = await chromium.launch({ headless: true });
  const history = loadHistory();
  const today = todayStr();

  for (const site of SITES) {
    const { results: tagResults, collections } = await checkSite(browser, site);
    if (!history[site.key]) history[site.key] = [];
    history[site.key] = history[site.key].filter(h => h.date !== today);
    history[site.key].push({
      date: today,
      source: 'automated',
      tags: tagResults,
      collections,   // { measured:[{url,tags,pct}], summaryPct, discovered }
    });
    history[site.key].sort((a, b) => a.date.localeCompare(b.date));
    if (history[site.key].length > MAX_HISTORY_PER_SITE) {
      history[site.key] = history[site.key].slice(-MAX_HISTORY_PER_SITE);
    }
    const score = scoreOf(site, tagResults);
    const collInfo = collections.summaryPct !== null
      ? `${collections.summaryPct}% colecciones OK (${collections.discovered} descubiertas)`
      : `colecciones: N/V (0 descubiertas)`;
    console.log(`  📊 ${site.name}: ${score.ok}/${score.total} tags OK (${score.pct}%) · ${collInfo}`);
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
