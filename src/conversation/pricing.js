// Turf Defenders — pricing engine.
// Pure functions, no side effects. Used by conversation engine when AI needs to quote.

export const PACKAGES = {
  deep: {
    id: 'deep',
    name: 'Deep Clean',
    tagline: 'Standard Deep Clean',
    rate: 0.60,
    minimum: 306,           // pre-discount floor so post-discount never dips below $275
    firstTimeMinimum: 275,  // hard floor on discounted price
    includes: [
      'Power brush and fluff turf',
      'Vacuum up debris',
      'Deodorize and sanitize with hydrogen peroxide based formula',
      'Odor removal treatment',
     
    ],
    bestFor: 'Odor removal and regular maintenance',
  },
  extraction: {
    id: 'extraction',
    name: 'Extraction',
    tagline: 'Extraction Service',
    rate: 0.82,
    minimum: 473,           // pre-discount floor so post-discount never dips below $425
    firstTimeMinimum: 425,  // hard floor on discounted price
    includes: [
      'Everything in the deep clean',
      'Carpet-extraction process — sucks out deep buildup',
      'Special oxy turf formula',
      'Odor-reducing infill',
    ],
    bestFor: 'Heavy odor, multiple pets, years of buildup',
  },
};

export const FIRST_TIME_DISCOUNT = 0.10; // 10% off — special we're running right now
export const BIANNUAL_DISCOUNT = 0.10;   // 10% off each visit on bi-annual plan
export const QUARTERLY_DISCOUNT = 0.15;  // 15% off each visit on quarterly plan

// Global minimum job price — no quote ever goes below this.
export const MINIMUM_JOB_PRICE = 200;

/**
 * Quote a single package for a given yard size.
 * @param {string} packageId  - 'deep' | 'extraction'
 * @param {number} sqft       - yard square footage
 * @param {boolean} firstTime - apply 10% special discount?
 */
export function quote(packageId, sqft, firstTime = false) {
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new Error(`Unknown package: ${packageId}`);
  if (sqft <= 0) throw new Error(`Invalid sq ft: ${sqft}`);

  const baseRaw = sqft * pkg.rate;
  const baseQuote = Math.max(pkg.minimum, MINIMUM_JOB_PRICE, Math.round(baseRaw));
  let discounted = firstTime
    ? Math.round(baseQuote * (1 - FIRST_TIME_DISCOUNT))
    : baseQuote;
  if (firstTime && pkg.firstTimeMinimum && discounted < pkg.firstTimeMinimum) {
    discounted = pkg.firstTimeMinimum;
  }
  if (discounted < MINIMUM_JOB_PRICE) discounted = MINIMUM_JOB_PRICE;

  return {
    package: pkg.name,
    sqft,
    base: baseQuote,
    firstTime: discounted,
    appliedMinimum: baseRaw < pkg.minimum,
  };
}

/**
 * Quote all packages — used at the pitch step.
 */
export function quoteAll(sqft, firstTime = false) {
  return {
    deep: quote('deep', sqft, firstTime),
    extraction: quote('extraction', sqft, firstTime),
  };
}

/**
 * Recurring plan price per visit, given a base package price.
 */
export function recurringPrice(baseVisitPrice, cadence) {
  const discount =
    cadence === 'quarterly' ? QUARTERLY_DISCOUNT
    : cadence === 'biannual' ? BIANNUAL_DISCOUNT
    : 0;
  return Math.round(baseVisitPrice * (1 - discount));
}
