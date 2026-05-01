const fs = require('fs');

const TTL_MS = (parseInt(process.env.OUTPUT_TTL_MINUTES) || 1440) * 60 * 1000;

function scheduleCleanup(filePath) {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[CLEANUP] Deleted: ${filePath}`);
      }
    } catch (err) {
      console.warn(`[CLEANUP] Could not delete ${filePath}: ${err.message}`);
    }
  }, TTL_MS);

  console.log(`[CLEANUP] Scheduled deletion of ${filePath} in ${TTL_MS / 60000} min`);
}

module.exports = { scheduleCleanup };
