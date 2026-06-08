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
  apron: parseFloat(process.env.PRICE_APRON || 20),
  mobile: parseFloat(process.env.PRICE_MOBILE || 15),
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
  const itemWord = forcedType === 'apron' ? 'apron' : forcedType === 'mobile' ? 'mobile' : 'bag';
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
      logger.info(`  Requesting completely new name from AI for ${itemWord} ${i + 1}...`);
      const newName = await generateAlternativeName(bag, imagePath, mediaType, imageBase64, itemWord);
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
async function generateAlternativeName(bag, imagePath, mediaType, imageBase64, itemWord) {
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
            text: `This upcycled ${itemWord} was going to be named "${bag.name}" but that name is already taken along with all its whimsical variants.

Please come up with a completely different creative "Miss ___" name for this ${itemWord} based on its fabric pattern, colors, and vibe. The name must be fresh and distinct — not a variation of "${bag.name}".

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
async function generateBrandStory(bagName, description, forcedType = 'bag') {
  const itemWord = forcedType === 'apron' ? 'apron' : forcedType === 'mobile' ? 'mobile' : 'bag';  
  const article  = forcedType === 'apron' ? 'an' : 'a';
  const client = getClient();  
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [{
        role: 'user',
		content: `Generate a slightly varied brand story for ${article} ${itemWord} called "${bagName}".
		Keep the same meaning and key points but vary the wording slightly so each ${itemWord} feels unique.
		Do NOT change the dimensions. Return ONLY valid JSON, no markdown:

		{
		  "occupation": "${itemWord === 'apron' ? 'Apron' : itemWord === 'mobile' ? 'Loot Bag' : 'Shopping Bag'}",    
		  "handmadeBy": "An amazing local woman",
		  "handmadeFrom": "Upcycled material that was donated or found at a local thrift store.",
		  "quality": "Each ${itemWord === 'apron' ? 'apron' : itemWord === 'mobile' ? 'loot bag' : 'shopping bag'} has finished seams${itemWord === 'bag' ? ', reinforced handles' : ', a handy front pocket,'} and is sewn to last.",
		  "purpose": "The best part — a portion of all profits go back into the community at <a href='https://karis-society.org/about/'>Karis Support Society</a>. Plus you are supporting zero waste solutions for our lovely planet."		  
		}

		Vary the wording slightly for each field — especially handmadeBy, handmadeFrom, quality and purpose — while keeping the same meaning. When varying the wording you MUST ensure that all words used are valid English words and are grammatically correct. occupation should always be "${itemWord === 'apron' ? 'Apron' : itemWord === 'mobile' ? 'Loot Bag' : 'Shopping Bag'}".
		When occupation is Loot Bag include the following text at the end of the quality section: NOTE: Items shown in the Loot Bag are for illustrative purposes only. `		
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
		occupation: itemWord === 'apron' ? 'Apron' : itemWord === 'mobile' ? 'Loot Bag' : 'Shopping Bag',
                    
		handmadeBy: 'An amazing local woman',
		handmadeFrom: 'Upcycled material that was donated or found at a local thrift store.',
		quality: `Each ${itemWord === 'apron' ? 'apron' : itemWord === 'mobile' ? 'loot bag' : 'shopping bag'} has finished seams${itemWord === 'bag' ? ', reinforced handles' : ', a handy front pocket,'} and is sewn to last.`,
		purpose: 'The best part — a portion of all profits go back into the community at <a href="https://karis-society.org/about/">Karis Support Society</a>. Plus you are supporting zero waste solutions for our lovely planet.',
		};
    }
	// Ensure Karis link is always present regardless of AI wording
	if (parsed.purpose) {
	  parsed.purpose = parsed.purpose.replace(
		/(?<!">)Karis Support Society(?!<\/a>)/g,
		'<a href="https://karis-society.org/about/">Karis Support Society</a>'
	  );
	}
    return parsed;
  } 
  catch (err) {
	logger.warn(`  Brand story generation failed: ${err.message} — using defaults`);
	return {
		occupation: itemWord === 'apron' ? 'Apron' : itemWord === 'mobile' ? 'Loot Bag' : 'Shopping Bag',	
		handmadeBy: 'An amazing local woman',
		handmadeFrom: 'Upcycled material that was donated or found at a local thrift store.',
		quality: `Each ${itemWord === 'apron' ? 'apron' : itemWord === 'mobile' ? 'loot bag' : 'shopping bag'} has finished seams${itemWord === 'bag' ? ', reinforced handles' : ', a handy front pocket,'} and is sewn to last.`,
		purpose: 'The best part — a portion of all profits go back into the community at <a href="https://karis-society.org/about/">Karis Support Society</a>. Plus you are supporting zero waste solutions for our lovely planet.',		
	};
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
    'Show the bag upright with handles standing naturally tall, looking full and appealing as a product photo. The location where the handles are sewn to the bag must match the original photo - do not change this.',
    'Show the bag upright with the handles flopped naturally forward over the front of the bag, as if just set down. The location where the handles are sewn to the bag must match the original photo - do not change this.',
    'Show the bag slightly angled to the left with handles standing tall, giving a dynamic product shot feel. The location where the handles are sewn to the bag must match the original photo - do not change this.',
    'Show the bag slightly angled to the right with one handle flopped forward and one standing, looking natural and casual. The location where the handles are sewn to the bag must match the original photo - do not change this.',
    'Show the bag upright with both handles relaxed and drooping slightly to each side, looking soft and natural. The location where the handles are sewn to the bag must match the original photo - do not change this.',
    'Show the bag from a slight three-quarter angle with handles flopped naturally forward. The location where the handles are sewn to the bag must match the original photo - do not change this.',
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
 * Step 3b: Render an apron or a mobile bag on a mannequin using OpenAI image editing.
 */ 
async function renderApron(bagData, outputDir, forcedType) {
  const client = getClient();
  const safeName = bagData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const renderedPath = path.join(outputDir, `${safeName}_mannequin.png`);

  logger.info(`  Rendering on mannequin: ${bagData.name}...`);
   
  let prompt = "";
  if(forcedType === 'apron'){
	  prompt = `This is a flat upcycled fabric apron.
	Place this apron on a professional faceless dress form mannequin, shown from the front.
	The apron strings should be tied naturally around the waist and tied in a bow behind the back of the mannequin. The apron strings cannot be wrapped around to the front of the mannequin and MUST NOT be tied in a bow in the front of the mannequin. No tied bows should ever be seen on the front of the mannequin. The bib of the apron must be sitting flat against the upper chest of the mannequin. Please make the rendered apron on the mannequin 5 inches shorter in length.
	Keep all fabric patterns, colors, textures, labels, and design elements exactly as they appear — do not alter the fabric in any way.
	There is a small rectangular fabric branding tag sewn onto the top center of the apron between the neck straps. This tag MUST remain at the top center of the apron between the neck straps — do not move it. The tag's rectangular shape must be preserved. The text on the tag must not be changed or rewritten in any way. 
	Use a clean, neutral white or light gray studio background.
	Professional product photography style, soft even lighting, no harsh shadows.
	The mannequin should be simple, neutral-colored, and not distract from the apron.`;
  } else {
	  prompt = `This is a flat upcycled small bag with a long shoulder strap. The small bag is suitable for carrying a bottle of water, a bottle of soda, a smart phone, or other small items.
	Place this small bag on a professional faceless dress form mannequin, with the strap draped over one shoulder and the small bag resting against the opposite hip in a cross-body style. It is importent to vary which shoulder the strap is draped over - do not always pick the same shoulder. Only one side of the strap should be visible - the other side of the strap will be behind the mannequin's back. The entire front the small bag should be visible on the opposite hip from the shoulder on which the strap was draped. At the top of the small bag is an opening as wide as the small bag itself, revealing the top of an item that is being stored in the small bag. The item in the small bag can be a Kindle, a smart phone, a bottle of water, or a bottle of Diet Coke. Randomize the items you choose to put into the small bag. The small bag has a small pocket centered 3 inches directly below the opening on the top of the bag. This small pocket is made out of the same colors and patterns as the rest of the small bag, meaning the small pocket will not be visible unless there is something stored in it. We should see a pair of sunglasses or cards sticking out of the small pocket on the small bag. The small pocket should be empty if the small bag contains a bottle of water or a bottle of soda.
	Do not change the size of the small bag or relocate the small pocket on the small bag - these must remain unchanged from the original photo. 
	Keep all fabric patterns, colors, textures, labels, and design elements exactly as they appear — do not alter the fabric in any way.
	There is a small rectangular fabric branding tag sewn onto the top center of the small bag between the shoulder straps. This tag MUST remain at the top center of the small bag between the shoulder straps — do not move it. The tag's rectangular shape must be preserved. The text on the tag must not be changed or rewritten in any way. 
	Use a clean, neutral white or light gray studio background.
	Professional product photography style, soft even lighting, no harsh shadows.
	The mannequin should be simple, neutral-colored, and not distract from the small bag.`;	  
  }

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

module.exports = { detectBags, cropBags, puffBag, renderApron, prepareSecondaryImage, generateBrandStory, generateSKU, PRICES };
