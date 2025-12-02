// Load environment variables from .env file
require('dotenv').config();

const imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs-extra");
const path = require("path");
const winston = require("winston");
const xoauth2 = require("xoauth2");
const { config } = require("./config");

// Configuration for concurrent processing
const WORKER_POOL_SIZE = process.env.WORKER_POOL_SIZE || 2; // Number of concurrent IMAP connections (reduced for Gmail stability)
const BATCH_SIZE = process.env.BATCH_SIZE || 5; // Files per worker batch (reduced for Gmail stability)

// Global file lock to prevent duplicate processing
const processingFiles = new Set();

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

// Helper function to create IMAP connection with auto-retry for auth failures
function createImapConnection(imapConfig, resolve, reject, isRetry = false) {
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

    // If authentication failed and we're using OAuth2, try to refresh token
    if (!isRetry && imapConfig.xoauth2 && (
      err.message.includes('authenticate') ||
      err.message.includes('invalid_token') ||
      err.message.includes('AUTHENTICATIONFAILED') ||
      err.message.includes('Invalid credentials') ||
      err.message.includes('Authentication failed')
    )) {
      logger.info("Authentication failed, attempting to refresh OAuth2 token...");
      refreshTokenAndRetry(imapConfig, resolve, reject);
    } else {
      reject(err);
    }
  });
  imapClient.connect();
}

// Refresh OAuth2 token and retry connection
function refreshTokenAndRetry(originalConfig, resolve, reject) {
  const xoauth2gen = xoauth2.createXOAuth2Generator({
    user: config.imap.user,
    clientId: config.xoauth2.clientId,
    clientSecret: config.xoauth2.clientSecret,
    refreshToken: config.xoauth2.refreshToken
  });

  xoauth2gen.getToken((err, token) => {
    if (err) {
      logger.error(`Failed to refresh OAuth2 token: ${err.message}`);
      return reject(err);
    }

    logger.info("OAuth2 token refreshed successfully, retrying connection...");
    const newConfig = { ...originalConfig, xoauth2: token };
    createImapConnection(newConfig, resolve, reject, true); // Mark as retry
  });
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

// Check if email already exists in Gmail
async function isEmailAlreadyImported(imapClient, messageId, subject, date) {
  return new Promise((resolve, reject) => {
    if (!messageId && !subject) {
      return resolve(false); // Can't check without identifiers
    }

    let searchCriteria = [];

    if (messageId) {
      // Search by Message-ID header (most reliable)
      searchCriteria = [['HEADER', 'MESSAGE-ID', messageId]];
    } else if (subject && date) {
      // Fallback: search by subject and date
      const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      searchCriteria = [
        ['HEADER', 'SUBJECT', subject],
        ['ON', dateStr]
      ];
    } else {
      return resolve(false);
    }

    imapClient.search(searchCriteria, (err, results) => {
      if (err) {
        logger.warn(`Error searching for duplicate: ${err.message}`);
        return resolve(false); // Continue with upload on search error
      }

      const exists = results && results.length > 0;
      if (exists) {
        logger.info(`Email already exists (found ${results.length} match(es))`);
      }
      resolve(exists);
    });
  });
}

// Worker class for handling concurrent uploads
class EmailWorker {
  constructor(workerId) {
    this.workerId = workerId;
    this.imapClient = null;
    this.keepAlive = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      logger.info(`Worker ${this.workerId}: Connecting to IMAP...`);
      this.imapClient = await connectToImap();
      this.isConnected = true;

      // Start keep-alive for this worker
      this.keepAlive = setInterval(() => {
        if (this.imapClient && this.isConnected) {
          this.imapClient.search(["ALL"], () => { });
        }
      }, 45000); // Every 45 seconds

      logger.info(`Worker ${this.workerId}: Connected successfully`);
    } catch (err) {
      logger.error(`Worker ${this.workerId}: Connection failed - ${err.message}`);
      throw err;
    }
  }

  async processFile(filePath) {
    if (!this.isConnected || !this.imapClient) {
      throw new Error(`Worker ${this.workerId}: Not connected to IMAP`);
    }

    // Check if file is already being processed by another worker
    if (processingFiles.has(filePath)) {
      logger.warn(`Worker ${this.workerId}: File ${filePath} already being processed by another worker, skipping`);
      return true; // Skip but don't fail
    }

    // Lock the file for processing
    processingFiles.add(filePath);

    try {
      const emlPath = path.join(config.emlDir, filePath);
      const result = await uploadEml(this.imapClient, emlPath, filePath);
      return result;
    } finally {
      // Always unlock the file when done
      processingFiles.delete(filePath);
    }
  }

  async disconnect() {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }

    if (this.imapClient && this.isConnected) {
      try {
        this.imapClient.end();
        logger.info(`Worker ${this.workerId}: Disconnected`);
      } catch (err) {
        logger.error(`Worker ${this.workerId}: Error disconnecting - ${err.message}`);
      }
    }

    this.isConnected = false;
    this.imapClient = null;
  }
}

