const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai');
const sharp = require('sharp');
const logger = require('./logger');
const { ensureUniqueName } = require('./woocommerce');

let openai;

function getClient() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

const PRICES = {
  heavy: parseFloat(process.env.PRICE_HEAVY || 25),
  light: parseFloat(process.env.PRICE_LIGHT || 20),
  apron: parseFloat(process.env.PRICE_APRON || 15),
};

/**
 * Step 1: Analyze the batch photo, identify items, get bounding boxes.
 * forcedType is passed so the prompt uses the right terminology.
 */
async function detectBags(imagePath, forcedType) {
  logger.info(`Analyzing photo for items: ${path.basename(imagePath)}`);

  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const client = getClient();

  const itemWord = forcedType === 'apron' ? 'apron' : 'bag';

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${mediaType};base64,${imageBase64}`, detail: 'high' }
        },
        {
          type: 'text',
          text: `You are a product cataloger for ArtsyPhartsy, a small business selling handmade upcycled bags and aprons made from recycled fabrics.

The brand names products in the style "Miss [Descriptive Word]" — whimsical names reflecting the fabric pattern or vibe (examples: Miss Geometric, Miss SantaFe, Miss Fabuloso, Miss Vanilla, Miss Picnic Anyone, Miss Camo, Miss Marple, Miss Pastel).

This photo contains one or more ${itemWord}s laid flat on a backdrop.

For each distinct ${itemWord} visible, provide:
1. A creative "Miss ___" name based on the fabric pattern, colors, and vibe
2. A 1-2 sentence product description highlighting the upcycled fabric
3. Bounding box as normalized coordinates (0.0 to 1.0) from top-left: x, y, width, height

Return ONLY valid JSON, no markdown fences:
{
  "bags": [
    {
      "name": "Miss Example",
      "description": "A striking upcycled canvas tote...",
      "bbox": { "x": 0.05, "y": 0.1, "w": 0.4, "h": 0.8 }
    }
  ]
}`
        }
      ]
    }]
  });

  const text = response.choices[0].message.content
    .replace(/```json|```/g, '')
    .trim();

  const parsed = JSON.parse(text);

  // Ensure every detected bag has a unique name in WooCommerce
  for (let i = 0; i < parsed.bags.length; i++) {
    const bag = parsed.bags[i];
    logger.info(`  Checking name uniqueness: "${bag.name}"`);
    const uniqueName = await ensureUniqueName(bag.name);
    if (uniqueName) {
      parsed.bags[i] = { ...bag, name: uniqueName };
    } else {
      // All whimsical variants exhausted — ask AI for a completely new name
      logger.info(`  Requesting completely new name from AI for bag ${i + 1}...`);
      const newName = await generateAlternativeName(bag, imagePath, mediaType, imageBase64);
      const finalName = await ensureUniqueName(newName) || `${newName} II`;
      parsed.bags[i] = { ...bag, name: finalName };
    }
  }

  logger.info(`Detected ${parsed.bags.length} item(s) in photo`);
  return parsed.bags;
}

/**
 * Step 2: Crop each item out of the batch photo.
 * Uses smart per-side padding that respects neighbouring bag bounding boxes.
 */
async function cropBags(imagePath, bags, outputDir) {
  // Auto-rotate based on EXIF so cropped images always have correct orientation
  const rotatedBuffer = await sharp(imagePath).rotate().toBuffer();
  const metadata = await sharp(rotatedBuffer).metadata();
  const { width, height } = metadata;
  const maxPadding = 0.10; // maximum padding as fraction of image
  const results = [];

  for (let i = 0; i < bags.length; i++) {
    const bag = bags[i];
    const { x, y, w, h } = bag.bbox;

    // Calculate how much space is available on each side before hitting a neighbour
    let maxLeft  = x;           // space to the left edge of this bag
    let maxRight = 1 - (x + w); // space to the right
    let maxTop   = y;
    let maxBot   = 1 - (y + h);

    // Constrain by neighbouring bags
    for (let j = 0; j < bags.length; j++) {
      if (i === j) continue;
      const nb = bags[j];

      // Neighbour is to the right
      if (nb.x > x + w) {
        const gap = nb.x - (x + w);
        maxRight = Math.min(maxRight, gap * 0.45); // take at most 45% of the gap
      }
      // Neighbour is to the left
      if (nb.x + nb.w < x) {
        const gap = x - (nb.x + nb.w);
        maxLeft = Math.min(maxLeft, gap * 0.45);
      }
      // Neighbour is below
      if (nb.y > y + h) {
        const gap = nb.y - (y + h);
        maxBot = Math.min(maxBot, gap * 0.45);
      }
      // Neighbour is above
      if (nb.y + nb.h < y) {
        const gap = y - (nb.y + nb.h);
        maxTop = Math.min(maxTop, gap * 0.45);
      }
    }

    // Apply padding capped by neighbour proximity and maxPadding
    const padLeft  = Math.min(maxPadding, maxLeft);
    const padRight = Math.min(maxPadding, maxRight);
    const padTop   = Math.min(maxPadding, maxTop);
    const padBot   = Math.min(maxPadding, maxBot);

    const left   = Math.max(0, Math.floor((x - padLeft)  * width));
    const top    = Math.max(0, Math.floor((y - padTop)   * height));
    const right  = Math.min(width,  Math.ceil((x + w + padRight) * width));
    const bottom = Math.min(height, Math.ceil((y + h + padBot)   * height));
    const cropW  = right - left;
    const cropH  = bottom - top;

    const safeName = bag.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const croppedPath = path.join(outputDir, `${safeName}_crop.jpg`);

    await sharp(rotatedBuffer)
      .extract({ left, top, width: cropW, height: cropH })
      .jpeg({ quality: 92 })
      .toFile(croppedPath);

    logger.info(`  Cropped: ${bag.name} → ${path.basename(croppedPath)} (pad L:${(padLeft*100).toFixed(0)}% R:${(padRight*100).toFixed(0)}% T:${(padTop*100).toFixed(0)}% B:${(padBot*100).toFixed(0)}%)`);
    results.push({ ...bag, croppedPath });
  }

  return results;
}

/**
 * Ask AI for a completely new name when all whimsical variants are exhausted.
 */
async function generateAlternativeName(bag, imagePath, mediaType, imageBase64) {
  const client = getClient();
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${imageBase64}`, detail: 'low' }
          },
          {
            type: 'text',
            text: `This upcycled bag was going to be named "${bag.name}" but that name is already taken along with all its whimsical variants.

Please come up with a completely different creative "Miss ___" name for this bag based on its fabric pattern, colors, and vibe. The name must be fresh and distinct — not a variation of "${bag.name}".

Return ONLY the name, nothing else. Example: Miss Meadow`
          }
        ]
      }]
    });
    const newName = response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    logger.info(`  AI suggested new name: "${newName}"`);
    return newName;
  } catch (err) {
    logger.warn(`  Alternative name generation failed: ${err.message}`);
    return `${bag.name} Original`;
  }
}

