// Run the real extension -> local Express -> mocked Groq flow in Chromium.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { createAnalyzer } = require('../server/groq');
const project = path.resolve(__dirname, '..');
const id = (page, name) => page.locator(`#lock-in-buddy-${name}`);

async function navigate(page, videoID, title) {
  await page.evaluate(({ videoID, title }) => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    history.pushState({}, '', `/watch?v=${videoID}`);
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', videoID);
    document.querySelector('#video-title').textContent = title;
    document.title = `${title} - YouTube`;
    document.dispatchEvent(new Event('yt-navigate-finish'));
  }, { videoID, title });
}
async function classification(page, expected) {
  await page.waitForFunction((expected) => {
    const status = document.getElementById('lock-in-buddy-ai-status');
    return status?.dataset.classification === expected || status?.textContent.startsWith('Video check unavailable.');
  }, expected);
  assert.equal(await id(page, 'ai-status').getAttribute('data-classification'), expected,
    await id(page, 'ai-status').textContent());
}

(async () => {
  const requests = [];
  const errors = [];
  let context;
  let server;
  let serverPort = 0;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-in-buddy-ai-browser-'));
  const extension = path.join(profile, 'extension');
  const analyze = createAnalyzer({ apiKey: 'fake-browser-test-key', fetchImpl: async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    requests.push(input);
    const result = input.videoTitle === 'Minecraft Funny Moments' ? { classification: 'distracting', reason: 'Gameplay highlights do not address calculus.' }
      : input.videoTitle === 'My new project' ? { classification: 'uncertain', reason: 'The title does not describe the topic.' }
      : { classification: 'relevant', reason: 'The title relates to the saved study task.' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  } });
  const startServer = async () => {
    server = createApp({ analyze, requestLimit: 100 }).listen(serverPort, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    serverPort = server.address().port;
  };
  const stopServer = async () => {
    if (server?.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  };
  try {
    await startServer();
    // Copy only extension assets, excluding server/.env and other local files.
    // Point the temporary extension at an isolated mock-server port, so tests
    // never use or interrupt the user's running backend on port 3000.
    await fs.mkdir(extension);
    for (const file of ['manifest.json', 'background.js', 'session.js', 'analysis.js',
      'storage.js', 'youtube.js', 'appear.js', 'buddy.js', 'styleBuddy.css', 'dashboard']) {
      await fs.cp(path.join(project, file), path.join(extension, file), { recursive: true });
    }
    const analysisPath = path.join(extension, 'analysis.js');
    const analysisCode = await fs.readFile(analysisPath, 'utf8');
    assert.ok(analysisCode.includes('http://127.0.0.1:3000/api/analyze'));
    await fs.writeFile(analysisPath, analysisCode.replace('http://127.0.0.1:3000/api/analyze',
      `http://127.0.0.1:${serverPort}/api/analyze`));
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, headless: true,
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await context.route('https://www.youtube.com/**', (route) => {
      const videoID = new URL(route.request().url()).searchParams.get('v') || 'a';
      const title = videoID === 'd' ? 'How Minecraft Was Programmed' : 'Integration by Parts Tutorial';
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <html><head><title>${title} - YouTube</title></head><body>
        <ytd-watch-flexy video-id="${videoID}"><ytd-watch-metadata><h1><yt-formatted-string id="video-title">${title}</yt-formatted-string></h1></ytd-watch-metadata></ytd-watch-flexy>
        <button id="host-control">Host playback control</button></body></html>` });
    });
    const page = await context.newPage();
    // Start at the home page, then enter a video without replacing the document.
    // Chrome's message sender URL can still describe that original document.
    await page.goto('https://www.youtube.com/');
    await page.waitForFunction(() => document.getElementById('lock-in-buddy-chat-input')?.disabled === false);
    await id(page, 'button').click();
    assert.equal(await id(page, 'ai-enabled').isChecked(), false);
    assert.match(await id(page, 'ai-privacy').textContent(), /task.*video title.*GroqCloud/);
    await id(page, 'task-input').fill('Study Calculus');
    await id(page, 'save-task').click();
    await id(page, 'chat-focus').click();
    await page.waitForTimeout(1100);
    assert.equal(requests.length, 0);
    await id(page, 'ai-enabled').check();
    await page.waitForFunction(() => document.getElementById('lock-in-buddy-ai-status')?.textContent === 'Open a YouTube video to check its relevance.');
    assert.equal(requests.length, 0);
    await navigate(page, 'a', 'Integration by Parts Tutorial');
    await classification(page, 'relevant');
    assert.deepEqual(requests, [{ task: 'Study Calculus', videoTitle: 'Integration by Parts Tutorial' }]);
    await navigate(page, 'a', 'Integration by Parts Tutorial');
    await classification(page, 'relevant');
    assert.equal(requests.length, 1);
    console.log('PASS homepage-to-watch SPA navigation, explicit opt-in, real extension/Express/Groq request shape, relevant feedback, and duplicate suppression');

    await navigate(page, 'b', 'Minecraft Funny Moments');
    await classification(page, 'distracting');
    await id(page, 'close-panel').click();
    assert.equal(await id(page, 'ai-reminder').isVisible(), true);
    assert.match(await id(page, 'ai-reminder').textContent(), /return to your task/);
    await page.locator('#host-control').click();
    await id(page, 'ai-reminder').click();
    await navigate(page, 'c', 'My new project');
    await classification(page, 'uncertain');
    assert.match(await id(page, 'ai-status').textContent(), /You decide/);
    console.log('PASS SPA video changes, friendly distracting reminder, accessible host controls, and neutral uncertain feedback');

    await page.locator('#lock-in-buddy-task-editor summary').click();
    await id(page, 'task-input').fill('Research Video Game Development');
    await id(page, 'save-task').click();
    const count = requests.length;
    await navigate(page, 'd', 'How Minecraft Was Programmed');
    await page.waitForTimeout(1100);
    assert.equal(requests.length, count, 'Task changes reset the timer; idle sessions must not send titles');
    await id(page, 'chat-focus').click();
    await classification(page, 'relevant');
    assert.deepEqual(requests.at(-1), { task: 'Research Video Game Development', videoTitle: 'How Minecraft Was Programmed' });
    const beforeReload = requests.length;
    await page.reload();
    await page.waitForFunction(() => document.getElementById('lock-in-buddy-chat-input')?.disabled === false);
    await classification(page, 'relevant');
    assert.equal(await id(page, 'ai-enabled').isChecked(), true);
    assert.equal(requests.length, beforeReload);
    console.log('PASS actual-task relevance, idle-session privacy, automatic recheck on a new session, and persistent opt-in');

    await stopServer();
    await navigate(page, 'offline', 'A new offline video');
    await page.waitForFunction(() => document.getElementById('lock-in-buddy-ai-status')?.textContent.includes('Start the local analysis server'));
    await id(page, 'start-timer').click();
    await page.waitForFunction(() => document.getElementById('lock-in-buddy-start-timer')?.textContent === 'Resume focusing');
    const worker = context.serviceWorkers()[0];
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard/index.html`);
    await dashboard.waitForFunction(() => document.getElementById('focus-heading')?.textContent === 'Research Video Game Development');
    assert.equal(await dashboard.locator('#dashboard-status').isVisible(), false);
    await id(page, 'ai-enabled').uncheck();
    await startServer();
    await id(page, 'ai-enabled').check();
    await id(page, 'start-timer').click();
    await classification(page, 'relevant');
    await id(page, 'ai-enabled').uncheck();
    const lastCount = requests.length;
    await navigate(page, 'disabled', 'A video after disabling');
    await page.waitForTimeout(1100);
    assert.equal(requests.length, lastCount);
    await page.screenshot({ path: path.join(os.tmpdir(), 'lock-in-buddy-ai.png') });
    assert.deepEqual(errors, []);
    console.log('PASS unavailable-backend timer/dashboard recovery, server restart, disable control, and no page errors');
  } finally {
    if (context) await context.close();
    await stopServer();
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
