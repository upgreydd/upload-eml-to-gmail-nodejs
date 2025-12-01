#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

const { config } = require('./src/config');

console.log('=== Application Configuration ===\n');

// Check basic settings
console.log('IMAP Configuration:');
console.log(`  User: ${config.imap.user}`);
console.log(`  Host: ${config.imap.host}:${config.imap.port}`);
console.log(`  TLS: ${config.imap.tls}`);

// Check authentication method
if (config.xoauth2.clientId && config.xoauth2.clientSecret && config.xoauth2.refreshToken) {
    console.log('\n✅ OAuth2 Configuration detected:');
    console.log(`  Client ID: ${config.xoauth2.clientId.substring(0, 20)}...`);
    console.log(`  Client Secret: ${config.xoauth2.clientSecret ? '***CONFIGURED***' : 'NOT SET'}`);
    console.log(`  Refresh Token: ${config.xoauth2.refreshToken ? '***CONFIGURED***' : 'NOT SET'}`);
    console.log(`  Access Token: ${config.xoauth2.accessToken ? '***PROVIDED***' : 'Will be generated'}`);
    console.log('\n🔒 Will use OAuth2 authentication (recommended)');
} else if (config.imap.password) {
    console.log('\n⚠️  Password authentication detected');
    console.log(`  Password: ${config.imap.password ? '***CONFIGURED***' : 'NOT SET'}`);
    console.log('\n🔑 Will use password authentication');
} else {
    console.log('\n❌ No authentication method configured!');
    console.log('\nPlease configure either:');
    console.log('1. OAuth2 (recommended): Set OAUTH2_CLIENT_ID, OAUTH2_CLIENT_SECRET, OAUTH2_REFRESH_TOKEN');
    console.log('2. Password: Set GMAIL_PASSWORD');
    console.log('\nSee XOAUTH2_SETUP.md for OAuth2 setup instructions.');
    process.exit(1);
}

// Check remaining settings
console.log('\nApplication Configuration:');
console.log(`  EML Directory: ${config.emlDir}`);
console.log(`  Gmail Label: ${config.gmailLabel}`);
console.log(`  Log File: ${config.logFile}`);
console.log(`  Processed File: ${config.processedFile}`);

// Check if EML directory exists
const fs = require('fs-extra');
if (fs.pathExistsSync(config.emlDir)) {
    console.log('✅ EML directory exists');
} else {
    console.log('⚠️  EML directory does not exist - please create it or update EML_DIR');
}

console.log('\n=== Status: Configuration looks good! ===');
console.log('To run the import: npm start');
