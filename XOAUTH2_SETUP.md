# xoauth2 Configuration for Gmail

This document describes how to configure xoauth2 (OAuth2) for secure Gmail connection without using passwords.

## Why xoauth2?

- **Security**: No need to store passwords in configuration
- **Modern**: OAuth2 is a modern authentication standard
- **Control**: You can revoke access at any time through Google Console
- **Compliance**: Gmail prefers OAuth2 over app passwords

## Configuration Steps

### 1. Create Project in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable Gmail API:
   - Navigate to "APIs & Services" > "Library"
   - Find "Gmail API" and click "Enable"

### 2. OAuth2 Configuration

1. In Google Cloud Console, go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth 2.0 Client IDs"
3. Select "Desktop application" as application type
4. Give it a name (e.g., "Gmail EML Importer")
5. Download the JSON credentials file

### 3. Obtaining Refresh Token

You can use an online tool or do it programmatically:

#### Option A: Use OAuth2 Playground

1. Go to [OAuth2 Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon (top right)
3. Check "Use your own OAuth credentials"
4. Enter your Client ID and Client Secret
5. In the left panel, find "Gmail API v1" and select:
   - `https://mail.google.com/` (full Gmail access)
6. Click "Authorize APIs"
7. Sign in to Gmail and confirm permissions
8. Click "Exchange authorization code for tokens"
9. Copy the "Refresh token"

#### Option B: Use Built-in Helper Script (Recommended)

This project includes a helper script that automates the token generation process:

1. First, set your Client ID and Client Secret in `.env` file:
   ```env
   OAUTH2_CLIENT_ID=your-client-id.googleusercontent.com
   OAUTH2_CLIENT_SECRET=your-client-secret
   ```

2. Run the helper script:
   ```bash
   npm run generate-oauth2-token
   ```

3. Follow the prompts:
   - The script will display a URL - open it in your browser
   - Sign in to Gmail and authorize the application
   - Copy the authorization code and paste it when prompted
   - The script will automatically update your `.env` file with the tokens

This method is easier and automatically saves the tokens to your `.env` file.

### 4. Application Configuration

In `src/config.js` file, uncomment and fill the xoauth2 section:

```javascript
// Optional xoauth2 configuration - if provided, will use OAuth2 instead of password
xoauth2: {
  clientId: "your-client-id.googleusercontent.com",
  clientSecret: "your-client-secret",
  refreshToken: "your-refresh-token",
  // accessToken: "your-access-token", // Optional - will be generated automatically
},
```

### 5. Running the Application

When xoauth2 is configured, the application automatically:
- Detects OAuth2 configuration
- Generates access token from refresh token
- Uses xoauth2 instead of password for IMAP connection

## Troubleshooting

### "invalid_client" Error
- Check if Client ID and Client Secret are correct
- Make sure Gmail API is enabled in the project

### "invalid_grant" Error
- Refresh token may be expired
- Generate a new refresh token

### "insufficient_scope" Error
- Make sure you're using scope `https://mail.google.com/`
- You may need to re-authorize with proper scopes

### IMAP Connection Error
- Check if xoauth2 token is properly generated
- Check application logs for error details

## Useful Links

- [Google OAuth2 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [Gmail API Reference](https://developers.google.com/gmail/imap_extensions)
- [xoauth2 Library Documentation](https://github.com/andris9/xoauth2)
- [node-imap xoauth2 Support](https://github.com/mscdex/node-imap#connection-instance-methods)

## Testing Configuration

After configuring xoauth2, you can test the configuration:

```bash
# Generate OAuth2 tokens (if using Option B)
npm run generate-oauth2-token

# Check configuration
npm run check-config

# Test IMAP connection
npm run test-connection

# Run the application
npm start
```

If the configuration is correct, you'll see in the logs:
```
Using xoauth2 authentication
xoauth2 token obtained successfully
Connected to IMAP server
```

## Security

- **Do not commit** Client Secret or Refresh Token to repository
- Use environment variables for sensitive data
- Regularly check permissions in Google Account Security
- Consider rotating credentials periodically
