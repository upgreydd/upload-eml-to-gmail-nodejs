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
const WORKER_POOL_SIZE = process.env.WORKER_POOL_SIZE || 1; // Number of concurrent IMAP connections (reduced to prevent Gmail limits)
const BATCH_SIZE = process.env.BATCH_SIZE || 3; // Files per worker batch (reduced for memory efficiency)

// Global file lock to prevent duplicate processing
const processingFiles = new Set();

// Track duplicate check failures to disable if unreliable
let duplicateCheckFailures = 0;
const MAX_DUPLICATE_CHECK_FAILURES = 10;
let skipDuplicateChecks = false;

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

        try {
          // Get valid token (cached or refreshed)
          const token = await getValidOAuth2Token();

          // Configure IMAP with xoauth2
          imapConfig.xoauth2 = token;
          delete imapConfig.password; // Remove password when using xoauth2

          logger.info("xoauth2 token obtained successfully");
          createImapConnection(imapConfig, resolve, reject);
        } catch (err) {
          logger.error(`Failed to get xoauth2 token: ${err.message}`);
          logger.error('Make sure your OAuth2 credentials are correct. See XOAUTH2_SETUP.md for help.');
          return reject(err);
        }
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
    imapClient.openBox(config.gmailLabel, false, (err, box) => {
      if (err) {
        logger.error(`Failed to open mailbox "${config.gmailLabel}": ${err.message}`);
        return reject(err);
      }
      logger.info(`Connected to IMAP server - opened mailbox "${config.gmailLabel}" with ${box.messages.total} messages`);
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

// Global OAuth2 token management
let globalOAuth2Token = null;
let lastTokenRefresh = 0;
const TOKEN_REFRESH_INTERVAL = 45 * 60 * 1000; // Refresh every 45 minutes
let tokenRefreshPromise = null; // Prevent concurrent refreshes

// Get or refresh OAuth2 token with caching
async function getValidOAuth2Token(forceRefresh = false) {
  // If a refresh is already in progress, wait for it
  if (tokenRefreshPromise) {
    logger.info("Token refresh already in progress, waiting...");
    return await tokenRefreshPromise;
  }

  // Check if we need to refresh
  const needsRefresh = forceRefresh ||
    !globalOAuth2Token ||
    (Date.now() - lastTokenRefresh > TOKEN_REFRESH_INTERVAL);

  if (!needsRefresh) {
    return globalOAuth2Token;
  }

  // Start token refresh
  tokenRefreshPromise = refreshOAuth2Token();

  try {
    const token = await tokenRefreshPromise;
    globalOAuth2Token = token;
    return token;
  } finally {
    tokenRefreshPromise = null;
  }
}

// Proactive OAuth2 token refresh
async function refreshOAuth2Token() {
  return new Promise((resolve, reject) => {
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

      lastTokenRefresh = Date.now();
      logger.info("OAuth2 token refreshed successfully");
      resolve(token);
    });
  });
}

// Ensure token is valid for chunk processing
async function ensureValidTokenForChunk() {
  if (config.xoauth2 && config.xoauth2.clientId) {
    try {
      await getValidOAuth2Token(); // This will refresh if needed
      logger.info("OAuth2 token validated for chunk processing");
      return true;
    } catch (err) {
      logger.error(`Token validation failed: ${err.message}`);
      return false;
    }
  }
  return true;
}