// Thread-safe progress tracker with mutex-like behavior
class ProgressTracker {
  constructor(totalFiles) {
    this.totalFiles = totalFiles;
    this.processedCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.lastReported = 0;
    this.processing = false;
  }

  async recordResult(success, filePath = '') {
    // Simple mutex to prevent race conditions
    while (this.processing) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    this.processing = true;

    try {
      this.processedCount++;
      if (success) {
        this.successCount++;
        logger.debug(`✓ Successfully processed: ${filePath}`);
      } else {
        this.failureCount++;
        logger.warn(`✗ Failed to process: ${filePath}`);
      }

      // Report progress every 25 files or on significant milestones
      if (this.processedCount - this.lastReported >= 25 ||
        this.processedCount === this.totalFiles ||
        this.processedCount % 100 === 0) {
        logger.info(`📊 Progress: ${this.processedCount}/${this.totalFiles} files processed (${this.successCount} success, ${this.failureCount} failed)`);
        this.lastReported = this.processedCount;
      }
    } finally {
      this.processing = false;
    }
  } getResults() {
    return {
      totalFiles: this.totalFiles,
      successCount: this.successCount,
      failureCount: this.failureCount
    };
  }
}

// Process files concurrently using worker pool
async function processFilesConcurrently(files) {
  const workers = [];
  const progressTracker = new ProgressTracker(files.length);
  let lastProgressTime = Date.now();
  let lastProgressCount = 0;

  // Watchdog to detect stalled processing
  const progressWatchdog = setInterval(() => {
    const currentTime = Date.now();
    const timeSinceLastProgress = currentTime - lastProgressTime;

    if (progressTracker.processedCount > lastProgressCount) {
      // Progress detected, update tracking
      lastProgressTime = currentTime;
      lastProgressCount = progressTracker.processedCount;
    } else if (timeSinceLastProgress > 300000) { // 5 minutes without progress
      logger.warn(`⚠️ Processing appears stalled - no progress for ${Math.round(timeSinceLastProgress / 1000)}s`);
      logger.info(`Last progress: ${progressTracker.processedCount}/${progressTracker.totalFiles} files processed`);
      lastProgressTime = currentTime; // Reset to avoid spam
    }
  }, 60000); // Check every minute

  try {
    // Create worker pool
    logger.info(`Creating ${WORKER_POOL_SIZE} workers...`);
    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
      const worker = new EmailWorker(i + 1);
      await worker.connect();
      workers.push(worker);
    }

    // Split files into batches for workers
    const batches = [];
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      batches.push(files.slice(i, i + BATCH_SIZE));
    }

    logger.info(`Processing ${files.length} files in ${batches.length} batches using ${workers.length} workers...`);

    // Process batches concurrently - each batch gets its own dedicated worker
    const workerPromises = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const worker = workers[i % workers.length];

      const promise = (async () => {
        const batchResults = { success: 0, failure: 0 };

        for (const filePath of batch) {
          try {
            logger.debug(`Worker ${worker.workerId}: Processing ${filePath}`);

            const success = await worker.processFile(filePath);

            // Add small delay to reduce Gmail API pressure
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay

            if (success) {
              batchResults.success++;
            } else {
              batchResults.failure++;
            }

            // Record progress in thread-safe way
            await progressTracker.recordResult(success, filePath);

          } catch (err) {
            logger.error(`Worker ${worker.workerId}: Failed to process ${filePath} - ${err.message}`);
            batchResults.failure++;
            await progressTracker.recordResult(false, filePath);
          }
        }

        logger.info(`Worker ${worker.workerId}: Batch completed - ${batchResults.success} success, ${batchResults.failure} failed`);
        return batchResults;
      })();

      workerPromises.push(promise);
    }    // Wait for all workers to complete
    const batchResults = await Promise.all(workerPromises);

    const finalResults = progressTracker.getResults();
    logger.info(`All workers completed. Total: ${finalResults.totalFiles}, Success: ${finalResults.successCount}, Failed: ${finalResults.failureCount}`);

  } finally {
    // Clear progress watchdog
    clearInterval(progressWatchdog);

    // Disconnect all workers
    logger.info("Disconnecting workers...");
    await Promise.all(workers.map(worker => worker.disconnect()));
  }

  return progressTracker.getResults();
}

