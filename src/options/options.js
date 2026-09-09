const $ = (id) => document.getElementById(id);
const statusLine = $('status');

function report(message, tone = 'ok') {
  statusLine.textContent = message;
  statusLine.dataset.tone = tone;
}

async function load() {
  $('redirect').value = chrome.identity.getRedirectURL();
  const { clientId = '' } = await chrome.storage.local.get('clientId');
  $('client-id').value = clientId;
}

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('redirect').value);
  report('Redirect URI copied.');
});

$('save').addEventListener('click', async () => {
  const clientId = $('client-id').value.trim();
  if (!clientId) {
    report('Enter the Client ID from your Spotify app.', 'error');
    return;
  }
  await chrome.storage.local.set({ clientId });
  report('Client ID saved. You can connect now.');
});

$('connect').addEventListener('click', async () => {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (!clientId) {
    report('Save your Client ID first.', 'error');
    return;
  }
  report('Opening Spotify…');
  const response = await chrome.runtime.sendMessage({ type: 'BEGIN_AUTH' });
  if (response?.ok) {
    report('Connected. Open the Spotinyl popup to see what is playing.');
  } else {
    report(response?.error?.message ?? 'Could not connect to Spotify.', 'error');
  }
});

$('signout').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'SIGN_OUT' });
  report('Signed out. Your Client ID is still saved.');
});

load();
