'use strict';
// Draws the app icon to build/icon.png (electron-builder turns it into .ico/.icns).
// Run with: npm run icon

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas id="c" width="1024" height="1024"></canvas>');
  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    ctx.scale(1024 / 24, 1024 / 24);
    const g = ctx.createLinearGradient(0, 1, 0, 23);
    g.addColorStop(0, '#ff5a4f');
    g.addColorStop(1, '#f0281c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(1.5, 1.5, 21, 21, 5.5);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D('M7 17 L15.5 8.5 M10.5 8 H16 V13.5'));
    return c.toDataURL('image/png');
  })()`);
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', out);
  app.quit();
});