/**
 * Generate a slightly varied brand story for each bag.
 * Keeps the same key points but varies the wording to keep it fresh.
 */
async function generateBrandStory(bagName, description) {
  const client = getClient();
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Generate a slightly varied version of this brand story for a bag called "${bagName}". 
Keep the same meaning and key points but vary the wording slightly so each bag feels unique.
Do NOT change the dimensions. Return ONLY valid JSON, no markdown:

{
  "occupation": "Shopping Bag",
  "handmadeBy": "An amazing local woman",
  "handmadeFrom": "Upcycled material that was donated or found at a local thrift store.",
  "quality": "Each bag has finished seams, reinforced handles and is sewn to last.",
  "purpose": "The best part — a portion of all profits go back into the community at Karis Support Society. Plus you are supporting zero waste solutions for our lovely planet."
}

Vary the wording slightly for each field — especially handmadeBy, handmadeFrom, quality and purpose — while keeping the same meaning. occupation should always be "Shopping Bag".`
      }]
    });

    const text = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);

    // Validate expected fields — AI sometimes returns different key names and it breaks things
    const required = ['occupation', 'handmadeBy', 'handmadeFrom', 'quality', 'purpose'];
    const missing = required.filter(k => !parsed[k]);
    if (missing.length > 0) {
      logger.warn(`  Brand story missing fields: ${missing.join(', ')} — using defaults`);
      return {
        occupation: 'Shopping Bag',
        handmadeBy: 'An amazing local woman',
        handmadeFrom: 'Upcycled material that was donated or found at a local thrift store.',
        quality: 'Each bag has finished seams, reinforced handles and is sewn to last.',
        purpose: 'The best part — a portion of all profits go back into the community at Karis Support Society. Plus you are supporting zero waste solutions for our lovely planet.'
      };
    }
    return parsed;  } catch (err) {
    logger.warn(`  Brand story generation failed: ${err.message} — using defaults`);
    return {
      occupation: 'Shopping Bag',
      handmadeBy: 'An amazing local woman',
      handmadeFrom: 'Upcycled material that was donated or found at a local thrift store.',
      quality: 'Each bag has finished seams, reinforced handles and is sewn to last.',
      purpose: 'The best part — a portion of all profits go back into the community at Karis Support Society. Plus you are supporting zero waste solutions for our lovely planet.'
    };
  }
}

/* detectTag
 * forcedType: 'light'|'heavy' = bag, 'apron' = apron, 'puffed' = post-puff scan
 * Returns normalized bbox {x,y,w,h} or null if no tag found.
 */
async function detectTag(imagePath, forcedType = 'light') {
  const client = getClient();
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';

  const locationHint = forcedType === 'apron'
    ? 'It will always appear on the top center of the apron between the neck straps.'
    : forcedType === 'puffed'
    ? 'It may appear anywhere on the bag — look carefully for a small rectangular white fabric label.'
    : 'It will always appear on the top center of the bag between the bag handles.';

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${imageBase64}`, detail: 'high' }
          },
          {
            type: 'text',
            text: `Look for a small rectangular fabric tag sewn onto this ${forcedType === 'apron' ? 'apron' : 'bag'}. ${locationHint} The rectangular fabric tag contains two lines of text. The first line says "ARTSY PHARTSY". The second line beneath it says "OLD MADE NEW".

If you find the tag, return its bounding box as normalized coordinates (0.0-1.0) from top-left.
If no tag is visible, return null for bbox.

Return ONLY valid JSON, no markdown:
{ "found": true, "bbox": { "x": 0.3, "y": 0.2, "w": 0.15, "h": 0.06 } }
or
{ "found": false, "bbox": null }`
          }
        ]
      }]
    });

    const text = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    if (parsed.found && parsed.bbox) {
      logger.info(`  Tag detected at x:${parsed.bbox.x.toFixed(2)} y:${parsed.bbox.y.toFixed(2)}`);
      return parsed.bbox;
    }
    logger.info(`  No branding tag detected in image`);
    return null;
  } catch (err) {
    logger.warn(`  Tag detection failed: ${err.message}`);
    return null;
  }
}

