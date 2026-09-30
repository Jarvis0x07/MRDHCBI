# MRDHCBI Web Demonstrator

A GitHub-Pages-friendly demonstrator for the supplied MRDHCBI + Hamming-syndrome prototype.

## What it does

1. User chooses **Sender** or **Receiver**.
2. Both enter the same pairing key.
3. The sender creates a temporary PeerJS/WebRTC room.
4. The receiver joins using the same key.
5. Sender selects:
   - a binary/grayscale image
   - a document to hide
6. The browser converts the image to binary pixels (`>=128 -> 1`).
7. The `(2,3)` visual-cryptography construction creates three shares.
8. The proposed Hamming-syndrome method embeds **3 payload bits per source image pixel per share**.
9. Only the marked shares are transferred; the document is not sent separately.
10. Receiver extracts the payload, restores the ciphertext shares, reconstructs the binary image, and verifies the document with CRC-32.
11. Both sides show a dashboard comparing the base MRDHCBI method and the proposed method.
12. A corruption slider can flip a chosen percentage of marked-share bits before transfer.

## Important result interpretation

For the current prototype:

| Metric | Base MRDHCBI | Hamming syndrome |
|---|---:|---:|
| Payload / source pixel | 1 bit | 3 bits |
| Stored bits / source pixel / share | 3 | 7 |
| Payload density / stored coded bit | 1/3 | 3/7 |
| Additional Hamming storage | — | 75% over the VC ciphertext |
| Clean image recovery | Exact | Exact |

The browser demo reports actual recovery for the current transaction. Do not describe the proposed method as universally better: it trades additional coded storage for higher payload capacity.

## GitHub Pages deployment

This is intentionally a static site.

### 1. Create a repository

Example:

```text
mrdhcbi-web
```

Copy the contents of this folder into the repository root.

### 2. Push

```bash
git init
git add .
git commit -m "Add MRDHCBI web demonstrator"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mrdhcbi-web.git
git push -u origin main
```

### 3. Enable Pages

In GitHub:

```text
Repository
→ Settings
→ Pages
→ Build and deployment
→ Source: Deploy from a branch
→ Branch: main
→ Folder: / (root)
→ Save
```

GitHub will provide the Pages URL.

No Node server is required for the website.

## Why a server is still involved

GitHub Pages only serves static files. It does not act as a live signaling server.

This demo therefore uses:

- **GitHub Pages** — hosts HTML/CSS/JS
- **PeerJS cloud signaling** — helps the two browsers find each other
- **WebRTC DataChannel** — transfers the marked shares directly between browsers

The transferred file data is not uploaded to GitHub Pages.

For a production/research deployment, replace the public PeerJS signaling dependency with a signaling server that you control.

## Project structure

```text
mrdhcbi-web/
├── index.html
├── styles.css
├── README.md
└── js/
    ├── algorithm.js
    └── app.js
```

## Browser algorithm

The implementation in `js/algorithm.js` mirrors the important logic in the supplied Python prototype:

- B0/B1 `(2,3)` visual cryptography basis matrices
- random column permutations
- base MRDHCBI embedding
- Hamming(7,4)
- syndrome calculation
- 3-bit syndrome-state embedding
- syndrome extraction and restoration
- VC reconstruction
- SHA-256 counter-mode XOR stream for the document payload
- CRC-32 integrity verification

## Document format

Before embedding, the browser creates:

```text
[name length: 2 bytes]
[mime length: 2 bytes]
[file size: 4 bytes]
[CRC-32: 4 bytes]
[file name]
[MIME type]
[file bytes]
```

That complete byte stream is XORed with a key-derived SHA-256 keystream and then converted to payload bits.

This is a reversible demonstration format, not a replacement for authenticated modern encryption.

## Corruption experiment

The corruption slider flips random bits in the marked shares before the WebRTC transfer.

The dashboard reports:

- image pixel recovery
- document recovery/integrity
- CRC status
- corruption percentage
- base/proposed capacity
- stored-bit expansion

The current Hamming-syndrome construction can use Hamming's correction capability to help restore the underlying ciphertext when errors are within its correction model, but the syndrome itself is also carrying payload. Therefore arbitrary corruption can still damage the document payload. The website deliberately reports the measured result instead of claiming 100% recovery under arbitrary corruption.

## Recommended research workflow

For your presentation/demo:

1. Run with `0%` corruption.
2. Show exact document recovery and exact image recovery.
3. Increase corruption to `1%`, `2%`, `5%`, `10%`.
4. Compare image recovery and document recovery.
5. Explain the capacity/storage tradeoff.
6. Export screenshots of the dashboard for your results section.

## Current scope

The prototype is designed as a research demonstrator rather than a production file-transfer system. In particular:

- the pairing key is used for room identification and payload masking;
- the public PeerJS broker is external infrastructure;
- the browser stores data only for the active transaction;
- no database is required;
- no user account is required;
- no original image is sent separately.

