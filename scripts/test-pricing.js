// Quick smoke test for the pricing engine.
// Run: node scripts/test-pricing.js

import { quote, quoteAll, recurringPrice } from '../src/conversation/pricing.js';

console.log('=== Single quote: 600 sq ft Khloe, first-time ===');
console.log(quote('khloe', 600, true));

console.log('\n=== Single quote: 800 sq ft Karl, first-time ===');
console.log(quote('karl', 800, true));

console.log('\n=== Single quote: 200 sq ft Khloe (should hit minimum) ===');
console.log(quote('khloe', 200, false));

console.log('\n=== All 3 packages for 800 sq ft yard, first-time ===');
console.table(quoteAll(800, true));

console.log('\n=== All 3 packages for 1200 sq ft yard, regular price ===');
console.table(quoteAll(1200, false));

console.log('\n=== Recurring plan price, $400 base ===');
console.log('Quarterly (15% off):', recurringPrice(400, 'quarterly'));
console.log('Bi-annual (10% off):', recurringPrice(400, 'biannual'));