/**
 * After rendering, composite the original clean tag back onto the rendered image.
 * Only replaces if tag is missing or shape is warped.
 */
async function replaceTag(croppedPath, renderedPath, originalTagBbox) {
  try {
    const origMeta = await sharp(croppedPath).metadata();
    const origW = origMeta.width;
    const origH = origMeta.height;
    const puffedSize = 1024;

    // Detect where the tag landed in the rendered image
    logger.info(`  Checking tag integrity in rendered image...`);
    const renderedTagBbox = await detectTag(renderedPath, 'puffed');

    if (renderedTagBbox) {
      // Compare aspect ratios — if similar, tag shape is intact, leave it alone
      const origAspect    = originalTagBbox.w / originalTagBbox.h;
      const renderedAspect = renderedTagBbox.w / renderedTagBbox.h;
      const aspectDiff    = Math.abs(origAspect - renderedAspect) / origAspect;

      if (aspectDiff < 0.4) {
        logger.info(`  Tag shape intact (aspect ratio diff: ${(aspectDiff * 100).toFixed(0)}%) — leaving as-is`);
        return true;
      }
      logger.info(`  Tag shape warped (aspect ratio diff: ${(aspectDiff * 100).toFixed(0)}%) — replacing with original`);
    } else {
      logger.info(`  Tag not found in rendered image — replacing with original`);
    }

    // Tag is missing or warped — paste clean original back
    const pad = 4;
    const tagLeft   = Math.max(0, Math.floor(originalTagBbox.x * origW) - pad);
    const tagTop    = Math.max(0, Math.floor(originalTagBbox.y * origH) - pad);
    const tagRight  = Math.min(origW, Math.ceil((originalTagBbox.x + originalTagBbox.w) * origW) + pad);
    const tagBottom = Math.min(origH, Math.ceil((originalTagBbox.y + originalTagBbox.h) * origH) + pad);
    const tagW = tagRight - tagLeft;
    const tagH = tagBottom - tagTop;

    // Use rendered position if found, otherwise scale from original
    let destLeft, destTop, destW, destH;
    if (renderedTagBbox) {
      destLeft = Math.round(renderedTagBbox.x * puffedSize);
      destTop  = Math.round(renderedTagBbox.y * puffedSize);
      destW    = Math.round(renderedTagBbox.w * puffedSize);
      destH    = Math.round(renderedTagBbox.h * puffedSize);
    } else {
      const scaleX = puffedSize / origW;
      const scaleY = puffedSize / origH;
      destLeft = Math.round(tagLeft * scaleX);
      destTop  = Math.round(tagTop  * scaleY);
      destW    = Math.round(tagW    * scaleX);
      destH    = Math.round(tagH    * scaleY);
    }

    // Clamp to image bounds
    destLeft = Math.max(0, Math.min(destLeft, puffedSize - 10));
    destTop  = Math.max(0, Math.min(destTop,  puffedSize - 10));
    destW    = Math.max(10, Math.min(destW,   puffedSize - destLeft));
    destH    = Math.max(10, Math.min(destH,   puffedSize - destTop));

    const tagBuffer = await sharp(croppedPath)
      .extract({ left: tagLeft, top: tagTop, width: tagW, height: tagH })
      .resize(destW, destH, { fit: 'fill' })
      .png()
      .toBuffer();

    const resultBuffer = await sharp(renderedPath)
      .composite([{ input: tagBuffer, left: destLeft, top: destTop, blend: 'over' }])
      .png()
      .toBuffer();

    fs.writeFileSync(renderedPath, resultBuffer);
    logger.info(`  Tag restored on rendered image`);
    return true;

  } catch (err) {
    logger.warn(`  Tag restoration failed: ${err.message} — keeping rendered image as-is`);
    return false;
  }
}

