# Artsy Phartsy Inventory Uploader

Automatically processes photos of multiple bags or aprons into individual product listings,
uploaded as WooCommerce drafts with an email notification to review them.

---

## How It Works

1. Drop a photo containing one or more bags into the `input/` folder
2. AI (GPT-4o) detects each individual bag and identifies its fabric type
3. Each bag is cropped out of the batch photo
4. AI image editing "puffs up" each flat bag to look naturally filled or drapes each apron on a mannequin
5. Each bag or apron is uploaded to WooCommerce as a **draft** product with photo, name, SKU, and price
6. An email notification is sent with links to review each draft
7. The source photo is moved to `input/processed/done/`

For batch photos with multiple bags:
- Leave at least 2-3 inches of backdrop between bags (not just above/below, but between bags too)
- Maximum 3 bags per photo works better than 4+ for tight layouts
- The more separation between bags, the more accurate the individual crops will be

---

## Prerequisites

- **Windows 11 with WSL2** (Ubuntu 22.04 or 24.04 recommended)
- **Node.js 18+** installed inside WSL
- An **OpenAI account** with a few dollars of credit (platform.openai.com)
- A **WooCommerce REST API key** (Read/Write)
- A **Gmail App Password** for sending notifications

---

## Step-by-Step Setup (WSL)

### 1. Install WSL (if not already installed)
Open PowerShell as Administrator and run:
```powershell
wsl --install
```
Restart your PC, then open the Ubuntu app from the Start menu.

### 2. Install Node.js inside WSL
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should show v20.x.x
```

### 3. Clone or copy this project into WSL
Option A — if you have git:
```bash
cd ~
git clone <your-repo-url> artsy-phartsy
cd artsy-phartsy
```

Option B — copy the folder from Windows into WSL:
```bash
# Your Windows C: drive is at /mnt/c/ inside WSL
cp -r /mnt/c/Users/YourName/Downloads/artsy-phartsy ~/artsy-phartsy
cd ~/artsy-phartsy
```

### 4. Install dependencies
```bash
npm install
```
This installs all required packages (OpenAI, sharp for image processing, chokidar for folder watching, nodemailer, etc.)

### 5. Configure your .env file
```bash
cp .env.example .env
nano .env
```

Fill in each value:

**OpenAI API Key**
- Go to platform.openai.com → API Keys → Create new secret key
- Add at least $5 credit under Billing

**WooCommerce API Keys**
- In WordPress admin: WooCommerce → Settings → Advanced → REST API
- Click "Add Key", set permissions to Read/Write
- Copy the Consumer Key and Consumer Secret (shown only once!)

**Gmail App Password**
- Your Google Account → Security → 2-Step Verification (must be enabled)
- Scroll down to "App Passwords" → create one named "ArtsyPhartsy"
- Use the 16-character password it generates (spaces are fine to include)

**Notification emails**
- Comma-separated list, e.g.: `wife@gmail.com,john@gmail.com`

### 6. Set up the input folder
The tool watches the `input/` folder inside the project.

**Tip — use a shared folder users can drop photos into from their phone:**
If you're using OneDrive or Dropbox on Windows, you can point the INPUT_FOLDER
to that synced folder:
```
INPUT_FOLDER=/mnt/c/Users/YourName/OneDrive/ArtsyPhartsy/new-bags
```
Take a photo on phone, it syncs to OneDrive, the tool picks it up automatically.

---

## Running the Tool

### Start
```bash
npm start
```
You'll see:
```
════════════════════════════════════════════════════════════
  ArtsyPhartsy Bag Uploader — RUNNING
════════════════════════════════════════════════════════════
  Watching: /home/yourname/artsy-phartsy/input
  Output:   /home/yourname/artsy-phartsy/output
  Notify:   <email address>
────────────────────────────────────────────────────────────
  Drop JPG/PNG photos into the input folder to begin.
  Press Ctrl+C to stop gracefully.
════════════════════════════════════════════════════════════
```

### Stop gracefully
Press `Ctrl+C` — the tool will finish any photo currently being processed before exiting.

### Check status while running
Open a second WSL terminal and run:
```bash
kill -USR1 $(pgrep -f "node src/index.js")
```
This prints the current queue without interrupting processing.

### Run in the background (so you can close the terminal)
```bash
nohup npm start > logs/nohup.log 2>&1 &
echo $! > logs/pid.txt
echo "Started with PID $(cat logs/pid.txt)"
```

To stop it later:
```bash
kill $(cat logs/pid.txt)
```

---

## Testing Before a Full Batch

**Test the email notification only:**
```bash
node -e "
require('dotenv').config();
const { sendNotification } = require('./src/email');
sendNotification('test-photo.jpg', [
  { name: 'Miss Test', sku: 'AP-TEST-001', price: 25, ok: true, adminUrl: 'https://XXXXXXXXXX/wp-admin' }
], 'https://XXXXXXXXXX/wp-admin/edit.php?post_status=draft&post_type=product');
"
```

**Test with a single bag photo (no batch splitting):**
Just drop a photo of one bag into the `input/` folder — easiest way to validate the full pipeline for a few cents.

---

## Folder Structure After Running

```
input/
  processed/
    done/          ← successfully processed source photos
    failed/        ← photos that had errors
output/
  batch_1234567/
    miss_geometric_crop.jpg      ← cropped from original
    miss_geometric_puffed.png    ← AI puffed version (uploaded to WooCommerce)
logs/
  uploader.log                   ← full log history
```

---

## Estimated Costs Per Bag

| Step | Model | Cost |
|------|-------|------|
| Detection (GPT-4o vision) | ~$0.01–0.02 per batch photo | |
| Puffing (DALL-E 2 edit) | ~$0.02 per bag | |
| **Total per bag** | **~$0.03–0.04** | |

A backlog of 200 bags ≈ **$6–8 total**.

---

## Troubleshooting

**"Missing required environment variables"**
→ Make sure you created `.env` (not just `.env.example`) and filled in all values.

**"Image upload failed"**
→ Check your WooCommerce Consumer Key has Read/Write permission, not Read only.

**"Failed to send notification email"**
→ Make sure you're using a Gmail App Password (not your real Gmail password).
→ Check that 2-Step Verification is enabled on your Google account.

**Bags not being detected in photos**
→ Try a neutral, high-contrast backdrop (light grey or blue works best).
→ Ensure bags are spread out with visible gaps between them.
→ Bright, even lighting helps the AI identify individual items.

**DALL-E puffing looks wrong**
→ The fallback is the cropped original — it will still upload, just flat.
→ Better source photo quality = better puffing results.

---

## Photo Tips for Best Results

- **Even lighting**: avoid harsh shadows between bags
- **Clear separation**: leave a small gap between bags
- **Flat and smooth**: straighten out folds and wrinkles before shooting
- **Good resolution**: shoot in your phone's standard (not compressed) mode
