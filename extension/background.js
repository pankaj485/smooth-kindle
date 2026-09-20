// Toolbar button and keyboard command both just ask the active reader tab to toggle.
async function toggleActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/read\.amazon\.[a-z.]+\//.test(tab.url)) return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'kvs:toggle' });
  } catch (e) {
    // Content script not loaded on this page (e.g. library view) — nothing to do.
  }
}

browser.action.onClicked.addListener(toggleActiveTab);
browser.commands.onCommand.addListener((command) => {
  if (command === 'toggle-scroll-mode') toggleActiveTab();
});
