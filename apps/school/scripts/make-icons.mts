/**
 * Renders the PNG app icons from public/icon.svg with Chromium (already installed for the browser tests) — no image library needed.
 *   LD_LIBRARY_PATH=… pnpm exec tsx scripts/make-icons.mts
 * "maskable" icons must keep their artwork inside the central 80% (platforms crop them to circles, squircles…), so that one is
 * drawn on a full-bleed background with the artwork scaled down.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("public/icon.svg", "utf8");
const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<rect[^>]*rx="96"[^>]*\/>/, ""); // artwork without its rounded background
const bg = "#0f1b24";

const pages: Record<string, string> = {
  "public/icon-192.png": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="192" height="192">${svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")}</svg>`,
  "public/icon-512.png": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")}</svg>`,
  "public/icon-maskable-512.png": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="${bg}"/><g transform="translate(51.2 51.2) scale(0.8)">${inner}</g></svg>`,
};

const browser = await chromium.launch();
for (const [file, markup] of Object.entries(pages)) {
  const size = Number(/width="(\d+)"/.exec(markup)![1]);
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${markup}`);
  writeFileSync(file, await page.screenshot({ omitBackground: true, type: "png" }));
  await page.close();
  console.log("wrote", file, size);
}
await browser.close();
