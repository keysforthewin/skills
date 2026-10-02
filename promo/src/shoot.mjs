// node shoot.mjs still 2 7 14 ...   -> stills/t.png
// node shoot.mjs video               -> pipes every frame to ffmpeg
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'

const here = new URL('.', import.meta.url).pathname
const browser = await chromium.launch({
  executablePath: `${os.homedir()}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
})
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(`file://${here}video.html`)
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(800)

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'still') {
  mkdirSync(`${here}stills`, { recursive: true })
  for (const t of rest) {
    await page.evaluate(x => window.seek(x), +t)
    await page.screenshot({ path: `${here}stills/${t}.png` })
  }
} else {
  const FPS = 30
  const duration = await page.evaluate(() => window.DURATION)
  const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${here}wep-promo.mp4`],
    { stdio: ['pipe', 'ignore', 'inherit'] })
  const total = Math.round(duration * FPS)
  for (let i = 0; i < total; i++) {
    await page.evaluate(x => window.seek(x), i / FPS)
    const shot = await page.screenshot({ type: 'jpeg', quality: 96 })
    if (!ff.stdin.write(shot)) await new Promise(r => ff.stdin.once('drain', r))
    if (i % 150 === 0) console.log(`${i}/${total}`)
  }
  ff.stdin.end()
  await new Promise(r => ff.on('close', r))
}
await browser.close()
