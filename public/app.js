// Kiosk application state configuration
let settings = {
  autoPrint: true,
  pollRateMs: 3000,
  printCooldownMs: 4000
};

// Internal states
let photosMap = {}; // Tracks loaded photos by ID
let printQueue = []; // Sequential print queue
let isPrinting = false; // Semaphore lock for print queue
let isFirstPoll = true; // Prevents back-printing old photos on load
let printedCache = new Set(); // Tracks image IDs already printed in this event
let printPromiseResolve = null; // Resolves when iframe finishes loading
let printTimeoutId = null;

// DOM Elements
const galleryGrid = document.getElementById('gallery-grid');
const queueList = document.getElementById('queue-list');
const statTotal = document.getElementById('stat-total');
const statPrinted = document.getElementById('stat-printed');
const statQueue = document.getElementById('stat-queue');
const galleryCountBadge = document.getElementById('gallery-count-badge');
const pollingBadge = document.getElementById('polling-badge');
const printFrame = document.getElementById('print-frame');

// Settings modal elements
const settingsBtn = document.getElementById('settings-btn');
const resetBtn = document.getElementById('reset-btn');
const settingsModal = document.getElementById('settings-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalSaveBtn = document.getElementById('modal-save-btn');

// Form inputs
const settingAutoPrint = document.getElementById('setting-auto-print');
const settingPollRate = document.getElementById('setting-poll-rate');
const settingPrintDelay = document.getElementById('setting-print-delay');
const settingTargetUrl = document.getElementById('setting-target-url');
const settingImageSelector = document.getElementById('setting-image-selector');
const settingBgColor = document.getElementById('setting-bg-color');

// Profile items
const profileUrl = document.getElementById('profile-url');
const profileDevice = document.getElementById('profile-device');

// --- Initialization & Local Storage ---

async function loadSettings() {
  // Load local client settings
  const cachedSettings = localStorage.getItem('kiosk_settings');
  if (cachedSettings) {
    try {
      settings = JSON.parse(cachedSettings);
    } catch (e) {
      console.error('[Kiosk] Settings load error, defaults used.', e);
    }
  }
  
  // Update inputs
  settingAutoPrint.value = settings.autoPrint.toString();
  settingPollRate.value = Math.round(settings.pollRateMs / 1000);
  settingPrintDelay.value = Math.round(settings.printCooldownMs / 1000);
  
  // Load printed cache
  const cachedPrints = localStorage.getItem('printed_cache');
  if (cachedPrints) {
    try {
      const arr = JSON.parse(cachedPrints);
      printedCache = new Set(arr);
    } catch (e) {
      console.error('[Kiosk] Printed cache load error.', e);
    }
  }
  
  // Detect if running inside Fully Kiosk Browser
  if (window.fully) {
    profileDevice.textContent = 'Fully Kiosk Browser';
  } else {
    profileDevice.textContent = 'Standard Web Browser';
  }

  // Load server-side dynamic configuration
  try {
    const response = await fetch('/api/config');
    if (response.ok) {
      const config = await response.json();
      settingTargetUrl.value = config.targetGalleryUrl || '';
      settingImageSelector.value = config.galleryImageSelector || '';
      settingBgColor.value = config.canvasBgColor || '#ffffff';
      
      // Update sidebar targeting info
      profileUrl.textContent = config.targetGalleryUrl || 'None configured (using Mock Mode)';
    }
  } catch (err) {
    console.error('[Kiosk] Failed to fetch server config:', err);
  }
  
  updateSidebarStats();
}

async function saveSettings() {
  const localAutoPrint = settingAutoPrint.value === 'true';
  const localPollRateMs = Math.max(1, parseInt(settingPollRate.value, 10)) * 1000;
  const localPrintCooldownMs = Math.max(1, parseInt(settingPrintDelay.value, 10)) * 1000;
  
  const targetGalleryUrl = settingTargetUrl.value.trim();
  const galleryImageSelector = settingImageSelector.value.trim();
  const canvasBgColor = settingBgColor.value.trim();
  
  try {
    // Save to server config first
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        targetGalleryUrl,
        galleryImageSelector,
        canvasBgColor
      })
    });
    
    if (!res.ok) throw new Error('Server update failed.');
    const data = await res.json();
    
    // Save local client states
    settings.autoPrint = localAutoPrint;
    settings.pollRateMs = localPollRateMs;
    settings.printCooldownMs = localPrintCooldownMs;
    localStorage.setItem('kiosk_settings', JSON.stringify(settings));
    
    // Update local UI labels
    profileUrl.textContent = targetGalleryUrl || 'None configured (using Mock Mode)';
    
    showToast('Settings Saved', 'Configurations updated on server and client.', 'success');
    
    // Restart polling loop
    stopPolling();
    startPolling();
    
    closeModal();
  } catch (err) {
    console.error('[Kiosk] Save settings failed:', err);
    showToast('Save Failed', err.message, 'error');
  }
}

