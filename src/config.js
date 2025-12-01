module.exports.config = {
  imap: {
    user: process.env.GMAIL_USER || undefined, // Replace with your Gmail address
    password: process.env.GMAIL_PASSWORD || undefined, // Replace with App-Specific Password (not needed for xoauth2)
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  },
  // Optional xoauth2 configuration - if provided, will use OAuth2 instead of password
  xoauth2: {
    // Uncomment and fill these for OAuth2 authentication:
    // Or use environment variables for better security:
    clientId: process.env.OAUTH2_CLIENT_ID || undefined, // "your-client-id.googleusercontent.com",
    clientSecret: process.env.OAUTH2_CLIENT_SECRET || undefined, // "your-client-secret",
    refreshToken: process.env.OAUTH2_REFRESH_TOKEN || undefined, // "your-refresh-token",
    accessToken: process.env.OAUTH2_ACCESS_TOKEN || undefined, // Optional - will be generated if not provided
  },
  emlDir: process.env.EML_DIR || "/path/to/eml/files/", // Directory containing .eml files
  gmailLabel: process.env.GMAIL_LABEL || "Imported", // Gmail label to upload to (create in Gmail first)
  logFile: process.env.LOG_FILE || "import_eml_log.txt",
  processedFile: process.env.PROCESSED_FILE || "processed_eml.txt", // Tracks processed files
};