// Timeout wrapper for operations that might hang
function withTimeout(promise, timeoutMs, operation) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

// Upload .eml file
async function uploadEml(imapClient, emlPath, filename) {
  try {
    // Double-check processed files first (fastest check)
    const currentProcessedFiles = await getProcessedFiles();
    if (currentProcessedFiles.has(filename)) {
      logger.debug(`File ${filename} already in processed list, skipping`);
      return true;
    }

    // Read and parse .eml file
    const emlContent = await fs.readFile(emlPath);
    const parsed = await simpleParser(emlContent);

    // Get Date header
    const dateStr = parsed.headers.get("date");
    const date = new Date(dateStr);

    // Check for duplicates in Gmail with timeout
    logger.debug(`Checking Gmail for duplicates of ${filename}...`);
    const messageId = parsed.headers.get("message-id");
    const subject = parsed.subject;

    const alreadyExists = await withTimeout(
      isEmailAlreadyImported(imapClient, messageId, subject, date),
      120000, // 2 minute timeout for duplicate check
      `Duplicate check for ${filename}`
    );

    if (alreadyExists) {
      logger.debug(`Email ${filename} already exists in Gmail, skipping upload`);
      await appendProcessedFile(filename);
      return true; // Mark as successful since it's already there
    }

    // Upload to Gmail with timeout
    const uploadPromise = new Promise((resolve, reject) => {
      logger.debug(`Uploading ${filename} to Gmail...`);
      imapClient.append(
        emlContent,
        {
          mailbox: config.gmailLabel,
          date: date || null, // Let Gmail set date if null
        },
        (err) => {
          if (err) {
            // Check if it's a temporary error that should be retried
            if (err.message.includes('System Error') || err.message.includes('Temporary failure') || err.message.includes('UNAVAILABLE')) {
              logger.warn(`Temporary upload failure for ${filename}: ${err.message} - will retry later`);
            } else {
              logger.error(`Failed to upload ${filename}: ${err.message}`);
            }
            return resolve(false);
          }
          logger.debug(`Successfully uploaded ${filename}`);
          appendProcessedFile(filename);
          resolve(true);
        }
      );
    });

    return await withTimeout(
      uploadPromise,
      180000, // 3 minute timeout for upload
      `Upload of ${filename}`
    );

  } catch (err) {
    if (err.message.includes('timed out')) {
      logger.warn(`Operation timeout for ${filename}: ${err.message}`);
    } else {
      logger.error(`Error uploading ${filename}: ${err.message}`);
    }
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
    const unprocessedFiles = emlFiles.filter((filePath) => !processedFiles.has(filePath));

    logger.info(
      `Found ${allFiles.length} file(s), ${emlFiles.length} .eml file(s), ${unprocessedFiles.length} file(s) not yet processed`
    );

    const files = unprocessedFiles;

    if (files.length === 0) {
      logger.info("No files to process.");
      return;
    }

    // Process .eml files concurrently
    const results = await processFilesConcurrently(files);

    totalFiles = results.totalFiles;
    successCount = results.successCount;
    failureCount = results.failureCount;

    logger.info(
      `Completed. Total files: ${totalFiles}, Successes: ${successCount}, Failures: ${failureCount}`
    );
  } catch (err) {
    logger.error(`Script failed: ${err.message}`);
    throw err; // Re-throw to trigger retry
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