/**
 * Step 3a: Puff up a bag using OpenAI image editing.
 * Uses prompt-only approach — secondary image always shows the real tag.
 */
async function puffBag(bagData, outputDir, forcedType = 'light') {
  const client = getClient();
  const safeName = bagData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const puffedPath = path.join(outputDir, `${safeName}_puffed.png`);

  logger.info(`  Puffing: ${bagData.name}...`);

  const presentations = [
    'Show the bag upright with handles standing naturally tall, looking full and appealing as a product photo.',
    'Show the bag upright with the handles flopped naturally forward over the front of the bag, as if just set down.',
    'Show the bag slightly angled to the left with handles standing tall, giving a dynamic product shot feel.',
    'Show the bag slightly angled to the right with one handle flopped forward and one standing, looking natural and casual.',
    'Show the bag upright with both handles relaxed and drooping slightly to each side, looking soft and natural.',
    'Show the bag from a slight three-quarter angle with handles flopped naturally forward.',
  ];
  const presentation = presentations[Math.floor(Math.random() * presentations.length)];
  logger.info(`  Presentation style: ${presentation}`);

  const prompt = `This is a flat upcycled fabric tote bag laid on a surface.
Transform it to look naturally filled and puffed out, as if stuffed with a pillow or contents, giving it a full three-dimensional shape with volume and depth.
Keep all fabric patterns, colors, textures, and design elements exactly as they appear — do not alter the fabric at all.
There is a small rectangular fabric branding tag sewn onto the top center of the bag between the two handles. This tag MUST remain at the top center of the bag between the handles — do not move it. Its rectangular shape must be preserved.
${presentation}
Use a clean, neutral light gray or off-white background.
Professional product photography style, soft even lighting, no harsh shadows.`;

  try {
    const pngBuffer = await sharp(fs.readFileSync(bagData.croppedPath)).png().toBuffer();
    const tmpPngPath = bagData.croppedPath.replace(/\.(jpg|jpeg)$/i, '_tmp.png');
    fs.writeFileSync(tmpPngPath, pngBuffer);

    const imageFile = await toFile(fs.createReadStream(tmpPngPath), path.basename(tmpPngPath), { type: 'image/png' });
    const response = await client.images.edit({
      model: 'gpt-image-2',
      image: imageFile,
      prompt,
      n: 1,
      size: '1024x1024',
    });

    fs.unlinkSync(tmpPngPath);

    const imgData = response.data[0].b64_json;
    fs.writeFileSync(puffedPath, Buffer.from(imgData, 'base64'));
    logger.info(`  Puffed:  ${bagData.name} → ${path.basename(puffedPath)}`);

    return { ...bagData, puffedPath };

  } catch (err) {
    logger.warn(`  Puffing failed for ${bagData.name}: ${err.message} — using cropped original`);
    fs.copyFileSync(bagData.croppedPath, puffedPath.replace('_puffed.png', '_fallback.jpg'));
    return { ...bagData, puffedPath: bagData.croppedPath, puffFailed: true };
  }
}

