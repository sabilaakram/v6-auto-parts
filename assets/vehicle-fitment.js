/*
 * Vehicle fitment helpers for the reg-lookup results page (sections/vehicle-parts-results.liquid).
 *
 * V6Fitment.lookupVehicle(endpoint, reg)  -> DVLA vehicle via the Cloudflare Worker (dvla-worker/)
 * V6Fitment.loadCatalog(collectionUrl)    -> all products as slim JSON (templates/collection.vf-fitment.liquid)
 * V6Fitment.shortlist(vehicle, products)  -> [{ product, score, fit: 'year' | 'check' }], best first
 *
 * DVLA returns make / year / engine size / fuel but NOT the model, so parts are matched on
 * those four only: keep parts naming the make, drop any whose stated years, fuel or engine
 * size contradict the vehicle, and rank parts that state a matching year first.
 */
(function () {
  if (window.V6Fitment) return;

  const MAKE_ALIASES = {
    'MERCEDES-BENZ': ['mercedes', 'benz', 'sprinter', 'vito', 'viano'],
    MERCEDES: ['mercedes', 'benz', 'sprinter', 'vito', 'viano'],
    VOLKSWAGEN: ['volkswagen', 'vw'],
    'LAND ROVER': ['land rover', 'landrover', 'range rover', 'discovery', 'defender', 'freelander', 'evoque'],
    VAUXHALL: ['vauxhall', 'opel'],
    'ALFA ROMEO': ['alfa romeo', 'alfa'],
  };
  const DIESEL_WORDS = /\b(diesel|tdi|cdi|crdi|hdi|bluehdi|dci|tdci|cdti|jtd|jtdm|d4d|sdv6|tdv6|tdv8|multijet|bluetec|bluemotion)\b/;
  const PETROL_WORDS = /\b(petrol|tfsi|tsi|fsi|gti|vtec|ecoboost|vvt-?i)\b/;
  const UNAVAILABLE = 'Sorry, the registration lookup is unavailable right now. Please try again, or use Search by Parts.';

  function userError(message) {
    const err = new Error(message);
    err.userMessage = message;
    return err;
  }

  async function lookupVehicle(endpoint, reg) {
    if (!endpoint) throw userError(UNAVAILABLE);
    let res;
    try {
      res = await fetch(endpoint + (endpoint.includes('?') ? '&' : '?') + 'reg=' + encodeURIComponent(reg));
    } catch (e) {
      throw userError(UNAVAILABLE);
    }
    if (res.status === 404) throw userError("We couldn't find a vehicle with registration " + reg + '. Please check it and try again.');
    if (res.status === 400) throw userError("That doesn't look like a valid UK registration. Please check it and try again.");
    if (res.status === 429) throw userError('The lookup is busy right now. Please try again in a minute.');
    if (!res.ok) throw userError(UNAVAILABLE);
    const data = await res.json();
    if (!data || !data.vehicle || !data.vehicle.make) throw userError("We couldn't read the details for " + reg + '. Please try again.');
    return data.vehicle;
  }

  let catalogPromise = null;
  function loadCatalog(collectionUrl) {
    if (!catalogPromise) {
      catalogPromise = (async () => {
        const cacheKey = 'vf-catalog-v1';
        try {
          const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
          if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.products;
        } catch (e) {}
        const page = (n) =>
          fetch(collectionUrl + '?view=vf-fitment&page=' + n).then((r) => {
            if (!r.ok) throw new Error('catalog ' + r.status);
            return r.json();
          });
        const first = await page(1);
        const rest = [];
        for (let n = 2; n <= Math.min(first.pages || 1, 20); n++) rest.push(page(n));
        const products = first.products.concat(...(await Promise.all(rest)).map((p) => p.products));
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), products }));
        } catch (e) {}
        return products;
      })().catch((err) => {
        catalogPromise = null;
        throw userError(UNAVAILABLE);
      });
    }
    return catalogPromise;
  }

  function norm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[‐-―−]/g, '-')
      .toLowerCase();
  }

  function makeRegex(make) {
    const key = String(make || '').toUpperCase().trim();
    const words = MAKE_ALIASES[key] || [norm(key)];
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('(^|[^a-z0-9])(' + escaped.join('|') + ')(?=$|[^a-z0-9])');
  }

  // "2014-2018", "2015 to 2025", "2015-18", "2014 onwards", "2014+"
  function yearRanges(text) {
    const ranges = [];
    const re = /\b((?:19|20)\d{2})\s*(?:-|to|\/)\s*((?:19|20)\d{2}|\d{2})(?!\d)/g;
    let m;
    while ((m = re.exec(text))) {
      const from = +m[1];
      const to = m[2].length === 2 ? Math.floor(from / 100) * 100 + +m[2] : +m[2];
      if (to >= from) ranges.push([from, to]);
    }
    const open = /\b((?:19|20)\d{2})\s*(?:\+|-?\s*(?:onwards?|on|present|now|current)\b)/g;
    while ((m = open.exec(text))) ranges.push([+m[1], 2100]);
    return ranges;
  }

  function singleYears(text) {
    return (text.match(/\b(19[5-9]\d|20[0-3]\d)\b/g) || []).map(Number);
  }

  // "2.0 TDI", "1.8 (2002", "5.3L", "1600cc"
  function engineSizes(text) {
    const out = [];
    const re = /\b([1-6]\.\d)(?:\s*(?:l\b|litre|ltr|tdi|tfsi|tsi|fsi|tdci|hdi|cdi|crdi|dci|cdti|jtd|v6|v8|turbo|petrol|diesel|i\b|t\b|d\b|16v|8v)|(?=\s*[(,|]|\s*$))/g;
    let m;
    while ((m = re.exec(text))) out.push(+m[1]);
    const cc = /\b(\d{3,4})\s*cc\b/g;
    while ((m = cc.exec(text))) out.push(Math.round(+m[1] / 100) / 10);
    return out;
  }

  function shortlist(vehicle, products) {
    const makeRe = makeRegex(vehicle.make);
    const years = [vehicle.year, parseInt(vehicle.firstRegistered, 10)].filter(Boolean);
    const fuel = String(vehicle.fuel || '').toUpperCase();
    const litres = vehicle.engineCc ? Math.round(vehicle.engineCc / 100) / 10 : null;
    const out = [];

    products.forEach((p) => {
      const title = norm(p.t);
      const all = title + ' ' + norm(p.g);
      if (!makeRe.test(all)) return;

      let score = 1;
      let fit = 'check';
      let ranges = yearRanges(title);
      if (!ranges.length) ranges = yearRanges(norm(p.g));
      if (ranges.length) {
        if (!years.length) return;
        if (!ranges.some(([a, b]) => years.some((y) => y >= a && y <= b))) return;
        score += 3;
        fit = 'year';
      } else {
        const singles = singleYears(title);
        if (singles.length && years.length) {
          if (singles.some((s) => years.some((y) => Math.abs(s - y) <= 1))) {
            score += 1;
            fit = 'year';
          } else {
            score -= 1;
          }
        }
      }

      const isDiesel = DIESEL_WORDS.test(all);
      const isPetrol = PETROL_WORDS.test(all);
      if (fuel === 'DIESEL') {
        if (isPetrol && !isDiesel) return;
        if (isDiesel) score += 1;
      }
      if (fuel === 'PETROL') {
        if (isDiesel && !isPetrol) return;
        if (isPetrol) score += 1;
      }

      const sizes = engineSizes(title);
      if (litres && sizes.length) {
        if (!sizes.some((s) => Math.abs(s - litres) <= 0.15)) return;
        score += 2;
      }

      out.push({ product: p, score, fit });
    });

    out.sort((a, b) => b.score - a.score || a.product.t.localeCompare(b.product.t));
    return out;
  }

  window.V6Fitment = { lookupVehicle, loadCatalog, shortlist };
})();
