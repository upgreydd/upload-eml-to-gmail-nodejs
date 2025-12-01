#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

const { google } = require('googleapis');

console.log('=== OAuth2 Authorization URL Generator ===\n');

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

// Get redirect URI from environment or use default
const redirectUri = process.env.OAUTH2_REDIRECT_URI || 'http://localhost:3000/callback';

// Create OAuth2 client
const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
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

console.log('\n📋 Authorization URL:');
console.log('==========================================');
console.log(authUrl);
console.log('==========================================\n');

console.log('📝 Instructions:');
console.log('1. Copy the URL above and open it in your browser');
console.log('2. Sign in to your Gmail account and authorize the application');
console.log('3. You will be redirected to your callback URL with a "code" parameter');
console.log('4. Copy the authorization code from the URL');
console.log('\n💡 For automatic token exchange, use: npm run generate-oauth2-token');
console.log('💡 Make sure your redirect URI matches what you configured in Google Cloud Console');
