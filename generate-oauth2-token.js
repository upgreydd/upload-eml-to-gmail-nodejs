#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs-extra');
const path = require('path');

console.log('=== OAuth2 Refresh Token Generator ===\n');

// Check if required credentials are provided
const clientId = process.env.OAUTH2_CLIENT_ID;
const clientSecret = process.env.OAUTH2_CLIENT_SECRET;

if (!clientId || !clientSecret) {
    console.error('❌ Missing OAuth2 credentials in .env file!');
    console.log('\nPlease set the following in your .env file:');
    console.log('OAUTH2_CLIENT_ID=your-client-id.googleusercontent.com');
    console.log('OAUTH2_CLIENT_SECRET=your-client-secret');
    console.log('\nGet these from Google Cloud Console > APIs & Services > Credentials');
    console.log('See XOAUTH2_SETUP.md for detailed instructions.');
    process.exit(1);
}

console.log('✅ Found OAuth2 credentials in .env file');
console.log(`Client ID: ${clientId.substring(0, 20)}...`);

// Determine redirect URI - can be overridden for remote servers
const redirectUri = process.env.OAUTH2_REDIRECT_URI || 'http://localhost:3000/callback';
const serverPort = process.env.OAUTH2_SERVER_PORT || 3000;

console.log(`Using redirect URI: ${redirectUri}`);

// Create OAuth2 client
const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
);// Gmail scopes
const scopes = [
    'https://mail.google.com/' // Full Gmail access for IMAP
];

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Required to get refresh token
    scope: scopes,
    prompt: 'consent' // Force consent screen to get refresh token
});

console.log('\n🔐 Step 1: Starting local server...');

// Create a simple HTTP server to handle the callback
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/callback') {
        const { code, error } = parsedUrl.query;

        if (error) {
            console.error('\n❌ Authorization error:', error);
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`
        <html>
          <body>
            <h1>❌ Authorization Failed</h1>
            <p>Error: ${error}</p>
            <p>You can close this window and try again.</p>
          </body>
        </html>
      `);
            server.close();
            process.exit(1);
        }

        if (code) {
            try {
                console.log('\n🔄 Exchanging authorization code for tokens...');

                // Exchange code for tokens
                const { tokens } = await oauth2Client.getToken(code);

                if (!tokens.refresh_token) {
                    console.error('\n❌ No refresh token received!');
                    console.log('This might happen if you\'ve already authorized this app before.');
                    console.log('Try revoking access at https://myaccount.google.com/permissions');
                    console.log('Then run this script again.');

                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(`
            <html>
              <body>
                <h1>⚠️ No Refresh Token</h1>
                <p>Please revoke access at <a href="https://myaccount.google.com/permissions" target="_blank">Google Account Permissions</a> and try again.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
                    server.close();
                    process.exit(1);
                }

                console.log('✅ Tokens received successfully!');

                // Display tokens (truncated for security)
                console.log('\n📋 Your OAuth2 tokens:');
                console.log(`Access Token: ${tokens.access_token.substring(0, 20)}...`);
                console.log(`Refresh Token: ${tokens.refresh_token.substring(0, 20)}...`);
                console.log(`Expires: ${new Date(tokens.expiry_date)}`);

                // Update .env file
                console.log('\n💾 Updating .env file...');

                const envPath = path.join(process.cwd(), '.env');
                let envContent = '';

                if (await fs.pathExists(envPath)) {
                    envContent = await fs.readFile(envPath, 'utf8');
                }

                // Update or add refresh token
                if (envContent.includes('OAUTH2_REFRESH_TOKEN=')) {
                    envContent = envContent.replace(
                        /OAUTH2_REFRESH_TOKEN=.*/,
                        `OAUTH2_REFRESH_TOKEN=${tokens.refresh_token}`
                    );
                } else {
                    envContent += `\nOAUTH2_REFRESH_TOKEN=${tokens.refresh_token}`;
                }

                // Update or add access token (optional)
                if (envContent.includes('OAUTH2_ACCESS_TOKEN=')) {
                    envContent = envContent.replace(
                        /OAUTH2_ACCESS_TOKEN=.*/,
                        `OAUTH2_ACCESS_TOKEN=${tokens.access_token}`
                    );
                } else {
                    envContent += `\nOAUTH2_ACCESS_TOKEN=${tokens.access_token}`;
                }

                await fs.writeFile(envPath, envContent);

                console.log('✅ .env file updated successfully!');
                console.log('\n🎉 OAuth2 setup complete!');
                console.log('\nYou can now run:');
                console.log('  npm run check-config  # Verify configuration');
                console.log('  npm run test-connection  # Test IMAP connection');
                console.log('  npm start  # Run the EML importer');

                // Send success response
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body>
              <h1>🎉 Success!</h1>
              <p>OAuth2 tokens have been saved to your .env file.</p>
              <p>You can close this window and return to the terminal.</p>
              <script>setTimeout(() => window.close(), 3000);</script>
            </body>
          </html>
        `);

                // Close server after a short delay
                setTimeout(() => {
                    server.close();
                    process.exit(0);
                }, 1000);

            } catch (error) {
                console.error('\n❌ Error exchanging authorization code:');
                console.error(error.message);

                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body>
              <h1>❌ Token Exchange Failed</h1>
              <p>Error: ${error.message}</p>
              <p>Please check the terminal for details and try again.</p>
            </body>
          </html>
        `);

                server.close();
                process.exit(1);
            }
        }
    } else {
        // 404 for other routes
        res.writeHead(404);
        res.end('Not Found');
    }
});

// Start server
const host = redirectUri.includes('localhost') ? 'localhost' : '0.0.0.0';
server.listen(serverPort, host, () => {
    console.log(`✅ Server started on ${host}:${serverPort}`);
    console.log('\n🔐 Step 2: Authorize the application');
    console.log('Open this URL in your browser:');
    console.log(`\n${authUrl}\n`);
    console.log('Sign in to your Gmail account and authorize the application.');
    console.log('The authorization will be handled automatically after you approve access.');
});

// Handle server errors
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${serverPort} is already in use!`);
        console.log(`Please stop any other applications using port ${serverPort} and try again.`);
    } else {
        console.error('❌ Server error:', err.message);
    }
    process.exit(1);
});