/**
 * Step 3b: Render an apron on a mannequin using OpenAI image editing.
 * Uses detectTag + replaceTag for aprons since the transformation is more dramatic.
 */
async function renderApron(bagData, outputDir, forcedType = 'apron') {
  const client = getClient();
  const safeName = bagData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const renderedPath = path.join(outputDir, `${safeName}_mannequin.png`);

  logger.info(`  Rendering on mannequin: ${bagData.name}...`);

  // Detect tag before rendering so we can restore it if needed
  const tagBbox = await detectTag(bagData.croppedPath, forcedType);

  const prompt = `This is a flat upcycled fabric apron.
Place this apron on a professional faceless dress form mannequin, shown from the front.
The apron strings should be tied naturally at the waist, with the bib sitting flat against the upper chest of the mannequin.
Keep all fabric patterns, colors, textures, labels, and design elements exactly as they appear — do not alter the fabric in any way.
There is a small rectangular fabric branding tag sewn onto the top center of the apron between the neck straps. This tag MUST remain at the top center of the apron between the neck straps — do not move it. The tag's rectangular shape must be preserved. The text on the tag must not be changed or rewritten in any way.
Use a clean, neutral white or light gray studio background.
Professional product photography style, soft even lighting, no harsh shadows.
The mannequin should be simple, neutral-colored, and not distract from the apron.`;

  try {
    const pngBuffer = await sharp(fs.readFileSync(bagData.croppedPath)).png().toBuffer();
    const tmpPngPath = bagData.croppedPath.replace(/\.(jpg|jpeg)$/i, '_tmp.png');
    fs.writeFileSync(tmpPngPath, pngBuffer);

    const imageFile = await toFile(fs.createReadStream(tmpPngPath), path.basename(tmpPngPath), { type: 'image/png' });
    const response = await client.images.edit({
      model: 'gpt-image-2',
      image: imageFile,
      prompt,
      n: 1,
      size: '1024x1024',
    });

    fs.unlinkSync(tmpPngPath);

    const imgData = response.data[0].b64_json;
    fs.writeFileSync(renderedPath, Buffer.from(imgData, 'base64'));

    // For aprons, also attempt tag restoration since the transformation is dramatic
    if (tagBbox) {
      await replaceTag(bagData.croppedPath, renderedPath, tagBbox);
    }

    logger.info(`  Mannequin render complete: ${bagData.name} → ${path.basename(renderedPath)}`);
    return { ...bagData, puffedPath: renderedPath };

  } catch (err) {
    logger.warn(`  Mannequin render failed for ${bagData.name}: ${err.message} — using cropped original`);
    fs.copyFileSync(bagData.croppedPath, renderedPath.replace('_mannequin.png', '_fallback.jpg'));
    return { ...bagData, puffedPath: bagData.croppedPath, puffFailed: true };
  }
}

