// One-time helper to bootstrap a Jobber refresh token.
//
// Run this ONCE on Dalis's Mac to grant the SCT Sales Agent permission to
// create requests in Jobber. After this runs successfully you'll have a
// JOBBER_REFRESH_TOKEN to paste into .env (and into Railway env vars when
// you deploy).
//
// Prereqs:
//   1. You've registered a developer app at https://developer.getjobber.com
//   2. JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET are set in .env
//   3. The app's redirect URI is set to: http://localhost:8765/callback
//   4. The app has scopes including: read_clients write_clients write_requests
//
// Run:  node scripts/jobber-auth.js
// Then: open the printed URL in your browser, log into Jobber, click Allow.
// The script catches the callback, exchanges the code, and prints your token.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Tiny zero-dep .env loader (matches the rest of the app)
try {
  const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch (e) { /* .env optional */ }

const CLIENT_ID = process.env.JOBBER_CLIENT_ID;
const CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8765/callback';
const PORT = 8765;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET must be set in .env first.');
  console.error('   See JOBBER_SETUP.md for how to register your Jobber app.\n');
  process.exit(1);
}

// Jobber-recommended scopes for our use case (read clients, create clients, create requests).
const SCOPES = [
  'read_clients',
  'write_clients',
  'write_requests',
].join(' ');

const authUrl =
  'https://api.getjobber.com/api/oauth/authorize' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}`;

console.log('\n🔑 Jobber OAuth bootstrap');
console.log('━'.repeat(70));
console.log('\n1) Open this URL in your browser, log in, and click Allow:\n');
console.log('   ' + authUrl);
console.log('\n2) Jobber will redirect back to localhost — this script will catch it.');
console.log('\n   (Listening on http://localhost:' + PORT + ' ... Ctrl+C to abort)\n');

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${err}`);
  }
  return res.json();
}

const server = createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>❌ Jobber returned an error</h1><pre>${error}</pre>`);
    console.error(`\n❌ Jobber error: ${error}\n`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    return res.end('<h1>Missing ?code in callback.</h1>');
  }

  try {
    const tokens = await exchangeCodeForToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>✅ Done — you can close this tab.</h1>
      <p>Your refresh token has been printed to the terminal where you ran the script.</p>
    `);

    console.log('\n✅ Success! Tokens received.\n');
    console.log('━'.repeat(70));
    console.log('Paste this into your .env (and into Railway env vars when deploying):\n');
    console.log(`JOBBER_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('━'.repeat(70));
    console.log('\nAccess token (short-lived, you do NOT need to save this):');
    console.log(`  ${tokens.access_token.slice(0, 24)}...  (expires in ${tokens.expires_in}s)\n`);
    console.log('Next: open .env, paste the JOBBER_REFRESH_TOKEN line, save.\n');
    console.log('Then verify with:  node scripts/test-jobber.js\n');

    server.close();
    setTimeout(() => process.exit(0), 200);
  } catch (e) {
    console.error('\n❌ Token exchange failed:', e.message, '\n');
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h1>Token exchange failed</h1><pre>${e.message}</pre>`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
