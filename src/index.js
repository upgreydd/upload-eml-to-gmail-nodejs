// Load environment variables from .env file
require('dotenv').config();

const imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs-extra");
const path = require("path");
const winston = require("winston");
const xoauth2 = require("xoauth2");
const { config } = require("./config");

// Set up logging
const logger = winston.createLogger({
  exitOnError: false,
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} - ${level.toUpperCase()} - ${message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: config.logFile }),
    new winston.transports.Console(),
  ],
});

// IMAP connection
function connectToImap() {
  return new Promise(async (resolve, reject) => {
    try {
      // Prepare IMAP configuration
      let imapConfig = { ...config.imap };

      // Check if xoauth2 is configured
      if (config.xoauth2 && config.xoauth2.clientId && config.xoauth2.clientSecret && config.xoauth2.refreshToken) {
        logger.info("Using xoauth2 authentication");

        // Create xoauth2 generator
        const xoauth2gen = xoauth2.createXOAuth2Generator({
          user: config.imap.user,
          clientId: config.xoauth2.clientId,
          clientSecret: config.xoauth2.clientSecret,
          refreshToken: config.xoauth2.refreshToken,
          accessToken: config.xoauth2.accessToken || undefined
        });

        // Get token
        xoauth2gen.getToken((err, token) => {
          if (err) {
            logger.error(`Failed to get xoauth2 token: ${err.message}`);
            logger.error('Make sure your OAuth2 credentials are correct. See XOAUTH2_SETUP.md for help.');
            return reject(err);
          }

          // Configure IMAP with xoauth2
          imapConfig.xoauth2 = token;
          delete imapConfig.password; // Remove password when using xoauth2

          logger.info("xoauth2 token obtained successfully");
          createImapConnection(imapConfig, resolve, reject);
        });
      } else {
        logger.info("Using password authentication");
        createImapConnection(imapConfig, resolve, reject);
      }
    } catch (err) {
      logger.error(`Error preparing IMAP connection: ${err.message}`);
      reject(err);
    }
  });
}

// Helper function to create IMAP connection
function createImapConnection(imapConfig, resolve, reject) {
  const imapClient = new imap(imapConfig);
  imapClient.once("ready", () => {
    imapClient.openBox(config.gmailLabel, false, (err) => {
      if (err) {
        logger.error(`Failed to open mailbox: ${err.message}`);
        return reject(err);
      }
      logger.info("Connected to IMAP server");
      resolve(imapClient);
    });
  });
  imapClient.once("error", (err) => {
    logger.error(`IMAP connection error: ${err.message}`);
    reject(err);
  });
  imapClient.connect();
}

// Recursively get all files from directory and subdirectories
async function getFilesRecursively(dirPath) {
  const allFiles = [];

  try {
    const items = await fs.readdir(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stats = await fs.stat(fullPath);

      if (stats.isDirectory()) {
        // Recursively scan subdirectory
        const subFiles = await getFilesRecursively(fullPath);
        allFiles.push(...subFiles);
      } else if (stats.isFile()) {
        // Add file path relative to the base directory
        const relativePath = path.relative(config.emlDir, fullPath);
        allFiles.push(relativePath);
      }
    }
  } catch (err) {
    logger.error(`Error reading directory ${dirPath}: ${err.message}`);
  }

  return allFiles;
}

// Load processed files
async function getProcessedFiles() {
  try {
    if (await fs.pathExists(config.processedFile)) {
      const data = await fs.readFile(config.processedFile, "utf8");
      return new Set(data.split("\n").filter(Boolean));
    }
    return new Set();
  } catch (err) {
    logger.error(`Error reading processed files: ${err.message}`);
    return new Set();
  }
}

// Append processed file
async function appendProcessedFile(filename) {
  try {
    await fs.appendFile(config.processedFile, `${filename}\n`);
  } catch (err) {
    logger.error(`Error appending to processed file: ${err.message}`);
  }
}

