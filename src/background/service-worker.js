import { createRouter } from './router.js';

const storage = {
  async get() {
    const { clientId = null, tokens = null } = await chrome.storage.local.get(['clientId', 'tokens']);
    return { clientId, tokens };
  },
  async set(patch) {
    await chrome.storage.local.set(patch);
  },
};

const router = createRouter({
  storage,
  fetchImpl: (...args) => fetch(...args),
  launchAuthFlow: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
  redirectUri: chrome.identity.getRedirectURL(),
  now: () => Date.now(),
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  router
    .handle(message)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: { tag: 'unknown', message: error?.message ?? 'Unexpected error.' },
      state: null,
    }));
  return true; // keep the message channel open for the async response
});
