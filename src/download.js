const axios = require('axios');
const fs = require('fs');

const TIMEOUT_MS = 120_000;
const MAX_FILE_SIZE = 500 * 1024 * 1024;

function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.slice(0, 40)}${u.search ? '[?…]' : ''}`;
  } catch {
    return url.slice(0, 60);
  }
}

async function download(url, destPath) {
  if (!url || url === 'null') {
    throw new Error(`Cannot download: invalid URL`);
  }

  const filename = require('path').basename(destPath);
  console.log(`[DL] Downloading → ${filename} from ${safeUrl(url)}`);

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_FILE_SIZE,
    headers: {
      'User-Agent': 'ffmpeg-worker/1.0'
    }
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    let received = 0;

    response.data.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_FILE_SIZE) {
        writer.destroy();
        reject(new Error(`File too large (> 500 MB): ${url}`));
      }
    });

    response.data.pipe(writer);

    writer.on('finish', () => {
      console.log(`[DL] Done: ${destPath} (${(received / 1024 / 1024).toFixed(1)} MB)`);
      resolve(destPath);
    });

    writer.on('error', err => {
      reject(new Error(`Write error for ${destPath}: ${err.message}`));
    });

    response.data.on('error', err => {
      reject(new Error(`Download error for ${url}: ${err.message}`));
    });
  });
}

module.exports = { download };