// Upload .eml file
async function uploadEml(imapClient, emlPath, filename, processedFiles) {
  try {
    // Read and parse .eml file
    logger.info("Reading file...");
    const emlContent = await fs.readFile(emlPath);
    logger.info("Parsing file...");
    const parsed = await simpleParser(emlContent);

    // Get Date header
    logger.info("Parsing date...");
    const dateStr = parsed.headers.get("date");
    const date = new Date(dateStr);

    logger.info(`Date is ${date}`);

    // Upload to Gmail
    return new Promise((resolve, reject) => {
      logger.info("Uploading...");
      imapClient.append(
        emlContent,
        {
          mailbox: config.gmailLabel,
          date: date || null, // Let Gmail set date if null
        },
        (err) => {
          if (err) {
            logger.error(`Failed to upload: ${err.message}`);
            return resolve(false);
          }
          logger.info(`Successfully uploaded`);
          appendProcessedFile(filename);
          resolve(true);
        }
      );
    });
  } catch (err) {
    logger.error(`Error uploading: ${err.message}`);
    return false;
  }
}

// Main function
async function main() {
  let totalFiles = 0;
  let successCount = 0;
  let failureCount = 0;
  let imapClient = null;
  let keepAlive = null;

  try {
    // Connect to IMAP
    imapClient = await connectToImap();

    // Periodic keep-alive
    keepAlive = setInterval(() => {
      imapClient.search(["ALL"], () => { }); // NOOP equivalent
      logger.info(`Keep-alive`);
    }, 1000 * 30); // Every 30 seconds

    // Load processed files
    logger.info("Reading processed files...");
    const processedFiles = await getProcessedFiles();

    // Load list of files recursively
    logger.info("Reading directory recursively...");
    const allFiles = await getFilesRecursively(config.emlDir);

    // Filter .eml files
    logger.info("Filtering .eml files...");
    const emlFiles = allFiles.filter((filePath) =>
      filePath.toLowerCase().endsWith(".eml")
    );

    // Filter not yet processed files
    logger.info("Filtering processed files...");
    const files = emlFiles.filter((filePath) => !processedFiles.has(filePath));

    logger.info(
      `Found ${allFiles.length} file(s), ${emlFiles.length} .eml file(s), ${files.length} file(s) not yet processed`
    );

    // Process .eml files
    for (const filePath of files) {
      totalFiles++;

      logger.info(`Processing ${totalFiles}/${files.length} file: ${filePath}`);

      const emlPath = path.join(config.emlDir, filePath);
      const success = await uploadEml(
        imapClient,
        emlPath,
        filePath,
        processedFiles
      );
      if (success) {
        successCount++;
      } else {
        failureCount++;
      }

      logger.info(
        `Processed ${totalFiles}/${files.length} files: ${successCount} successes, ${failureCount} failures`
      );
    }

    logger.info(
      `Completed. Total files: ${totalFiles}, Successes: ${successCount}, Failures: ${failureCount}`
    );
  } catch (err) {
    logger.error(`Script failed: ${err.message}`);
    throw err; // Re-throw to trigger retry
  } finally {
    // Cleanup keep-alive
    clearInterval(keepAlive);

    // Cleanup IMAP connection
    if (imapClient) {
      try {
        imapClient.end();
        logger.info("IMAP connection closed");
      } catch (endErr) {
        logger.error(`Error closing IMAP connection: ${endErr.message}`);
      }
    }
  }
}

// Retry wrapper
async function runWithRetry(maxRetries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Starting attempt ${attempt} of ${maxRetries}`);
      await main();
      logger.info("Script completed successfully");
      return;
    } catch (err) {
      logger.error(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        logger.error("Max retries reached. Giving up.");
        return;
      }
      logger.info(`Waiting ${delayMs}ms before retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Run script with retry
runWithRetry(100).catch((err) => logger.error(`Fatal error: ${err.message}`));
