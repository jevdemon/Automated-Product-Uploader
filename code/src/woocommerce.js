const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const os = require('os');
const logger = require('./logger');

function getBaseUrl() {
  return process.env.WOO_URL.replace(/\/$/, '') + '/wp-json';
}

function getWooCreds() {
  return Buffer.from(process.env.WOO_CONSUMER_KEY + ':' + process.env.WOO_CONSUMER_SECRET).toString('base64');
}

function getWpCreds() {
  return Buffer.from(process.env.WP_USERNAME + ':' + process.env.WP_APP_PASSWORD).toString('base64');
}

async function checkNameExists(name) {
  try {
    const response = await axios.get(`${getBaseUrl()}/wc/v3/products`, {
      headers: { 'Authorization': 'Basic ' + getWooCreds() },
      params: { search: name, per_page: 10, status: 'any' },
      timeout: 15000,
    });
    return response.data.some(
      p => p.name.toLowerCase().trim() === name.toLowerCase().trim()
    );
  } catch (err) {
    logger.warn(`  Name check failed for "${name}": ${err.message} | code: ${err.code} — assuming unique`);
    return false;
  }
}

function whimsicalVariant(baseName, attempt) {
  const variants = [
    `${baseName} Too`,
    `${baseName}'s Sister`,
    `${baseName}'s Twin`,
    `${baseName}'s Cousin`,
    `${baseName}'s Doppelgänger`,
    `${baseName}'s Long Lost Cousin`,
  ];
  if (attempt <= variants.length) return variants[attempt - 1];
  return null;
}

async function ensureUniqueName(name) {
  const originalTaken = await checkNameExists(name);
  if (!originalTaken) return name;

  logger.info(`  Name "${name}" already exists — trying whimsical variants...`);

  for (let attempt = 1; attempt <= 6; attempt++) {
    const variant = whimsicalVariant(name, attempt);
    if (!variant) break;
    const taken = await checkNameExists(variant);
    if (!taken) {
      logger.info(`  Settled on: "${variant}"`);
      return variant;
    }
    logger.info(`  "${variant}" also taken — trying next...`);
  }

  logger.info(`  All variants exhausted for "${name}" — requesting new name from AI`);
  return null;
}

async function uploadImage(imagePath, altText) {
  let uploadPath = imagePath;
  let tempPath = null;

  try {
    const stats = fs.statSync(imagePath);
    const isPng = imagePath.toLowerCase().endsWith('.png');
    const isLarge = stats.size > 2 * 1024 * 1024;

    if (isPng || isLarge) {
      tempPath = path.join(os.tmpdir(), `ap_upload_${Date.now()}.jpg`);
      await sharp(imagePath)
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(tempPath);
      const newSize = fs.statSync(tempPath).size;
      logger.info(`    Compressed: ${Math.round(stats.size/1024)}KB → ${Math.round(newSize/1024)}KB`);
      uploadPath = tempPath;
    }

    const filename = path.basename(uploadPath);
    const form = new FormData();
    form.append('file', fs.createReadStream(uploadPath), {
      filename: filename.replace(/\.png$/i, '.jpg'),
      contentType: 'image/jpeg',
    });
    form.append('alt_text', altText);
    form.append('title', altText);

    const response = await axios.post(
      `${getBaseUrl()}/wp/v2/media`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Authorization': 'Basic ' + getWpCreds(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000,
      }
    );
    return response.data.id;

  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

async function createDraftProduct(bag, imageIds = []) {
  // Build the brand story with slight AI variation on key points
  const brandStory = `
<ul>
  <li><strong>Occupation:</strong> ${bag.brandStory.occupation}</li>
  <li><strong>Handmade by:</strong> ${bag.brandStory.handmadeBy}</li>
  <li><strong>Handmade from:</strong> ${bag.brandStory.handmadeFrom}</li>
  <li><strong>Quality:</strong> ${bag.brandStory.quality}</li>
  <li><strong>Purpose:</strong> ${bag.brandStory.purpose}</li>
  <li><strong>Bag Dimensions:</strong> 14 inches wide, 15 inches high and 5 inches deep</li>
</ul>`;

  const fullDescription = `<p>${bag.description}</p>${brandStory}`;
  const productData = {
    name: bag.name,
    type: 'simple',
    status: 'draft',
    description: bag.description,
    short_description: fullDescription,
    regular_price: bag.price.toString(),
    sku: bag.sku,
    manage_stock: false,
    images: imageIds,
    categories: [{ id: 22 }],
    meta_data: [
      { key: '_fabric_type', value: bag.type },
      { key: '_artsy_phartsy', value: 'true' },
      { key: '_source_photo', value: bag.sourcePhoto },
    ],
  };

  const response = await axios.post(
    `${getBaseUrl()}/wc/v3/products`,
    productData,
    { headers: { 'Authorization': 'Basic ' + getWooCreds(), 'Content-Type': 'application/json' } }
  );

  const product = response.data;
  const adminUrl = `${process.env.WOO_URL.replace(/\/$/, '')}/wp-admin/post.php?post=${product.id}&action=edit`;
  return { id: product.id, adminUrl };
}

async function uploadBag(bag) {
  const puffedPath = bag.puffedPath || bag.croppedPath;
  logger.info(`  Uploading: ${bag.name} (${bag.sku})`);

  try {
    const imageIds = [];
    let primaryFailed = false;

    // 1. Upload puffed image as primary
    try {
      const puffedId = await uploadImage(puffedPath, bag.name);
      imageIds.push({ id: puffedId, alt: bag.name });
      logger.info(`    Primary image uploaded (ID: ${puffedId})`);
      // Brief pause to let WordPress finish processing the image
      await new Promise(r => setTimeout(r, 1500));
    } catch (imgErr) {
      logger.warn(`    Primary image upload failed after all retries: ${imgErr.message} | code: ${imgErr.code} | status: ${imgErr.response?.status}`);
      primaryFailed = true;
    }

    // 2. Upload secondary — only if primary succeeded (prevents mismatched/duplicate images)
    if (!primaryFailed && bag.croppedPath && bag.croppedPath !== puffedPath) {
      try {
        const cropId = await uploadImage(bag.croppedPath, `${bag.name} — detail`);
        imageIds.push({ id: cropId, alt: `${bag.name} — detail view` });
        logger.info(`    Secondary image uploaded (ID: ${cropId})`);
      } catch (imgErr) {
        logger.warn(`    Secondary image upload failed: ${imgErr.message} | code: ${imgErr.code} | status: ${imgErr.response?.status} | data: ${JSON.stringify(imgErr.response?.data)}`);
      }
    }

    // 3. Create the draft product — only if primary image uploaded successfully
    if (primaryFailed) {
      logger.error(`    Skipping product creation for ${bag.name} — primary image failed`);
      return { name: bag.name, sku: bag.sku, ok: false, error: 'Primary image upload failed after all retries' };
    }

    const { id, adminUrl } = await createDraftProduct(bag, imageIds);
    logger.info(`    Product created as draft (ID: ${id})`);

    return {
      name: bag.name,
      sku: bag.sku,
      price: bag.price,
      type: bag.type,
      productId: id,
      adminUrl,
      ok: true,
    };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    logger.error(`    Failed to upload ${bag.name}: ${detail}`);
    return {
      name: bag.name,
      sku: bag.sku,
      ok: false,
      error: detail,
    };
  }
}

function getDraftsUrl() {
  return `${process.env.WOO_URL.replace(/\/$/, '')}/wp-admin/edit.php?post_status=draft&post_type=product`;
}

module.exports = { uploadBag, getDraftsUrl, checkNameExists, ensureUniqueName };