/**
 * Prepare the secondary image by replacing the background with a clean studio backdrop.
 * Uses gpt-image-2 to replace busy/cluttered backgrounds with neutral light gray.
 * Falls back to color-boosted crop if AI fails.
 */
async function prepareSecondaryImage(croppedPath, outputDir) {
  const client = getClient();
  const safeName = path.basename(croppedPath, path.extname(croppedPath));
  const secondaryPath = path.join(outputDir, `${safeName}_secondary.png`);

  logger.info(`  Preparing secondary image (background replacement)...`);

  try {
    const tmpPngPath = croppedPath.replace(/\.[^.]+$/, '_secondary_tmp.png');
    const pngBuffer = await sharp(croppedPath).png().toBuffer();
    fs.writeFileSync(tmpPngPath, pngBuffer);

    const imageFile = await toFile(fs.createReadStream(tmpPngPath), path.basename(tmpPngPath), { type: 'image/png' });

    const response = await client.images.edit({
      model: 'gpt-image-2',
      image: imageFile,
      prompt: `Replace only the background of this bag photo with a clean, neutral light gray studio background (#f0f0f0). 
Keep the bag itself completely unchanged — same fabric, same colors, same patterns, same tag, same position, same orientation. 
Do not alter the bag in any way. Only the background changes.
Professional product photography style, soft even lighting, no shadows.`,
      n: 1,
      size: '1024x1024',
    });

    fs.unlinkSync(tmpPngPath);

    const imgData = response.data[0].b64_json;
    fs.writeFileSync(secondaryPath, Buffer.from(imgData, 'base64'));
    logger.info(`  Secondary image prepared with clean background → ${path.basename(secondaryPath)}`);
    return secondaryPath;

  } catch (err) {
    logger.warn(`  Background replacement failed: ${err.message} — using color-boosted crop`);
    // Fallback: just color boost the original
    const fallbackPath = path.join(outputDir, `${safeName}_secondary.jpg`);
    await sharp(croppedPath)
      .modulate({ brightness: 1.08, saturation: 1.35 })
      .sharpen({ sigma: 0.5 })
      .jpeg({ quality: 92 })
      .toFile(fallbackPath);
    return fallbackPath;
  }
}

/**
 * Generate a unique SKU.
 */
function generateSKU(name) {
  const prefix = 'AP';
  const namePart = name.replace(/[^a-zA-Z]/g, '').slice(0, 6).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  const rand = Math.random().toString(36).substr(2, 3).toUpperCase();
  return `${prefix}-${namePart}-${ts}${rand}`;
}

module.exports = { detectBags, cropBags, puffBag, renderApron, detectTag, replaceTag, prepareSecondaryImage, generateBrandStory, generateSKU, PRICES };