// Refresh OAuth2 token and retry connection
async function refreshTokenAndRetry(originalConfig, resolve, reject) {
  try {
    logger.info("Authentication failed, attempting to refresh OAuth2 token...");
    const token = await getValidOAuth2Token(true); // Force refresh

    logger.info("OAuth2 token refreshed successfully, retrying connection...");
    const newConfig = { ...originalConfig, xoauth2: token };
    createImapConnection(newConfig, resolve, reject, true); // Mark as retry
  } catch (err) {
    logger.error(`Failed to refresh OAuth2 token: ${err.message}`);
    reject(err);
  }
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

// Load processed files (streaming for memory efficiency)
async function getProcessedFiles() {
  const processedFiles = new Set();

  try {
    if (await fs.pathExists(config.processedFile)) {
      const readline = require('readline');
      const fileStream = fs.createReadStream(config.processedFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          processedFiles.add(line.trim());
        }
      }
    }

    logger.info(`Loaded ${processedFiles.size} processed files from tracking file`);
    return processedFiles;
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

// Check if email already exists in Gmail (with proper error handling)
async function isEmailAlreadyImported(imapClient, messageId, subject, date) {
  return new Promise((resolve, reject) => {
    // Validate connection state first
    if (!imapClient || imapClient.state !== 'authenticated') {
      logger.warn(`IMAP client not in authenticated state (state: ${imapClient ? imapClient.state : 'null'})`);
      return resolve(false);
    }

    if (!messageId && !subject) {
      return resolve(false); // Can't check without identifiers
    }

    // Build search criteria - use Gmail-specific syntax
    let searchCriteria = [];

    if (messageId) {
      // Clean up Message-ID (remove brackets if present for Gmail compatibility)
      const cleanMessageId = messageId.replace(/^<|>$/g, '');
      logger.debug(`Searching for Message-ID: ${cleanMessageId}`);
      searchCriteria = [['HEADER', 'MESSAGE-ID', cleanMessageId]];
    } else if (subject && date) {
      // Fallback: search by subject and date
      const dateStr = date.toDateString(); // Use more compatible date format
      logger.debug(`Searching for subject: "${subject}" on date: ${dateStr}`);
      searchCriteria = [
        ['HEADER', 'SUBJECT', subject],
        ['ON', dateStr]
      ];
    } else {
      return resolve(false);
    }

    // Add timeout handler at IMAP level with more detailed logging
    const timeout = setTimeout(() => {
      logger.warn(`IMAP search timeout after 30s for criteria: ${JSON.stringify(searchCriteria)}`);
      resolve(false);
    }, 30000);

    try {
      imapClient.search(searchCriteria, (err, results) => {
        clearTimeout(timeout);

        if (err) {
          logger.warn(`IMAP search error: ${err.message} (criteria: ${JSON.stringify(searchCriteria)})`);
          return resolve(false); // Continue with upload on search error
        }

        const exists = results && results.length > 0;
        if (exists) {
          logger.info(`Email already exists (found ${results.length} match(es) for Message-ID: ${messageId})`);
        } else {
          logger.debug(`No duplicate found for Message-ID: ${messageId}`);
        }
        resolve(exists);
      });
    } catch (syncErr) {
      clearTimeout(timeout);
      logger.warn(`IMAP search exception: ${syncErr.message}`);
      resolve(false);
    }
  });
}// Worker class for handling concurrent uploads
class EmailWorker {
  constructor(workerId) {
    this.workerId = workerId;
    this.imapClient = null;
    this.keepAlive = null;
    this.isConnected = false;
  }

  async connect(retryCount = 0) {
    const maxRetries = 3;
    const baseDelay = 5000; // 5 seconds base delay

    try {
      logger.info(`Worker ${this.workerId}: Connecting to IMAP... (attempt ${retryCount + 1}/${maxRetries + 1})`);
      this.imapClient = await connectToImap();
      this.isConnected = true;

      // Start keep-alive for this worker (reduced frequency to avoid connection issues)
      this.keepAlive = setInterval(() => {
        if (this.imapClient && this.isConnected) {
          this.imapClient.search(["ALL"], () => { });
        }
      }, 120000); // Every 2 minutes (reduced from 45 seconds)

      logger.info(`Worker ${this.workerId}: Connected successfully`);
    } catch (err) {
      this.isConnected = false;

      if (err.message.includes('Too many simultaneous connections') && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff: 5s, 10s, 20s
        logger.warn(`Worker ${this.workerId}: Gmail connection limit reached, retrying in ${delay / 1000}s... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.connect(retryCount + 1);
      }

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
    // Read and parse .eml file
    const emlContent = await fs.readFile(emlPath);
    const parsed = await simpleParser(emlContent);

    // Get Date header
    const dateStr = parsed.headers.get("date");
    const date = new Date(dateStr);

    // Check for duplicates in Gmail with timeout (with fallback mechanism)
    let alreadyExists = false;

    if (!skipDuplicateChecks) {
      try {
        // Validate IMAP connection state before duplicate check
        if (!imapClient || imapClient.state !== 'authenticated') {
          throw new Error(`IMAP connection not ready (state: ${imapClient ? imapClient.state : 'null'})`);
        }

        logger.debug(`Checking Gmail for duplicates of ${filename}...`);
        const messageId = parsed.headers.get("message-id");
        const subject = parsed.subject;

        logger.debug(`Message-ID: ${messageId}, Subject: ${subject ? subject.substring(0, 50) + '...' : 'none'}`);

        alreadyExists = await withTimeout(
          isEmailAlreadyImported(imapClient, messageId, subject, date),
          45000, // 45 second timeout for duplicate check (reduced)
          `Duplicate check for ${filename}`
        );

        if (alreadyExists) {
          logger.debug(`Email ${filename} already exists in Gmail, skipping upload`);
          await appendProcessedFile(filename);
          return true; // Mark as successful since it's already there
        }
      } catch (err) {
        duplicateCheckFailures++;
        logger.warn(`Duplicate check failed for ${filename}: ${err.message} (failure ${duplicateCheckFailures}/${MAX_DUPLICATE_CHECK_FAILURES})`);

        if (duplicateCheckFailures >= MAX_DUPLICATE_CHECK_FAILURES) {
          skipDuplicateChecks = true;
          logger.warn(`Too many duplicate check failures (${duplicateCheckFailures}). Disabling duplicate checks for performance.`);
        }
        // Continue with upload if duplicate check fails
      }
    } else {
      logger.debug(`Skipping duplicate check for ${filename} (disabled due to previous failures)`);
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

// Process files sequentially (one by one) for maximum stability
async function processFilesSequentially(files) {
  logger.info(`Processing ${files.length} files sequentially (one by one) for maximum stability...`);

  let imapClient = null;
  let successCount = 0;
  let failureCount = 0;

  try {
    // Create single IMAP connection
    logger.info("Connecting to IMAP...");
    imapClient = await connectToImap();
    logger.info("Single IMAP connection established successfully");

    // Process files one by one
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const progress = `${i + 1}/${files.length}`;

      try {
        // Check connection state before each file
        if (!imapClient || imapClient.state !== 'authenticated') {
          logger.warn(`IMAP connection lost (state: ${imapClient ? imapClient.state : 'null'}), reconnecting...`);
          if (imapClient) {
            try { imapClient.end(); } catch (e) { /* ignore */ }
          }

          // Ensure we have a fresh token before reconnecting
          try {
            await getValidOAuth2Token();
            imapClient = await connectToImap();
            logger.info("IMAP connection reestablished");
          } catch (connErr) {
            logger.error(`Failed to reestablish connection: ${connErr.message}`);
            // If connection fails, we'll try again on next file
            imapClient = null;
            throw connErr;
          }
        }

        logger.debug(`[${progress}] Processing: ${filePath}`);

        const emlPath = path.join(config.emlDir, filePath);
        const success = await uploadEml(imapClient, emlPath, filePath);

        if (success) {
          successCount++;
          logger.debug(`[${progress}] ✓ Success: ${filePath}`);
        } else {
          failureCount++;
          logger.warn(`[${progress}] ✗ Failed: ${filePath}`);
        }

        // Progress reporting every 10 files
        if ((i + 1) % 10 === 0 || (i + 1) === files.length) {
          logger.info(`📊 Progress: ${i + 1}/${files.length} files processed (${successCount} success, ${failureCount} failed)`);
        }

        // Small delay between files to avoid overwhelming Gmail
        if (i < files.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        }

      } catch (err) {
        failureCount++;
        logger.error(`[${progress}] ✗ Failed to process ${filePath}: ${err.message}`);

        // If connection error or auth error, force token refresh and reconnect
        if (err.message.includes('connection') ||
          err.message.includes('IMAP') ||
          err.message.includes('authenticated') ||
          err.message.includes('Invalid credentials') ||
          err.message.includes('Authentication failed')) {
          logger.warn("Connection or authentication error detected, forcing token refresh for next file");
          if (imapClient) {
            try { imapClient.end(); } catch (e) { /* ignore */ }
            imapClient = null;
          }
          // Force token refresh for next connection attempt
          try {
            await getValidOAuth2Token(true);
            logger.info("Token refreshed due to authentication error");
          } catch (tokenErr) {
            logger.error(`Failed to refresh token: ${tokenErr.message}`);
          }
        }
      }
    }

    const results = {
      totalFiles: files.length,
      successCount: successCount,
      failureCount: failureCount
    };

    logger.info(`Sequential processing completed. Total: ${results.totalFiles}, Success: ${results.successCount}, Failed: ${results.failureCount}`);
    return results;

  } catch (err) {
    logger.error(`Fatal error in sequential processing: ${err.message}`);
    throw err;
  } finally {
    // Clean up single connection
    if (imapClient) {
      try {
        logger.info("Disconnecting IMAP connection...");
        imapClient.end();
      } catch (err) {
        logger.error(`Error disconnecting IMAP: ${err.message}`);
      }
    }
  }
}

// Process files in chunks to avoid memory overload
async function processFilesInChunks(processedFiles, allEmlFiles) {
  const CHUNK_SIZE = 100; // Process 100 files at a time
  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailures = 0;

  for (let i = 0; i < allEmlFiles.length; i += CHUNK_SIZE) {
    const chunk = allEmlFiles.slice(i, i + CHUNK_SIZE);

    // Filter unprocessed files in this chunk
    const unprocessedChunk = chunk.filter(filePath => !processedFiles.has(filePath));

    if (unprocessedChunk.length === 0) {
      logger.info(`Chunk ${Math.floor(i / CHUNK_SIZE) + 1}: All ${chunk.length} files already processed, skipping`);
      continue;
    }

    logger.info(`Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${unprocessedChunk.length} files (${i + 1} to ${Math.min(i + CHUNK_SIZE, allEmlFiles.length)} of ${allEmlFiles.length})`);

    // Ensure valid OAuth2 token before processing chunk
    if (!(await ensureValidTokenForChunk())) {
      logger.error("Failed to ensure valid token for chunk, skipping chunk");
      continue;
    }

    // Process this chunk sequentially
    const chunkResults = await processFilesSequentially(unprocessedChunk);

    totalProcessed += chunkResults.totalFiles;
    totalSuccess += chunkResults.successCount;
    totalFailures += chunkResults.failureCount;

    logger.info(`Chunk completed: ${chunkResults.successCount}/${chunkResults.totalFiles} successful. Overall: ${totalSuccess}/${totalProcessed} (${totalFailures} failed)`);

    // Force garbage collection between chunks
    if (global.gc) {
      global.gc();
    }
  }

  return {
    totalFiles: totalProcessed,
    successCount: totalSuccess,
    failureCount: totalFailures
  };
}

// Main function
async function main() {
  let totalFiles = 0;
  let successCount = 0;
  let failureCount = 0;

  try {
    // Ensure we start with a fresh OAuth2 token
    if (config.xoauth2 && config.xoauth2.clientId) {
      logger.info("Refreshing OAuth2 token at startup...");
      try {
        await getValidOAuth2Token(true); // Force refresh at startup
        logger.info("Startup token refresh completed successfully");
      } catch (err) {
        logger.error(`Failed to refresh token at startup: ${err.message}`);
        throw err;
      }
    }

    // Load processed files
    logger.info("Reading processed files...");
    const processedFiles = await getProcessedFiles();

    // Get all EML files (but don't filter yet to save memory)
    logger.info("Reading directory recursively...");
    const allFiles = await getFilesRecursively(config.emlDir);

    // Filter to EML files only
    logger.info("Filtering .eml files...");
    const emlFiles = allFiles.filter(filePath => filePath.toLowerCase().endsWith(".eml"));

    // Clear allFiles array immediately
    allFiles.length = 0;

    // Count unprocessed files without creating large arrays
    const totalEmlFiles = emlFiles.length;
    let unprocessedCount = 0;
    for (const filePath of emlFiles) {
      if (!processedFiles.has(filePath)) {
        unprocessedCount++;
      }
    }

    logger.info(
      `Found ${totalEmlFiles} .eml file(s), ${unprocessedCount} file(s) not yet processed`
    );

    if (unprocessedCount === 0) {
      logger.info("No files to process.");
      return;
    }

    // Process files in memory-efficient chunks
    const results = await processFilesInChunks(processedFiles, emlFiles);

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
}// Retry wrapper
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
