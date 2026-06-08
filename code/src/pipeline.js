const fs = require('fs');
const path = require('path');
const { detectBags, cropBags, puffBag, renderApron, prepareSecondaryImage, generateBrandStory, generateSKU, PRICES } = require('./ai');
const { uploadBag, getDraftsUrl } = require('./woocommerce');
const { sendNotification } = require('./email');
const logger = require('./logger');

/**
 * Process a single batch photo end-to-end.
 * forcedType: 'light' | 'heavy' | 'apron' | 'mobile'
 */
async function processPhoto(imagePath, forcedType) {
  const filename = path.basename(imagePath);
  const outputDir = process.env.OUTPUT_FOLDER || './output';
  const batchDir = path.join(outputDir, `batch_${Date.now()}`);

  logger.info('─'.repeat(60));
  logger.info(`Processing: ${filename} (${forcedType} — $${PRICES[forcedType]})`);
  logger.info('─'.repeat(60));

  fs.mkdirSync(batchDir, { recursive: true });

  let bags = [];
  let results = [];

  try {
    // ── Step 1: AI detection ──────────────────────────────────
    logger.info('[1/4] Detecting items in photo...');
    const detectedBags = await detectBags(imagePath, forcedType);

    if (!detectedBags || detectedBags.length === 0) {
      logger.warn('No items detected in photo — skipping');
      moveToProcessed(imagePath, 'no_items_detected');
      return;
    }

    // ── Step 2: Crop ──────────────────────────────────────────
    logger.info(`[2/4] Cropping ${detectedBags.length} item(s)...`);
    const croppedBags = await cropBags(imagePath, detectedBags, batchDir);

    // ── Step 3: Render (puff or mannequin) ───────────────────
    const renderLabel = forcedType === 'apron' | 'mobile' ? 'Rendering on mannequin' : 'Puffing';
    logger.info(`[3/4] ${renderLabel}...`);

    for (const bag of croppedBags) {
		const rendered = (forcedType === 'apron' || forcedType === 'mobile')
        ? await renderApron(bag, batchDir, forcedType)
        : await puffBag(bag, batchDir, forcedType);	

      // Prepare secondary image — rotated, clean background, enhanced colors
      logger.info(`  Preparing secondary detail image...`);
      const secondaryPath = await prepareSecondaryImage(bag.croppedPath, batchDir);

      // Generate slightly varied brand story for this bag
      logger.info(`  Generating brand story...`);
      const brandStory = await generateBrandStory(rendered.name, rendered.description, forcedType);

      bags.push({
        ...rendered,
        sku: generateSKU(rendered.name),
        type: forcedType,
        price: PRICES[forcedType],
        sourcePhoto: filename,
        croppedPath: secondaryPath,
        brandStory,
      });
    }

    // ── Step 4: Upload to WooCommerce ─────────────────────────
    logger.info('[4/4] Uploading to WooCommerce as drafts...');
    for (const bag of bags) {
      const result = await uploadBag(bag, forcedType);
      results.push(result);
    }

    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    logger.info(`Upload complete: ${ok} succeeded, ${fail} failed`);

  } catch (err) {
    logger.error(`Pipeline failed for ${filename}: ${err.message}`);
    logger.error(err.stack);
    results.push({ name: filename, ok: false, error: err.message });
  }

  // ── Email notification ────────────────────────────────────────
  if (results.length > 0) {
    await sendNotification(filename, results, getDraftsUrl());
  }

  // ── Move source photo to processed/ ──────────────────────────
  moveToProcessed(imagePath, results.some(r => r.ok) ? 'done' : 'failed');

  logger.info(`Batch complete. Files saved to: ${batchDir}`);
  logger.info('─'.repeat(60));
}

function moveToProcessed(imagePath, status) {
  const inputDir = path.dirname(imagePath);
  const processedDir = path.join(inputDir, 'processed', status);
  fs.mkdirSync(processedDir, { recursive: true });
  const dest = path.join(processedDir, path.basename(imagePath));
  try {
    fs.renameSync(imagePath, dest);
    logger.info(`Source photo moved to: processed/${status}/`);
  } catch (err) {
    logger.warn(`Could not move source photo: ${err.message}`);
  }
}

module.exports = { processPhoto };
