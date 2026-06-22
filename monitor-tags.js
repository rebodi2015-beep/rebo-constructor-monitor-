/**
 * Constructor.io — Monitor de Marcajes DOM
 * Banderas: Paris, Easy, Jumbo, Santaisabel
 *
 * v2 — fixes aplicados:
 *  - Cierre automático de modales (cookies / selección de comuna) antes de chequear
 *  - Espera por networkidle en vez de timeout fijo corto (Paris/Easy no cargaban)
 *  - PDP de Santaisabel reemplazado (el anterior estaba sin stock)
 *  - Historial 06-15/06-17/06-18 reconstruido como "histórico manual" (no automatizado)
 *  - Diseño claro, estilo original (antes quedó en tema oscuro por error)
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
    pdpUrl: 'https://www.santaisabel.cl/pan-de-molde-blanco-ideal-bolsa-700-g-tipo-sa/p', // reemplazado: el anterior no tenía stock
  },
];

// ─────────────────────────────────────────
// TAGS A CHEQUEAR (sin cambios respecto a v1)
// ─────────────────────────────────────────
const TAG_CHECKS = [
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.userId', page: 'home', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.userId' },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.testCell', page: 'home', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.testCell' },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.userSegments', page: 'home', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.userSegments' },
  { section: '1 — Window Variables (Global)', label: 'serviceURL', page: 'home', type: 'window', expr: '!!window.serviceURL' },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData', page: 'pdp', type: 'window', expr: 'window.cnstrc && !!window.cnstrc.purchaseData', requiresCheckout: true },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData.revenue', page: 'pdp', type: 'window', expr: 'window.cnstrc && window.cnstrc.purchaseData && !!window.cnstrc.purchaseData.revenue', requiresCheckout: true },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData.orderId', page: 'pdp', type: 'window', expr: 'window.cnstrc && window.cnstrc.purchaseData && !!window.cnstrc.purchaseData.orderId', requiresCheckout: true },
  { section: '1 — Window Variables (Global)', label: 'window.cnstrc.purchaseData.items', page: 'pdp', type: 'window', expr: 'window.cnstrc && window.cnstrc.purchaseData && !!window.cnstrc.purchaseData.items', requiresCheckout: true },

  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-search-form', page: 'home', type: 'selector', selector: '[data-cnstrc-search-form]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-search-input', page: 'home', type: 'selector', selector: '[data-cnstrc-search-input]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-search-submit-btn', page: 'home', type: 'selector', selector: '[data-cnstrc-search-submit-btn]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-autosuggest', page: 'search', type: 'selector', selector: '[data-cnstrc-autosuggest]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-section (srch)', page: 'search', type: 'selector', selector: '[data-cnstrc-item-section]' },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-name (suggest)', page: 'search', type: 'selector', selector: '[data-cnstrc-item-name]', notVerifiable: true },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-id (suggest)', page: 'search', type: 'selector', selector: '[data-cnstrc-item-id]', notVerifiable: true },
  { section: '2 — Buscador & Autocomplete', label: 'data-cnstrc-item-group', page: 'search', type: 'selector', selector: '[data-cnstrc-item-group]' },

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

  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-product-detail', page: 'pdp', type: 'selector', selector: '[data-cnstrc-product-detail]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-id (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-id]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-name (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-name]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-variation-id (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-variation-id]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-item-price (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-item-price]' },
  { section: '4 — Ficha de Producto (PDP)', label: 'data-cnstrc-btn (PDP)', page: 'pdp', type: 'selector', selector: '[data-cnstrc-btn]' },

  { section: '5 — Recomendaciones (Recommendations Widget)', label: 'data-cnstrc-recommendations', page: 'pdp', type: 'selector', selector: '[data-cnstrc-recommendations]' },
  { section: '5 — Recomendaciones (Recommendations Widget)', label: 'data-cnstrc-recommendations-pod-id', page: 'pdp', type: 'selector', selector: '[data-cnstrc-recommendations-pod-id]' },
  { section: '5 — Recomendaciones (Recommendations Widget)', label: 'data-cnstrc-strategy-id', page: 'pdp', type: 'selector', selector: '[data-cnstrc-strategy-id]' },
];

// ─────────────────────────────────────────
// HISTORIAL LEGADO (reconstruido del dashboard manual previo)
// Marcado explícitamente como "manual_legacy": no viene de scraping
// automático verificado, sino de la carga manual que existía antes.
// ─────────────────────────────────────────
const LEGACY_HISTORY = {
  paris: [
    { date: '2026-06-15', source: 'manual_legacy', tags: { 'data-cnstrc-product-detail': 'OK' } },
    { date: '2026-06-17', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'OK', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'OK',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'MISSING',
      'data-cnstrc-item-section (srch)': 'MISSING', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'MISSING', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'OK', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-item-id (PLP)': 'OK', 'data-cnstrc-item-name (PLP)': 'OK', 'data-cnstrc-item-variation-id (PLP)': 'OK', 'data-cnstrc-item-price (PLP)': 'OK', 'data-cnstrc-btn (PLP)': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'MISSING',
      'data-cnstrc-recommendations': 'OK', 'data-cnstrc-recommendations-pod-id': 'OK', 'data-cnstrc-strategy-id': 'OK',
    }},
    { date: '2026-06-18', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'OK', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'OK',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'MISSING',
      'data-cnstrc-item-section (srch)': 'MISSING', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'MISSING', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'OK', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-item-id (PLP)': 'OK', 'data-cnstrc-item-name (PLP)': 'OK', 'data-cnstrc-item-variation-id (PLP)': 'OK', 'data-cnstrc-item-price (PLP)': 'OK', 'data-cnstrc-btn (PLP)': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'MISSING',
      'data-cnstrc-recommendations': 'OK', 'data-cnstrc-recommendations-pod-id': 'OK', 'data-cnstrc-strategy-id': 'OK',
    }},
  ],
  easy: [
    { date: '2026-06-15', source: 'manual_legacy', tags: { 'data-cnstrc-product-detail': 'OK' } },
    { date: '2026-06-17', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'MISSING', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'MISSING',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'MISSING',
      'data-cnstrc-item-section (srch)': 'MISSING', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'OK', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'OK', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-item-id (PLP)': 'OK', 'data-cnstrc-item-name (PLP)': 'OK', 'data-cnstrc-item-variation-id (PLP)': 'MISSING', 'data-cnstrc-item-price (PLP)': 'OK', 'data-cnstrc-btn (PLP)': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'OK',
      'data-cnstrc-recommendations': 'MISSING', 'data-cnstrc-recommendations-pod-id': 'MISSING', 'data-cnstrc-strategy-id': 'MISSING',
    }},
    { date: '2026-06-18', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'MISSING', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'MISSING',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'MISSING',
      'data-cnstrc-item-section (srch)': 'MISSING', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'OK', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'OK', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-item-id (PLP)': 'OK', 'data-cnstrc-item-name (PLP)': 'OK', 'data-cnstrc-item-variation-id (PLP)': 'MISSING', 'data-cnstrc-item-price (PLP)': 'OK', 'data-cnstrc-btn (PLP)': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'OK',
      'data-cnstrc-recommendations': 'MISSING', 'data-cnstrc-recommendations-pod-id': 'MISSING', 'data-cnstrc-strategy-id': 'MISSING',
    }},
  ],
  jumbo: [
    { date: '2026-06-15', source: 'manual_legacy', tags: { 'data-cnstrc-product-detail': 'OK' } },
    { date: '2026-06-17', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'MISSING', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'OK',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'OK',
      'data-cnstrc-item-section (srch)': 'OK', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'MISSING', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'MISSING', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'OK',
      'data-cnstrc-recommendations': 'OK', 'data-cnstrc-recommendations-pod-id': 'MISSING', 'data-cnstrc-strategy-id': 'MISSING',
    }},
    { date: '2026-06-18', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'MISSING', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'OK',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'OK',
      'data-cnstrc-item-section (srch)': 'OK', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'MISSING', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'MISSING', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'OK',
      'data-cnstrc-recommendations': 'OK', 'data-cnstrc-recommendations-pod-id': 'MISSING', 'data-cnstrc-strategy-id': 'MISSING',
    }},
  ],
  santaisabel: [
    { date: '2026-06-15', source: 'manual_legacy', tags: { 'data-cnstrc-product-detail': 'OK' } },
    { date: '2026-06-17', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'MISSING', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'OK',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'OK',
      'data-cnstrc-item-section (srch)': 'OK', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'MISSING', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'MISSING', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'OK',
      'data-cnstrc-recommendations': 'OK', 'data-cnstrc-recommendations-pod-id': 'MISSING', 'data-cnstrc-strategy-id': 'MISSING',
    }},
    { date: '2026-06-18', source: 'manual_legacy', tags: {
      'window.cnstrc.userId': 'MISSING', 'window.cnstrc.testCell': 'MISSING', 'window.cnstrc.userSegments': 'MISSING', 'serviceURL': 'OK',
      'data-cnstrc-search-form': 'OK', 'data-cnstrc-search-input': 'OK', 'data-cnstrc-search-submit-btn': 'OK', 'data-cnstrc-autosuggest': 'OK',
      'data-cnstrc-item-section (srch)': 'OK', 'data-cnstrc-item-group': 'MISSING',
      'script#cnstrc-data': 'MISSING', 'data-cnstrc-search': 'OK', 'data-cnstrc-result-id': 'MISSING', 'data-cnstrc-num-results': 'OK',
      'data-cnstrc-product-detail': 'OK', 'data-cnstrc-item-id (PDP)': 'OK', 'data-cnstrc-item-name (PDP)': 'OK', 'data-cnstrc-item-variation-id (PDP)': 'MISSING', 'data-cnstrc-item-price (PDP)': 'OK', 'data-cnstrc-btn (PDP)': 'OK',
      'data-cnstrc-recommendations': 'OK', 'data-cnstrc-recommendations-pod-id': 'MISSING', 'data-cnstrc-strategy-id': 'MISSING',
    }},
  ],
};

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

// ─────────────────────────────────────────
// CHEQUEO POR SITIO
// ─────────────────────────────────────────
async function checkSite(browser, site) {
  console.log(`\n🔍 Chequeando ${site.name}...`);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'es-CL',
  });
  const page = await context.newPage();

  const pageCache = {};
  const results = {};

  async function ensurePage(pageType) {
    if (pageCache[pageType]) return true;
    const urlMap = { home: site.homeUrl, search: site.searchUrl, plp: site.plpUrl, pdp: site.pdpUrl };
    const url = urlMap[pageType];
    if (!url || url.includes('PLACEHOLDER')) return false;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await dismissModals(page);
      await page.waitForTimeout(3500); // dar tiempo a hidratación de componentes JS
      pageCache[pageType] = true;
      return true;
    } catch (err) {
      // networkidle puede fallar en sitios con polling constante; reintentar con domcontentloaded
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await dismissModals(page);
        await page.waitForTimeout(4000);
        pageCache[pageType] = true;
        return true;
      } catch (err2) {
        console.log(`  ⚠️  No se pudo cargar ${pageType} (${url}): ${err2.message}`);
        pageCache[pageType] = false;
        return false;
      }
    }
  }

  for (const tag of TAG_CHECKS) {
    if (tag.requiresCheckout) {
      results[tag.label] = 'N/V';
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
// HISTORIAL
// ─────────────────────────────────────────
function loadHistory() {
  let history = {};
  if (fs.existsSync(HISTORY_PATH)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')); } catch { history = {}; }
  }
  // Sembrar histórico legado una sola vez (si esas fechas no existen todavía)
  for (const siteKey of Object.keys(LEGACY_HISTORY)) {
    if (!history[siteKey]) history[siteKey] = [];
    for (const legacyEntry of LEGACY_HISTORY[siteKey]) {
      const exists = history[siteKey].some(h => h.date === legacyEntry.date);
      if (!exists) history[siteKey].push(legacyEntry);
    }
    history[siteKey].sort((a, b) => a.date.localeCompare(b.date));
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

function scoreOf(tagResults) {
  const verificable = TAG_CHECKS.filter(t => !t.notVerifiable && !t.notApplicable && !t.requiresCheckout);
  const ok = verificable.filter(t => tagResults[t.label] === 'OK').length;
  return { ok, total: verificable.length, pct: Math.round((ok / verificable.length) * 100) };
}

// ─────────────────────────────────────────
// HTML — diseño claro, estilo original
// ─────────────────────────────────────────
function generateHtml(history) {
  const sections = [...new Set(TAG_CHECKS.map(t => t.section))];

  const siteCards = SITES.map(site => {
    const siteHistory = history[site.key] || [];
    const last = siteHistory[siteHistory.length - 1];
    const lastScore = last ? scoreOf(last.tags) : { pct: 0 };

    const dateHeaders = siteHistory.map(h => {
      const sc = scoreOf(h.tags);
      const legacyTag = h.source === 'manual_legacy' ? '<span class="legacy-tag" title="Carga manual histórica, no scraping automático">hist.</span>' : '';
      return `<th><div class="date-score ${sc.pct >= 80 ? 'ok' : sc.pct >= 50 ? 'warn' : 'err'}">${sc.pct}%</div><div class="date-label">${h.date}${legacyTag}</div></th>`;
    }).join('');

    const sectionRows = sections.map(section => {
      const tagsInSection = TAG_CHECKS.filter(t => t.section === section);
      const rows = tagsInSection.map(tag => {
        const cells = siteHistory.map(h => {
          const v = h.tags[tag.label] || '—';
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
          <div class="site-name">${site.name}</div>
          <div class="site-meta">${siteHistory.length} ejecuciones registradas</div>
        </div>
        <div class="site-score ${lastScore.pct >= 80 ? 'ok' : lastScore.pct >= 50 ? 'warn' : 'err'}">${lastScore.pct}%</div>
      </div>
      <table class="event-table">
        <thead><tr><th>Tag</th>${dateHeaders}</tr></thead>
        <tbody>${sectionRows}</tbody>
      </table>
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
  .subtitle{font-size:13px;color:#6e6e73;margin-bottom:1.5rem}
  .tabs{display:flex;gap:8px;margin-bottom:1.5rem;flex-wrap:wrap}
  .tab-btn{background:#fff;border:1px solid #e5e5ea;color:#1d1d1f;padding:8px 16px;border-radius:99px;cursor:pointer;font-size:13px;font-weight:500}
  .tab-btn.active{background:#1d1d1f;color:#fff;border-color:#1d1d1f}
  .site-card{display:none;background:#fff;border-radius:12px;border:1px solid #e5e5ea;padding:1.25rem;margin-bottom:1rem}
  .site-card.active{display:block}
  .site-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
  .site-name{font-size:16px;font-weight:600}
  .site-meta{font-size:12px;color:#6e6e73;margin-top:2px}
  .site-score{font-size:20px;font-weight:700;padding:6px 14px;border-radius:8px}
  .site-score.ok{background:#d4edda;color:#155724}
  .site-score.warn{background:#fff3cd;color:#856404}
  .site-score.err{background:#f8d7da;color:#721c24}
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
</style>
</head>
<body>
<h1>Constructor.io — Historial de Monitoreo · Cencosud Chile</h1>
<div class="subtitle">Última actualización: <strong>${date}</strong> · Automatizado vía GitHub Actions (cron diario)</div>
<div class="legend">OK · MISSING (en rojo) · N/A no aplica · N/V no verificable por scraping pasivo · — sin dato ese día · <span class="legacy-tag">hist.</span> = carga manual previa, no automatizada</div>
<div class="tabs">${tabs}</div>
${siteCards}
<div class="footer">Generado automáticamente · Cencosud Chile · Constructor.io tag monitoring</div>
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
  console.log('🚀 Monitor de tags Constructor.io arrancando...');
  const browser = await chromium.launch({ headless: true });
  const history = loadHistory();
  const today = todayStr();

  for (const site of SITES) {
    const tagResults = await checkSite(browser, site);
    if (!history[site.key]) history[site.key] = [];
    history[site.key] = history[site.key].filter(h => h.date !== today);
    history[site.key].push({ date: today, source: 'automated', tags: tagResults });
    history[site.key].sort((a, b) => a.date.localeCompare(b.date));
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
