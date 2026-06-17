import { createServer } from 'node:http';
import { google } from 'googleapis';
import { env } from '../src/config/env';

/**
 * One-time helper to mint a Google OAuth refresh token for the Calendar API.
 *
 * Prereqs (in Google Cloud Console):
 *  1. Create an OAuth 2.0 Client ID (type: Web application).
 *  2. Add this redirect URI:  http://localhost:53682/callback
 *  3. Put the client id/secret in .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 *
 * Then run:  npm run get-google-token
 * Open the printed URL, consent, and copy the GOOGLE_REFRESH_TOKEN it prints.
 */
const REDIRECT = 'http://localhost:53682/callback';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, REDIRECT);
const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

console.log('\n1) Open this URL and grant access:\n');
console.log(url, '\n');

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('missing code');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Done — you can close this tab and return to the terminal.');
    console.log('\n2) Add this to your .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (err) {
    res.writeHead(500).end('token exchange failed');
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(53682, () => console.log('Waiting for the OAuth redirect on', REDIRECT, '...'));