function updatePrintedCache(photoId) {
  printedCache.add(photoId);
  localStorage.setItem('printed_cache', JSON.stringify(Array.from(printedCache)));
  updateSidebarStats();
}

// --- Polling Loop ---
let pollIntervalId = null;

function startPolling() {
  fetchPhotos(); // Immediate fetch
  pollIntervalId = setInterval(fetchPhotos, settings.pollRateMs);
  
  pollingBadge.className = 'status-badge online';
  pollingBadge.querySelector('span').textContent = 'Server Active';
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

async function fetchPhotos() {
  try {
    const response = await fetch('/api/photos');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const photos = await response.json();
    
    // Process photos in reverse order (oldest to newest) to display & queue them chronologically
    const reversedPhotos = [...photos].reverse();
    
    reversedPhotos.forEach(photo => {
      if (!photosMap[photo.id]) {
        // Newly discovered image
        photosMap[photo.id] = photo;
        
        // Add to UI Grid
        addPhotoToGrid(photo, !isFirstPoll);
        
        // Check if we should queue print
        if (!isFirstPoll) {
          if (settings.autoPrint && !printedCache.has(photo.id)) {
            showToast('New Photo', 'Adding newly captured photo to print queue.', 'info');
            queuePrint(photo);
          }
        } else {
          // On first page load, we register historical photos as printed to avoid printing history
          if (!printedCache.has(photo.id)) {
            printedCache.add(photo.id);
          }
        }
      }
    });
    
    // Save printed cache state if changed on initial load
    if (isFirstPoll) {
      localStorage.setItem('printed_cache', JSON.stringify(Array.from(printedCache)));
      isFirstPoll = false;
    }
    
    updateSidebarStats();
    
  } catch (err) {
    console.error('[Kiosk] Polling fetch error:', err.message);
    pollingBadge.className = 'status-badge offline';
    pollingBadge.querySelector('span').textContent = 'Conn Error (Re-polling)';
  }
}

// --- UI Grid Rendering ---

function addPhotoToGrid(photo, isNew) {
  const emptyWall = galleryGrid.querySelector('.gallery-empty');
  if (emptyWall) {
    galleryGrid.innerHTML = '';
  }
  
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.id = `card-${photo.id}`;
  
  // Format readable timestamp
  const dateObj = new Date(photo.timestamp);
  const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  card.innerHTML = `
    ${isNew ? '<span class="card-badge-new">New</span>' : ''}
    <img src="${photo.processedUrl}" alt="Photo ${timeStr}">
    <div class="card-overlay">
      <div class="card-details">
        <span class="card-time">⌚ ${timeStr}</span>
        <button class="card-reprint-btn" onclick="triggerManualReprint('${photo.id}')">🖨️ Reprint</button>
      </div>
    </div>
  `;
  
  // Prepend to show newest at the top-left
  galleryGrid.insertBefore(card, galleryGrid.firstChild);
}

function updateSidebarStats() {
  const total = Object.keys(photosMap).length;
  statTotal.textContent = total;
  statPrinted.textContent = printedCache.size;
  statQueue.textContent = printQueue.length;
  galleryCountBadge.textContent = `${total} photo${total === 1 ? '' : 's'} captured`;
}

// --- Printing Queue Engine ---

function queuePrint(photo) {
  if (printQueue.some(item => item.id === photo.id)) return;
  
  printQueue.push(photo);
  updateQueueUI();
  updateSidebarStats();
  
  processQueue();
}

function triggerManualReprint(photoId) {
  const photo = photosMap[photoId];
  if (photo) {
    showToast('Reprint Triggered', 'Re-adding photo to the print queue.', 'success');
    queuePrint(photo);
  }
}

function updateQueueUI() {
  if (printQueue.length === 0) {
    queueList.innerHTML = '<li class="queue-empty-text">Queue is idle</li>';
    return;
  }
  
  queueList.innerHTML = '';
  printQueue.forEach((photo, index) => {
    const li = document.createElement('li');
    li.className = `queue-item ${index === 0 && isPrinting ? 'printing' : ''}`;
    
    li.innerHTML = `
      <img class="queue-thumbnail" src="${photo.processedUrl}">
      <div class="queue-item-info">
        <div class="queue-item-name">Image #${photo.id.substring(4, 9)}</div>
        <div class="queue-item-status">${index === 0 && isPrinting ? '⚡ Printing...' : 'Pending'}</div>
      </div>
    `;
    queueList.appendChild(li);
  });
}

async function processQueue() {
  if (isPrinting || printQueue.length === 0) return;
  
  isPrinting = true;
  updateQueueUI();
  
  const currentPhoto = printQueue[0];
  console.log(`[Printer] Dequeued ${currentPhoto.id} for processing.`);
  
  try {
    await printImageAsync(currentPhoto);
    
    // Print request sent successfully
    showToast('Print Job Sent', 'Sent to printer queue. Waiting for cooling delay...', 'success');
    updatePrintedCache(currentPhoto.id);
    
    // Pop from queue
    printQueue.shift();
    updateQueueUI();
    
    // Wait for thermal cooling delay of Selphy
    console.log(`[Printer] Cooldown timer running: ${settings.printCooldownMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, settings.printCooldownMs));
    
  } catch (err) {
    console.error('[Printer] Print failed:', err.message);
    showToast('Print Error', `Failed: ${err.message}. Retrying in 10s...`, 'error');
    
    await new Promise(resolve => setTimeout(resolve, 10000));
  } finally {
    isPrinting = false;
    updateQueueUI();
    
    processQueue();
  }
}

function printImageAsync(photo) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data && event.data.url === photo.processedUrl) {
        if (event.data.type === 'PRINT_READY') {
          clearTimeout(printTimeoutId);
          window.removeEventListener('message', onMessage);
          
          try {
            console.log('[Printer] Iframe loaded, firing window.print()...');
            printFrame.contentWindow.focus();
            printFrame.contentWindow.print();
            resolve();
          } catch (e) {
            reject(new Error('Print command block: ' + e.message));
          }
        } else if (event.data.type === 'PRINT_ERROR') {
          clearTimeout(printTimeoutId);
          window.removeEventListener('message', onMessage);
          reject(new Error('Failed to load image in iframe.'));
        }
      }
    };
    
    window.addEventListener('message', onMessage);
    
    printFrame.src = `print.html?img=${encodeURIComponent(photo.processedUrl)}`;
    
    // 8 second safety timeout
    printTimeoutId = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Iframe load timeout (network offline?)'));
    }, 8000);
  });
}

// --- Toast Notifications ---

function showToast(title, message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = '🔔';
  if (type === 'success') icon = '✓';
  if (type === 'error') icon = '✗';
  if (type === 'info') icon = 'ℹ';
  
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => toast.classList.add('show'), 50);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// --- Event Handlers & Modals ---

settingsBtn.addEventListener('click', openModal);
modalCloseBtn.addEventListener('click', closeModal);
modalSaveBtn.addEventListener('click', saveSettings);
window.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeModal();
});

function openModal() {
  settingsModal.classList.add('open');
}

function closeModal() {
  settingsModal.classList.remove('open');
}

// Reset Database handler
resetBtn.addEventListener('click', async () => {
  const confirmReset = confirm(
    "⚠️ WARNING: RESET EVENT STATE?\n\nThis will permanently delete all processed images from the server database, wipe the mock uploads folder, and clear the tablet cache.\n\nThis action cannot be undone."
  );
  
  if (!confirmReset) return;
  
  try {
    resetBtn.disabled = true;
    resetBtn.textContent = 'Clearing...';
    
    const response = await fetch('/api/photos/reset', { method: 'POST' });
    if (!response.ok) throw new Error('API reset failure.');
    
    // Clear local caches
    photosMap = {};
    printQueue = [];
    printedCache.clear();
    localStorage.removeItem('printed_cache');
    isPrinting = false;
    
    // Clear UI
    galleryGrid.innerHTML = `
      <div class="gallery-empty">
        <div class="gallery-empty-icon">🎨</div>
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 4px;">Waiting for first snapshot</p>
        <p style="font-size: 13px;">Photos taken in the booth will appear here and print automatically.</p>
      </div>
    `;
    updateQueueUI();
    updateSidebarStats();
    
    showToast('Event Cleared', 'Server data and local caches have been fully wiped.', 'success');
  } catch (err) {
    console.error('[Kiosk] Reset error:', err);
    showToast('Reset Failed', err.message, 'error');
  } finally {
    resetBtn.disabled = false;
    resetBtn.textContent = '🗑️ Reset Event';
  }
});

// Start Up
window.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  startPolling();
});
