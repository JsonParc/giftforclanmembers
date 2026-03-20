function createWeightStorageHelpers({
  fs,
  http,
  https,
  path,
  zlib,
  rootDir,
  actionCount,
  externalWeightsUrls,
  pruneMinAbsQ,
  pruneActionMinAbsQ,
  roundDecimals
}) {
  const weightsDownloadPromises = new Map();

  function getWeightsPaths(difficulty) {
    const jsonPath = path.join(rootDir, `ai-weights-${difficulty}.json`);
    return {
      jsonPath,
      gzipPath: `${jsonPath}.gz`
    };
  }

  function getExternalWeightsUrl(difficulty) {
    return externalWeightsUrls[difficulty] || null;
  }

  function hasCachedWeights(difficulty) {
    const paths = getWeightsPaths(difficulty);
    return fs.existsSync(paths.jsonPath) || fs.existsSync(paths.gzipPath);
  }

  function getAvailableWeightSources(difficulty) {
    const paths = getWeightsPaths(difficulty);
    const sources = [];
    if (fs.existsSync(paths.gzipPath)) {
      const stats = fs.statSync(paths.gzipPath);
      sources.push({
        path: paths.gzipPath,
        format: 'gzip',
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs
      });
    }
    if (fs.existsSync(paths.jsonPath)) {
      const stats = fs.statSync(paths.jsonPath);
      sources.push({
        path: paths.jsonPath,
        format: 'json',
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs
      });
    }
    sources.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      if (a.format === b.format) return 0;
      return a.format === 'gzip' ? -1 : 1;
    });
    return sources;
  }

  function readWeightsSource(source) {
    if (!source) return null;
    if (source.format === 'gzip') {
      const compressed = fs.readFileSync(source.path);
      return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    }
    return JSON.parse(fs.readFileSync(source.path, 'utf8'));
  }

  function writeFileAtomic(filePath, contents) {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, contents);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    fs.renameSync(tempPath, filePath);
  }

  function removeFileIfExists(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn(`[AI-RL] Failed to remove ${path.basename(filePath)}: ${error.message}`);
    }
  }

  function createDenseActionRow() {
    return new Float32Array(actionCount);
  }

  function isActionRowLike(row) {
    return Array.isArray(row) || ArrayBuffer.isView(row);
  }

  function unpackWeightTable(table, tableFormat = 'dense') {
    const unpacked = Object.create(null);
    const entries = Object.entries(table || {});
    for (const [stateKey, rawRow] of entries) {
      const row = createDenseActionRow();
      if (tableFormat === 'sparse-pairs-v2') {
        const packedRow = Array.isArray(rawRow) ? rawRow : [];
        for (let i = 0; i < packedRow.length; i += 2) {
          const actionIndex = Number(packedRow[i]);
          const actionValue = Number(packedRow[i + 1]);
          if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex >= actionCount) continue;
          if (!Number.isFinite(actionValue) || actionValue === 0) continue;
          row[actionIndex] = actionValue;
        }
      } else if (isActionRowLike(rawRow)) {
        for (let i = 0; i < actionCount; i++) {
          const value = Number(rawRow[i]);
          row[i] = Number.isFinite(value) ? value : 0;
        }
      }
      unpacked[stateKey] = row;
    }
    return unpacked;
  }

  function packWeightTable(table) {
    const packed = Object.create(null);
    for (const [stateKey, row] of Object.entries(table || {})) {
      if (!isActionRowLike(row)) continue;
      const packedRow = [];
      for (let i = 0; i < actionCount; i++) {
        const value = Number(row[i]);
        if (!Number.isFinite(value) || value === 0) continue;
        packedRow.push(i, value);
      }
      if (packedRow.length > 0) {
        packed[stateKey] = packedRow;
      }
    }
    return packed;
  }

  function normalizeStateMeta(entry) {
    if (Array.isArray(entry)) {
      const visits = Math.max(0, Math.floor(Number(entry[0]) || 0));
      const lastTouched = Math.max(0, Math.floor(Number(entry[1]) || 0));
      return [visits, lastTouched];
    }
    if (entry && typeof entry === 'object') {
      const visits = Math.max(0, Math.floor(Number(entry.visits) || 0));
      const lastTouched = Math.max(0, Math.floor(Number(entry.lastTouched) || 0));
      return [visits, lastTouched];
    }
    return [0, 0];
  }

  function normalizeActionRow(row) {
    const normalized = createDenseActionRow();
    let maxAbsQ = 0;
    let nonZeroActionCount = 0;
    let zeroedActionCount = 0;
    const factor = Math.pow(10, roundDecimals);
    for (let i = 0; i < actionCount; i++) {
      const rawValue = isActionRowLike(row) ? row[i] : undefined;
      let value = Number.isFinite(rawValue) ? rawValue : 0;
      if (roundDecimals > 0) {
        value = Math.round(value * factor) / factor;
      } else {
        value = Math.round(value);
      }
      if (Math.abs(value) < pruneActionMinAbsQ) {
        if (value !== 0) {
          zeroedActionCount++;
        }
        value = 0;
      }
      normalized[i] = value;
      const absValue = Math.abs(value);
      if (absValue > maxAbsQ) {
        maxAbsQ = absValue;
      }
      if (absValue > 0) {
        nonZeroActionCount++;
      }
    }
    return { row: normalized, maxAbsQ, nonZeroActionCount, zeroedActionCount };
  }

  function pruneWeightTable(table, stateMeta = {}, options = {}) {
    const {
      minAbsQ = pruneMinAbsQ,
      minVisits = 0,
      recentTouchWindow = 0,
      currentTouchTick = 0,
      maxStateCount = 0
    } = options;
    const nextTable = Object.create(null);
    const nextStateMeta = Object.create(null);
    const retainedStates = [];
    const entries = Object.entries(table || {});
    let prunedZeroStates = 0;
    let prunedLowSignalStates = 0;
    let zeroedActions = 0;
    let prunedLowVisitStates = 0;
    let trimmedOverflowStates = 0;
    const recentTouchCutoff = recentTouchWindow > 0
      ? Math.max(0, Math.floor(currentTouchTick) - Math.floor(recentTouchWindow))
      : -1;

    for (const [stateKey, row] of entries) {
      const normalized = normalizeActionRow(row);
      const meta = normalizeStateMeta(stateMeta?.[stateKey]);
      const visits = meta[0];
      const lastTouched = meta[1];
      zeroedActions += normalized.zeroedActionCount;
      if (normalized.maxAbsQ <= 0 || normalized.nonZeroActionCount <= 0) {
        prunedZeroStates++;
        continue;
      }
      const isRecent = recentTouchCutoff >= 0 ? lastTouched >= recentTouchCutoff : false;
      const isEstablished = visits >= Math.max(0, Math.floor(minVisits));
      if (normalized.maxAbsQ < minAbsQ && !isEstablished && !isRecent) {
        prunedLowSignalStates++;
        continue;
      }
      if (!isEstablished && !isRecent && normalized.nonZeroActionCount <= 1 && normalized.maxAbsQ < Math.max(minAbsQ * 1.35, minAbsQ + pruneActionMinAbsQ)) {
        prunedLowVisitStates++;
        continue;
      }
      const recencyBoost = isRecent ? 4 : 0;
      const visitBoost = Math.min(10, Math.log2(visits + 1) * 1.6);
      const densityBoost = Math.min(4, normalized.nonZeroActionCount * 0.18);
      retainedStates.push({
        stateKey,
        row: normalized.row,
        meta,
        priority: (normalized.maxAbsQ * 18) + visitBoost + recencyBoost + densityBoost
      });
    }

    if (maxStateCount > 0 && retainedStates.length > maxStateCount) {
      retainedStates.sort((a, b) => b.priority - a.priority);
      trimmedOverflowStates = retainedStates.length - maxStateCount;
      retainedStates.length = maxStateCount;
    }

    for (const retained of retainedStates) {
      nextTable[retained.stateKey] = retained.row;
      nextStateMeta[retained.stateKey] = retained.meta;
    }

    return {
      table: nextTable,
      stateMeta: nextStateMeta,
      stats: {
        minAbsQ,
        minVisits,
        recentTouchWindow,
        currentTouchTick,
        maxStateCount,
        minActionAbsQ: pruneActionMinAbsQ,
        roundDecimals,
        beforeStateCount: entries.length,
        afterStateCount: Object.keys(nextTable).length,
        prunedStates: prunedZeroStates + prunedLowSignalStates + prunedLowVisitStates + trimmedOverflowStates,
        prunedZeroStates,
        prunedLowSignalStates,
        prunedLowVisitStates,
        trimmedOverflowStates,
        zeroedActions
      }
    };
  }

  function mergeCookieHeader(existingHeader, setCookieHeaders) {
    const cookieMap = new Map();
    if (existingHeader) {
      for (const part of String(existingHeader).split(/;\s*/)) {
        const eqIndex = part.indexOf('=');
        if (eqIndex <= 0) continue;
        cookieMap.set(part.slice(0, eqIndex), part);
      }
    }
    const headers = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : (setCookieHeaders ? [setCookieHeaders] : []);
    for (const rawHeader of headers) {
      const pair = String(rawHeader).split(';')[0].trim();
      const eqIndex = pair.indexOf('=');
      if (eqIndex <= 0) continue;
      cookieMap.set(pair.slice(0, eqIndex), pair);
    }
    return Array.from(cookieMap.values()).join('; ');
  }

  function decodeHtmlEntities(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, '\'')
      .replace(/&quot;/g, '"');
  }

  function decodeGoogleDriveEscapedUrl(value) {
    return decodeHtmlEntities(String(value || ''))
      .replace(/\\u003d/g, '=')
      .replace(/\\u0026/g, '&')
      .replace(/\\u002f/g, '/')
      .replace(/\\\//g, '/');
  }

  function isGoogleDriveUrl(url) {
    return /drive\.google\.com|drive\.usercontent\.google\.com/.test(String(url || ''));
  }

  function extractHtmlAttribute(tag, attrName) {
    const match = String(tag || '').match(new RegExp(`${attrName}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
    return match ? decodeHtmlEntities(match[2]) : null;
  }

  function extractGoogleDriveDownloadUrl(html, currentUrl) {
    const downloadUrlMatch = html.match(/"downloadUrl":"([^"]+)"/i);
    if (downloadUrlMatch) {
      return decodeGoogleDriveEscapedUrl(downloadUrlMatch[1]);
    }

    const hrefMatch = html.match(/href\s*=\s*(['"])(\/[^'"]*export=download[^'"]*|https?:\/\/[^'"]*(?:export=download|drive\.usercontent\.google\.com\/download)[^'"]*)\1/i);
    if (hrefMatch) {
      return new URL(decodeGoogleDriveEscapedUrl(hrefMatch[2]), currentUrl).toString();
    }

    const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    let formMatch;
    while ((formMatch = formRegex.exec(html)) !== null) {
      const formAttrs = formMatch[1] || '';
      const formBody = formMatch[2] || '';
      const action = extractHtmlAttribute(formAttrs, 'action');
      if (!action) continue;
      const actionUrl = new URL(decodeGoogleDriveEscapedUrl(action), currentUrl);
      const actionText = actionUrl.toString();
      if (!/export=download|drive\.usercontent\.google\.com\/download/i.test(actionText)) {
        continue;
      }

      const inputRegex = /<input\b([^>]*)>/gi;
      let inputMatch;
      while ((inputMatch = inputRegex.exec(formBody)) !== null) {
        const inputAttrs = inputMatch[1] || '';
        const type = (extractHtmlAttribute(inputAttrs, 'type') || '').toLowerCase();
        const name = extractHtmlAttribute(inputAttrs, 'name');
        const value = extractHtmlAttribute(inputAttrs, 'value') || '';
        if (!name) continue;
        if (type && type !== 'hidden') continue;
        actionUrl.searchParams.set(name, value);
      }
      return actionUrl.toString();
    }

    return null;
  }

  function downloadFileWithRedirects(url, destinationPath, redirectCount = 0, cookieHeader = '') {
    return new Promise((resolve, reject) => {
      if (!url) {
        reject(new Error('Missing download URL'));
        return;
      }
      if (redirectCount > 5) {
        reject(new Error('Too many redirects while downloading weights'));
        return;
      }
      const client = url.startsWith('https://') ? https : http;
      const requestOptions = new URL(url);
      requestOptions.headers = {
        'User-Agent': 'Mozilla/5.0 MW-Craft-RL/1.0',
        Accept: '*/*'
      };
      if (cookieHeader) {
        requestOptions.headers.Cookie = cookieHeader;
      }
      const request = client.get(requestOptions, (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;
        const nextCookieHeader = mergeCookieHeader(cookieHeader, response.headers['set-cookie']);
        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          resolve(downloadFileWithRedirects(nextUrl, destinationPath, redirectCount + 1, nextCookieHeader));
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Weight download failed with HTTP ${statusCode}`));
          return;
        }

        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('text/html')) {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            if (body.length < 262144) body += chunk;
          });
          response.on('end', () => {
            if (isGoogleDriveUrl(url)) {
              const nextUrl = extractGoogleDriveDownloadUrl(body, url);
              if (nextUrl) {
                resolve(downloadFileWithRedirects(nextUrl, destinationPath, redirectCount + 1, nextCookieHeader));
                return;
              }
            }
            reject(new Error(`Weight download returned HTML instead of binary: ${body.slice(0, 120)}`));
          });
          return;
        }

        const tempPath = `${destinationPath}.tmp`;
        const output = fs.createWriteStream(tempPath);
        output.on('error', (error) => {
          response.destroy(error);
        });
        response.on('error', (error) => {
          output.destroy(error);
        });
        output.on('finish', () => {
          output.close((closeError) => {
            if (closeError) {
              reject(closeError);
              return;
            }
            fs.rename(tempPath, destinationPath, (renameError) => {
              if (renameError) {
                reject(renameError);
                return;
              }
              resolve(destinationPath);
            });
          });
        });
        response.pipe(output);
      });
      request.on('error', reject);
    });
  }

  async function ensureExternalWeightsCached(difficulty) {
    if (hasCachedWeights(difficulty)) {
      console.log(`[AI-RL][${difficulty}] Using cached local weights file.`);
      return true;
    }
    const downloadUrl = getExternalWeightsUrl(difficulty);
    if (!downloadUrl) {
      return false;
    }
    if (!weightsDownloadPromises.has(difficulty)) {
      const { gzipPath } = getWeightsPaths(difficulty);
      console.log(`[AI-RL][${difficulty}] Downloading weights from external source...`);
      const promise = downloadFileWithRedirects(downloadUrl, gzipPath)
        .then(() => {
          console.log(`[AI-RL][${difficulty}] External weights cached at ${path.basename(gzipPath)}.`);
          return true;
        })
        .finally(() => {
          weightsDownloadPromises.delete(difficulty);
        });
      weightsDownloadPromises.set(difficulty, promise);
    }
    return weightsDownloadPromises.get(difficulty);
  }

  return {
    getWeightsPaths,
    getExternalWeightsUrl,
    hasCachedWeights,
    getAvailableWeightSources,
    readWeightsSource,
    writeFileAtomic,
    removeFileIfExists,
    packWeightTable,
    unpackWeightTable,
    pruneWeightTable,
    ensureExternalWeightsCached
  };
}

module.exports = {
  createWeightStorageHelpers
};
