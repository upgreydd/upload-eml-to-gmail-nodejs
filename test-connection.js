#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

const imap = require("imap");
const xoauth2 = require("xoauth2");
const { config } = require('./src/config');

console.log('=== IMAP Connection Test ===\n');

async function testConnection() {
    try {
        // Prepare IMAP configuration
        let imapConfig = { ...config.imap };

        // Check if xoauth2 is configured
        if (config.xoauth2 && config.xoauth2.clientId && config.xoauth2.clientSecret && config.xoauth2.refreshToken) {
            console.log('🔐 Testing OAuth2 authentication...');

            // Create xoauth2 generator
            const xoauth2gen = xoauth2.createXOAuth2Generator({
                user: config.imap.user,
                clientId: config.xoauth2.clientId,
                clientSecret: config.xoauth2.clientSecret,
                refreshToken: config.xoauth2.refreshToken,
                accessToken: config.xoauth2.accessToken || undefined
            });

            // Get token
            const token = await new Promise((resolve, reject) => {
                xoauth2gen.getToken((err, token) => {
                    if (err) reject(err);
                    else resolve(token);
                });
            });

            console.log('✅ OAuth2 token generated successfully');

            // Configure IMAP with xoauth2
            imapConfig.xoauth2 = token;
            delete imapConfig.password; // Remove password when using xoauth2
        } else {
            console.log('🔑 Testing password authentication...');
        }

        // Test IMAP connection
        console.log(`🌐 Connecting to ${imapConfig.host}:${imapConfig.port}...`);

        const imapClient = await new Promise((resolve, reject) => {
            const client = new imap(imapConfig);
            client.once('ready', () => resolve(client));
            client.once('error', reject);
            client.connect();
        });

        console.log('✅ IMAP connection successful');

        // Test opening mailbox
        console.log(`📁 Opening mailbox: ${config.gmailLabel}...`);

        await new Promise((resolve, reject) => {
            imapClient.openBox(config.gmailLabel, true, (err, box) => {
                if (err) reject(err);
                else {
                    console.log(`✅ Mailbox opened successfully (${box.messages.total} messages)`);
                    resolve();
                }
            });
        });

        // Clean up
        imapClient.end();
        console.log('\n🎉 All tests passed! Your configuration is working correctly.');

    } catch (error) {
        console.error('\n❌ Connection test failed:');
        console.error(`   ${error.message}`);
        console.log('\n💡 Troubleshooting tips:');

        if (error.message.includes('invalid_grant') || error.message.includes('invalid_client')) {
            console.log('   - Check your OAuth2 credentials (Client ID, Client Secret, Refresh Token)');
            console.log('   - Your refresh token might be expired - generate a new one');
            console.log('   - See XOAUTH2_SETUP.md for detailed setup instructions');
        } else if (error.message.includes('authenticate')) {
            console.log('   - Check your Gmail username and password/OAuth2 credentials');
            console.log('   - Make sure IMAP is enabled in Gmail settings');
            console.log('   - If using password auth, use App-Specific Password (not regular password)');
        } else if (error.message.includes('NONEXISTENT')) {
            console.log(`   - The Gmail label "${config.gmailLabel}" does not exist`);
            console.log('   - Create the label in Gmail or update GMAIL_LABEL setting');
        } else {
            console.log('   - Check your network connection');
            console.log('   - Make sure Gmail IMAP is enabled');
            console.log('   - Check firewall settings');
        }

        process.exit(1);
    }
}

testConnection();
