#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

const { google } = require('googleapis');
const readline = require('readline');
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

// Create OAuth2 client
const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob' // For installed applications
);

// Gmail scopes
const scopes = [
    'https://mail.google.com/' // Full Gmail access for IMAP
];

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Required to get refresh token
    scope: scopes,
    prompt: 'consent' // Force consent screen to get refresh token
});

console.log('\n🔐 Step 1: Authorize the application');
console.log('Open this URL in your browser:');
console.log(`\n${authUrl}\n`);
console.log('Sign in to your Gmail account and authorize the application.');

// Get authorization code from user
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('📋 Step 2: Paste the authorization code here: ', async (code) => {
    try {
        console.log('\n🔄 Exchanging authorization code for tokens...');

        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
            console.error('\n❌ No refresh token received!');
            console.log('This might happen if you\'ve already authorized this app before.');
            console.log('Try revoking access at https://myaccount.google.com/permissions');
            console.log('Then run this script again.');
            process.exit(1);
        }

        console.log('✅ Tokens received successfully!');

        // Display tokens
        console.log('\n📋 Your OAuth2 tokens:');
        console.log(`Access Token: ${tokens.access_token}`);
        console.log(`Refresh Token: ${tokens.refresh_token}`);
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

    } catch (error) {
        console.error('\n❌ Error exchanging authorization code:');
        console.error(error.message);

        if (error.message.includes('invalid_grant')) {
            console.log('\n💡 The authorization code may be expired or invalid.');
            console.log('Please try running this script again and get a fresh code.');
        }
    }

    rl.close();
});
